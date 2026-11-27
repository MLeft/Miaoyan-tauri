use super::persistence::*;
use std::{fs, path::{Path, PathBuf}, sync::Arc};

impl Persistence {
    fn fail_at(&self, stage: &str) { self.faults.lock().unwrap().push(stage.into()); }
    fn hook_at(&self, stage: &str, hook: impl FnOnce() + Send + 'static) { self.hooks.lock().unwrap().insert(stage.into(), Box::new(hook)); }
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("miaoyan-persistence-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        for child in ["config", "library", "destination", "trash"] { fs::create_dir(root.join(child)).unwrap(); }
        Self(root)
    }
    fn service(&self) -> Persistence {
        Persistence::with_trash(self.0.join("config"), Arc::new(FakeTrash(self.0.join("trash"))))
    }
    fn note(&self, name: &str, text: &str) -> PathBuf {
        let path = self.0.join("library").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
struct FakeTrash(PathBuf);
impl TrashAdapter for FakeTrash {
    fn recycle(&self, path: &Path) -> std::io::Result<()> {
        // Never invokes the OS recycle bin; both paths belong to this fixture.
        assert!(fs::canonicalize(path)?.starts_with(fs::canonicalize(self.0.parent().unwrap())?));
        move_no_replace(path, &self.0.join(uuid::Uuid::new_v4().to_string()))
    }
}

#[test]
fn encryption_migrates_identity_annotations_history_and_removes_owned_plaintext_copies() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("private.md", "PRIVATE_CURRENT");
    let id = s.resolve(&note).unwrap();
    s.write_annotations(&note, &id, "[{\"comment\":\"PRIVATE_COMMENT\"}]").unwrap();
    s.save_version(&note, &id, "PRIVATE_VERSION").unwrap();
    s.toggle_pin(&note).unwrap();
    let outcome = s.set_encryption(&note, "fixture-password", true, None).unwrap();
    let protected = PathBuf::from(&outcome.path);
    let snapshot = outcome.snapshot.as_ref().unwrap();
    assert_eq!(snapshot.id, outcome.path);
    assert_eq!(snapshot.content, "PRIVATE_CURRENT");
    assert_eq!(snapshot.disk_version, s.read_encrypted_document(&protected, "fixture-password").unwrap().disk_version);
    assert!(!note.exists());
    assert_eq!(s.resolve(&protected).unwrap(), id);
    assert_eq!(super::encryption::decrypt(&fs::read(&protected).unwrap(), "fixture-password").unwrap(), "PRIVATE_CURRENT");
    let versions = s.list_versions(&protected).unwrap();
    assert_eq!(versions.len(), 1);
    let version = f.0.join("config/versions").join(&id).join(&versions[0].filename);
    assert_eq!(super::encryption::decrypt(&fs::read(version).unwrap(), "fixture-password").unwrap(), "PRIVATE_VERSION");
    assert_eq!(s.pins().unwrap(), vec![outcome.path]);
    for entry in walkdir::WalkDir::new(&f.0).into_iter().map(|entry| entry.unwrap()).filter(|entry| entry.file_type().is_file()) {
        let bytes = fs::read(entry.path()).unwrap();
        for marker in ["PRIVATE_CURRENT", "PRIVATE_COMMENT", "PRIVATE_VERSION"] {
            assert!(!bytes.windows(marker.len()).any(|window| window == marker.as_bytes()), "Plaintext copy remained: {}", entry.path().display());
        }
    }
    let plain = PathBuf::from(s.set_encryption(&protected, "fixture-password", false, None).unwrap().path);
    assert_eq!(plain, note);
    assert_eq!(s.resolve(&plain).unwrap(), id);
    assert_eq!(fs::read_to_string(&plain).unwrap(), "PRIVATE_CURRENT");
    assert_eq!(s.read_annotations(&plain).unwrap().json, "[{\"comment\":\"PRIVATE_COMMENT\"}]");
    let versions = s.list_versions(&plain).unwrap();
    assert_eq!(s.get_version(&plain, &id, &versions[0].filename).unwrap(), "PRIVATE_VERSION");
}

#[test]
fn annotation_writes_cas_against_external_sidecar_changes() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("cas.md", "body");
    let initial = s.read_annotations(&note).unwrap();
    assert_eq!(initial.disk_version, "");
    let sidecar = f.0.join("library/cas.annotations.json");
    let first = s.write_annotations_checked(&note, &initial.document_id, "[{\"comment\":\"mine\"}]", &initial.disk_version).unwrap();
    assert_eq!(fs::read_to_string(&sidecar).unwrap(), "[{\"comment\":\"mine\"}]");
    fs::write(&sidecar, "[{\"comment\":\"external edit\"}]").unwrap();
    let error = s.write_annotations_checked(&note, &initial.document_id, "[{\"comment\":\"stale write\"}]", &first).unwrap_err();
    assert_eq!(error.code, "Conflict");
    assert_eq!(fs::read_to_string(&sidecar).unwrap(), "[{\"comment\":\"external edit\"}]");
    let reloaded = s.read_annotations(&note).unwrap();
    assert!(reloaded.json.contains("external edit"));
    assert_ne!(reloaded.disk_version, first);
    let second = s.write_annotations_checked(&note, &initial.document_id, "[{\"comment\":\"merged\"}]", &reloaded.disk_version).unwrap();
    assert_eq!(fs::read_to_string(&sidecar).unwrap(), "[{\"comment\":\"merged\"}]");
    assert_ne!(second, reloaded.disk_version);
}

#[test]
fn encrypted_annotation_writes_cas_against_external_sidecar_changes() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("sealed-cas.md", "body");
    let id = s.resolve(&note).unwrap();
    s.write_annotations(&note, &id, "[]").unwrap();
    let protected = PathBuf::from(&s.set_encryption(&note, "fixture-password", true, None).unwrap().path);
    let initial = s.read_encrypted_annotations(&protected, "fixture-password").unwrap();
    let first = s.write_encrypted_annotations_checked(&protected, &initial.document_id, "[]", "fixture-password", &initial.disk_version).unwrap();
    let sidecar = fs::read_dir(f.0.join("library")).unwrap().map(|entry| entry.unwrap().path())
        .find(|path| path.file_name().unwrap().to_string_lossy().contains("annotations")).expect("encrypted sidecar");
    let mut tampered = fs::read(&sidecar).unwrap(); tampered.extend_from_slice(b"tamper");
    fs::write(&sidecar, &tampered).unwrap();
    let error = s.write_encrypted_annotations_checked(&protected, &initial.document_id, "[]", "fixture-password", &first).unwrap_err();
    assert_eq!(error.code, "Conflict");
    assert_eq!(fs::read(&sidecar).unwrap(), tampered);
}

