//! Lazy, config-injected document identity and metadata transactions.
//! Scanners intentionally never call this service. Paths remain the frontend note IDs.
use std::{collections::BTreeMap, fs, hash::{Hash, Hasher}, io, path::{Component, Path, PathBuf}, sync::{Arc, Mutex}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use super::{attachments, encryption, storage};

type Result<T> = std::result::Result<T, PersistenceError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Warning { pub code: String, pub path: String, pub message: String }
impl Warning {
    pub(super) fn new(code: &str, path: &Path, message: impl Into<String>) -> Self {
        Self { code: code.into(), path: display(path), message: message.into() }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistenceError {
    pub code: String,
    pub message: String,
    pub paths: Vec<String>,
    pub recovery_id: Option<String>,
    pub warnings: Vec<Warning>,
}
impl PersistenceError {
    pub(crate) fn new(code: &str, message: impl Into<String>, paths: &[&Path]) -> Self {
        Self { code: code.into(), message: message.into(), paths: paths.iter().map(|p| display(p)).collect(), recovery_id: None, warnings: Vec::new() }
    }
    fn io(path: &Path, error: io::Error) -> Self { Self::new("Io", error.to_string(), &[path]) }
}
impl std::fmt::Display for PersistenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.code, self.message) }
}
impl std::error::Error for PersistenceError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationRead { pub document_id: String, pub json: String, #[serde(default)] pub disk_version: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionEntry { pub document_id: String, pub timestamp: String, pub filename: String, pub size: u64 }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MutationOutcome {
    pub document_id: Option<String>,
    pub path: String,
    pub warnings: Vec<Warning>,
    #[serde(skip)]
    pub snapshot: Option<crate::models::NoteContent>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryInfo { pub transaction_id: String, pub kind: String, pub paths: Vec<String>, pub committed: bool }

#[derive(Clone, Serialize, Deserialize)]
struct Resource { path: PathBuf, sha256: String }
#[derive(Clone, Serialize, Deserialize)]
struct Version { entry: VersionEntry, sha256: String }
#[derive(Clone, Serialize, Deserialize)]
struct Document {
    active_path: Option<PathBuf>,
    #[serde(default)]
    display_path: Option<PathBuf>,
    retired_paths: Vec<PathBuf>,
    annotations: Option<Resource>,
    versions: Vec<Version>, // insertion order, not wall-clock order
    pinned: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Claim { source: PathBuf, document_id: String, sha256: String, destination: PathBuf }
#[derive(Clone, Serialize, Deserialize)]
struct Catalog {
    schema: u32,
    documents: BTreeMap<String, Document>,
    legacy_claims: Vec<Claim>,
    last_transaction: Option<String>,
}
impl Default for Catalog {
    fn default() -> Self { Self { schema: 1, documents: BTreeMap::new(), legacy_claims: Vec::new(), last_transaction: None } }
}
#[derive(Clone, Serialize, Deserialize)]
struct Action {
    source: PathBuf,
    target: PathBuf,
    sha256: String,
    copy: bool,
    done: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Journal {
    id: String,
    kind: String,
    actions: Vec<Action>,
    cleanup: Vec<Resource>,
    #[serde(default)]
    staged: Vec<Resource>,
    trash_path: Option<PathBuf>,
    result_path: PathBuf,
}
impl Journal {
    fn new(kind: &str, result_path: &Path) -> Self {
        Self { id: uuid::Uuid::new_v4().to_string(), kind: kind.into(), actions: Vec::new(), cleanup: Vec::new(), staged: Vec::new(), trash_path: None, result_path: result_path.into() }
    }
    fn paths(&self) -> Vec<String> {
        let mut paths: Vec<_> = self.actions.iter().flat_map(|a| [display(&a.source), display(&a.target)]).collect();
        paths.extend(self.cleanup.iter().map(|resource| display(&resource.path)));
        paths.push(display(&self.result_path));
        if let Some(path) = &self.trash_path { paths.push(display(path)); }
        paths
    }
    fn recovery_error(&self, message: impl Into<String>) -> PersistenceError {
        PersistenceError { code: "RecoveryRequired".into(), message: message.into(), paths: self.paths(), recovery_id: Some(self.id.clone()), warnings: Vec::new() }
    }
}

pub trait TrashAdapter: Send + Sync { fn recycle(&self, path: &Path) -> io::Result<()>; }
struct NativeTrash;
impl TrashAdapter for NativeTrash {
    fn recycle(&self, path: &Path) -> io::Result<()> { trash::delete(path).map_err(io::Error::other) }
}

pub struct Persistence {
    config_dir: PathBuf,
    lock: Mutex<()>,
    trash: Arc<dyn TrashAdapter>,
    #[cfg(test)]
    pub(super) faults: Mutex<Vec<String>>,
    #[cfg(test)]
    pub(super) hooks: Mutex<BTreeMap<String, Box<dyn FnOnce() + Send>>>,
}
impl Persistence {
    /// No IO at construction: a damaged catalog must never panic during app startup.
    pub fn new(config_dir: PathBuf) -> Self { Self::with_trash(config_dir, Arc::new(NativeTrash)) }
    pub fn with_trash(config_dir: PathBuf, trash: Arc<dyn TrashAdapter>) -> Self {
        Self { config_dir, trash, lock: Mutex::new(()), #[cfg(test)] faults: Mutex::new(Vec::new()), #[cfg(test)] hooks: Mutex::new(BTreeMap::new()) }
    }
    fn guard(&self) -> Result<std::sync::MutexGuard<'_, ()>> {
        self.lock.lock().map_err(|_| PersistenceError::new("Unavailable", "Persistence lock poisoned", &[]))
    }
    fn checkpoint(&self, _stage: &str) -> Result<()> {
        #[cfg(test)] {
            if let Some(hook) = self.hooks.lock().unwrap().remove(_stage) { hook(); }
            let mut faults = self.faults.lock().unwrap();
            if let Some(index) = faults.iter().position(|s| s == _stage) {
                faults.remove(index); return Err(PersistenceError::new("Io", format!("Injected failure at {_stage}"), &[]));
            }
        }
        Ok(())
    }
    fn catalog_path(&self) -> PathBuf { self.config_dir.join("document-catalog.json") }
    fn journal_path(&self) -> PathBuf { self.config_dir.join("document-transaction.json") }
    fn versions_dir(&self, id: &str) -> PathBuf { self.config_dir.join("versions").join(id) }
    fn load(&self) -> Result<Catalog> {
        let catalog: Catalog = match read_optional(&self.catalog_path())? {
            Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| PersistenceError::new("InvalidCatalog", e.to_string(), &[&self.catalog_path()]))?,
            None => Catalog::default(),
        };
        if catalog.schema != 1 { return Err(PersistenceError::new("InvalidCatalog", "Unsupported catalog schema", &[&self.catalog_path()])); }
        let mut active: Vec<&Path> = Vec::new();
        for (id, doc) in &catalog.documents {
            if uuid::Uuid::parse_str(id).is_err() { return Err(PersistenceError::new("InvalidCatalog", "Invalid document UUID", &[&self.catalog_path()])); }
            if let Some(path) = &doc.active_path {
                if !path.is_absolute() || active.iter().any(|p| same_path(p, path)) { return Err(PersistenceError::new("InvalidCatalog", "Duplicate or relative active path", &[path])); }
                active.push(path);
            }
            for version in &doc.versions {
                if version.entry.document_id != *id || validate_leaf(&version.entry.filename).is_err() { return Err(PersistenceError::new("InvalidCatalog", "Invalid version membership", &[&self.catalog_path()])); }
            }
        }
        Ok(catalog)
    }
    fn journal(&self) -> Result<Option<Journal>> {
        read_optional(&self.journal_path())?.map(|bytes| serde_json::from_slice(&bytes).map_err(|e| PersistenceError::new("InvalidCatalog", format!("Damaged recovery journal: {e}"), &[&self.journal_path()]))).transpose()
    }
    fn available(&self) -> Result<()> {
        if let Some(journal) = self.journal()? {
            // A single small journal also blocks unrelated persistence mutations until
            // recovered; this avoids applying a stale whole-catalog transaction snapshot.
            return Err(journal.recovery_error("Retry the pending transaction before writing document metadata"));
        }
        Ok(())
    }
    fn store<T: Serialize>(&self, path: &Path, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| PersistenceError::new("InvalidMetadata", e.to_string(), &[path]))?;
        check_chain(path)?;
        if let Err(error) = storage::write_atomic(path, &bytes) {
            // The existing atomic writer may report post-commit backup cleanup failure.
            // Never roll back a transaction whose exact commit is already visible.
            if regular_bytes(path).ok().as_deref() != Some(bytes.as_slice()) { return Err(PersistenceError::io(path, error)); }
        }
        Ok(())
    }
    fn store_catalog(&self, catalog: &Catalog) -> Result<()> { self.store(&self.catalog_path(), catalog) }
    fn store_journal(&self, journal: &Journal) -> Result<()> { self.store(&self.journal_path(), journal) }

