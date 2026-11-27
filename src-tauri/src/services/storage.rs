use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use chrono::{DateTime, Utc};
use crate::models::{NoteMetadata, Project};

/// 系统/重型目录名：扫描与监听时跳过（代码仓库、构建产物、系统目录等）
pub fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "Trash"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | "__pycache__"
                | ".git"
                | "AppData"
                | "Local Settings"
                | "NetHood"
                | "PrintHood"
                | "Recent"
                | "SendTo"
                | "Cookies"
                | "$Recycle.Bin"
                | "System Volume Information"
                | "Library"
                | "Caches"
                | "Logs"
                | "Temporary Items"
        )
}

/// Child symlinks/junctions must not turn a scan into a cycle or escape its root.
/// Explicit roots are checked separately and are allowed to be links.
pub fn is_scan_directory(entry: &fs::DirEntry) -> bool {
    entry.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false)
        && !is_directory_reparse_point(&entry.path())
}

fn is_directory_reparse_point(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        fs::symlink_metadata(path)
            .map(|m| m.is_dir() && m.file_attributes() & 0x400 != 0)
            .unwrap_or(true)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

pub(crate) fn scan_entries<'a>(root: &Path, cancelled: &'a impl Fn() -> bool) -> impl Iterator<Item = walkdir::Result<walkdir::DirEntry>> + 'a {
    let mut entries = WalkDir::new(root).follow_links(false).follow_root_links(true).into_iter();
    std::iter::from_fn(move || loop {
        if cancelled() { return None; }
        let entry = entries.next()?;
        if let Ok(entry) = &entry {
            if entry.depth() > 0 && (is_ignored_dir(&entry.file_name().to_string_lossy()) || entry.file_type().is_symlink() || (entry.file_type().is_dir() && is_directory_reparse_point(entry.path()))) {
                if entry.file_type().is_dir() { entries.skip_current_dir(); }
                continue;
            }
        }
        return Some(entry);
    })
}

fn note_entries<'a>(root: &Path, cancelled: &'a impl Fn() -> bool) -> impl Iterator<Item = walkdir::DirEntry> + 'a {
    scan_entries(root, cancelled).filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_note_file(e.path()))
}

#[derive(serde::Serialize)]
pub struct DirectorySnapshot {
    pub project: Option<Project>,
    pub notes: Vec<NoteMetadata>,
}

pub fn root_scopes_overlap(removed: &Path, retained: &[PathBuf]) -> std::io::Result<bool> {
    if retained.is_empty() { return Ok(false); }
    fn lexical_key(path: &Path) -> PathBuf {
        let path: PathBuf = path.components().collect();
        #[cfg(windows)] { PathBuf::from(path.to_string_lossy().to_lowercase()) }
        #[cfg(not(windows))] { path }
    }
    let removed_key = lexical_key(removed);
    let canonical_removed = match fs::canonicalize(removed) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    };
    for root in retained {
        let key = lexical_key(root);
        if removed_key.starts_with(&key) || key.starts_with(&removed_key) { return Ok(true); }
        let canonical_root = match fs::canonicalize(root) {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
            Err(error) => return Err(error),
        };
        if canonical_removed.starts_with(&canonical_root) || canonical_root.starts_with(&canonical_removed) { return Ok(true); }
    }
    Ok(false)
}

pub fn read_directory_snapshot(root: &Path) -> std::io::Result<DirectorySnapshot> {
    match fs::metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(DirectorySnapshot { project: None, notes: Vec::new() }),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.is_dir() => return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "Expected a directory")),
        Ok(_) => (),
    }
    let mut children: std::collections::BTreeMap<PathBuf, Vec<PathBuf>> = std::collections::BTreeMap::new();
    let mut notes = Vec::new();
    let never_cancel = || false;
    let entries = scan_entries(root, &never_cancel);
    for entry in entries {
        let entry = entry.map_err(std::io::Error::other)?;
        if entry.depth() == 0 { continue; }
        let path = entry.path();
        if entry.file_type().is_dir() {
            children.entry(path.parent().unwrap().to_path_buf()).or_default().push(path.to_path_buf());
        } else if entry.file_type().is_file() && has_supported_ext(path) {
            let metadata = entry.metadata().map_err(std::io::Error::other)?;
            let note = note_metadata(path, root, &metadata).ok_or_else(|| std::io::Error::other(format!("File changed or metadata unavailable: {}", path.display())))?;
            notes.push(note);
        }
    }
    fn project(path: &Path, directories: &std::collections::BTreeMap<PathBuf, Vec<PathBuf>>) -> Project {
        let mut children: Vec<_> = directories.get(path).into_iter().flatten().map(|child| project(child, directories)).collect();
        children.sort_by_key(|child| child.name.to_lowercase());
        Project { path: path.to_string_lossy().into_owned(), name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(), children, is_root: false }
    }
    notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(DirectorySnapshot { project: Some(project(root, &children)), notes })
}

pub fn scan_projects(root_path: &Path, cancelled: &impl Fn() -> bool) -> std::io::Result<Vec<Project>> {
    let mut projects = Vec::new();
    if cancelled() {
        return Ok(projects);
    }
    match fs::metadata(root_path) {
        Ok(metadata) if metadata.is_dir() => (),
        Ok(_) => return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("Expected a directory: {}", root_path.display()))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(projects),
        Err(error) => return Err(error),
    }
    let entries = match fs::read_dir(root_path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(projects),
        Err(error) => return Err(error),
    };

    for entry in entries {
        if cancelled() { break; }
        let entry = entry?;
        let path = entry.path();
        if is_scan_directory(&entry) {
            let name = path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            // Skip hidden / system directories
            if is_ignored_dir(&name) {
                continue;
            }
            let children = scan_projects(&path, cancelled)?;
            projects.push(Project {
                name,
                path: path.to_string_lossy().to_string(),
                children,
                is_root: false,
            });
        }
    }

    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(projects)
}

/// 可收录文件白名单（扫描 / 单文件夹扫描 / is_note_file 共用同一份规则）
pub fn has_supported_ext(path: &Path) -> bool {
    let ext = path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    matches!(ext.as_str(), "md" | "markdown" | "txt" | "html" | "htm" | "pdf")
        || is_encrypted_file(path)
}

/// PDF 是二进制文档：只读预览，不参与文本读写与全文搜索
pub fn is_pdf_file(path: &Path) -> bool {
    path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .eq_ignore_ascii_case("pdf")
}

/// 全量扫描（带进度回调）：每收录一个笔记文件调用一次 on_file，参数为当前累计数量。
pub fn scan_notes_with_progress(root_path: &Path, mut on_file: impl FnMut(usize), cancelled: &impl Fn() -> bool) -> Vec<NoteMetadata> {
    let mut notes = Vec::new();
    if cancelled() || !root_path.exists() {
        return notes;
    }

    for entry in note_entries(root_path, cancelled) {
        if let Some(meta) = entry.metadata().ok().and_then(|metadata| note_metadata(entry.path(), root_path, &metadata)) {
            notes.push(meta);
            on_file(notes.len());
        }
    }

    notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    notes
}