#[test]
fn encryption_protects_legacy_originals_and_unindexed_failed_versions() {
    use std::hash::{Hash, Hasher};
    let f = Fixture::new(); let s = f.service();
    let note = f.note("legacy-history.md", "current body");
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    note.to_string_lossy().as_ref().hash(&mut hasher);
    let legacy = f.0.join("config/versions").join(format!("{:x}", hasher.finish()));
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("20250101_000001.md"), "PRIVATE_LEGACY").unwrap();
    let id = s.resolve(&note).unwrap();
    s.fail_at("version_index");
    assert!(s.save_version(&note, &id, "PRIVATE_FAILED").is_err());
    let protected = PathBuf::from(s.set_encryption(&note, "fixture-password", true, None).unwrap().path);
    assert_eq!(s.list_versions(&protected).unwrap().len(), 1);
    let mut retained = 0;
    for entry in walkdir::WalkDir::new(&f.0).into_iter().map(|entry| entry.unwrap()).filter(|entry| entry.file_type().is_file()) {
        let bytes = fs::read(entry.path()).unwrap();
        assert!(!bytes.windows(8).any(|window| window == b"PRIVATE_"), "Plaintext backup remained: {}", entry.path().display());
        if entry.path().extension().is_some_and(|extension| extension == "encrypted") {
            let body = super::encryption::decrypt(&bytes, "fixture-password").unwrap();
            if body == "PRIVATE_LEGACY" || body == "PRIVATE_FAILED" { retained += 1; }
        }
    }
    assert_eq!(retained, 3);
}

#[test]
fn stale_document_versions_never_overwrite_external_changes() {
    let f = Fixture::new(); let s = f.service();
    let path = f.note("concurrent.md", "original");
    let read = s.read_document(&path).unwrap();
    assert_eq!(read.content, "original");
    fs::write(&path, "external edit").unwrap();
    assert_eq!(s.write_document(&path, b"local draft", &read.disk_version).unwrap_err().code, "DiskConflict");
    assert_eq!(fs::read_to_string(&path).unwrap(), "external edit");
    let current = s.read_document(&path).unwrap();
    let saved = s.write_document(&path, b"accepted edit", &current.disk_version).unwrap();
    assert_eq!(saved, s.read_document(&path).unwrap().disk_version);
    assert_eq!(s.write_document(&path, b"other stale draft", &current.disk_version).unwrap_err().code, "DiskConflict");
    assert_eq!(fs::read_to_string(&path).unwrap(), "accepted edit");
}

#[test]
fn encrypted_document_versions_reject_external_ciphertext_changes() {
    let f = Fixture::new(); let s = f.service();
    let plain = f.note("concurrent-encrypted.md", "original");
    let path = PathBuf::from(s.set_encryption(&plain, "fixture-password", true, None).unwrap().path);
    let read = s.read_encrypted_document(&path, "fixture-password").unwrap();
    fs::write(&path, super::encryption::encrypt("external", "fixture-password").unwrap()).unwrap();
    assert_eq!(s.write_encrypted_document(&path, "local draft", "fixture-password", &read.disk_version).unwrap_err().code, "DiskConflict");
    let current = s.read_encrypted_document(&path, "fixture-password").unwrap();
    assert_eq!(current.content, "external");
    let version = s.write_encrypted_document(&path, "accepted", "fixture-password", &current.disk_version).unwrap();
    assert_eq!(version, s.read_encrypted_document(&path, "fixture-password").unwrap().disk_version);
}

