//! Per-call scan planning; no cache or cross-IPC task state.
use crate::models::NoteMetadata;
use crate::services::storage;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(super) fn worker_limit() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(4)
}

#[derive(Debug)]
pub(super) struct ScanFailure<R> {
    pub completed: Vec<R>,
    total: usize,
    errors: Vec<String>,
}

impl<R> std::fmt::Display for ScanFailure<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Scan incomplete ({}/{} jobs completed): {}",
            self.completed.len(), self.total, self.errors.join("; "))
    }
}

/// One fixed worker set for all roots and top-level directories in this call.
/// Completed jobs survive any worker failure; no job is retried (progress has side effects).
pub(super) fn bounded_map<T: Send, R: Send>(jobs: Vec<T>, f: impl Fn(T) -> R + Sync, cancelled: &(impl Fn() -> bool + Sync)) -> Result<Vec<R>, ScanFailure<R>> {
    bounded_map_with_builder(jobs, f, || Ok(std::thread::Builder::new()), cancelled)
}

// The fallible builder seam permits deterministic creation failures without exhausting OS threads.
fn bounded_map_with_builder<T: Send, R: Send>(
    jobs: Vec<T>,
    f: impl Fn(T) -> R + Sync,
    mut builder: impl FnMut() -> std::io::Result<std::thread::Builder>,
    cancelled: &(impl Fn() -> bool + Sync),
) -> Result<Vec<R>, ScanFailure<R>> {
    let total = jobs.len();
    let workers = worker_limit().min(total);
    let queue = Mutex::new(jobs.into_iter().enumerate());
    let results = Mutex::new(Vec::new());
    let errors = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        let mut errors = Vec::new();
        for _ in 0..workers {
            if cancelled() { break; }
            let queue = &queue;
            let results = &results;
            let f = &f;
            match builder().and_then(|builder| builder.spawn_scoped(scope, move || {
                loop {
                    let job = {
                        let mut queue = queue.lock().unwrap();
                        if cancelled() { break; }
                        queue.next()
                    };
                    let Some((index, job)) = job else { break };
                    let value = f(job);
                    results.lock().unwrap().push((index, value));
                }
            })) {
                Ok(handle) => handles.push(handle),
                Err(error) => {
                    errors.push(format!("worker creation failed: {error}"));
                    break;
                }
            }
        }
        // Explicitly join every handle, including after a panic or a spawn failure.
        for handle in handles {
            if let Err(panic) = handle.join() {
                let message = panic.downcast_ref::<String>().map(String::as_str)
                    .or_else(|| panic.downcast_ref::<&str>().copied())
                    .unwrap_or("unknown panic");
                errors.push(format!("worker panicked: {message}"));
            }
        }
        errors
    });
    let mut results = results.into_inner().unwrap();
    results.sort_unstable_by_key(|(index, _)| *index);
    let completed = results.into_iter().map(|(_, value)| value).collect();
    if errors.is_empty() {
        Ok(completed)
    } else {
        Err(ScanFailure { completed, total, errors })
    }
}

#[derive(serde::Serialize, Clone)]
pub(super) struct ScanEvent<'a, T> { pub scan_id: &'a str, pub data: T }

pub(super) fn emit<T: serde::Serialize + Clone>(app: &tauri::AppHandle, event: &str, scan_id: &str, data: T) {
    use tauri::Emitter;
    let _ = app.emit(event, ScanEvent { scan_id, data });
}

#[derive(serde::Serialize, Clone)]
pub(super) struct ProjectDiscovery<'a> {
    #[serde(flatten)]
    pub project: &'a crate::models::Project,
    pub scanning: bool,
}