    pub fn read_document(&self, path: &Path) -> Result<crate::models::NoteContent> {
        ensure_plaintext(path)?;
        self.document_available(path)?;
        let bytes = regular_bytes(path)?;
        let disk_version = digest(&bytes);
        let content = String::from_utf8(bytes).map_err(|error| PersistenceError::new("InvalidMetadata", error.to_string(), &[path]))?;
        Ok(crate::models::NoteContent { id: display(path), content, disk_version })
    }

    pub fn write_document(&self, path: &Path, content: &[u8], expected_version: &str) -> Result<String> {
        let _guard = self.guard()?;
        ensure_plaintext(path)?;
        self.document_available(path)?;
        self.check_document_version(path, expected_version)?;
        self.save_checked(path, content, expected_version)?;
        Ok(digest(content))
    }

    fn save_checked(&self, path: &Path, content: &[u8], expected_version: &str) -> Result<()> {
        storage::write_atomic_checked(path, content, |candidate| {
            self.checkpoint("document_commit").map_err(io::Error::other)?;
            self.check_document_version(candidate, expected_version).map_err(|error| {
                let kind = if error.code == "DiskConflict" { io::ErrorKind::WouldBlock } else { io::ErrorKind::Other };
                io::Error::new(kind, error)
            })
        }).map_err(|error| {
            if error.kind() == io::ErrorKind::WouldBlock { PersistenceError::new("DiskConflict", error.to_string(), &[path]) }
            else { PersistenceError::io(path, error) }
        })
    }

    fn check_document_version(&self, path: &Path, expected_version: &str) -> Result<()> {
        if digest(&regular_bytes(path)?) != expected_version {
            return Err(PersistenceError::new("DiskConflict", "The file changed on disk. Keep the draft and save it elsewhere, or discard the draft before reopening the disk version", &[path]));
        }
        Ok(())
    }

    fn document_available(&self, path: &Path) -> Result<()> {
        if !path.is_absolute() {
            return Err(PersistenceError::new("InvalidName", "An absolute document path is required", &[path]));
        }
        let metadata = fs::metadata(path).map_err(|error| PersistenceError::io(path, error))?;
        if !metadata.is_file() {
            return Err(PersistenceError::new("UnsafePath", "Expected an existing document", &[path]));
        }
        if let Some(journal) = self.journal()? {
            let canonical = fs::canonicalize(path).map_err(|error| PersistenceError::io(path, error))?;
            if journal.actions.iter().any(|action| relative_to(&canonical, &action.source).is_some() || relative_to(&canonical, &action.target).is_some()) ||
                journal.cleanup.iter().any(|resource| same_path(&canonical, &resource.path)) ||
                absolute(&journal.result_path).is_ok_and(|path| same_path(&canonical, &path)) {
                return Err(journal.recovery_error("Recover this document's pending transaction before saving"));
            }
        }
        Ok(())
    }

    pub fn resolve(&self, path: &Path) -> Result<String> {
        let _guard = self.guard()?; self.available()?;
        let mut catalog = self.load()?;
        let id = self.resolve_in(&mut catalog, path)?;
        self.store_catalog(&catalog)?; Ok(id)
    }
    fn resolve_in(&self, catalog: &mut Catalog, raw_path: &Path) -> Result<String> {
        let path = absolute(raw_path)?; regular_metadata(&path)?;
        if let Some((id, _)) = catalog.documents.iter().find(|(_, doc)| doc.active_path.as_ref().is_some_and(|p| same_path(p, &path))) { return Ok(id.clone()); }
        let id = uuid::Uuid::new_v4().to_string();
        let retired = catalog.documents.values().any(|d| d.retired_paths.iter().any(|p| same_path(p, &path)));
        let mut doc = Document { active_path: Some(path.clone()), display_path: Some(raw_path.to_path_buf()), retired_paths: Vec::new(), annotations: None, versions: Vec::new(), pinned: false };
        if !retired {
            let sidecar = annotation_path(&path);
            if let Some(bytes) = read_optional(&sidecar)? {
                self.validate_sidecar_owner(catalog, &path, &id, &sidecar)?;
                validate_annotations(&sidecar, &bytes)?;
                let resource = Resource { path: sidecar.clone(), sha256: digest(&bytes) };
                doc.annotations = Some(resource.clone());
                catalog.legacy_claims.push(Claim { source: sidecar.clone(), document_id: id.clone(), sha256: resource.sha256, destination: sidecar });
            }
            let legacy = self.legacy_dir(raw_path);
            if legacy.exists() {
                check_chain(&legacy)?;
                let mut entries = fs::read_dir(&legacy).map_err(|e| PersistenceError::io(&legacy, e))?.collect::<io::Result<Vec<_>>>().map_err(|e| PersistenceError::io(&legacy, e))?;
                entries.sort_by_key(|e| e.file_name());
                for entry in entries {
                    let source = entry.path();
                    if source.extension().is_none_or(|e| e != "md") { continue; }
                    if catalog.legacy_claims.iter().any(|c| same_path(&c.source, &source)) { continue; }
                    let bytes = regular_bytes(&source)?;
                    std::str::from_utf8(&bytes).map_err(|e| PersistenceError::new("InvalidMetadata", e.to_string(), &[&source]))?;
                    let filename = format!("{}_{}.md", entry.file_name().to_string_lossy().trim_end_matches(".md"), uuid::Uuid::new_v4());
                    validate_leaf(&filename)?;
                    let target = self.versions_dir(&id).join(&filename);
                    write_new(&target, &bytes)?;
                    let sha256 = digest(&bytes);
                    doc.versions.push(Version { entry: VersionEntry { document_id: id.clone(), timestamp: entry.file_name().to_string_lossy().trim_end_matches(".md").into(), filename, size: bytes.len() as u64 }, sha256: sha256.clone() });
                    catalog.legacy_claims.push(Claim { source, document_id: id.clone(), sha256, destination: target });
                }
                // Legacy originals stay intact even if an old installation exceeded the cap.
                if doc.versions.len() > 20 { doc.versions.drain(..doc.versions.len() - 20); }
            }
            if let Some(bytes) = read_optional(&self.config_dir.join("pins.json"))? {
                let pins: Vec<String> = serde_json::from_slice(&bytes).map_err(|e| PersistenceError::new("InvalidMetadata", e.to_string(), &[&self.config_dir.join("pins.json")]))?;
                doc.pinned = pins.iter().any(|p| absolute(Path::new(p)).is_ok_and(|p| same_path(&p, &path)));
            }
        }
        catalog.documents.insert(id.clone(), doc); Ok(id)
    }
    fn legacy_dir(&self, raw_path: &Path) -> PathBuf {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        raw_path.to_string_lossy().as_ref().hash(&mut hasher);
        self.config_dir.join("versions").join(format!("{:x}", hasher.finish()))
    }
    fn validate_sidecar_owner(&self, catalog: &Catalog, note: &Path, id: &str, sidecar: &Path) -> Result<()> {
        let mut candidates = Vec::new();
        for entry in fs::read_dir(note.parent().unwrap()).map_err(|e| PersistenceError::io(note, e))? {
            let entry = entry.map_err(|e| PersistenceError::io(note, e))?; let p = entry.path();
            if storage::has_supported_ext(&p) && (same_path(&annotation_path(&p), sidecar) ||
                (encrypted(&p) && same_path(&annotation_path(&p).with_extension(""), sidecar))) { candidates.push(p); }
        }
        let current_owner = catalog.documents.get(id).and_then(|d| d.annotations.as_ref()).is_some_and(|a| same_path(&a.path, sidecar));
        let claimed = sidecar.exists() && !current_owner && catalog.legacy_claims.iter().any(|c| same_path(&c.source, sidecar) && c.document_id != id);
        let owned = catalog.documents.iter().any(|(owner, d)| owner != id && d.active_path.is_some() && d.annotations.as_ref().is_some_and(|a| same_path(&a.path, sidecar)));
        if candidates.len() > 1 || claimed || owned {
            let mut paths = vec![sidecar]; paths.extend(candidates.iter().map(PathBuf::as_path));
            return Err(PersistenceError::new("Conflict", "Ambiguous annotation ownership; preserve the sidecar and choose/rename its owning document", &paths));
        }
        Ok(())
    }
    fn expected(&self, catalog: &mut Catalog, path: &Path, expected: &str) -> Result<String> {
        let id = self.resolve_in(catalog, path)?;
        if id != expected { return Err(PersistenceError::new("IdentityMismatch", "The path belongs to another document; discard this stale queued request", &[path])); }
        Ok(id)
    }