#[test]
fn a_change_while_preparing_an_atomic_save_is_not_overwritten() {
    let f = Fixture::new(); let s = f.service();
    let path = f.note("staging.md", "original");
    let snapshot = s.read_document(&path).unwrap();
    let changed = path.clone();
    s.hook_at("document_commit", move || fs::write(changed, "external while preparing").unwrap());
    assert_eq!(s.write_document(&path, b"local draft", &snapshot.disk_version).unwrap_err().code, "DiskConflict");
    assert_eq!(fs::read_to_string(&path).unwrap(), "external while preparing");
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn recovery_copy_preserves_failed_drafts_annotations_assets_and_the_original() {
    let f = Fixture::new(); let s = f.service();
    let source = f.note("copy.md", "external current");
    f.note("images/pic.png", "fixture asset");
    let id = s.resolve(&source).unwrap();
    s.write_annotations(&source, &id, "[{\"comment\":\"old annotation\"}]").unwrap();
    let target = f.0.join("destination/saved.md");
    let result = s.copy_document(&source, &target, "draft ![](images/pic.png)", Some("[{\"comment\":\"failed annotation draft\"}]"), None, false).unwrap();
    assert_eq!(fs::read_to_string(&source).unwrap(), "external current");
    assert_eq!(fs::read_to_string(&target).unwrap(), "draft ![](images/pic.png)");
    assert_eq!(fs::read_to_string(f.0.join("destination/images/pic.png")).unwrap(), "fixture asset");
    assert_ne!(result.document_id.unwrap(), id);
    assert_eq!(s.read_annotations(&target).unwrap().json, "[{\"comment\":\"failed annotation draft\"}]");
    assert_eq!(result.snapshot.unwrap().disk_version, s.read_document(&target).unwrap().disk_version);
    assert!(s.copy_document(&source, &target, "must not overwrite", None, None, false).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "draft ![](images/pic.png)");
}

#[test]
fn recovery_copy_of_an_encrypted_draft_never_writes_plaintext() {
    let f = Fixture::new(); let s = f.service();
    let source = f.note("copy.md", "original");
    let source = PathBuf::from(s.set_encryption(&source, "fixture-password", true, None).unwrap().path);
    let target = f.0.join("destination/saved.md.encrypted");
    let copied = s.copy_document(&source, &target, "PRIVATE_DRAFT", Some("[{\"comment\":\"PRIVATE_COMMENT\"}]"), Some("fixture-password"), false).unwrap();
    assert_eq!(s.read_encrypted_document(&target, "fixture-password").unwrap().content, "PRIVATE_DRAFT");
    assert_eq!(s.read_encrypted_annotations(&target, "fixture-password").unwrap().json, "[{\"comment\":\"PRIVATE_COMMENT\"}]");
    assert!(s.copy_document(&source, &f.0.join("destination/plain.md"), "PRIVATE_DRAFT", None, Some("fixture-password"), false).is_err());
    assert!(source.exists());
    assert_eq!(copied.snapshot.unwrap().content, "PRIVATE_DRAFT");
    for entry in walkdir::WalkDir::new(f.0.join("destination")).into_iter().map(|entry| entry.unwrap()).filter(|entry| entry.file_type().is_file()) {
        assert!(!fs::read(entry.path()).unwrap().windows(8).any(|bytes| bytes == b"PRIVATE_"));
    }
}

#[test]
fn encryption_conversion_respects_the_last_saved_disk_version() {
    let f = Fixture::new(); let s = f.service();
    let path = f.note("conversion.md", "opened body");
    let snapshot = s.read_document(&path).unwrap();
    fs::write(&path, "external body").unwrap();
    assert_eq!(s.set_encryption(&path, "fixture-password", true, Some(&snapshot.disk_version)).unwrap_err().code, "DiskConflict");
    assert_eq!(fs::read_to_string(&path).unwrap(), "external body");
    assert!(!path.with_file_name("conversion.md.encrypted").exists());
}

#[test]
fn failed_recovery_copy_rolls_back_without_deleting_the_source() {
    for stage in ["prepared", "after_metadata", "after_body", "catalog_commit"] {
        let f = Fixture::new(); let s = f.service();
        let source = f.note("copy-fail.md", "source body");
        f.note("images/pic.png", "asset bytes");
        let target = f.0.join("destination/copy.md");
        s.fail_at(stage);
        assert!(s.copy_document(&source, &target, "draft ![](images/pic.png)", Some("[]"), None, false).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), "source body");
        assert!(!target.exists());
        assert!(!f.0.join("destination/images/pic.png").exists());
        assert!(s.recoveries().unwrap().is_empty());
    }
}