/// Canonical paths are identity keys only: retain the first configured spelling
/// in payloads (especially avoiding Windows extended-length paths in the UI).
fn unique_roots(roots: Vec<String>, cancelled: &impl Fn() -> bool) -> std::io::Result<Vec<(PathBuf, PathBuf)>> {
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for root in roots.into_iter().filter(|root| !root.is_empty()) {
        if cancelled() { break; }
        let path: PathBuf = Path::new(&root).components().collect();
        match fs::metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
            Ok(metadata) if !metadata.is_dir() => return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("Expected a directory: {}", path.display()))),
            Ok(_) => (),
        }
        let key = fs::canonicalize(&path)?;
        if seen.insert(key.clone()) { result.push((path, key)); }
    }
    Ok(result)
}

pub(super) fn project_paths(root: String, extras: Vec<String>, cancelled: &impl Fn() -> bool) -> std::io::Result<Vec<PathBuf>> {
    let roots = unique_roots(std::iter::once(root.clone()).chain(extras).collect(), cancelled)?;
    let mut paths = Vec::new();
    if !cancelled() && !root.is_empty() {
        match fs::read_dir(&root) {
            Ok(entries) => {
                for entry in entries {
                    if cancelled() { break; }
                    let entry = entry?;
                    if storage::is_scan_directory(&entry) && !storage::is_ignored_dir(&entry.file_name().to_string_lossy()) { paths.push(entry.path()); }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    paths.sort_by_key(|p| {
        p.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
    });
    let main_path: PathBuf = Path::new(&root).components().collect();
    let main_key = roots.iter().find(|(path, _)| *path == main_path).map(|(_, key)| key.clone());
    // Nested extras remain independent project roots even when notes are covered
    // by an ancestor. Only exact aliases/duplicates are collapsed.
    paths.extend(
        roots
            .into_iter()
            .filter(|(_, key)| Some(key) != main_key.as_ref())
            .map(|(p, _)| p),
    );
    let mut seen = std::collections::HashSet::new();
    let mut unique = Vec::new();
    for path in paths {
        if cancelled() { break; }
        match fs::canonicalize(&path) {
            Ok(key) => { if seen.insert(key) { unique.push(path); } }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error),
        }
    }
    Ok(unique)
}

pub(super) fn note_roots(roots: Vec<String>, cancelled: &impl Fn() -> bool) -> std::io::Result<Vec<PathBuf>> {
    let roots = unique_roots(roots, cancelled)?;
    Ok(roots
        .iter()
        .take_while(|_| !cancelled())
        .filter(|(_, key)| {
            !roots.iter().any(|(_, ancestor)| {
                key != ancestor
                    && key
                        .strip_prefix(ancestor)
                        .map(|relative| {
                            // Explicit ignored/hidden roots are not covered by their ancestor.
                            !relative
                                .components()
                                .any(|c| storage::is_ignored_dir(&c.as_os_str().to_string_lossy()))
                        })
                        .unwrap_or(false)
            })
        })
        .map(|(path, _)| path.clone())
        .collect())
}

pub(super) enum NoteTask {
    Tree(PathBuf),
    Files { root: PathBuf, files: Vec<PathBuf> },
}

pub(super) fn note_tasks(roots: Vec<String>, cancelled: &impl Fn() -> bool) -> std::io::Result<Vec<NoteTask>> {
    let mut tasks = Vec::new();
    for root in note_roots(roots, cancelled)? {
        if cancelled() { break; }
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let mut files = Vec::new();
        for entry in entries {
            if cancelled() { break; }
            let entry = entry?;
            let path = entry.path();
            if storage::is_scan_directory(&entry) {
                if !storage::is_ignored_dir(&entry.file_name().to_string_lossy()) {
                    tasks.push(NoteTask::Tree(path));
                }
            } else if entry.file_type().map(|t| t.is_file()).unwrap_or(false)
                && storage::is_note_file(&path)
            {
                files.push(path);
            }
        }
        if !files.is_empty() {
            tasks.push(NoteTask::Files { root, files });
        }
    }
    Ok(tasks)
}

pub(super) fn scan_task(task: NoteTask, mut on_file: impl FnMut(), cancelled: &impl Fn() -> bool) -> std::io::Result<(String, Vec<NoteMetadata>)> {
    match task {
        NoteTask::Tree(path) => {
            match fs::metadata(&path) {
                Ok(metadata) if metadata.is_dir() => (),
                Ok(_) => return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("Expected a directory: {}", path.display()))),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((path.to_string_lossy().into_owned(), Vec::new())),
                Err(error) => return Err(error),
            }
            let notes = storage::scan_notes_with_progress(&path, |_| on_file(), cancelled);
            Ok((path.to_string_lossy().into_owned(), notes))
        }
        NoteTask::Files { root, files } => {
            let notes = files
                .into_iter()
                .take_while(|_| !cancelled())
                .filter_map(|p| {
                    let note = storage::build_note_metadata(&p, &root)?;
                    on_file();
                    Some(note)
                })
                .collect();
            Ok((root.to_string_lossy().into_owned(), notes))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn a_file_used_as_a_library_root_is_an_error_not_a_successful_empty_scan() {
        let fixture = Fixture::new();
        let path = fixture.0.join("not-a-directory.md");
        fs::write(&path, "fixture").unwrap();
        let root = path.to_string_lossy().into_owned();
        assert!(note_roots(vec![root.clone()], &|| false).is_err());
        assert!(note_tasks(vec![root.clone()], &|| false).is_err());
        assert!(project_paths(root, Vec::new(), &|| false).is_err());
    }

    #[test]
    fn a_discovered_subdirectory_that_becomes_a_file_reports_scan_failure() {
        let fixture = Fixture::new();
        let child = fixture.0.join("child");
        fs::create_dir(&child).unwrap();
        let tasks = note_tasks(vec![fixture.root()], &|| false).unwrap();
        assert_eq!(tasks.len(), 1);
        fs::remove_dir(&child).unwrap(); fs::write(&child, "not a directory").unwrap();
        assert!(scan_task(tasks.into_iter().next().unwrap(), || {}, &|| false).is_err());
        assert!(storage::scan_projects(&child, &|| false).is_err());
    }

    #[test]
    fn canceled_worker_set_does_not_take_the_remaining_scan_jobs() {
        use std::sync::atomic::AtomicBool;
        let canceled = AtomicBool::new(false);
        let started = AtomicUsize::new(0);
        let results = bounded_map((0..10000).collect(), |value| {
            started.fetch_add(1, Ordering::SeqCst);
            canceled.store(true, Ordering::SeqCst);
            value
        }, &|| canceled.load(Ordering::SeqCst)).unwrap();
        assert!(started.load(Ordering::SeqCst) <= worker_limit());
        assert!(results.len() <= worker_limit());
    }

    #[test]
    fn search_includes_extra_roots_once_and_never_searches_binary_or_encrypted_bodies() {
        let main = Fixture::new();
        let extra = Fixture::new();
        fs::write(main.0.join("main.md"), "needle").unwrap();
        fs::write(extra.0.join("extra.md"), "NEEDLE").unwrap();
        fs::write(extra.0.join("secret.md.encrypted"), "needle").unwrap();
        fs::write(extra.0.join("binary.pdf"), "needle").unwrap();
        let state = crate::services::search::SearchState::default();
        let session = state.open("fixture");
        let run = state.begin("fixture", &session, 1).unwrap();
        let results = crate::services::search::search(&note_roots(vec![main.root(), extra.root(), extra.root()], &|| false).unwrap(), "needle", &run);
        let mut titles: Vec<_> = results.into_iter().map(|note| note.title).collect();
        titles.sort();
        assert_eq!(titles, ["extra.md", "main.md"]);
        let encrypted = crate::services::search::search(&note_roots(vec![main.root(), extra.root()], &|| false).unwrap(), "secret", &run);
        assert_eq!(encrypted.len(), 1);
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("miaoyan-scan-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn root(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn overlapping_roots_read_each_note_once_including_explicit_hidden_roots() {
        let f = Fixture::new();
        for child in ["Alpha/deep", ".selected", "Trash", "empty"] {
            fs::create_dir_all(f.0.join(child)).unwrap();
        }
        for name in [
            "top.md",
            "Alpha/a.txt",
            "Alpha/deep/book.pdf",
            ".selected/secret.md",
            "Trash/no.md",
        ] {
            fs::write(f.0.join(name), b"synthetic").unwrap();
        }
        let nested = f.0.join("Alpha").to_string_lossy().into_owned();
        let hidden = f.0.join(".selected").to_string_lossy().into_owned();
        let roots = vec![
            nested.clone(),
            f.root(),
            format!("{}/.", f.root()),
            hidden.clone(),
            nested.clone(),
        ];
        let count = AtomicUsize::new(0);
        let chunks = bounded_map(note_tasks(roots, &|| false).unwrap(), |task| {
            scan_task(task, || {
                count.fetch_add(1, Ordering::Relaxed);
            }, &|| false)
        }, &|| false).expect("scan succeeds");
        let notes: Vec<_> = chunks
            .into_iter()
            .collect::<std::io::Result<Vec<_>>>()
            .expect("tasks succeed")
            .into_iter()
            .flat_map(|(_, notes)| notes)
            .collect();
        assert_eq!(count.load(Ordering::Relaxed), 4);
        assert_eq!(notes.len(), 4);
        assert_eq!(
            notes
                .iter()
                .map(|n| &n.path)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            4
        );
        assert_eq!(
            notes.iter().find(|n| n.title == "book.pdf").unwrap().folder,
            "deep"
        );
        assert_eq!(
            notes.iter().find(|n| n.title == "top.md").unwrap().folder,
            ""
        );
        let projects = project_paths(
            f.root(),
            vec![
                nested,
                hidden.clone(),
                f.0.join("Alpha/deep").to_string_lossy().into_owned(),
            ], &|| false,
        ).unwrap();
        assert_eq!(projects.len(), 4); // Alpha, empty, explicit hidden, explicit deep
        assert!(projects.contains(&PathBuf::from(hidden)));
        assert!(projects.contains(&f.0.join("Alpha/deep")));
        assert!(note_tasks(vec![
            String::new(),
            f.0.join("missing").to_string_lossy().into_owned()
        ], &|| false).unwrap()
        .is_empty());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn selected_directory_aliases_are_deduplicated_without_losing_projects() {
        let f = Fixture::new();
        let root = f.0.join("root");
        let target = f.0.join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("only.md"), b"synthetic").unwrap();
        let alias = root.join("selected-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        #[cfg(windows)]
        assert!(std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&alias)
            .arg(&target)
            .output()
            .unwrap()
            .status
            .success());
        let roots: Vec<_> = [&root, &alias, &target, &root]
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let count = AtomicUsize::new(0);
        let chunks = bounded_map(note_tasks(roots, &|| false).unwrap(), |task| {
            scan_task(task, || {
                count.fetch_add(1, Ordering::Relaxed);
            }, &|| false)
        }, &|| false).expect("scan succeeds");
        let chunks: Vec<_> = chunks.into_iter().collect::<std::io::Result<Vec<_>>>().expect("tasks succeed");
        let projects = project_paths(
            root.to_string_lossy().into_owned(),
            vec![
                alias.to_string_lossy().into_owned(),
                target.to_string_lossy().into_owned(),
            ], &|| false,
        ).unwrap();
        #[cfg(windows)]
        fs::remove_dir(&alias).unwrap();
        #[cfg(unix)]
        fs::remove_file(&alias).unwrap();
        assert_eq!(count.load(Ordering::Relaxed), 1);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].1[0].path, alias.join("only.md").to_string_lossy());
        assert_eq!(projects, vec![alias]);
    }

    #[test]
    fn worker_panic_reports_failure_and_retains_completed_jobs_without_replaying() {
        let calls = Mutex::new(Vec::new());
        let result = std::panic::catch_unwind(|| {
            bounded_map((0..8).collect(), |i| {
                calls.lock().unwrap().push(i);
                if i == 7 { panic!("injected scan failure"); }
                i
            }, &|| false)
        });
        let failure = result.expect("worker failure must not unwind the batch").expect_err("the failed job must be reported");
        assert_eq!(failure.completed, (0..7).collect::<Vec<_>>());
        assert_eq!(failure.total, 8);
        assert!(failure.errors.iter().any(|error| error.contains("injected scan failure")));
        let calls = calls.into_inner().unwrap();
        assert_eq!(calls.len(), 8);
        assert_eq!(calls.iter().collect::<std::collections::HashSet<_>>().len(), 8);
    }

    #[test]
    fn thread_creation_failure_returns_a_scan_error_without_running_jobs() {
        let called = AtomicUsize::new(0);
        let failure = bounded_map_with_builder(vec![1, 2, 3], |value| {
            called.fetch_add(1, Ordering::Relaxed);
            value
        }, || Err(std::io::Error::other("injected thread creation failure")), &|| false).expect_err("creation failure must be returned");
        assert!(failure.completed.is_empty());
        assert_eq!(failure.total, 3);
        assert_eq!(called.load(Ordering::Relaxed), 0);
        assert!(failure.to_string().contains("injected thread creation failure"));
    }

    #[test]
    fn workers_are_bounded_and_results_keep_input_order() {
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let entered = std::sync::Barrier::new(worker_limit());
        let ids = Mutex::new(std::collections::HashSet::new());
        let result = bounded_map((0..128).collect(), |i| {
            ids.lock().unwrap().insert(std::thread::current().id());
            let n = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(n, Ordering::SeqCst);
            if i < worker_limit() {
                entered.wait();
            }
            active.fetch_sub(1, Ordering::SeqCst);
            i
        }, &|| false);
        assert_eq!(result.expect("scan succeeds"), (0..128).collect::<Vec<_>>());
        assert_eq!(peak.load(Ordering::SeqCst), worker_limit());
        assert_eq!(ids.lock().unwrap().len(), worker_limit());
        assert!(worker_limit() <= 4);
        eprintln!(
            "scan: 128 jobs, {} worker threads, peak {}",
            ids.lock().unwrap().len(),
            peak.load(Ordering::SeqCst)
        );
        assert!(bounded_map(Vec::<usize>::new(), |i| i, &|| false).expect("empty scan succeeds").is_empty());
    }

    #[test]
    #[ignore = "isolated synthetic 1k/10k timing; not native UI performance"]
    fn synthetic_scan_workload() {
        for total in [1_000, 10_000] {
            let f = Fixture::new();
            for d in 0..32 {
                fs::create_dir(f.0.join(format!("folder-{d}"))).unwrap();
            }
            for i in 0..total {
                fs::write(
                    f.0.join(format!("folder-{}/note-{i}.md", i % 32)),
                    b"synthetic",
                )
                .unwrap();
            }
            let started = std::time::Instant::now();
            let metadata = AtomicUsize::new(0);
            let chunks = bounded_map(
                note_tasks(vec![
                    f.root(),
                    f.root(),
                    f.0.join("folder-0").to_string_lossy().into_owned(),
                ], &|| false).unwrap(),
                |task| {
                    scan_task(task, || {
                        metadata.fetch_add(1, Ordering::Relaxed);
                    }, &|| false)
                }, &|| false,
            ).expect("scan succeeds");
            let chunks: Vec<_> = chunks.into_iter().collect::<std::io::Result<Vec<_>>>().expect("tasks succeed");
            let count: usize = chunks.iter().map(|(_, notes)| notes.len()).sum();
            assert_eq!(count, total);
            assert_eq!(metadata.load(Ordering::Relaxed), total);
            eprintln!(
                "synthetic: {total} notes, {} chunks, {} metadata results, <= {} workers, {:?}",
                chunks.len(),
                metadata.load(Ordering::Relaxed),
                worker_limit(),
                started.elapsed()
            );
        }
    }
}