    pub fn read_annotations(&self, path: &Path) -> Result<AnnotationRead> {
        ensure_plaintext(path)?;
        let _guard = self.guard()?; self.available()?; let mut catalog = self.load()?;
        let id = self.resolve_in(&mut catalog, path)?;
        let (json, disk_version) = match &catalog.documents[&id].annotations {
            Some(resource) => match read_optional(&resource.path)? {
                Some(bytes) => {
                    validate_annotations(&resource.path, &bytes)?;
                    let version = digest(&bytes);
                    (String::from_utf8(bytes).map_err(|e| PersistenceError::new("InvalidMetadata", e.to_string(), &[&resource.path]))?, version)
                }
                None => ("[]".into(), String::new()),
            },
            None => ("[]".into(), String::new()),
        };
        self.store_catalog(&catalog)?; Ok(AnnotationRead { document_id: id, json, disk_version })
    }
    #[cfg(test)]
    pub fn write_annotations(&self, path: &Path, expected: &str, json: &str) -> Result<()> {
        self.write_annotations_versioned(path, expected, json, None).map(|_| ())
    }
    pub fn write_annotations_checked(&self, path: &Path, expected: &str, json: &str, expected_version: &str) -> Result<String> {
        self.write_annotations_versioned(path, expected, json, Some(expected_version))
    }
    fn write_annotations_versioned(&self, path: &Path, expected: &str, json: &str, expected_version: Option<&str>) -> Result<String> {
        ensure_plaintext(path)?;
        let _guard = self.guard()?; self.available()?; let mut catalog = self.load()?;
        let id = self.expected(&mut catalog, path, expected)?;
        let canonical = catalog.documents[&id].active_path.as_ref().unwrap().clone();
        let path = canonical.as_path();
        let sidecar = catalog.documents[&id].annotations.as_ref().map(|a| a.path.clone()).unwrap_or_else(|| annotation_path(path));
        validate_annotations(&sidecar, json.as_bytes())?;
        self.validate_sidecar_owner(&catalog, path, &id, &sidecar)?;
        let owned = catalog.documents[&id].annotations.is_some();
        if !owned && sidecar.try_exists().map_err(|e| PersistenceError::io(&sidecar, e))? {
            return Err(PersistenceError::new("Conflict", "Unclaimed/retired sidecar exists; preserve it before adding new annotations", &[&sidecar, path]));
        }
        if let Some(expected_version) = expected_version { self.check_sidecar_version(&sidecar, expected_version)?; }
        // Persist ownership first. A failed write leaves the previous portable data intact.
        catalog.documents.get_mut(&id).unwrap().annotations = Some(Resource { path: sidecar.clone(), sha256: digest(json.as_bytes()) });
        self.store_catalog(&catalog)?;
        if owned && sidecar.exists() { regular_metadata(&sidecar)?; storage::write_atomic(&sidecar, json).map_err(|e| PersistenceError::io(&sidecar, e))?; }
        else { write_new(&sidecar, json.as_bytes())?; }
        Ok(digest(json.as_bytes()))
    }
    fn check_sidecar_version(&self, sidecar: &Path, expected_version: &str) -> Result<()> {
        let current = if sidecar.try_exists().map_err(|error| PersistenceError::io(sidecar, error))? {
            digest(&regular_bytes(sidecar)?)
        } else { String::new() };
        if current != expected_version {
            return Err(PersistenceError::new("Conflict", "Annotations changed on disk since they were loaded; reload or retry with the current version", &[sidecar]));
        }
        Ok(())
    }
    #[cfg(test)]
    pub fn delete_annotations(&self, path: &Path, expected: &str) -> Result<()> {
        // Keep a portable empty JSON array rather than unlinking a possibly raced file.
        self.write_annotations(path, expected, "[]")
    }

    fn decrypt_document(&self, path: &Path, password: &str) -> Result<String> {
        if !encrypted(path) { return Err(PersistenceError::new("UnsupportedDocument", "Expected an encrypted document", &[path])); }
        encryption::decrypt(&regular_bytes(path)?, password).map_err(|message| PersistenceError::new("Encryption", message, &[path]))
    }

    pub fn read_encrypted_document(&self, path: &Path, password: &str) -> Result<crate::models::NoteContent> {
        self.document_available(path)?;
        if !encrypted(path) { return Err(PersistenceError::new("UnsupportedDocument", "Expected an encrypted document", &[path])); }
        let bytes = regular_bytes(path)?;
        let disk_version = digest(&bytes);
        let content = encryption::decrypt(&bytes, password).map_err(|message| PersistenceError::new("Encryption", message, &[path]))?;
        Ok(crate::models::NoteContent { id: display(path), content, disk_version })
    }

    pub fn write_encrypted_document(&self, path: &Path, content: &str, password: &str, expected_version: &str) -> Result<String> {
        let _guard = self.guard()?; self.document_available(path)?;
        self.check_document_version(path, expected_version)?;
        self.decrypt_document(path, password)?;
        let bytes = encryption::encrypt(content, password).map_err(|message| PersistenceError::new("Encryption", message, &[path]))?;
        self.save_checked(path, &bytes, expected_version)?;
        Ok(digest(&bytes))
    }

    pub fn read_encrypted_annotations(&self, path: &Path, password: &str) -> Result<AnnotationRead> {
        let _guard = self.guard()?; self.available()?;
        self.decrypt_document(path, password)?;
        let mut catalog = self.load()?;
        let id = self.resolve_in(&mut catalog, path)?;
        let (json, disk_version) = if let Some(resource) = &catalog.documents[&id].annotations {
            if !encrypted(&resource.path) { return Err(PersistenceError::new("Encryption", "Unlock to migrate legacy annotations first", &[path])); }
            let bytes = regular_bytes(&resource.path)?;
            let version = digest(&bytes);
            let json = encryption::decrypt(&bytes, password).map_err(|message| PersistenceError::new("Encryption", message, &[&resource.path]))?;
            validate_annotation_json(&resource.path, json.as_bytes())?;
            (json, version)
        } else { ("[]".into(), String::new()) };
        self.store_catalog(&catalog)?;
        Ok(AnnotationRead { document_id: id, json, disk_version })
    }

    #[cfg(test)]
    pub fn write_encrypted_annotations(&self, path: &Path, expected: &str, json: &str, password: &str) -> Result<()> {
        self.write_encrypted_annotations_versioned(path, expected, json, password, None).map(|_| ())
    }
    pub fn write_encrypted_annotations_checked(&self, path: &Path, expected: &str, json: &str, password: &str, expected_version: &str) -> Result<String> {
        self.write_encrypted_annotations_versioned(path, expected, json, password, Some(expected_version))
    }
    fn write_encrypted_annotations_versioned(&self, path: &Path, expected: &str, json: &str, password: &str, expected_version: Option<&str>) -> Result<String> {
        validate_annotation_json(path, json.as_bytes())?;
        let _guard = self.guard()?; self.available()?;
        self.decrypt_document(path, password)?;
        let mut catalog = self.load()?;
        let id = self.expected(&mut catalog, path, expected)?;
        if catalog.documents[&id].annotations.as_ref().is_some_and(|resource| !encrypted(&resource.path)) {
            return Err(PersistenceError::new("Encryption", "Unlock to migrate legacy annotations first", &[path]));
        }
        let canonical = catalog.documents[&id].active_path.as_ref().unwrap();
        let sidecar = annotation_path(canonical);
        self.validate_sidecar_owner(&catalog, canonical, &id, &sidecar)?;
        let owned = catalog.documents[&id].annotations.as_ref().is_some_and(|resource| same_path(&resource.path, &sidecar));
        if let Some(expected_version) = expected_version { self.check_sidecar_version(&sidecar, expected_version)?; }
        if !owned { require_absent(&sidecar)?; }
        let bytes = encryption::encrypt(json, password).map_err(|message| PersistenceError::new("Encryption", message, &[&sidecar]))?;
        catalog.documents.get_mut(&id).unwrap().annotations = Some(Resource { path: sidecar.clone(), sha256: digest(&bytes) });
        self.store_catalog(&catalog)?;
        if owned { regular_metadata(&sidecar)?; storage::write_atomic(&sidecar, &bytes).map_err(|error| PersistenceError::io(&sidecar, error))?; }
        else { write_new(&sidecar, &bytes)?; }
        Ok(digest(&bytes))
    }