#[test]
fn a_deleted_source_can_still_recover_its_in_memory_draft_and_annotations() {
    let f = Fixture::new(); let s = f.service();
    let source = f.note("deleted.md", "source body");
    let id = s.resolve(&source).unwrap();
    s.write_annotations(&source, &id, "[{\"comment\":\"retained\"}]").unwrap();
    fs::remove_file(&source).unwrap();
    let target = f.0.join("destination/recovery.md");
    s.copy_document(&source, &target, "unsaved draft", None, None, false).unwrap();
    assert_eq!(s.read_annotations(&target).unwrap().json, "[{\"comment\":\"retained\"}]");
    assert_eq!(fs::read_to_string(&target).unwrap(), "unsaved draft");
    assert!(!source.exists());
}

#[test]
fn plaintext_save_cannot_overwrite_an_encrypted_document_or_pdf() {
    let f = Fixture::new(); let s = f.service();
    for name in ["protected.md.encrypted", "binary.pdf"] {
        let path = f.note(name, "untouched bytes");
        assert!(s.write_document(&path, b"plaintext", "").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "untouched bytes");
    }
}

#[test]
fn unrelated_encrypted_documents_remain_writable_during_recovery() {
    let f = Fixture::new(); let s = f.service();
    let source = f.note("pending.md", "pending");
    let other = f.note("other.md", "other");
    let protected = PathBuf::from(s.set_encryption(&other, "fixture-password", true, None).unwrap().path);
    s.fail_at("cleanup");
    s.rename(&source, "new", false).unwrap();
    assert_eq!(s.recoveries().unwrap().len(), 1);
    let version = s.read_encrypted_document(&protected, "fixture-password").unwrap().disk_version;
    s.write_encrypted_document(&protected, "updated unrelated", "fixture-password", &version).unwrap();
    assert_eq!(s.read_encrypted_document(&protected, "fixture-password").unwrap().content, "updated unrelated");
}

#[test]
fn encrypted_history_reads_saves_and_restores_without_plaintext_files() {
    let f = Fixture::new(); let s = f.service();
    let plain = f.note("history.md", "PRIVATE_CURRENT");
    let id = s.resolve(&plain).unwrap();
    s.save_version(&plain, &id, "PRIVATE_OLD").unwrap();
    let path = PathBuf::from(s.set_encryption(&plain, "fixture-password", true, None).unwrap().path);
    let old = s.list_versions(&path).unwrap().pop().unwrap();
    assert!(s.get_version(&path, &id, &old.filename).is_err());
    assert!(s.get_encrypted_version(&path, &id, &old.filename, "wrong").is_err());
    assert_eq!(s.get_encrypted_version(&path, &id, &old.filename, "fixture-password").unwrap(), "PRIVATE_OLD");
    let new = s.save_encrypted_version(&path, &id, "PRIVATE_NEW", "fixture-password").unwrap();
    assert_eq!(s.save_encrypted_version(&path, &id, "PRIVATE_NEW", "fixture-password").unwrap().filename, new.filename);
    let before = fs::read(&path).unwrap();
    let version = s.read_encrypted_document(&path, "fixture-password").unwrap().disk_version;
    assert!(s.write_encrypted_document(&path, "must not write", "wrong", &version).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    s.restore_encrypted_version(&path, &id, &old.filename, "fixture-password").unwrap();
    assert_eq!(s.read_encrypted_document(&path, "fixture-password").unwrap().content, "PRIVATE_OLD");
    assert_eq!(s.list_versions(&path).unwrap().len(), 3);
    for entry in walkdir::WalkDir::new(&f.0).into_iter().map(|entry| entry.unwrap()).filter(|entry| entry.file_type().is_file()) {
        let bytes = fs::read(entry.path()).unwrap();
        assert!(!bytes.windows(8).any(|window| window == b"PRIVATE_"), "Plaintext remained: {}", entry.path().display());
    }
}

#[test]
fn legacy_encrypted_notes_migrate_their_existing_plaintext_annotations() {
    let f = Fixture::new(); let s = f.service();
    let path = f.note("legacy.md.encrypted", "");
    fs::write(&path, super::encryption::encrypt("private body", "fixture-password").unwrap()).unwrap();
    let sidecar = path.with_file_name("legacy.md.annotations.json");
    fs::write(&sidecar, "[{\"comment\":\"legacy comment\"}]").unwrap();
    s.set_encryption(&path, "fixture-password", true, None).unwrap();
    assert!(!sidecar.exists(), "Legacy plaintext sidecar must not be stranded");
    assert_eq!(s.read_encrypted_annotations(&path, "fixture-password").unwrap().json, "[{\"comment\":\"legacy comment\"}]");
}

#[test]
fn encrypted_annotation_writes_require_the_password_and_never_create_plaintext_sidecars() {
    let f = Fixture::new(); let s = f.service();
    let plain = f.note("annotations.md", "body");
    let path = PathBuf::from(s.set_encryption(&plain, "fixture-password", true, None).unwrap().path);
    let id = s.resolve(&path).unwrap();
    assert!(s.write_annotations(&path, &id, "[]").is_err());
    assert!(s.write_encrypted_annotations(&path, &id, "[{\"comment\":\"private draft\"}]", "wrong").is_err());
    s.write_encrypted_annotations(&path, &id, "[{\"comment\":\"private draft\"}]", "fixture-password").unwrap();
    assert!(s.read_annotations(&path).is_err());
    assert!(s.read_encrypted_annotations(&path, "wrong").is_err());
    assert_eq!(s.read_encrypted_annotations(&path, "fixture-password").unwrap().json, "[{\"comment\":\"private draft\"}]");
    assert!(!path.with_file_name("annotations.md.annotations.json").exists());
}

#[test]
fn encryption_rejects_changed_sources_before_committing_and_preserves_external_edits() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("race.md", "before");
    let changed = note.clone();
    s.hook_at("after_body", move || fs::write(changed, "external edit").unwrap());
    let error = s.set_encryption(&note, "fixture-password", true, None).unwrap_err();
    assert_eq!(error.code, "Conflict");
    assert_eq!(fs::read_to_string(&note).unwrap(), "external edit");
    assert!(!note.with_file_name("race.md.encrypted").exists());
    assert!(s.recoveries().unwrap().is_empty());
}