pub fn scan_notes_in_folder(folder_path: &Path, root_path: &Path) -> Vec<NoteMetadata> {
    let mut notes = Vec::new();
    if !folder_path.exists() {
        return notes;
    }

    match fs::read_dir(folder_path) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                if !has_supported_ext(&path) {
                    continue;
                }
                if let Some(name) = path.file_name() {
                    if name.to_string_lossy().starts_with('.') {
                        continue;
                    }
                }
                if let Some(meta) = build_note_metadata(&path, root_path) {
                    notes.push(meta);
                }
            }
        }
        Err(_) => {}
    }

    notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    notes
}

pub fn build_note_metadata(path: &Path, root_path: &Path) -> Option<NoteMetadata> {
    let metadata = fs::metadata(path).ok()?;
    note_metadata(path, root_path, &metadata)
}

pub(crate) fn note_metadata(path: &Path, root_path: &Path, metadata: &fs::Metadata) -> Option<NoteMetadata> {
    if !metadata.is_file() { return None; }
    let encrypted = is_encrypted_file(path);
    // For encrypted files (.md.encrypted), strip both suffixes to get the title
    let title = if encrypted {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        name.trim_end_matches(".encrypted")
            .trim_end_matches(".md")
            .to_string()
    } else {
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    };
    
    let folder = path.parent()
        .map(|p| {
            p.strip_prefix(root_path)
                .unwrap_or(p)
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default();

    let created_at: DateTime<Utc> = metadata.created()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        .into();
    let modified_at: DateTime<Utc> = metadata.modified()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        .into();

    let id = path.to_string_lossy().to_string();

    Some(NoteMetadata {
        id,
        title,
        path: path.to_string_lossy().to_string(),
        folder,
        created_at,
        modified_at,
        pinned: false,
        size: metadata.len(),
        is_encrypted: encrypted,
    })
}

/// 判断是否为可收录的笔记文件（扩展名白名单 + 非隐藏文件，与扫描 walker 的过滤规则一致）
pub fn is_note_file(path: &Path) -> bool {
    if !has_supported_ext(path) {
        return false;
    }
    !path.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false)
}

/// Test oracle only: production totals come from the successful metadata scan,
/// never a second whole-tree walk racing the scan.
#[cfg(test)]
pub fn count_note_files(root_path: &Path) -> usize {
    note_entries(root_path, &|| false).count()
}

/// Check if path is an encrypted note (.md.encrypted)
fn is_encrypted_file(path: &Path) -> bool {
    path.to_string_lossy().ends_with(".md.encrypted")
}

#[cfg(unix)]
#[path = "atomic_unix.rs"]
mod atomic_unix;

pub fn write_atomic(path: impl AsRef<Path>, content: impl AsRef<[u8]>) -> std::io::Result<()> {
    use std::io::Write;
    write_atomic_with(path.as_ref(), |file| file.write_all(content.as_ref()))
}

pub fn write_atomic_checked(path: &Path, content: &[u8], check: impl Fn(&Path) -> std::io::Result<()>) -> std::io::Result<()> {
    use std::io::Write;
    write_atomic_with_check(path, |file| file.write_all(content), check)
}

fn write_atomic_with(path: &Path, write: impl FnOnce(&mut fs::File) -> std::io::Result<()>) -> std::io::Result<()> {
    write_atomic_with_check(path, write, |_| Ok(()))
}

fn write_atomic_with_check(
    path: &Path,
    write: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
    check: impl Fn(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    #[cfg(unix)]
    let _write_guard = atomic_unix::WRITES.lock().map_err(|_| std::io::Error::other("Atomic write lock poisoned"))?;
    let target = if path.is_symlink() { fs::canonicalize(path)? } else { path.to_path_buf() };
    writable_metadata(&target)?;
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(parent)?;
    // Canonicalizing the parent also supplies extended-length Windows/UNC paths, even
    // when the target does not exist yet. Do not canonicalize a missing target.
    let parent = fs::canonicalize(parent)?;
    let target = parent.join(target.file_name().ok_or_else(|| std::io::Error::other("Missing file name"))?);
    let temporary = parent.join(format!(".miaoyan-{}.tmp", uuid::Uuid::new_v4()));
    #[cfg(windows)]
    let mut file = atomic_windows::create_private(&temporary)?;
    #[cfg(unix)]
    let mut file = atomic_unix::create_private(&temporary)?;
    let result = write(&mut file).and_then(|()| file.sync_all());
    #[cfg(windows)]
    drop(file);
    if let Err(error) = result {
        return Err(cleanup_failed_write(&temporary, error));
    }

    if let Err(error) = check(&target) { return Err(cleanup_failed_write(&temporary, error)); }

    // Never use an earlier metadata snapshot to decide whether rename may overwrite.
    // A concurrent creator must go through the same permissions-preserving replacement.
    #[cfg(windows)]
    let result = atomic_windows::move_no_replace(&temporary, &target);
    #[cfg(unix)]
    let result = atomic_unix::move_no_replace(&temporary, &target);
    match result {
        Ok(()) => {
            #[cfg(unix)]
            fs::File::open(&parent)?.sync_all()?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            #[cfg(windows)]
            let metadata = match writable_metadata(&target) {
                Ok(Some(metadata)) => metadata,
                Ok(None) => return Err(cleanup_failed_write(&temporary, std::io::Error::new(std::io::ErrorKind::NotFound, "Target disappeared before replacement"))),
                Err(error) => return Err(cleanup_failed_write(&temporary, error)),
            };
            #[cfg(windows)]
            {
                let _ = metadata;
                // This function owns cleanup now: a failed recovery MUST retain copies.
                replace_existing_file_with_check(&temporary, &target, atomic_windows::replace, check)
            }
            #[cfg(unix)]
            {
                let result = (|| {
                    atomic_unix::replace(&file, &temporary, &target)?;
                    fs::File::open(&parent)?.sync_all()
                })();
                result.map_err(|error| cleanup_failed_write(&temporary, error))
            }
        }
        Err(error) => Err(cleanup_failed_write(&temporary, error)),
    }
}

fn writable_metadata(path: &Path) -> std::io::Result<Option<fs::Metadata>> {
    // Existing symlinks were resolved at entry. Refuse a newly raced symlink rather
    // than replacing the link itself or accidentally changing a different file.
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.permissions().readonly() => Ok(Some(meta)),
        Ok(_) => Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "Target is not a writable regular file")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn cleanup_failed_write(source: &Path, error: std::io::Error) -> std::io::Error {
    match fs::remove_file(source) {
        Ok(()) => error,
        Err(cleanup) if cleanup.kind() == std::io::ErrorKind::NotFound => error,
        Err(cleanup) => std::io::Error::new(error.kind(), format!("{error}; temporary retained at {}: {cleanup}", source.display())),
    }
}

#[cfg(all(test, windows))]
fn replace_existing_file_with(
    source: &Path,
    target: &Path,
    replace: impl FnOnce(&Path, &Path, &Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    replace_existing_file_with_check(source, target, replace, |_| Ok(()))
}

#[cfg(windows)]
fn replace_existing_file_with_check(
    source: &Path,
    target: &Path,
    replace: impl FnOnce(&Path, &Path, &Path) -> std::io::Result<()>,
    check: impl Fn(&Path) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let backup = source.with_extension("bak");
    match replace(source, target, &backup) {
        Ok(()) => {
            check(&backup).map_err(|error| std::io::Error::new(error.kind(), format!("{error}; concurrent disk version retained at {}", backup.display())))?;
            fs::remove_file(&backup).map_err(|error| {
            std::io::Error::new(error.kind(), format!("Replacement committed, but backup retained at {}: {error}", backup.display()))
            })
        },
        Err(error) => {
            // ReplaceFileW with a backup guarantees original names for 1176/1175
            // and other failures. Only 1177 moved the original to the backup name.
            // https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-replacefilew
            if error.raw_os_error() == Some(1177) {
                if let Err(recovery) = atomic_windows::move_no_replace(&backup, target) {
                    // Never overwrite a concurrent creation; never delete either copy
                    // when recovery fails. Return both absolute paths for manual recovery.
                    return Err(std::io::Error::new(error.kind(), format!(
                        "{error}; restoring {} failed: {recovery}; original retained at {}; replacement retained at {}",
                        target.display(), backup.display(), source.display()
                    )));
                }
            }
            Err(cleanup_failed_write(source, error))
        }
    }
}

#[cfg(windows)]
mod atomic_windows {
    use super::*;
    use std::{ffi::c_void, io, os::windows::{ffi::OsStrExt, io::{AsRawHandle, FromRawHandle, OwnedHandle}}, ptr};

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        descriptor: *mut c_void,
        inherit_handle: i32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn CreateFileW(path: *const u16, access: u32, sharing: u32, security: *const SecurityAttributes, disposition: u32, flags: u32, template: *mut c_void) -> *mut c_void;
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
        fn ReplaceFileW(target: *const u16, source: *const u16, backup: *const u16, flags: u32, exclude: *mut c_void, reserved: *mut c_void) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(token: *mut c_void, class: u32, info: *mut c_void, length: u32, needed: *mut u32) -> i32;
        fn ConvertSidToStringSidW(sid: *mut c_void, text: *mut *mut u16) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text: *const u16, revision: u32, descriptor: *mut *mut c_void, size: *mut u32) -> i32;
    }

    struct LocalMemory(*mut c_void);
    impl Drop for LocalMemory {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0); }
        }
    }

    fn checked(result: i32) -> io::Result<()> {
        if result == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }

    fn wide(path: &Path) -> io::Result<Vec<u16>> {
        let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let path = fs::canonicalize(parent)?.join(path.file_name().ok_or_else(|| io::Error::other("Missing file name"))?);
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "NUL in file name")); }
        wide.push(0);
        Ok(wide)
    }

    fn private_descriptor() -> io::Result<LocalMemory> {
        unsafe {
            let mut token = ptr::null_mut();
            checked(OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token))?; // TOKEN_QUERY
            let token = OwnedHandle::from_raw_handle(token);
            let mut needed = 0;
            GetTokenInformation(token.as_raw_handle(), 1, ptr::null_mut(), 0, &mut needed); // TokenUser
            if needed == 0 { return Err(io::Error::last_os_error()); }
            // TOKEN_USER begins with a SID pointer; pointer-sized storage ensures alignment.
            let mut info = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
            checked(GetTokenInformation(token.as_raw_handle(), 1, info.as_mut_ptr().cast(), needed, &mut needed))?;
            let sid = *(info.as_ptr().cast::<*mut c_void>());
            let mut text = ptr::null_mut();
            checked(ConvertSidToStringSidW(sid, &mut text))?;
            let _text = LocalMemory(text.cast());
            let mut length = 0;
            while *text.add(length) != 0 { length += 1; }
            let user = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            // A protected DACL prevents any parent-directory ACE being inherited.
            // Do not use Owner Rights: the token's default owner can be a group.
            let sddl: Vec<u16> = format!("D:P(A;;FA;;;SY)(A;;FA;;;{user})").encode_utf16().chain(Some(0)).collect();
            let mut descriptor = ptr::null_mut();
            checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, ptr::null_mut()))?;
            Ok(LocalMemory(descriptor))
        }
    }

    pub(super) fn create_private(path: &Path) -> io::Result<fs::File> {
        let path = wide(path)?;
        let descriptor = private_descriptor()?;
        let security = SecurityAttributes {
            length: std::mem::size_of::<SecurityAttributes>() as u32,
            descriptor: descriptor.0,
            inherit_handle: 0,
        };
        // CREATE_NEW + explicit DACL protects the file from its first instant of existence.
        let handle = unsafe { CreateFileW(path.as_ptr(), 0x40000000, 0, &security, 1, 0x80, ptr::null_mut()) };
        if handle == -1isize as *mut c_void { return Err(io::Error::last_os_error()); }
        Ok(unsafe { fs::File::from_raw_handle(handle) })
    }

    pub(super) fn move_no_replace(source: &Path, target: &Path) -> io::Result<()> {
        let source = wide(source)?;
        let target = wide(target)?;
        // No MOVEFILE_REPLACE_EXISTING, including when restoring a backup.
        checked(unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) })
    }

    pub(super) fn replace(source: &Path, target: &Path, backup: &Path) -> io::Result<()> {
        let source = wide(source)?;
        let target = wide(target)?;
        let backup = wide(backup)?;
        // Preserve destination DACL/streams; never ignore ACL or attribute merge errors.
        checked(unsafe { ReplaceFileW(target.as_ptr(), source.as_ptr(), backup.as_ptr(), 0, ptr::null_mut(), ptr::null_mut()) })
    }
}