    pub fn list_versions(&self, path: &Path) -> Result<Vec<VersionEntry>> {
        let _guard = self.guard()?; self.available()?; let mut catalog = self.load()?;
        let id = self.resolve_in(&mut catalog, path)?;
        for version in &catalog.documents[&id].versions { self.version_bytes(&id, version)?; }
        self.store_catalog(&catalog)?;
        Ok(catalog.documents[&id].versions.iter().rev().map(|v| v.entry.clone()).collect())
    }
    fn version_bytes(&self, id: &str, version: &Version) -> Result<Vec<u8>> {
        validate_leaf(&version.entry.filename)?;
        let path = self.versions_dir(id).join(&version.entry.filename);
        let bytes = regular_bytes(&path)?;
        if digest(&bytes) != version.sha256 { return Err(PersistenceError::new("Conflict", "Version checksum changed; preserve the file for recovery", &[&path])); }
        Ok(bytes)
    }
    fn get_version_in(&self, catalog: &Catalog, id: &str, filename: &str, password: Option<&str>) -> Result<String> {
        validate_leaf(filename)?;
        let version = catalog.documents[id].versions.iter().find(|v| v.entry.filename == filename).ok_or_else(|| PersistenceError::new("UnknownVersion", "Version does not belong to this document's index", &[]))?;
        let bytes = self.version_bytes(id, version)?;
        if encrypted(Path::new(filename)) {
            let password = password.ok_or_else(|| PersistenceError::new("Encryption", "Unlock this document to read its history", &[]))?;
            encryption::decrypt(&bytes, password).map_err(|message| PersistenceError::new("Encryption", message, &[]))
        } else { String::from_utf8(bytes).map_err(|error| PersistenceError::new("InvalidMetadata", error.to_string(), &[])) }
    }
    pub fn get_version(&self, path: &Path, expected: &str, filename: &str) -> Result<String> {
        ensure_plaintext(path)?;
        let _guard = self.guard()?; self.available()?; let mut catalog = self.load()?;
        let id = self.expected(&mut catalog, path, expected)?;
        let content = self.get_version_in(&catalog, &id, filename, None)?; self.store_catalog(&catalog)?; Ok(content)
    }
    pub fn save_version(&self, path: &Path, expected: &str, content: &str) -> Result<VersionEntry> {
        let _guard = self.guard()?; self.available()?; ensure_plaintext(path)?;
        let mut catalog = self.load()?; let id = self.expected(&mut catalog, path, expected)?;
        self.save_version_in(&mut catalog, &id, content, None)
    }
    fn save_version_in(&self, catalog: &mut Catalog, id: &str, content: &str, password: Option<&str>) -> Result<VersionEntry> {
        if let Some(latest) = catalog.documents[id].versions.last() {
            if self.get_version_in(catalog, id, &latest.entry.filename, password)? == content { self.store_catalog(catalog)?; return Ok(latest.entry.clone()); }
        }
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S_%f").to_string();
        let suffix = if password.is_some() { ".md.encrypted" } else { ".md" };
        let filename = format!("{timestamp}_{}{suffix}", uuid::Uuid::new_v4());
        let path = self.versions_dir(id).join(&filename);
        let bytes = match password {
            Some(password) => encryption::encrypt(content, password).map_err(|message| PersistenceError::new("Encryption", message, &[&path]))?,
            None => content.as_bytes().to_vec(),
        };
        self.checkpoint("version_write")?; write_new(&path, &bytes)?;
        let entry = VersionEntry { document_id: id.into(), timestamp, filename, size: content.len() as u64 };
        let doc = catalog.documents.get_mut(id).unwrap();
        doc.versions.push(Version { entry: entry.clone(), sha256: digest(&bytes) });
        let removed: Vec<_> = if doc.versions.len() > 20 { doc.versions.drain(..doc.versions.len() - 20).collect() } else { Vec::new() };
        // On failure, the old on-disk index and every old version remain intact.
        // An unindexed new file is intentionally retained, never mistaken for a version.
        self.checkpoint("version_index")?; self.store_catalog(catalog)?;
        for old in removed {
            let path = self.versions_dir(id).join(old.entry.filename);
            // GC is best-effort after commit. Unindexed data never expands the 20-entry API.
            let _ = remove_verified(&Resource { path, sha256: old.sha256 });
        }
        Ok(entry)
    }
    pub fn restore_version(&self, path: &Path, expected: &str, filename: &str) -> Result<()> {
        let _guard = self.guard()?; self.available()?; ensure_plaintext(path)?;
        let mut catalog = self.load()?; let id = self.expected(&mut catalog, path, expected)?;
        let text = self.get_version_in(&catalog, &id, filename, None)?;
        let current = String::from_utf8(regular_bytes(path)?).map_err(|e| PersistenceError::new("InvalidMetadata", e.to_string(), &[path]))?;
        self.save_version_in(&mut catalog, &id, &current, None)?;
        self.checkpoint("restore_write")?;
        storage::write_atomic(path, &text).map_err(|e| PersistenceError::io(path, e))
    }

    pub fn get_encrypted_version(&self, path: &Path, expected: &str, filename: &str, password: &str) -> Result<String> {
        let _guard = self.guard()?; self.available()?;
        let mut catalog = self.load()?; let id = self.expected(&mut catalog, path, expected)?;
        self.decrypt_document(path, password)?;
        self.get_version_in(&catalog, &id, filename, Some(password))
    }

    pub fn save_encrypted_version(&self, path: &Path, expected: &str, content: &str, password: &str) -> Result<VersionEntry> {
        let _guard = self.guard()?; self.available()?;
        let mut catalog = self.load()?; let id = self.expected(&mut catalog, path, expected)?;
        self.decrypt_document(path, password)?;
        self.save_version_in(&mut catalog, &id, content, Some(password))
    }

    pub fn restore_encrypted_version(&self, path: &Path, expected: &str, filename: &str, password: &str) -> Result<()> {
        let _guard = self.guard()?; self.available()?;
        let mut catalog = self.load()?; let id = self.expected(&mut catalog, path, expected)?;
        let current = self.decrypt_document(path, password)?;
        let content = self.get_version_in(&catalog, &id, filename, Some(password))?;
        self.save_version_in(&mut catalog, &id, &current, Some(password))?;
        let bytes = encryption::encrypt(&content, password).map_err(|message| PersistenceError::new("Encryption", message, &[path]))?;
        self.checkpoint("restore_write")?;
        storage::write_atomic(path, bytes).map_err(|error| PersistenceError::io(path, error))
    }

    pub fn pins(&self) -> Result<Vec<String>> {
        let _guard = self.guard()?; self.available()?; let mut catalog = self.load()?;
        // Resolve legacy pins only on explicit pin usage, never during scanning.
        if let Some(bytes) = read_optional(&self.config_dir.join("pins.json"))? {
            let pins: Vec<String> = serde_json::from_slice(&bytes).map_err(|e| PersistenceError::new("InvalidMetadata", e.to_string(), &[&self.config_dir.join("pins.json")]))?;
            for pin in pins { let p = Path::new(&pin); if p.try_exists().map_err(|e| PersistenceError::io(p, e))? { self.resolve_in(&mut catalog, p)?; } }
        }
        self.store_catalog(&catalog)?; Ok(pin_paths(&catalog))
    }
    pub fn toggle_pin(&self, path: &Path) -> Result<Vec<String>> {
        let _guard = self.guard()?; self.available()?; let mut catalog = self.load()?;
        let id = self.resolve_in(&mut catalog, path)?;
        let doc = catalog.documents.get_mut(&id).unwrap(); doc.pinned = !doc.pinned;
        self.store_catalog(&catalog)?; Ok(pin_paths(&catalog))
    }