#[test]
fn encryption_collision_and_wrong_password_never_overwrite_an_existing_document() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("collision.md", "plain source");
    let target = f.note("collision.md.encrypted", "occupied");
    assert_eq!(s.set_encryption(&note, "fixture-password", true, None).unwrap_err().code, "Conflict");
    assert_eq!(fs::read_to_string(&note).unwrap(), "plain source");
    assert_eq!(fs::read_to_string(&target).unwrap(), "occupied");
    fs::remove_file(&target).unwrap();
    let encrypted = PathBuf::from(s.set_encryption(&note, "fixture-password", true, None).unwrap().path);
    let before = fs::read(&encrypted).unwrap();
    assert!(s.set_encryption(&encrypted, "incorrect", false, None).is_err());
    assert_eq!(fs::read(&encrypted).unwrap(), before);
    assert!(!note.exists());
}

#[test]
fn encryption_failures_roll_back_and_committed_cleanup_can_be_retried() {
    for stage in ["encryption_stage", "prepared", "after_body", "catalog_commit", "cleanup"] {
        let f = Fixture::new(); let s = f.service();
        let note = f.note("failure.md", "private body");
        let id = s.resolve(&note).unwrap();
        s.write_annotations(&note, &id, "[{\"comment\":\"private comment\"}]").unwrap();
        s.fail_at(stage);
        let result = s.set_encryption(&note, "fixture-password", true, None);
        if stage == "cleanup" {
            let outcome = result.unwrap();
            assert!(outcome.warnings.iter().any(|warning| warning.code == "RecoveryPending"));
            assert!(note.exists());
            let recovery = s.recoveries().unwrap().pop().unwrap();
            assert!(recovery.committed);
            assert_eq!(s.write_document(&note, b"must not write", "").unwrap_err().code, "RecoveryRequired");
            s.retry_recovery(&recovery.transaction_id).unwrap();
            assert!(!note.exists());
            assert!(Path::new(&outcome.path).exists());
        } else {
            assert!(result.is_err());
            assert_eq!(fs::read_to_string(&note).unwrap(), "private body");
            assert_eq!(s.resolve(&note).unwrap(), id);
            assert!(s.recoveries().unwrap().is_empty());
        }
        assert!(!fs::read_dir(note.parent().unwrap()).unwrap().map(|entry| entry.unwrap()).any(|entry| entry.file_name().to_string_lossy().starts_with(".miaoyan-encryption-")));
    }
}

#[test]
fn rename_move_folder_keep_identity_history_annotations_and_pin() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("old.md", "current");
    fs::write(note.with_file_name("old.annotations.json"), "[{\"id\":\"a\"}]").unwrap();
    let id = s.resolve(&note).unwrap();
    s.toggle_pin(&note).unwrap();
    s.save_version(&note, &id, "history").unwrap();
    let renamed = s.rename(&note, "new", false).unwrap();
    let renamed = PathBuf::from(renamed.path);
    assert_eq!(fs::read_to_string(renamed.with_file_name("new.annotations.json")).unwrap(), "[{\"id\":\"a\"}]");
    let moved = s.move_note(&renamed, &f.0.join("destination"), false).unwrap();
    let folder = s.rename_folder(&f.0.join("destination"), "renamed-folder", false).unwrap();
    let final_path = PathBuf::from(folder.path).join("new.md");
    assert_eq!(s.resolve(&final_path).unwrap(), id);
    assert_eq!(s.read_annotations(&final_path).unwrap().document_id, id);
    assert_eq!(s.read_annotations(&final_path).unwrap().json, "[{\"id\":\"a\"}]");
    let versions = s.list_versions(&final_path).unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(s.get_version(&final_path, &id, &versions[0].filename).unwrap(), "history");
    assert_eq!(s.pins().unwrap(), vec![final_path.to_string_lossy().into_owned()]);
    assert!(!Path::new(&moved.path).exists());
    assert_eq!(f.service().resolve(&final_path).unwrap(), id);
}