pub fn get_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("miaoyan")
}

pub fn load_config(path: &Path) -> Result<crate::models::AppConfig, String> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|error| format!("Invalid configuration {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(crate::models::AppConfig::default()),
        Err(error) => Err(format!("Cannot read configuration {}: {error}", path.display())),
    }
}

pub fn ensure_config_dir() -> PathBuf {
    let config_dir = get_config_dir();
    if !config_dir.exists() {
        let _ = fs::create_dir_all(&config_dir);
    }
    config_dir
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("miaoyan-storage-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn config_load_distinguishes_missing_from_corrupt_or_unreadable() {
        let dir = TestDirectory::new();
        let path = dir.0.join("config.json");
        assert!(load_config(&path).is_ok());
        assert!(!path.exists());
        fs::write(&path, "{broken").unwrap();
        assert!(load_config(&path).is_err(), "Corrupt configuration must not become defaults");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(load_config(&path).is_err(), "IO errors must not become defaults");
        fs::remove_dir(&path).unwrap();
        let mut config = crate::models::AppConfig::default();
        config.storage_path = "isolated-library".to_string();
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        assert_eq!(load_config(&path).unwrap().storage_path, "isolated-library");
    }

    // Scanning fixtures contain synthetic data only.
    #[cfg(any(unix, windows))]
    fn directory_link(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link).arg(target).output().unwrap();
            assert!(output.status.success(), "junction creation failed: {:?}; stdout={}; stderr={}",
                output.status, String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        }
    }

    #[test]
    #[ignore = "Synthetic 10k/50k filesystem benchmark; run explicitly with --release"]
    fn directory_snapshot_large_library() {
        for (count, budget_ms) in [(10_000usize, 1_000u128), (50_000, 5_000)] {
            let dir = TestDirectory::new();
            for folder in 0..100 { fs::create_dir(dir.0.join(format!("folder-{folder}"))).unwrap(); }
            for index in 0..count { fs::write(dir.0.join(format!("folder-{}/note-{index}.md", index % 100)), "fixture").unwrap(); }
            let started = std::time::Instant::now();
            let mut enumerated = 0;
            for entry in WalkDir::new(&dir.0) {
                let entry = entry.unwrap();
                if entry.file_type().is_file() {
                    assert_eq!(entry.metadata().unwrap().len(), 7);
                    enumerated += 1;
                }
            }
            assert_eq!(enumerated, count);
            println!("directory_enumeration_notes={count} cached_metadata_ms={}", started.elapsed().as_millis());
            let mut durations = Vec::new();
            for _ in 0..3 {
                let started = std::time::Instant::now();
                let snapshot = read_directory_snapshot(&dir.0).unwrap();
                assert_eq!(snapshot.notes.len(), count);
                assert_eq!(snapshot.project.unwrap().children.len(), 100);
                durations.push(started.elapsed().as_millis());
            }
            durations.sort();
            println!("directory_snapshot_notes={count} median_ms={} max_ms={}", durations[1], durations[2]);
            assert!(durations[1] <= budget_ms, "{count} files exceeded the {budget_ms}ms snapshot budget");
        }
    }

    #[test]
    fn canceled_directory_walk_and_project_discovery_stop_before_visiting_more_entries() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let dir = TestDirectory::new();
        fs::create_dir(dir.0.join("child")).unwrap();
        fs::write(dir.0.join("child/note.md"), "fixture").unwrap();
        let canceled = AtomicBool::new(false);
        let should_cancel = || canceled.load(Ordering::SeqCst);
        let mut entries = scan_entries(&dir.0, &should_cancel);
        assert_eq!(entries.next().unwrap().unwrap().depth(), 0);
        canceled.store(true, Ordering::SeqCst);
        assert!(entries.next().is_none());
        assert!(scan_projects(&dir.0, &|| canceled.load(Ordering::SeqCst)).unwrap().is_empty());
        assert!(scan_notes_with_progress(&dir.0, |_| panic!("Canceled scan emitted progress"), &|| canceled.load(Ordering::SeqCst)).is_empty());
    }

    #[test]
    fn a_real_file_scan_stops_at_the_cancellation_boundary_instead_of_reading_the_remaining_library() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let dir = TestDirectory::new();
        for index in 0..500 { fs::write(dir.0.join(format!("note-{index}.md")), "fixture").unwrap(); }
        let canceled = AtomicBool::new(false);
        let mut progress = Vec::new();
        let notes = scan_notes_with_progress(&dir.0, |count| {
            progress.push(count);
            if count == 7 { canceled.store(true, Ordering::SeqCst); }
        }, &|| canceled.load(Ordering::SeqCst));
        assert_eq!(progress, [1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(notes.len(), 7);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 500);
    }

    #[test]
    fn scope_overlap_detects_nested_roots_and_keeps_disjoint_removals_incremental() {
        let dir = TestDirectory::new();
        let main = dir.0.join("main");
        let nested = main.join("Parent/Child");
        let hidden = main.join(".selected");
        let extra = dir.0.join("extra");
        for path in [&nested, &hidden, &extra] { fs::create_dir_all(path).unwrap(); }
        assert!(!root_scopes_overlap(&extra, &[main.clone()]).unwrap());
        assert!(root_scopes_overlap(&nested, &[main.clone()]).unwrap());
        assert!(root_scopes_overlap(&main, &[nested]).unwrap());
        assert!(root_scopes_overlap(&hidden, &[main.clone()]).unwrap());
        assert!(root_scopes_overlap(&dir.0.join("missing-alias"), &[main]).unwrap());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn scope_overlap_detects_physical_aliases_and_child_links_that_are_not_covered_by_a_main_walk() {
        let dir = TestDirectory::new();
        let main = dir.0.join("main");
        let target = dir.0.join("target");
        fs::create_dir(&main).unwrap(); fs::create_dir(&target).unwrap();
        let child_alias = main.join("linked");
        let other_alias = dir.0.join("other-alias");
        directory_link(&target, &child_alias); directory_link(&target, &other_alias);
        assert!(root_scopes_overlap(&child_alias, &[main]).unwrap());
        assert!(root_scopes_overlap(&other_alias, &[child_alias]).unwrap());
    }

    #[test]
    fn directory_snapshot_includes_descendants_and_excludes_ignored_or_linked_children() {
        let dir = TestDirectory::new();
        let root = dir.0.join("incoming");
        fs::create_dir_all(root.join("deep/more")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("deep/more/note.md"), "body").unwrap();
        fs::write(root.join("node_modules/hidden.md"), "ignored").unwrap();
        let snapshot = read_directory_snapshot(&root).unwrap();
        assert_eq!(snapshot.notes.len(), 1);
        let project = snapshot.project.unwrap();
        assert_eq!(project.children.len(), 1);
        assert_eq!(project.children[0].name, "deep");
        assert_eq!(project.children[0].children[0].name, "more");
        #[cfg(any(unix, windows))] {
            directory_link(&root.join("deep"), &root.join("linked"));
            assert_eq!(read_directory_snapshot(&root).unwrap().notes.len(), 1);
        }
        assert!(read_directory_snapshot(&root.join("missing")).unwrap().project.is_none());
        assert!(read_directory_snapshot(&root.join("deep/more/note.md")).is_err());
    }

    #[test]
    fn directory_snapshots_refresh_metadata_after_edit_and_remove() {
        let dir = TestDirectory::new();
        let path = dir.0.join("note.md");
        fs::write(&path, "old").unwrap();
        let old = read_directory_snapshot(&dir.0).unwrap();
        assert_eq!(old.notes[0].size, 3);
        fs::write(&path, "updated body").unwrap();
        assert_eq!(read_directory_snapshot(&dir.0).unwrap().notes[0].size, 12);
        assert_eq!(build_note_metadata(&path, &dir.0).unwrap().size, 12);
        fs::remove_file(&path).unwrap();
        assert!(read_directory_snapshot(&dir.0).unwrap().notes.is_empty());
        assert!(build_note_metadata(&path, &dir.0).is_none());
        assert_eq!(old.notes[0].size, 3);
    }

    #[test]
    fn explicit_metadata_request_never_treats_a_directory_named_md_as_a_note() {
        let dir = TestDirectory::new();
        let path = dir.0.join("folder.md"); fs::create_dir(&path).unwrap();
        assert!(build_note_metadata(&path, &dir.0).is_none());
    }

    #[test]
    fn scan_contract_includes_hidden_root_and_preserves_metadata_and_hierarchy() {
        let dir = TestDirectory::new();
        let root = dir.0.join(".selected");
        for child in ["Alpha/deep", "zeta", ".hidden", "Trash", "node_modules"] {
            fs::create_dir_all(root.join(child)).unwrap();
        }
        for name in ["top.md", "Alpha/deep/book.PDF", "Alpha/secret.md.encrypted",
            "zeta/page.html", ".hidden/no.md", "Trash/no.md", "node_modules/no.md", ".skip.md", "no.bin"] {
            fs::write(root.join(name), b"synthetic").unwrap();
        }
        let mut progress = Vec::new();
        let notes = scan_notes_with_progress(&root, |n| progress.push(n), &|| false);
        assert_eq!(notes.len(), 4);
        assert_eq!(count_note_files(&root), 4);
        assert_eq!(progress, vec![1, 2, 3, 4]);
        let encrypted = notes.iter().find(|n| n.is_encrypted).unwrap();
        assert_eq!(encrypted.title, "secret");
        assert_eq!(encrypted.folder, "Alpha");
        assert_eq!(encrypted.size, 9);
        assert_eq!(encrypted.id, encrypted.path);
        assert!(!encrypted.pinned);
        assert!(notes.windows(2).all(|n| n[0].modified_at >= n[1].modified_at));
        let projects = scan_projects(&root, &|| false).unwrap();
        assert_eq!(projects.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Alpha", "zeta"]);
        assert_eq!(projects[0].children[0].name, "deep");
        assert!(!projects[0].is_root);
        assert_eq!(scan_notes_in_folder(&root, &root).len(), 1);
        let snapshot = read_directory_snapshot(&root).unwrap();
        assert_eq!(snapshot.notes.len(), 4);
        let encrypted = snapshot.notes.iter().find(|note| note.is_encrypted).unwrap();
        assert_eq!(encrypted.title, "secret");
        assert_eq!(encrypted.folder, "Alpha");
        assert_eq!(encrypted.size, 9);
        for note in &snapshot.notes {
            let disk = fs::metadata(&note.path).unwrap();
            assert_eq!(note.created_at, DateTime::<Utc>::from(disk.created().unwrap_or(std::time::SystemTime::UNIX_EPOCH)));
            assert_eq!(note.modified_at, DateTime::<Utc>::from(disk.modified().unwrap()));
            assert_eq!(note.id, note.path);
            assert!(!note.pinned);
        }
        let children = snapshot.project.unwrap().children;
        assert_eq!(children.iter().map(|child| child.name.as_str()).collect::<Vec<_>>(), ["Alpha", "zeta"]);
        assert_eq!(children[0].children[0].name, "deep");
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn scans_do_not_follow_child_directory_links_but_allow_selected_link_roots() {
        let dir = TestDirectory::new();
        let root = dir.0.join("root");
        let target = dir.0.join("target-folder");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(target.join("nested")).unwrap();
        fs::write(target.join("nested/note.md"), b"synthetic").unwrap();
        let link = root.join("linked");
        directory_link(&target, &link);
        let projects = scan_projects(&root, &|| false).unwrap();
        let notes = scan_notes_with_progress(&root, |_| {}, &|| false);
        let count = count_note_files(&root);
        let selected_notes = scan_notes_with_progress(&link, |_| {}, &|| false);
        let selected_projects = scan_projects(&link, &|| false).unwrap();
        // Remove the junction/symlink itself before fixture cleanup, never its target.
        #[cfg(windows)]
        fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        fs::remove_file(&link).unwrap();
        assert!(projects.is_empty(), "child links must not be scanned as projects");
        assert!(notes.is_empty());
        assert_eq!(count, 0);
        assert_eq!(selected_notes.len(), 1);
        assert_eq!(selected_projects.len(), 1);
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn directory_link_cycles_are_pruned_at_every_depth() {
        let dir = TestDirectory::new();
        let root = dir.0.join("root");
        fs::create_dir_all(root.join("child")).unwrap();
        fs::write(root.join("child/note.md"), b"synthetic").unwrap();
        let cycle = root.join("child").join("back");
        directory_link(&root, &cycle);
        let notes = scan_notes_with_progress(&root, |_| {}, &|| false);
        let projects = scan_projects(&root, &|| false).unwrap();
        let count = count_note_files(&root);
        #[cfg(windows)]
        fs::remove_dir(&cycle).unwrap();
        #[cfg(unix)]
        fs::remove_file(&cycle).unwrap();
        assert_eq!(count, 1);
        assert_eq!(notes.len(), 1);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "child");
        assert!(projects[0].children.is_empty());
    }

    #[cfg(windows)]
    mod security {
        use super::*;
        use std::{ffi::c_void, os::windows::io::AsRawHandle};

        #[link(name = "advapi32")]
        extern "system" {
            fn GetSecurityInfo(handle: *mut c_void, kind: u32, info: u32, owner: *mut *mut c_void, group: *mut *mut c_void, dacl: *mut *mut c_void, sacl: *mut *mut c_void, descriptor: *mut *mut c_void) -> u32;
            fn ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor: *mut c_void, revision: u32, info: u32, text: *mut *mut u16, length: *mut u32) -> i32;
            fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text: *const u16, revision: u32, descriptor: *mut *mut c_void, size: *mut u32) -> i32;
            fn SetFileSecurityW(path: *const u16, info: u32, descriptor: *mut c_void) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn LocalFree(memory: *mut c_void) -> *mut c_void;
        }

        pub fn dacl(file: &fs::File) -> String {
            unsafe {
                let mut descriptor = std::ptr::null_mut();
                assert_eq!(GetSecurityInfo(file.as_raw_handle(), 1, 4, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), &mut descriptor), 0);
                let mut text = std::ptr::null_mut();
                let converted = ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 4, &mut text, std::ptr::null_mut());
                LocalFree(descriptor);
                assert_ne!(converted, 0);
                let mut len = 0;
                while *text.add(len) != 0 { len += 1; }
                let result = String::from_utf16(std::slice::from_raw_parts(text, len)).unwrap();
                LocalFree(text.cast());
                result
            }
        }

        // Only called on a newly created file inside TestDirectory, never user data.
        pub fn set_test_dacl(path: &Path) {
            use std::os::windows::ffi::OsStrExt;
            let text: Vec<u16> = "D:P(A;;FA;;;OW)(A;;FR;;;WD)".encode_utf16().chain(Some(0)).collect();
            let path: Vec<u16> = fs::canonicalize(path).unwrap().as_os_str().encode_wide().chain(Some(0)).collect();
            unsafe {
                let mut descriptor = std::ptr::null_mut();
                assert_ne!(ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()), 0);
                let result = SetFileSecurityW(path.as_ptr(), 4 | 0x80000000, descriptor);
                LocalFree(descriptor);
                assert_ne!(result, 0, "{}", std::io::Error::last_os_error());
            }
        }
    }

    #[test]
    fn temporary_is_private_before_any_content_is_written() {
        let dir = TestDirectory::new();
        let path = dir.0.join("private.md");
        let check_and_write = |file: &mut fs::File| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(file.metadata()?.permissions().mode() & 0o777, 0o600);
            }
            #[cfg(windows)]
            {
                let dacl = security::dacl(file);
                assert!(dacl.starts_with("D:P("), "temporary DACL must be protected: {dacl}");
                let aces: Vec<_> = dacl.trim_start_matches("D:P").split('(').filter(|ace| !ace.is_empty()).collect();
                assert_eq!(aces.len(), 2, "only current user and SYSTEM: {dacl}");
                assert!(aces.contains(&"A;;FA;;;SY)"), "{dacl}");
                assert!(aces.iter().any(|ace| ace.starts_with("A;;FA;;;S-1-5-21-")), "{dacl}");
            }
            std::io::Write::write_all(file, b"private content")
        };
        write_atomic_with(&path, check_and_write).unwrap();
        write_atomic_with(&path, check_and_write).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "private content");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn concurrent_creation_preserves_the_new_targets_permissions() {
        let dir = TestDirectory::new();
        let path = dir.0.join("created-during-write.md");
        #[cfg(windows)]
        let mut expected_dacl = String::new();
        write_atomic_with(&path, |file| {
            fs::write(&path, "concurrent creator")?;
            #[cfg(windows)]
            {
                security::set_test_dacl(&path);
                expected_dacl = security::dacl(&fs::File::open(&path)?);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o640))?;
            }
            std::io::Write::write_all(file, b"replacement")
        }).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
        #[cfg(windows)]
        // ReplaceFile may mark automatic inheritance as processed (AI). Compare
        // protection and every ACE, not that bookkeeping bit.
        assert_eq!(security::dacl(&fs::File::open(&path).unwrap()).replace("D:PAI(", "D:P("), expected_dacl.replace("D:PAI(", "D:P("));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        }
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn last_instant_external_replacement_is_retained_instead_of_silently_discarded() {
        let dir = TestDirectory::new();
        let source = dir.0.join("prepared.tmp");
        let target = dir.0.join("note.md");
        fs::write(&source, "local draft").unwrap();
        fs::write(&target, "opened version").unwrap();
        let error = replace_existing_file_with_check(&source, &target, |source, target, backup| {
            fs::write(target, "last instant external version")?;
            atomic_windows::replace(source, target, backup)
        }, |path| {
            if fs::read(path)? == b"opened version" { Ok(()) }
            else { Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "Disk conflict")) }
        }).unwrap_err();
        assert!(error.to_string().contains("retained at"));
        assert_eq!(fs::read_to_string(source.with_extension("bak")).unwrap(), "last instant external version");
        assert_eq!(fs::read_to_string(&target).unwrap(), "local draft");
    }

    #[cfg(windows)]
    #[test]
    fn replacement_1176_keeps_original_and_cleans_replacement() {
        let dir = TestDirectory::new();
        let target = dir.0.join("note.md");
        let source = dir.0.join("replacement.tmp");
        fs::write(&target, "original").unwrap();
        fs::write(&source, "replacement").unwrap();
        let result = replace_existing_file_with(&source, &target, |_, _, _| {
            // With a backup specified, 1176 leaves both original names intact.
            Err(std::io::Error::from_raw_os_error(1176))
        });
        assert_eq!(result.unwrap_err().raw_os_error(), Some(1176));
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn replacement_1177_restores_original_from_backup() {
        let dir = TestDirectory::new();
        let target = dir.0.join("note.md");
        let source = dir.0.join("replacement.tmp");
        fs::write(&target, "original").unwrap();
        security::set_test_dacl(&target);
        let original_dacl = security::dacl(&fs::File::open(&target).unwrap());
        fs::write(&source, "replacement").unwrap();
        let result = replace_existing_file_with(&source, &target, |source, target, backup| {
            // Documented 1177 state: original moved to backup, replacement still named
            // source with the old attributes merged. Real file moves, no fake filesystem.
            fs::rename(target, backup)?;
            security::set_test_dacl(source);
            Err(std::io::Error::from_raw_os_error(1177))
        });
        assert_eq!(result.unwrap_err().raw_os_error(), Some(1177));
        assert_eq!(fs::read_to_string(&target).unwrap(), "original");
        assert_eq!(security::dacl(&fs::File::open(&target).unwrap()), original_dacl);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn failed_1177_recovery_preserves_both_copies_and_reports_paths() {
        let dir = TestDirectory::new();
        let target = dir.0.join("note.md");
        let source = dir.0.join("replacement.tmp");
        fs::write(&target, "original").unwrap();
        fs::write(&source, "replacement").unwrap();
        let mut backup_path = PathBuf::new();
        let error = replace_existing_file_with(&source, &target, |_, target, backup| {
            backup_path = backup.to_path_buf();
            fs::rename(target, backup)?;
            // A different writer wins the target name before recovery. Do not overwrite it.
            fs::write(target, "concurrent creation")?;
            Err(std::io::Error::from_raw_os_error(1177))
        }).unwrap_err();
        assert_eq!(fs::read_to_string(&target).unwrap(), "concurrent creation");
        assert_eq!(fs::read_to_string(&backup_path).unwrap(), "original");
        assert_eq!(fs::read_to_string(&source).unwrap(), "replacement");
        let message = error.to_string();
        assert!(message.contains(&backup_path.display().to_string()), "{message}");
        assert!(message.contains(&source.display().to_string()), "{message}");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 3);
    }

    #[test]
    fn a_concurrent_readonly_creation_is_not_overwritten() {
        let dir = TestDirectory::new();
        let path = dir.0.join("concurrent-readonly.md");
        let mut original_permissions = None;
        let result = write_atomic_with(&path, |file| {
            fs::write(&path, "concurrent creator")?;
            let permissions = fs::metadata(&path)?.permissions();
            let mut readonly = permissions.clone();
            readonly.set_readonly(true);
            original_permissions = Some(permissions);
            fs::set_permissions(&path, readonly)?;
            std::io::Write::write_all(file, b"replacement")
        });
        fs::set_permissions(&path, original_permissions.unwrap()).unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "concurrent creator");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn write_only_target_permissions_are_preserved() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TestDirectory::new();
        let path = dir.0.join("write-only.md");
        fs::write(&path, "original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o200)).unwrap();
        write_atomic(&path, "replacement").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o200);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn default_acl_cannot_leak_into_new_or_replaced_notes() {
        use std::os::{fd::AsRawFd, unix::fs::PermissionsExt};
        // Linux UAPI posix_acl_xattr.h: version 2, little-endian entries.
        fn acl(named_uid: u32) -> Vec<u8> {
            let mut bytes = 2u32.to_le_bytes().to_vec();
            for (tag, perm, id) in [(1u16, 6u16, u32::MAX), (2, 4, named_uid),
                (4, 0, u32::MAX), (16, 4, u32::MAX), (32, 0, u32::MAX)] {
                bytes.extend(tag.to_le_bytes());
                bytes.extend(perm.to_le_bytes());
                bytes.extend(id.to_le_bytes());
            }
            bytes
        }
        fn set(file: &fs::File, name: &std::ffi::CStr, value: &[u8]) {
            assert_eq!(unsafe { libc::fsetxattr(file.as_raw_fd(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0) }, 0,
                "ACL-capable temporary filesystem required: {}", std::io::Error::last_os_error());
        }
        fn get(file: &fs::File) -> Option<Vec<u8>> {
            let mut value = vec![0u8; 256];
            let len = unsafe { libc::fgetxattr(file.as_raw_fd(), c"system.posix_acl_access".as_ptr(), value.as_mut_ptr().cast(), value.len()) };
            if len < 0 {
                assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ENODATA));
                None
            } else {
                value.truncate(len as usize);
                Some(value)
            }
        }
        let dir = TestDirectory::new();
        let plain = dir.0.join("plain.md");
        let restricted = dir.0.join("acl.md");
        fs::write(&plain, "original").unwrap();
        fs::set_permissions(&plain, fs::Permissions::from_mode(0o640)).unwrap();
        fs::write(&restricted, "original").unwrap();
        let original_acl = acl(unsafe { libc::geteuid() }.wrapping_add(1));
        set(&fs::File::open(&restricted).unwrap(), c"system.posix_acl_access", &original_acl);
        let inherited_acl = acl(unsafe { libc::geteuid() }.wrapping_add(2));
        set(&fs::File::open(&dir.0).unwrap(), c"system.posix_acl_default", &inherited_acl);
        for path in [&plain, &restricted, &dir.0.join("new.md")] {
            write_atomic_with(path, |file| {
                assert_eq!(file.metadata()?.permissions().mode() & 0o077, 0);
                assert_eq!(get(file), None, "discard inherited entries before writing");
                std::io::Write::write_all(file, b"replacement")
            }).unwrap();
        }
        assert_eq!(get(&fs::File::open(&plain).unwrap()), None);
        assert_eq!(get(&fs::File::open(&restricted).unwrap()), Some(original_acl));
        assert_eq!(fs::metadata(&plain).unwrap().permissions().mode() & 0o777, 0o640);
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 3);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_inherited_acl_is_blocked_at_creation_and_original_acl_is_preserved() {
        use std::process::Command;
        let dir = TestDirectory::new();
        let path = dir.0.join("acl.md");
        fs::write(&path, "original").unwrap();
        assert!(Command::new("/bin/chmod").args(["+a", "everyone deny writeextattr"]).arg(&path).status().unwrap().success());
        let acl = |file: &fs::File| atomic_unix::acl_fingerprint(file).unwrap();
        let original_acl = acl(&fs::File::open(&path).unwrap());
        assert!(Command::new("/bin/chmod").args(["+a", "everyone allow read,file_inherit,directory_inherit"]).arg(&dir.0).status().unwrap().success());
        for target in [&path, &dir.0.join("new.md")] {
            write_atomic_with(target, |file| {
                assert!(atomic_unix::acl_is_empty(file)?);
                std::io::Write::write_all(file, b"replacement")
            }).unwrap();
        }
        assert_eq!(acl(&fs::File::open(&path).unwrap()), original_acl);
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn denied_acl_read_keeps_original_and_cleans_temporary() {
        use std::process::Command;
        let dir = TestDirectory::new();
        let path = dir.0.join("unreadable-security.md");
        fs::write(&path, "original").unwrap();
        assert!(Command::new("/bin/chmod").args(["+a", "everyone deny readsecurity"]).arg(&path).status().unwrap().success());
        let result = write_atomic(&path, "replacement");
        // Restore only the ACL on this test's newly created file for cleanup.
        assert!(Command::new("/bin/chmod").arg("-N").arg(&path).status().unwrap().success());
        assert!(result.is_err(), "run as an unprivileged user so the deny ACE is enforced");
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires membership in a second group; no privileges are added"]
    fn replacement_preserves_a_non_parent_group() {
        use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
        let dir = TestDirectory::new();
        let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
        assert!(count >= 0);
        let mut groups = vec![0 as libc::gid_t; count as usize];
        assert!(unsafe { libc::getgroups(count, groups.as_mut_ptr()) } >= 0);
        groups.push(unsafe { libc::getegid() });
        let parent_gid = fs::metadata(&dir.0).unwrap().gid();
        let gid = groups.into_iter().find(|gid| *gid != parent_gid).expect("second group required");
        let path = dir.0.join("group.md");
        fs::write(&path, "original").unwrap();
        let original = fs::File::open(&path).unwrap();
        assert_eq!(unsafe { libc::fchown(original.as_raw_fd(), original.metadata().unwrap().uid(), gid) }, 0);
        write_atomic(&path, "replacement").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().gid(), gid);
        assert_eq!(original.metadata().unwrap().gid(), gid);
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
    }

    #[cfg(unix)]
    #[test]
    fn native_no_replace_moves_without_linking_and_never_clobbers() {
        let dir = TestDirectory::new();
        let source = dir.0.join("source");
        let target = dir.0.join("target");
        // Directories cannot be hard-linked: exercise the same native primitive
        // used for new notes without requiring an exFAT mount or privileges.
        fs::create_dir(&source).unwrap();
        atomic_unix::move_no_replace(&source, &target).unwrap();
        assert!(!source.exists());
        fs::create_dir(&source).unwrap();
        assert_eq!(atomic_unix::move_no_replace(&source, &target).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        assert!(source.is_dir());
        assert!(target.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn failed_native_replacement_keeps_original_inode_and_content() {
        use std::os::unix::fs::MetadataExt;
        let dir = TestDirectory::new();
        let path = dir.0.join("original.md");
        fs::write(&path, "original").unwrap();
        let original = fs::File::open(&path).unwrap();
        let temporary = dir.0.join("replacement.tmp");
        let file = fs::File::create(&temporary).unwrap();
        // An unlinked source fd is still valid for permission copying and sync,
        // but the actual rename must fail. No user directories or modes changed.
        fs::remove_file(&temporary).unwrap();
        assert!(atomic_unix::replace(&file, &temporary, &path).is_err());
        assert_eq!(original.metadata().unwrap().ino(), fs::metadata(&path).unwrap().ino());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn application_saves_to_the_same_path_do_not_overlap() {
        use std::{sync::mpsc, time::Duration};
        let dir = TestDirectory::new();
        let path = dir.0.join("serial.md");
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (second_tx, second_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            let path = &path;
            let first = scope.spawn(move || write_atomic_with(path, |file| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                std::io::Write::write_all(file, b"first")
            }));
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let second = scope.spawn(move || write_atomic_with(path, |file| {
                second_tx.send(()).unwrap();
                std::io::Write::write_all(file, b"second")
            }));
            let overlapped = second_rx.recv_timeout(Duration::from_millis(100)).is_ok();
            release_tx.send(()).unwrap();
            first.join().unwrap().unwrap();
            second.join().unwrap().unwrap();
            assert!(!overlapped);
        });
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn readonly_target_is_rejected_before_writing() {
        let dir = TestDirectory::new();
        let path = dir.0.join("readonly.md");
        fs::write(&path, "original").unwrap();
        let permissions = fs::metadata(&path).unwrap().permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&path, readonly).unwrap();
        let result = write_atomic_with(&path, |_| panic!("must reject before writing"));
        fs::set_permissions(&path, permissions).unwrap();
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn a_non_delete_shared_handle_keeps_original_and_cleans_temporary() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = TestDirectory::new();
        let path = dir.0.join("shared.md");
        fs::write(&path, "original").unwrap();
        let _handle = fs::OpenOptions::new().read(true).share_mode(1 | 2).open(&path).unwrap();
        assert!(write_atomic(&path, "replacement").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn unicode_long_paths_support_creation_and_replacement() {
        let dir = TestDirectory::new();
        let parent = (0..12).fold(dir.0.clone(), |p, i| p.join(format!("long-unicode-目录-{i:02}")));
        let path = parent.join("笔记-žluťoučký.md");
        assert!(path.as_os_str().len() > 260);
        write_atomic(&path, "original").unwrap();
        write_atomic(&path, "replacement").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
    }

    #[test]
    #[cfg_attr(windows, ignore = "requires Windows symlink privilege; run explicitly where available")]
    fn saving_through_a_symlink_preserves_the_link() {
        let dir = TestDirectory::new();
        let target = dir.0.join("target.md");
        let link = dir.0.join("link.md");
        fs::write(&target, "original").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &link).unwrap();
        write_atomic(&link, "replacement").unwrap();
        assert!(link.is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "replacement");
        assert_eq!(fs::read_to_string(&link).unwrap(), "replacement");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[test]
    fn saving_preserves_the_original_file_until_replacement() {
        let dir = TestDirectory::new();
        let path = dir.0.join("note.md");
        fs::write(&path, "original document").unwrap();
        let mut original = fs::File::open(&path).unwrap();

        let persistence = crate::services::persistence::Persistence::new(dir.0.join("config"));
        persistence.write_document(&path, b"new document", &persistence.read_document(&path).unwrap().disk_version).unwrap();

        let mut original_content = String::new();
        original.read_to_string(&mut original_content).unwrap();
        assert_eq!(original_content, "original document");
        assert_eq!(fs::read_to_string(&path).unwrap(), "new document");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn encrypted_saves_replace_without_truncating_the_original() {
        let dir = TestDirectory::new();
        let path = dir.0.join("note.md.encrypted");
        let encrypted = crate::services::encryption::encrypt("original document", "test password").unwrap();
        fs::write(&path, &encrypted).unwrap();
        let mut original = fs::File::open(&path).unwrap();

        let persistence = crate::services::persistence::Persistence::new(dir.0.join("config"));
        let version = persistence.read_encrypted_document(&path, "test password").unwrap().disk_version;
        persistence.write_encrypted_document(&path, "new document", "test password", &version).unwrap();

        let mut previous = Vec::new();
        original.read_to_end(&mut previous).unwrap();
        assert_eq!(previous, encrypted);
        assert_eq!(crate::services::encryption::decrypt(&fs::read(&path).unwrap(), "test password").unwrap(), "new document");
    }

    #[test]
    fn annotation_saves_replace_without_truncating_the_original() {
        let dir = TestDirectory::new();
        let note = dir.0.join("note.md");
        let annotations = dir.0.join("note.annotations.json");
        fs::write(&annotations, "[]").unwrap();
        let mut original = fs::File::open(&annotations).unwrap();

        fs::write(&note, "document").unwrap();
        let persistence = crate::services::persistence::Persistence::new(dir.0.join("config"));
        let document_id = persistence.resolve(&note).unwrap();
        persistence.write_annotations(&note, &document_id, "[{\"id\":\"annotation\"}]").unwrap();

        let mut previous = String::new();
        original.read_to_string(&mut previous).unwrap();
        assert_eq!(previous, "[]");
        assert_eq!(fs::read_to_string(&annotations).unwrap(), "[{\"id\":\"annotation\"}]");
    }

    #[test]
    fn partial_write_failure_keeps_the_original_and_cleans_the_temporary_file() {
        use std::io::Write;
        let dir = TestDirectory::new();
        let path = dir.0.join("note.md");
        fs::write(&path, "original document").unwrap();
        let result = write_atomic_with(&path, |file| {
            file.write_all(b"partial replacement")?;
            Err(std::io::Error::new(std::io::ErrorKind::StorageFull, "injected disk full"))
        });
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::StorageFull);
        assert_eq!(fs::read_to_string(&path).unwrap(), "original document");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn failed_new_file_write_leaves_no_partial_document() {
        use std::io::Write;
        let dir = TestDirectory::new();
        let path = dir.0.join("note.md");
        let result = write_atomic_with(&path, |file| {
            file.write_all(b"partial")?;
            Err(std::io::Error::other("injected write failure"))
        });
        assert!(result.is_err());
        assert!(!path.exists());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }

    #[test]
    fn atomic_creation_creates_its_parent_directory() {
        let dir = TestDirectory::new();
        let path = dir.0.join("nested").join("note.md");
        write_atomic(&path, "new document").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new document");
    }

    #[test]
    fn a_failed_save_does_not_remove_an_existing_directory() {
        let dir = TestDirectory::new();
        let path = dir.0.join("note.md");
        fs::create_dir(&path).unwrap();
        let persistence = crate::services::persistence::Persistence::new(dir.0.join("config"));
        assert!(persistence.write_document(&path, b"new document", "").is_err());
        assert!(path.is_dir());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 1);
    }
}