    pub fn create_folder(&self, parent: &Path, name: &str) -> Result<String> {
        validate_leaf(name)?; let _guard = self.guard()?; self.available()?; self.load()?;
        let path = absolute(parent)?.join(name); check_chain(&path)?;
        fs::create_dir(&path).map_err(|e| PersistenceError::io(&path, e))?; Ok(display(&path))
    }
    pub fn create_note(&self, folder: &Path, title: &str) -> Result<MutationOutcome> {
        validate_leaf(title)?;
        if encrypted(Path::new(title)) || storage::is_pdf_file(Path::new(title)) { return Err(PersistenceError::new("InvalidName", "Cannot create an empty encrypted or PDF document", &[Path::new(title)])); }
        let filename = if suffix(title).is_some() { title.into() } else { format!("{title}.md") };
        validate_leaf(&filename)?;
        let _guard = self.guard()?; self.available()?; let mut catalog = self.load()?;
        let target = absolute(folder)?.join(&filename); require_absent(&target)?;
        let id = uuid::Uuid::new_v4().to_string();
        let requested_target = folder.join(&filename);
        let mut journal = Journal::new("create", &requested_target);
        let source = target.with_file_name(format!(".miaoyan-create-{}", journal.id));
        write_new(&source, b"")?;
        journal.actions.push(Action { source: source.clone(), target: target.clone(), sha256: digest(b""), copy: false, done: false });
        journal.cleanup.push(Resource { path: source, sha256: digest(b"") });
        // An externally removed active path is retired before an application create.
        for doc in catalog.documents.values_mut() {
            if doc.active_path.as_ref().is_some_and(|p| same_path(p, &target)) { doc.retired_paths.push(target.clone()); doc.active_path = None; doc.pinned = false; }
        }
        catalog.documents.insert(id.clone(), Document { active_path: Some(target.clone()), display_path: Some(requested_target), retired_paths: Vec::new(), annotations: None, versions: Vec::new(), pinned: false });
        let mut outcome = self.execute(catalog, journal, Some(id), Vec::new())?;
        outcome.snapshot = Some(crate::models::NoteContent { id: outcome.path.clone(), content: String::new(), disk_version: digest(b"") });
        Ok(outcome)
    }
    pub fn copy_document(&self, source: &Path, target: &Path, content: &str, annotation_draft: Option<&str>, password: Option<&str>, allow_warnings: bool) -> Result<MutationOutcome> {
        let _guard = self.guard()?; self.available()?;
        let shown = target.to_path_buf();
        let source = absolute(source)?; let target = absolute(target)?;
        if storage::is_pdf_file(&source) || !storage::has_supported_ext(&target) || encrypted(&source) != encrypted(&target) || encrypted(&target) != password.is_some() {
            return Err(PersistenceError::new("UnsupportedDocument", "Save the draft in its original text/encryption format", &[&source, &target]));
        }
        require_absent(&target)?;
        let mut catalog = self.load()?;
        let owner = catalog.documents.values().find(|doc| doc.active_path.as_ref().is_some_and(|path| same_path(path, &source)));
        let existing = owner.and_then(|doc| doc.annotations.as_ref()).map(|resource| resource.path.clone()).unwrap_or_else(|| annotation_path(&source));
        let annotations = match annotation_draft {
            Some(json) => Some(json.to_string()),
            None => match read_optional(&existing)? {
                Some(bytes) => Some(if encrypted(&existing) {
                    encryption::decrypt(&bytes, password.ok_or_else(|| PersistenceError::new("Encryption", "Password required for annotations", &[&existing]))?)
                        .map_err(|message| PersistenceError::new("Encryption", message, &[&existing]))?
                } else { String::from_utf8(bytes).map_err(|error| PersistenceError::new("InvalidMetadata", error.to_string(), &[&existing]))? }),
                None => None,
            },
        };
        if let Some(json) = &annotations { validate_annotation_json(&existing, json.as_bytes())?; }
        let plain_source = if encrypted(&source) { source.with_extension("") } else { source.clone() };
        let plan = attachments::plan(content, &plain_source, &target, source.parent().unwrap(), target.parent().unwrap(), false);
        if !allow_warnings && !plan.warnings.is_empty() {
            let mut error = PersistenceError::new("ConfirmationRequired", "Some references could not be copied; confirm to retain the draft with those references unchanged", &[&source, &target]);
            error.warnings = plan.warnings;
            return Err(error);
        }
        let bytes = match password { Some(password) => encryption::encrypt(content, password).map_err(|message| PersistenceError::new("Encryption", message, &[&target]))?, None => content.as_bytes().to_vec() };
        let mut journal = Journal::new("copy", &shown);
        for asset in plan.copies { add_copy(&mut journal, &asset.source, &asset.target, &asset.bytes)?; }
        let sidecar = annotation_path(&target);
        if annotations.is_some() { require_absent(&sidecar)?; }
        let staged = (|| {
            let body = self.stage_copy(&mut journal, &target, &bytes)?;
            let annotations = annotations.map(|json| {
                let bytes = match password { Some(password) => encryption::encrypt(&json, password).map_err(|message| PersistenceError::new("Encryption", message, &[&sidecar]))?, None => json.into_bytes() };
                self.stage_copy(&mut journal, &sidecar, &bytes)
            }).transpose()?;
            Ok((body, annotations))
        })();
        let (body, annotations) = match staged {
            Ok(resources) => resources,
            Err(error) => {
                if let Err(recovery) = self.rollback(&mut journal) { return Err(journal.recovery_error(format!("{error}; {recovery}"))); }
                return Err(error);
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        for doc in catalog.documents.values_mut() {
            if doc.active_path.as_ref().is_some_and(|path| same_path(path, &target)) { doc.retired_paths.push(target.clone()); doc.active_path = None; }
        }
        catalog.documents.insert(id.clone(), Document { active_path: Some(target), display_path: Some(shown.clone()), retired_paths: Vec::new(), annotations, versions: Vec::new(), pinned: false });
        let mut outcome = self.execute(catalog, journal, Some(id), plan.warnings)?;
        outcome.snapshot = Some(crate::models::NoteContent { id: display(&shown), content: content.to_string(), disk_version: body.sha256 });
        Ok(outcome)
    }

    fn stage_copy(&self, journal: &mut Journal, target: &Path, bytes: &[u8]) -> Result<Resource> {
        let stage = target.with_file_name(format!(".miaoyan-copy-{}-{}", journal.id, journal.staged.len()));
        let resource = Resource { path: stage.clone(), sha256: digest(bytes) };
        journal.staged.push(resource.clone());
        journal.actions.push(Action { source: stage.clone(), target: target.into(), sha256: resource.sha256.clone(), copy: false, done: false });
        self.store_journal(journal)?;
        write_new(&stage, bytes)?;
        Ok(Resource { path: target.into(), sha256: resource.sha256 })
    }

    pub fn set_encryption(&self, path: &Path, password: &str, enabled: bool, expected_version: Option<&str>) -> Result<MutationOutcome> {
        let _guard = self.guard()?; self.available()?;
        if let Some(version) = expected_version { self.check_document_version(path, version)?; }
        if storage::is_pdf_file(path) || !storage::has_supported_ext(path) || (!enabled && !encrypted(path)) {
            return Err(PersistenceError::new("UnsupportedDocument", "Expected a supported text document", &[path]));
        }
        let target_shown = if enabled {
            if encrypted(path) { path.to_path_buf() } else { PathBuf::from(format!("{}.encrypted", display(path))) }
        } else { PathBuf::from(&display(path)[..display(path).len() - ".encrypted".len()]) };
        let source = absolute(path)?;
        let target = absolute(&target_shown)?;
        if !same_path(&source, &target) { require_absent(&target)?; }
        let source_bytes = regular_bytes(&source)?;
        let mut disk_version = digest(&source_bytes);
        let content = if encrypted(&source) {
            encryption::decrypt(&source_bytes, password).map_err(|message| PersistenceError::new("Encryption", message, &[&source]))?
        } else { String::from_utf8(source_bytes).map_err(|error| PersistenceError::new("InvalidMetadata", error.to_string(), &[&source]))? };
        let mut catalog = self.load()?;
        let id = self.resolve_in(&mut catalog, path)?;
        if encrypted(&source) {
            let legacy = annotation_path(&source).with_extension("");
            if let Some(bytes) = read_optional(&legacy)? {
                self.validate_sidecar_owner(&catalog, &source, &id, &legacy)?;
                validate_annotation_json(&legacy, &bytes)?;
                if catalog.documents[&id].annotations.as_ref().is_some_and(|resource| !same_path(&resource.path, &legacy)) {
                    return Err(PersistenceError::new("Conflict", "Both legacy and encrypted annotations exist; preserve both before migration", &[&legacy, &source]));
                }
                catalog.documents.get_mut(&id).unwrap().annotations = Some(Resource { path: legacy, sha256: digest(&bytes) });
            }
        }
        self.store_catalog(&catalog)?;
        let mut doc = catalog.documents[&id].clone();
        let mut journal = Journal::new("encryption", &target_shown);
        let prepared = (|| {
            if let Some(resource) = &doc.annotations {
                let destination = annotation_path(&target);
                if !same_path(&resource.path, &destination) {
                    self.validate_sidecar_owner(&catalog, &target, &id, &destination)?;
                    doc.annotations = Some(self.prepare_encryption(&mut journal, &resource.path, &destination, password, enabled)?);
                }
            }
            for version in &mut doc.versions {
                let original = self.versions_dir(&id).join(&version.entry.filename);
                self.version_bytes(&id, version)?;
                if encrypted(&original) == enabled { continue; }
                let filename = if enabled { format!("{}.encrypted", version.entry.filename) }
                    else { version.entry.filename[..version.entry.filename.len() - ".encrypted".len()].to_string() };
                let replacement = self.prepare_encryption(&mut journal, &original, &self.versions_dir(&id).join(&filename), password, enabled)?;
                version.entry.filename = filename;
                version.sha256 = replacement.sha256;
            }
            if enabled {
                let mut leftovers: Vec<Resource> = catalog.legacy_claims.iter().filter(|claim| claim.document_id == id)
                    .map(|claim| Resource { path: claim.source.clone(), sha256: claim.sha256.clone() }).collect();
                let versions_dir = self.versions_dir(&id);
                if versions_dir.exists() {
                    check_chain(&versions_dir)?;
                    for entry in fs::read_dir(&versions_dir).map_err(|error| PersistenceError::io(&versions_dir, error))? {
                        let file = entry.map_err(|error| PersistenceError::io(&versions_dir, error))?.path();
                        if file.extension().is_some_and(|extension| extension == "md") {
                            leftovers.push(Resource { sha256: digest(&regular_bytes(&file)?), path: file });
                        }
                    }
                }
                for resource in leftovers {
                    if encrypted(&resource.path) || journal.cleanup.iter().any(|item| same_path(&item.path, &resource.path)) { continue; }
                    let Some(bytes) = read_optional(&resource.path)? else { continue; };
                    if digest(&bytes) != resource.sha256 { return Err(PersistenceError::new("Conflict", "Legacy metadata changed; preserve it before encryption", &[&resource.path])); }
                    let destination = PathBuf::from(format!("{}.encrypted", display(&resource.path)));
                    self.prepare_encryption(&mut journal, &resource.path, &destination, password, true)?;
                }
            }
            if !same_path(&source, &target) {
                self.check_document_version(&source, &disk_version)?;
                disk_version = self.prepare_encryption(&mut journal, &source, &target, password, enabled)?.sha256;
                doc.retired_paths.push(source.clone());
            }
            Ok(())
        })();
        if let Err(error) = prepared {
            if self.journal()?.is_some() {
                if let Err(recovery) = self.rollback(&mut journal) { return Err(journal.recovery_error(format!("{error}; rollback: {recovery}"))); }
            } else {
                for resource in &journal.staged { remove_verified(resource)?; }
            }
            return Err(error);
        }
        doc.active_path = Some(target);
        doc.display_path = Some(target_shown.clone());
        catalog.documents.insert(id.clone(), doc);
        let snapshot = crate::models::NoteContent { id: display(&target_shown), content, disk_version };
        if journal.actions.is_empty() { return Ok(MutationOutcome { document_id: Some(id), path: display(&target_shown), warnings: Vec::new(), snapshot: Some(snapshot) }); }
        let mut outcome = self.execute(catalog, journal, Some(id), Vec::new())?;
        outcome.snapshot = Some(snapshot);
        Ok(outcome)
    }

    fn prepare_encryption(&self, journal: &mut Journal, source: &Path, target: &Path, password: &str, enabled: bool) -> Result<Resource> {
        require_absent(target)?;
        let original = regular_bytes(source)?;
        let text = if encrypted(source) {
            encryption::decrypt(&original, password).map_err(|message| PersistenceError::new("Encryption", message, &[source]))?
        } else { String::from_utf8(original.clone()).map_err(|error| PersistenceError::new("InvalidMetadata", error.to_string(), &[source]))? };
        let bytes = if enabled { encryption::encrypt(&text, password).map_err(|message| PersistenceError::new("Encryption", message, &[source]))? } else { text.into_bytes() };
        let sha256 = digest(&bytes);
        let stage = target.with_file_name(format!(".miaoyan-encryption-{}-{}", journal.id, journal.staged.len()));
        journal.staged.push(Resource { path: stage.clone(), sha256: sha256.clone() });
        journal.actions.push(Action { source: stage.clone(), target: target.into(), sha256: sha256.clone(), copy: false, done: false });
        journal.cleanup.push(Resource { path: source.into(), sha256: digest(&original) });
        self.store_journal(journal)?;
        write_new(&stage, &bytes)?;
        self.checkpoint("encryption_stage")?;
        Ok(Resource { path: target.into(), sha256 })
    }

    pub fn rename(&self, old: &Path, title: &str, allow_warnings: bool) -> Result<MutationOutcome> {
        validate_leaf(title)?;
        let name = rename_leaf(old, title)?;
        self.relocate(old, &old.parent().ok_or_else(|| PersistenceError::new("InvalidName", "Missing parent", &[old]))?.join(name), false, allow_warnings)
    }
    pub fn move_note(&self, old: &Path, target_folder: &Path, allow_warnings: bool) -> Result<MutationOutcome> {
        let name = old.file_name().ok_or_else(|| PersistenceError::new("InvalidName", "Missing file name", &[old]))?;
        validate_leaf(&name.to_string_lossy())?;
        self.relocate(old, &target_folder.join(name), false, allow_warnings)
    }
    pub fn rename_folder(&self, old: &Path, name: &str, allow_warnings: bool) -> Result<MutationOutcome> {
        validate_leaf(name)?;
        self.relocate(old, &old.parent().ok_or_else(|| PersistenceError::new("InvalidName", "Missing parent", &[old]))?.join(name), true, allow_warnings)
    }
    fn relocate(&self, old: &Path, target: &Path, directory: bool, allow_warnings: bool) -> Result<MutationOutcome> {
        let _guard = self.guard()?; self.available()?; let mut catalog = self.load()?;
        let requested_target = target.to_path_buf();
        let old = absolute(old)?; let target = absolute(target)?;
        if same_path(&old, &target) { return Err(PersistenceError::new("Conflict", "Same path (including case aliases); use an intermediate distinct name for case-only rename", &[&old, &target])); }
        require_absent(&target)?;
        if directory && relative_to(&target, &old).is_some() { return Err(PersistenceError::new("InvalidName", "Cannot move a directory into itself", &[&old, &target])); }
        let notes = if directory { document_files(&old)? } else { regular_metadata(&old)?; vec![old.clone()] };
        let mut relocated = Vec::new();
        for note in notes {
            let id = self.resolve_in(&mut catalog, &note)?;
            let dest = if directory { target.join(relative_to(&note, &old).unwrap()) } else { target.clone() };
            relocated.push((id, note, dest));
        }
        self.store_catalog(&catalog)?; // Commit lazy legacy ownership before changing paths.
        let mut journal = Journal::new(if directory { "rename_folder" } else { "relocate" }, &requested_target);
        let mut warnings = Vec::new();
        for (id, note, dest) in &relocated {
            let doc = catalog.documents[id].clone();
            if encrypted(note) || storage::is_pdf_file(note) {
                warnings.push(Warning::new("AttachmentsUnverified", note, "Binary/encrypted attachments were not inspected; the document itself can still move"));
            } else {
                let bytes = regular_bytes(note)?;
                let text = std::str::from_utf8(&bytes).map_err(|e| PersistenceError::new("InvalidMetadata", e.to_string(), &[note]))?;
                let root = if directory { old.as_path() } else { note.parent().unwrap() };
                let target_root = if directory { target.as_path() } else { dest.parent().unwrap() };
                let mut texts = vec![text.to_string()];
                for version in &doc.versions { texts.push(String::from_utf8(self.version_bytes(id, version)?).map_err(|e| PersistenceError::new("InvalidMetadata", e.to_string(), &[note]))?); }
                for text in texts {
                    let plan = attachments::plan(&text, note, dest, root, target_root, directory);
                    warnings.extend(plan.warnings);
                    for asset in plan.copies { add_copy(&mut journal, &asset.source, &asset.target, &asset.bytes)?; }
                }
            }
            if let Some(resource) = &doc.annotations {
                if let Some(bytes) = read_optional(&resource.path)? {
                    validate_annotations(&resource.path, &bytes)?;
                    let destination = if directory { target.join(relative_to(&resource.path, &old).ok_or_else(|| PersistenceError::new("Conflict", "Sidecar is outside moved directory", &[&resource.path]))?) } else { annotation_path(dest) };
                    if !directory && !same_path(&resource.path, &destination) {
                        // A same-stem destination document is ambiguous even if it has no sidecar yet.
                        self.validate_sidecar_owner(&catalog, dest, id, &destination)?;
                        require_absent(&destination)?;
                        add_copy(&mut journal, &resource.path, &destination, &bytes)?;
                        journal.cleanup.push(Resource { path: resource.path.clone(), sha256: digest(&bytes) });
                    }
                    catalog.documents.get_mut(id).unwrap().annotations = Some(Resource { path: destination, sha256: digest(&bytes) });
                }
            }
            let doc = catalog.documents.get_mut(id).unwrap();
            doc.retired_paths.push(note.clone());
            doc.active_path = Some(dest.clone());
            doc.display_path = Some(if directory { requested_target.join(relative_to(note, &old).unwrap()) } else { requested_target.clone() });
        }
        if !allow_warnings && warnings.iter().any(|w| w.code == "UnverifiedAttachment") {
            let mut error = PersistenceError::new("ConfirmationRequired", "Some references cannot be preserved automatically; inspect warnings and explicitly confirm", &[&old, &target]); error.warnings = warnings; return Err(error);
        }
        journal.actions.push(Action { source: old.clone(), target: target.clone(), sha256: path_digest(&old)?, copy: false, done: false });
        let id = if directory { None } else { relocated.first().map(|r| r.0.clone()) };
        self.execute(catalog, journal, id, warnings)
    }
    pub fn delete(&self, path: &Path) -> Result<MutationOutcome> {
        let _guard = self.guard()?; self.available()?; let mut catalog = self.load()?;
        let path = absolute(path)?; check_chain(&path)?;
        let directory = path.is_dir();
        let notes = if directory { document_files(&path)? } else { regular_metadata(&path)?; vec![path.clone()] };
        let mut ids = Vec::new(); for note in notes { ids.push(self.resolve_in(&mut catalog, &note)?); }
        self.store_catalog(&catalog)?;
        let mut journal = Journal::new("delete", &path);
        let quarantine = path.with_file_name(format!(".miaoyan-trash-{}", journal.id));
        fs::create_dir(&quarantine).map_err(|e| PersistenceError::io(&quarantine, e))?;
        journal.trash_path = Some(quarantine.clone());
        for id in &ids {
            let doc = catalog.documents.get_mut(id).unwrap();
            if !directory {
                if let Some(resource) = &doc.annotations {
                    if let Some(bytes) = read_optional(&resource.path)? {
                        validate_annotations(&resource.path, &bytes)?;
                        journal.actions.push(Action { source: resource.path.clone(), target: quarantine.join(resource.path.file_name().unwrap()), sha256: digest(&bytes), copy: false, done: false });
                    }
                }
            }
            if let Some(active) = doc.active_path.take() { doc.retired_paths.push(active); }
            doc.display_path = None;
            doc.pinned = false;
        }
        journal.actions.push(Action { source: path.clone(), target: quarantine.join(path.file_name().unwrap()), sha256: path_digest(&path)?, copy: false, done: false });
        self.execute(catalog, journal, if directory { None } else { ids.first().cloned() }, Vec::new())
    }

    fn execute(&self, mut catalog: Catalog, mut journal: Journal, id: Option<String>, mut warnings: Vec<Warning>) -> Result<MutationOutcome> {
        self.store_journal(&journal)?;
        let result = (|| {
            self.checkpoint("prepared")?;
            for index in 0..journal.actions.len() {
                let action = &journal.actions[index];
                if !action.copy { self.checkpoint("before_body")?; }
                if path_digest(&action.source)? != action.sha256 { return Err(PersistenceError::new("Conflict", "Source changed during preparation", &[&action.source])); }
                if action.copy { write_new(&action.target, &regular_bytes(&action.source)?)?; }
                else { move_no_replace(&action.source, &action.target).map_err(|e| PersistenceError::io(&action.target, e))?; }
                journal.actions[index].done = true;
                self.store_journal(&journal)?;
                if journal.actions[index].copy { self.checkpoint("after_metadata")?; } else { self.checkpoint("after_body")?; }
            }
            if journal.kind == "encryption" {
                for resource in &journal.cleanup {
                    if path_digest(&resource.path)? != resource.sha256 {
                        return Err(PersistenceError::new("Conflict", "Original changed during encryption; original edits were preserved", &[&resource.path]));
                    }
                }
            }
            self.checkpoint("catalog_commit")?;
            catalog.last_transaction = Some(journal.id.clone()); self.store_catalog(&catalog)
        })();
        if let Err(error) = result {
            // Reload the commit marker, not an in-memory assumption, before rollback.
            if self.load()?.last_transaction.as_deref() != Some(&journal.id) {
                if let Err(recovery) = self.rollback(&mut journal) { return Err(journal.recovery_error(format!("{error}; rollback: {recovery}"))); }
                return Err(error);
            }
        }
        if let Err(error) = self.cleanup(&journal) {
            warnings.push(Warning::new("RecoveryPending", &self.journal_path(), format!("Operation committed; cleanup pending ({}): {error}", journal.id)));
        }
        Ok(MutationOutcome { document_id: id, path: display(&journal.result_path), warnings, snapshot: None })
    }
    fn rollback(&self, journal: &mut Journal) -> Result<()> {
        for index in (0..journal.actions.len()).rev() {
            let action = &journal.actions[index];
            let source_exists = action.source.try_exists().map_err(|e| PersistenceError::io(&action.source, e))?;
            let target_exists = action.target.try_exists().map_err(|e| PersistenceError::io(&action.target, e))?;
            // A crash can occur after rename but before persisting `done`.
            let performed = action.done || (!action.copy && !source_exists && target_exists);
            if performed {
                if !target_exists {
                    if !action.copy && source_exists && path_digest(&action.source)? == action.sha256 { continue; }
                    return Err(journal.recovery_error("A transaction resource disappeared; preserve remaining copies"));
                }
                if path_digest(&action.target)? != action.sha256 { return Err(journal.recovery_error("Target changed; preserve both paths and resolve the external edit")); }
                if action.copy { remove_verified(&Resource { path: action.target.clone(), sha256: action.sha256.clone() })?; }
                else { move_no_replace(&action.target, &action.source).map_err(|e| journal.recovery_error(e.to_string()))?; }
                journal.actions[index].done = false; self.store_journal(journal)?;
            } else if action.copy && target_exists {
                // It might be an external creator or an unjournaled completed copy.
                // Do not guess ownership from content equality.
                return Err(journal.recovery_error("Uncertain prepared-copy ownership; preserve the target for manual relocation"));
            }
        }
        if journal.kind == "create" { for resource in &journal.cleanup { remove_verified(resource)?; } }
        for resource in &journal.staged { remove_verified(resource)?; }
        if let Some(path) = &journal.trash_path {
            if path.exists() { fs::remove_dir(path).map_err(|e| PersistenceError::io(path, e))?; } // empty quarantine only
        }
        fs::remove_file(self.journal_path()).map_err(|e| PersistenceError::io(&self.journal_path(), e))?; Ok(())
    }
    fn cleanup(&self, journal: &Journal) -> Result<()> {
        self.checkpoint("cleanup")?;
        for resource in &journal.cleanup { remove_verified(resource)?; }
        for resource in &journal.staged { remove_verified(resource)?; }
        if let Some(path) = &journal.trash_path {
            if path.try_exists().map_err(|e| PersistenceError::io(path, e))? { self.trash.recycle(path).map_err(|e| PersistenceError::io(path, e))?; }
        }
        fs::remove_file(self.journal_path()).map_err(|e| PersistenceError::io(&self.journal_path(), e))?; Ok(())
    }
    pub fn recoveries(&self) -> Result<Vec<RecoveryInfo>> {
        let _guard = self.guard()?; let catalog = self.load()?;
        Ok(self.journal()?.into_iter().map(|j| {
            let mut paths = j.paths();
            for document in catalog.documents.values() {
                if let (Some(active), Some(shown)) = (&document.active_path, &document.display_path) {
                    if j.actions.iter().any(|action| relative_to(active, &action.source).is_some() || relative_to(active, &action.target).is_some()) {
                        paths.push(display(shown));
                    }
                }
            }
            paths.sort();
            paths.dedup();
            RecoveryInfo { transaction_id: j.id.clone(), kind: j.kind.clone(), paths, committed: catalog.last_transaction.as_deref() == Some(&j.id) }
        }).collect())
    }
    pub fn retry_recovery(&self, transaction_id: &str) -> Result<()> {
        let _guard = self.guard()?; let catalog = self.load()?;
        let Some(mut journal) = self.journal()? else { return Ok(()); };
        if journal.id != transaction_id { return Err(journal.recovery_error("Recovery ID changed; refresh recovery information")); }
        let result = if catalog.last_transaction.as_deref() == Some(&journal.id) { self.cleanup(&journal) } else { self.rollback(&mut journal) };
        result.map_err(|e| journal.recovery_error(e.to_string()))
    }
}

fn pin_paths(catalog: &Catalog) -> Vec<String> {
    catalog.documents.values().filter(|d| d.pinned).filter_map(|d| d.active_path.as_ref().map(|p| display(d.display_path.as_ref().unwrap_or(p)))).collect()
}
fn display(path: &Path) -> String {
    // canonicalize() yields extended-length Windows paths; payloads and tree
    // identity use the plain spelling so local inserts still match their parent.
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") { return format!(r"\\{rest}"); }
        if let Some(rest) = text.strip_prefix(r"\\?\") { return rest.to_string(); }
    }
    text.into_owned()
}
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn encrypted(path: &Path) -> bool { path.to_string_lossy().to_ascii_lowercase().ends_with(".encrypted") }
fn ensure_plaintext(path: &Path) -> Result<()> {
    if encrypted(path) || storage::is_pdf_file(path) { Err(PersistenceError::new("UnsupportedDocument", "This operation requires an unencrypted text document", &[path])) } else { Ok(()) }
}
fn annotation_path(note: &Path) -> PathBuf {
    let suffix = if encrypted(note) { ".annotations.json.encrypted" } else { ".annotations.json" };
    note.with_file_name(format!("{}{suffix}", note.file_stem().unwrap_or_default().to_string_lossy()))
}
fn validate_annotations(path: &Path, bytes: &[u8]) -> Result<()> {
    if encrypted(path) { return Ok(()); }
    validate_annotation_json(path, bytes)
}
fn validate_annotation_json(path: &Path, bytes: &[u8]) -> Result<()> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| PersistenceError::new("InvalidMetadata", format!("Invalid annotations JSON: {e}"), &[path]))?;
    if !value.is_array() { return Err(PersistenceError::new("InvalidMetadata", "Annotations must be a JSON array", &[path])); }
    Ok(())
}