#[test]
fn old_path_reuse_cannot_inherit_or_accept_late_annotations() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("old.md", "first"); let id = s.resolve(&note).unwrap();
    s.write_annotations(&note, &id, "[{\"id\":\"old\"}]").unwrap();
    s.save_version(&note, &id, "old history").unwrap(); s.toggle_pin(&note).unwrap();
    s.rename(&note, "new", false).unwrap();
    s.create_note(&f.0.join("library"), "old").unwrap();
    let fresh = s.read_annotations(&note).unwrap();
    assert_ne!(fresh.document_id, id); assert_eq!(fresh.json, "[]");
    assert!(s.list_versions(&note).unwrap().is_empty());
    assert_eq!(s.write_annotations(&note, &id, "[]").unwrap_err().code, "IdentityMismatch");
    assert_eq!(s.delete_annotations(&note, &id).unwrap_err().code, "IdentityMismatch");
    s.delete(&note).unwrap(); s.create_note(&f.0.join("library"), "old").unwrap();
    assert_ne!(s.resolve(&note).unwrap(), fresh.document_id);
}

#[test]
fn reused_path_can_write_new_annotations_after_legacy_metadata_moved() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("legacy.md", "old document");
    fs::write(note.with_file_name("legacy.annotations.json"), "[{\"id\":\"old\"}]").unwrap();
    let old_id = s.resolve(&note).unwrap();
    let moved = s.rename(&note, "moved", false).unwrap();
    s.create_note(&f.0.join("library"), "legacy").unwrap();
    let new_id = s.resolve(&note).unwrap();
    assert_ne!(old_id, new_id);
    s.write_annotations(&note, &new_id, "[{\"id\":\"new\"}]").unwrap();
    s.write_annotations(&note, &new_id, "[{\"id\":\"updated\"}]").unwrap();
    assert_eq!(s.read_annotations(Path::new(&moved.path)).unwrap().json, "[{\"id\":\"old\"}]");
    assert_eq!(s.read_annotations(&note).unwrap().json, "[{\"id\":\"updated\"}]");
}

#[test]
fn newly_written_sidecars_move_with_their_parent_folder() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("folder/note.md", "document");
    let id = s.resolve(&note).unwrap();
    s.write_annotations(&note, &id, "[{\"id\":\"keep\"}]").unwrap();
    let moved = s.rename_folder(&f.0.join("library/folder"), "moved", false).unwrap();
    assert_eq!(s.read_annotations(&PathBuf::from(moved.path).join("note.md")).unwrap().json, "[{\"id\":\"keep\"}]");
}

#[test]
fn document_writes_do_not_recreate_removed_paths() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("removed.md", "original");
    fs::remove_file(&note).unwrap();
    assert!(s.write_document(&note, b"stale content", "").is_err());
    assert!(!note.exists());
}

#[test]
fn recovery_locks_block_body_writes_but_leave_unrelated_documents_writable() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("old.md", "original");
    let unrelated = f.note("unrelated.md", "other");
    s.resolve(&note).unwrap();
    s.hook_at("after_body", { let p = note.clone(); move || fs::write(&p, "external").unwrap() });
    s.fail_at("catalog_commit");
    assert_eq!(s.rename(&note, "new", false).unwrap_err().code, "RecoveryRequired");
    assert_eq!(s.write_document(&note, b"stale content", "").unwrap_err().code, "RecoveryRequired");
    assert_eq!(s.write_document(&note.with_file_name("new.md"), b"stale content", "").unwrap_err().code, "RecoveryRequired");
    s.write_document(&unrelated, b"updated other", &s.read_document(&unrelated).unwrap().disk_version).unwrap();
    assert_eq!(fs::read_to_string(&note).unwrap(), "external");
    assert_eq!(fs::read_to_string(note.with_file_name("new.md")).unwrap(), "original");
    assert_eq!(fs::read_to_string(&unrelated).unwrap(), "updated other");
}

#[test]
fn ambiguous_and_corrupt_sidecars_are_preserved() {
    let f = Fixture::new(); let s = f.service();
    let note = f.note("same.md", "md"); f.note("same.html", "html");
    let side = note.with_file_name("same.annotations.json"); fs::write(&side, "[]").unwrap();
    let err = s.read_annotations(&note).unwrap_err(); assert_eq!(err.code, "Conflict"); assert!(err.paths.len() >= 3);
    assert_eq!(fs::read_to_string(&side).unwrap(), "[]");
    let broken = f.note("broken.md", "x"); let side = broken.with_file_name("broken.annotations.json");
    fs::write(&side, "{broken").unwrap();
    assert_eq!(s.rename(&broken, "fixed", false).unwrap_err().code, "InvalidMetadata");
    assert_eq!(fs::read_to_string(&side).unwrap(), "{broken"); assert!(broken.exists());
}

#[test]
fn versions_are_unique_bounded_indexed_and_failure_preserves_twenty() {
    let f = Fixture::new(); let s = f.service(); let note = f.note("v.md", "current"); let id = s.resolve(&note).unwrap();
    for n in 0..25 { s.save_version(&note, &id, &format!("v{n}")).unwrap(); }
    let entries = s.list_versions(&note).unwrap(); assert_eq!(entries.len(), 20);
    assert_eq!(s.get_version(&note, &id, &entries[0].filename).unwrap(), "v24");
    let names: std::collections::HashSet<_> = entries.iter().map(|v| &v.filename).collect(); assert_eq!(names.len(), 20);
    s.fail_at("version_index"); assert!(s.save_version(&note, &id, "failed").is_err());
    assert_eq!(s.list_versions(&note).unwrap().iter().map(|v| &v.filename).collect::<Vec<_>>(), entries.iter().map(|v| &v.filename).collect::<Vec<_>>());
    assert!(s.get_version(&note, &id, "../v.md").is_err());
    assert!(s.get_version(&note, "wrong", &entries[0].filename).is_err());
    let dir = f.0.join("config/versions").join(&id); fs::write(dir.join("unlisted.md"), "secret").unwrap();
    assert!(s.get_version(&note, &id, "unlisted.md").is_err());
    s.restore_version(&note, &id, &entries[1].filename).unwrap();
    assert_eq!(fs::read_to_string(&note).unwrap(), "v23");
    let latest = s.list_versions(&note).unwrap(); assert_eq!(s.get_version(&note, &id, &latest[0].filename).unwrap(), "current");
}

#[test]
fn leaf_names_and_compound_extensions_are_not_silently_repaired() {
    let f = Fixture::new(); let s = f.service();
    for name in ["", " ", ".", "..", "../escape", "x/y", "x\\y", "C:x", "NUL", "con.md", "a.", "a ", "a\0b", "a\nb", "a?b", "COM1.txt"] {
        assert!(s.create_note(&f.0.join("library"), name).is_err(), "{name:?}");
        assert!(s.create_folder(&f.0.join("library"), name).is_err(), "{name:?}");
    }
    assert!(s.create_note(&f.0.join("library"), "empty.md.encrypted").is_err());
    let note = f.note("old.md.encrypted", "synthetic ciphertext");
    let result = s.rename(&note, "new", false).unwrap();
    assert!(result.path.ends_with("new.md.encrypted")); assert!(!result.warnings.is_empty());
    let path = PathBuf::from(result.path); let id = s.resolve(&path).unwrap();
    assert!(s.save_version(&path, &id, "plaintext").is_err());
    assert!(s.restore_version(&path, &id, "any.md").is_err());
}

#[test]
fn create_never_overwrites_a_racing_creator() {
    let f = Fixture::new(); let s = f.service(); let folder = f.0.join("library");
    s.hook_at("before_body", { let p = folder.join("race.md"); move || fs::write(&p, "external").unwrap() });
    assert!(s.create_note(&folder, "race").is_err());
    assert_eq!(fs::read_to_string(folder.join("race.md")).unwrap(), "external");
}

#[test]
fn stage_failures_restore_originals_and_block_on_rollback_occupation() {
    for stage in ["prepared", "after_metadata", "before_body", "after_body", "catalog_commit"] {
        let f = Fixture::new(); let s = f.service(); let note = f.note("old.md", "original"); let id = s.resolve(&note).unwrap();
        s.write_annotations(&note, &id, "[{\"id\":\"keep\"}]").unwrap();
        s.fail_at(stage); assert!(s.rename(&note, "new", false).is_err(), "{stage}");
        assert_eq!(fs::read_to_string(&note).unwrap(), "original", "{stage}");
        assert!(!note.with_file_name("new.md").exists());
        assert_eq!(s.read_annotations(&note).unwrap().json, "[{\"id\":\"keep\"}]");
    }
    let f = Fixture::new(); let s = f.service(); let note = f.note("old.md", "original"); s.resolve(&note).unwrap();
    s.hook_at("after_body", { let p = note.clone(); move || fs::write(&p, "external").unwrap() });
    s.fail_at("catalog_commit"); let err = s.rename(&note, "new", false).unwrap_err();
    assert_eq!(err.code, "RecoveryRequired"); assert!(err.paths.len() >= 2);
    assert_eq!(fs::read_to_string(&note).unwrap(), "external");
    assert_eq!(fs::read_to_string(note.with_file_name("new.md")).unwrap(), "original");
    assert_eq!(f.service().resolve(&note).unwrap_err().code, "RecoveryRequired");
    let recoveries = s.recoveries().unwrap(); assert_eq!(recoveries.len(), 1);
    fs::rename(&note, note.with_file_name("external-preserved.md")).unwrap();
    s.retry_recovery(&recoveries[0].transaction_id).unwrap();
    assert_eq!(fs::read_to_string(&note).unwrap(), "original");
    assert!(s.recoveries().unwrap().is_empty());
}