pub fn validate_leaf(name: &str) -> Result<()> {
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$") || ["COM", "LPT"].iter().any(|p| stem.strip_prefix(p).is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")));
    if name.trim().is_empty() || matches!(name, "." | "..") || name.ends_with(['.', ' ']) || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) || Path::new(name).is_absolute() || reserved {
        return Err(PersistenceError::new("InvalidName", "Use one nonblank filename without separators, control characters, Windows reserved names, or trailing dots/spaces", &[Path::new(name)]));
    }
    Ok(())
}
fn suffix(name: &str) -> Option<&'static str> {
    [".markdown.encrypted", ".html.encrypted", ".txt.encrypted", ".htm.encrypted", ".pdf.encrypted", ".md.encrypted", ".encrypted", ".markdown", ".html", ".htm", ".txt", ".pdf", ".md"].into_iter().find(|s| name.to_ascii_lowercase().ends_with(s))
}
pub fn rename_leaf(old: &Path, title: &str) -> Result<String> {
    validate_leaf(title)?;
    let old_name = old.file_name().unwrap_or_default().to_string_lossy();
    let suffix = suffix(&old_name).ok_or_else(|| PersistenceError::new("InvalidName", "Unsupported document extension", &[old]))?;
    let name = if title.to_ascii_lowercase().ends_with(suffix) { title.to_string() }
        else if let Some(base) = suffix.strip_suffix(".encrypted").filter(|s| !s.is_empty()) {
            if title.to_ascii_lowercase().ends_with(base) { format!("{title}.encrypted") } else { format!("{title}{suffix}") }
        } else { format!("{title}{suffix}") };
    validate_leaf(&name)?; Ok(name)
}