#[test]
fn post_commit_cleanup_failure_reports_success_and_retries() {
    let f = Fixture::new(); let s = f.service(); let note = f.note("old.md", "original"); let id = s.resolve(&note).unwrap();
    s.write_annotations(&note, &id, "[]").unwrap(); s.fail_at("cleanup");
    let result = s.rename(&note, "new", false).unwrap(); assert!(!result.warnings.is_empty());
    assert!(Path::new(&result.path).exists());
    let recovery = s.recoveries().unwrap().remove(0); assert!(recovery.committed);
    s.retry_recovery(&recovery.transaction_id).unwrap(); assert_eq!(s.resolve(Path::new(&result.path)).unwrap(), id);
}

#[test]
fn attachments_copy_only_real_references_and_leave_shared_originals() {
    let f = Fixture::new(); let s = f.service();
    let text = "```mermaid\ngraph LR; A-->B\n```\n![reference][pic]\n\n[pic]: images/a.png \"title\"\n\n<IMG alt='>' SRC='images/b&amp;c.png'>\n\n`![fake](images/fake.png)`\n\n```md\n![fake](images/fake2.png)\n```\n";
    let note = f.note("a.md", text); f.note("other.md", "![](images/a.png)");
    f.note("images/a.png", "image a"); f.note("images/b&c.png", "image b"); f.note("images/unused.png", "unused");
    let id = s.resolve(&note).unwrap(); s.save_version(&note, &id, "![history](images/history.png)").unwrap(); f.note("images/history.png", "old image");
    let moved = s.move_note(&note, &f.0.join("destination"), false).unwrap();
    assert_eq!(fs::read_to_string(&moved.path).unwrap(), text);
    for name in ["a.png", "b&c.png", "history.png"] { assert!(f.0.join("library/images").join(name).exists()); assert!(f.0.join("destination/images").join(name).exists()); }
    assert!(!f.0.join("destination/images/unused.png").exists());
    assert!(moved.warnings.is_empty());
}

#[test]
fn missing_dynamic_and_escaping_attachments_require_confirmation() {
    let f = Fixture::new(); let s = f.service(); let note = f.note("a.md", "![](missing.png)\n<img :src=\"dynamic\">\n![](../outside.png)");
    let err = s.move_note(&note, &f.0.join("destination"), false).unwrap_err(); assert_eq!(err.code, "ConfirmationRequired"); assert!(err.warnings.len() >= 3); assert!(note.exists());
    let result = s.move_note(&note, &f.0.join("destination"), true).unwrap(); assert!(result.warnings.len() >= 3);
    assert!(!f.0.join("outside.png").exists());
}

#[test]
fn malformed_catalog_fails_without_panicking_and_scans_never_touch_it() {
    let f = Fixture::new(); let note = f.note("a.md", "x");
    let catalog = f.0.join("config/document-catalog.json"); fs::write(&catalog, "not JSON").unwrap();
    let s = f.service(); assert_eq!(s.resolve(&note).unwrap_err().code, "InvalidCatalog");
    assert_eq!(super::storage::scan_notes_with_progress(&f.0.join("library"), |_| {}, &|| false).len(), 1);
    assert_eq!(fs::read_to_string(&catalog).unwrap(), "not JSON");
    let f = Fixture::new(); f.note("a.md", "x"); let _s = f.service();
    super::storage::scan_notes_with_progress(&f.0.join("library"), |_| {}, &|| false); assert_eq!(fs::read_dir(f.0.join("config")).unwrap().count(), 0);
}

#[test]
fn folder_delete_retires_descendants_without_prefix_confusion() {
    let f = Fixture::new(); let s = f.service(); let a = f.note("a/n.md", "a"); let ab = f.note("ab/n.md", "ab");
    let first = s.resolve(&a).unwrap(); let second = s.resolve(&ab).unwrap(); s.toggle_pin(&a).unwrap(); s.toggle_pin(&ab).unwrap();
    s.delete(&a.parent().unwrap()).unwrap(); assert!(ab.exists()); assert!(!a.exists());
    assert_eq!(s.resolve(&ab).unwrap(), second); assert_eq!(s.pins().unwrap(), vec![ab.to_string_lossy().into_owned()]);
    fs::create_dir(a.parent().unwrap()).unwrap(); s.create_note(a.parent().unwrap(), "n").unwrap(); assert_ne!(s.resolve(&a).unwrap(), first);
    assert_eq!(fs::read_dir(f.0.join("trash")).unwrap().count(), 1);
}

#[test]
fn created_folder_paths_stay_in_plain_spelling() {
    let f = Fixture::new(); let s = f.service();
    let parent = f.0.join("library");
    let path = s.create_folder(&parent, "plain-child").unwrap();
    assert!(path.ends_with("library\\plain-child"), "unexpected created path: {path}");
    assert!(!path.contains(r"\\?\"), "extended-length prefix leaked into the payload: {path}");
}