fn component_equal(a: &std::ffi::OsStr, b: &std::ffi::OsStr) -> bool {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" { fn CompareStringOrdinal(a: *const u16, a_len: i32, b: *const u16, b_len: i32, ignore_case: i32) -> i32; }
        let a: Vec<_> = a.encode_wide().collect(); let b: Vec<_> = b.encode_wide().collect();
        unsafe { CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1) == 2 }
    }
    #[cfg(not(windows))] { a == b }
}
pub(super) fn relative_to(path: &Path, root: &Path) -> Option<PathBuf> {
    let mut parts = path.components();
    for component in root.components() { if !component_equal(parts.next()?.as_os_str(), component.as_os_str()) { return None; } }
    Some(parts.as_path().to_path_buf())
}
fn same_path(a: &Path, b: &Path) -> bool { relative_to(a, b).is_some_and(|p| p.as_os_str().is_empty()) }
fn absolute(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() { return Err(PersistenceError::new("InvalidName", "An absolute document path is required", &[path])); }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component { Component::CurDir => (), Component::ParentDir => { normalized.pop(); }, _ => normalized.push(component.as_os_str()) }
    }
    check_chain(&normalized)?;
    // Canonicalize existing parents, including Windows long paths and case aliases.
    let mut ancestor = normalized.as_path(); let mut missing = Vec::new();
    while !ancestor.exists() {
        missing.push(ancestor.file_name().ok_or_else(|| PersistenceError::new("InvalidName", "Invalid path", &[path]))?.to_os_string());
        ancestor = ancestor.parent().ok_or_else(|| PersistenceError::new("InvalidName", "Missing parent", &[path]))?;
    }
    let mut result = fs::canonicalize(ancestor).map_err(|e| PersistenceError::io(ancestor, e))?;
    for part in missing.into_iter().rev() { result.push(part); }
    Ok(result)
}
fn check_chain(path: &Path) -> Result<()> {
    for parent in path.ancestors() {
        if parent.as_os_str().is_empty() { continue; }
        match fs::symlink_metadata(parent) {
            Ok(metadata) => {
                #[cfg(windows)]
                let reparse = { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 };
                #[cfg(not(windows))]
                let reparse = false;
                if metadata.file_type().is_symlink() || reparse { return Err(PersistenceError::new("UnsafePath", "Linked/reparse resources require explicit manual handling", &[parent])); }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => return Err(PersistenceError::io(parent, e)),
        }
    }
    Ok(())
}
fn regular_metadata(path: &Path) -> Result<fs::Metadata> {
    check_chain(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|e| PersistenceError::io(path, e))?;
    if !metadata.is_file() { return Err(PersistenceError::new("UnsafePath", "Expected a regular non-link file", &[path])); }
    Ok(metadata)
}
pub(super) fn regular_bytes(path: &Path) -> Result<Vec<u8>> {
    regular_metadata(path)?; fs::read(path).map_err(|e| PersistenceError::io(path, e))
}
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    check_chain(path)?;
    match fs::symlink_metadata(path) { Ok(_) => regular_bytes(path).map(Some), Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None), Err(e) => Err(PersistenceError::io(path, e)) }
}
fn require_absent(path: &Path) -> Result<()> {
    check_chain(path)?;
    match fs::symlink_metadata(path) { Ok(_) => Err(PersistenceError::new("Conflict", "Destination is occupied; nothing was overwritten", &[path])), Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()), Err(e) => Err(PersistenceError::io(path, e)) }
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    require_absent(path)?;
    let parent = path.parent().ok_or_else(|| PersistenceError::new("InvalidName", "Missing parent", &[path]))?;
    fs::create_dir_all(parent).map_err(|e| PersistenceError::io(parent, e))?; check_chain(parent)?;
    let staged = parent.join(format!(".miaoyan-stage-{}", uuid::Uuid::new_v4()));
    storage::write_atomic(&staged, bytes).map_err(|e| PersistenceError::io(&staged, e))?;
    match move_no_replace(&staged, path) {
        Ok(()) => Ok(()),
        Err(e) => { let _ = fs::remove_file(&staged); Err(PersistenceError::io(path, e)) },
    }
}
fn remove_verified(resource: &Resource) -> Result<()> {
    let Some(bytes) = read_optional(&resource.path)? else { return Ok(()); };
    if digest(&bytes) != resource.sha256 { return Err(PersistenceError::new("Conflict", "Cleanup resource changed; preserved for recovery", &[&resource.path])); }
    fs::remove_file(&resource.path).map_err(|e| PersistenceError::io(&resource.path, e))
}
fn add_copy(journal: &mut Journal, source: &Path, target: &Path, bytes: &[u8]) -> Result<()> {
    if same_path(source, target) { return Ok(()); }
    let hash = digest(bytes);
    if let Some(existing) = journal.actions.iter().find(|a| same_path(&a.target, target)) {
        if existing.sha256 == hash { return Ok(()); }
        return Err(PersistenceError::new("Conflict", "Referenced resources collide at destination", &[source, target]));
    }
    if let Some(existing) = read_optional(target)? {
        if digest(&existing) == hash { return Ok(()); } // Shared identical resource: never own/delete it.
        return Err(PersistenceError::new("Conflict", "Destination resource differs; preserve both originals", &[source, target]));
    }
    journal.actions.push(Action { source: source.into(), target: target.into(), sha256: hash, copy: true, done: false }); Ok(())
}
fn document_files(root: &Path) -> Result<Vec<PathBuf>> {
    check_chain(root)?;
    if !root.is_dir() { return Err(PersistenceError::new("UnsafePath", "Expected a directory", &[root])); }
    let mut paths = Vec::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(|e| PersistenceError::new("Io", e.to_string(), &[root]))?;
        check_chain(entry.path())?;
        if entry.file_type().is_file() && storage::has_supported_ext(entry.path()) { paths.push(entry.path().into()); }
    }
    Ok(paths)
}
fn path_digest(path: &Path) -> Result<String> {
    check_chain(path)?;
    if path.is_file() { return Ok(digest(&regular_bytes(path)?)); }
    if !path.is_dir() { return Err(PersistenceError::new("UnsafePath", "Missing transaction source", &[path])); }
    let mut entries = Vec::new();
    for entry in walkdir::WalkDir::new(path).follow_links(false) {
        let entry = entry.map_err(|e| PersistenceError::new("Io", e.to_string(), &[path]))?; check_chain(entry.path())?;
        if entry.path() != path { entries.push(entry.path().to_path_buf()); }
    }
    entries.sort(); let mut hash = Sha256::new();
    for entry in entries {
        hash.update(display(entry.strip_prefix(path).unwrap()).as_bytes()); hash.update([0]);
        if entry.is_file() { hash.update(regular_bytes(&entry)?); } hash.update([0]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Native no-replace only. EXDEV/unsupported volumes are returned, never copy-delete.
pub(super) fn move_no_replace(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" { fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32; }
        let wide = |path: &Path| -> io::Result<Vec<u16>> {
            let parent = fs::canonicalize(path.parent().ok_or_else(|| io::Error::other("Missing parent"))?)?;
            let full = parent.join(path.file_name().ok_or_else(|| io::Error::other("Missing file name"))?);
            let mut result: Vec<_> = full.as_os_str().encode_wide().collect();
            if result.contains(&0) { return Err(io::Error::other("NUL in path")); } result.push(0); Ok(result)
        };
        let source = wide(source)?; let target = wide(target)?;
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }
    #[cfg(target_os = "linux")] {
        use std::os::unix::ffi::OsStrExt;
        let source = std::ffi::CString::new(source.as_os_str().as_bytes())?; let target = std::ffi::CString::new(target.as_os_str().as_bytes())?;
        if unsafe { libc::renameat2(libc::AT_FDCWD, source.as_ptr(), libc::AT_FDCWD, target.as_ptr(), libc::RENAME_NOREPLACE) } == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }
    #[cfg(target_os = "macos")] {
        use std::os::unix::ffi::OsStrExt;
        let source = std::ffi::CString::new(source.as_os_str().as_bytes())?; let target = std::ffi::CString::new(target.as_os_str().as_bytes())?;
        if unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) } == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))] { let _ = (source, target); Err(io::Error::new(io::ErrorKind::Unsupported, "Native no-replace is unavailable")) }
}
