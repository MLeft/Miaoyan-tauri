use crate::services::storage;
use notify::event::{ModifyKind, RemoveKind, RenameMode};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const RENAME_TTL: Duration = Duration::from_secs(1);
const MAX_PENDING_RENAMES: usize = 256;
const COALESCE_WINDOW: Duration = Duration::from_millis(200);
const MAX_PENDING_EVENTS: usize = 1024;

/// Most-specific explicit root wins, including selected hidden roots.
fn under_ignored_relative(pb: &Path, roots: &[PathBuf]) -> bool {
    roots
        .iter()
        .filter_map(|r| pb.strip_prefix(r).ok())
        .min_by_key(|p| p.components().count())
        .map(|rel| {
            rel.components()
                .any(|c| storage::is_ignored_dir(&c.as_os_str().to_string_lossy()))
        })
        .unwrap_or(true)
}

fn is_note_file(pb: &Path) -> bool {
    storage::is_note_file(pb)
}

/// Windows directory Modify means a child changed, not a structural change.
fn is_child_change_noise(kind: &EventKind, is_dir: bool) -> bool {
    is_dir && matches!(kind, EventKind::Modify(kind) if !matches!(kind, ModifyKind::Name(_)))
}

/// Preserve create through modifications, but a later observation of existence
/// supersedes remove (atomic-save/replacement), not the other way round.
fn merge_event_type(old: &str, new: &str) -> &'static str {
    match new {
        "remove" => "remove",
        "create" => "create",
        _ if old == "create" => "create",
        _ => "modify",
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Output {
    File(&'static str, PathBuf),
    Structure {
        kind: &'static str,
        path: Option<PathBuf>,
        from: Option<PathBuf>,
        to: Option<PathBuf>,
    },
}

impl Output {
    fn structure(kind: &'static str, path: &Path) -> Self {
        Self::Structure {
            kind,
            path: Some(path.to_path_buf()),
            from: None,
            to: None,
        }
    }
}

struct RenameSource {
    path: PathBuf,
    tracker: Option<usize>,
    at: Instant,
}

#[derive(Default)]
struct PendingRenames(VecDeque<RenameSource>);

impl PendingRenames {
    fn deadline(&self) -> Option<Instant> {
        self.0.front().map(|source| source.at + RENAME_TTL)
    }

    fn expire(&mut self, now: Instant) -> Vec<PathBuf> {
        let mut expired = Vec::new();
        while self.deadline().map(|at| at <= now).unwrap_or(false) {
            expired.push(self.0.pop_front().unwrap().path);
        }
        expired
    }

    fn push(&mut self, source: RenameSource) -> Option<PathBuf> {
        let evicted = if self.0.len() >= MAX_PENDING_RENAMES {
            self.0.pop_front().map(|s| s.path)
        } else {
            None
        };
        self.0.push_back(source);
        evicted
    }

    fn take(&mut self, to: &Path, tracker: Option<usize>, adjacent: bool) -> Option<PathBuf> {
        let index = if let Some(tracker) = tracker {
            // Never substitute FIFO for a missing/mismatched notify tracker.
            let mut matches = self
                .0
                .iter()
                .enumerate()
                .filter(|(_, s)| s.tracker == Some(tracker));
            let index = matches.next()?.0;
            if matches.next().is_some() {
                return None;
            }
            index
        } else {
            // Trackerless platforms: only a single, immediately adjacent source
            // in the same parent is safe enough. Moves/ambiguity degrade to
            // remove + create, not a potentially destructive wrong dir-rename.
            if !adjacent || self.0.len() != 1 {
                return None;
            }
            let source = self.0.front()?;
            if source.tracker.is_some() || source.path.parent() != to.parent() {
                return None;
            }
            0
        };
        self.0.remove(index).map(|s| s.path)
    }
}

struct EventState {
    roots: Vec<PathBuf>,
    renames: PendingRenames,
    previous_was_from: bool,
}

impl EventState {
    fn new(roots: Vec<PathBuf>) -> Self {
        Self {
            roots,
            renames: PendingRenames::default(),
            previous_was_from: false,
        }
    }

    fn visible(&self, path: &Path) -> bool {
        !under_ignored_relative(path, &self.roots)
    }

    fn created(&self, path: &Path, output: &mut Vec<Output>) {
        if !self.visible(path) {
            return;
        }
        if path.is_dir() {
            output.push(Output::structure("dir-create", path));
        } else if is_note_file(path) {
            output.push(Output::File("create", path.to_path_buf()));
        }
    }

    fn removed(&self, path: &Path, directory: bool, output: &mut Vec<Output>) {
        if !self.visible(path) {
            return;
        }
        if directory || !is_note_file(path) {
            output.push(Output::structure("path-remove", path));
        } else {
            output.push(Output::File("remove", path.to_path_buf()));
        }
    }

    fn expired_source(&self, path: &Path, output: &mut Vec<Output>) {
        if !self.visible(path) {
            return;
        }
        // A replacement may already occupy the source name by the deadline.
        if path.exists() {
            self.created(path, output);
            return;
        }
        // Its old type is unknown, including directories named *.md.
        output.push(Output::structure("path-remove", path));
        if is_note_file(path) {
            output.push(Output::File("remove", path.to_path_buf()));
        }
    }

    fn expire(&mut self, now: Instant) -> Vec<Output> {
        let mut output = Vec::new();
        for path in self.renames.expire(now) {
            self.expired_source(&path, &mut output);
        }
        output
    }

    fn renamed(&self, from: &Path, to: &Path, output: &mut Vec<Output>) {
        let directory = to.is_dir();
        if self.visible(from) && self.visible(to) && directory {
            output.push(Output::Structure {
                kind: "dir-rename",
                path: None,
                from: Some(from.to_path_buf()),
                to: Some(to.to_path_buf()),
            });
        } else {
            // Each side is filtered independently: normal -> ignored removes,
            // ignored -> normal creates. Also handles supported -> other ext.
            self.removed(from, directory, output);
            self.created(to, output);
        }
    }

    fn process(&mut self, event: Event, now: Instant) -> Vec<Output> {
        let mut output = self.expire(now);
        let adjacent = self.previous_was_from;
        self.previous_was_from = matches!(
            event.kind,
            EventKind::Modify(ModifyKind::Name(RenameMode::From))
        );
        match event.kind {
            EventKind::Create(_) => {
                for path in &event.paths {
                    self.created(path, &mut output);
                }
            }
            EventKind::Modify(ModifyKind::Name(mode)) => match mode {
                RenameMode::Both => {
                    if let [from, to, ..] = event.paths.as_slice() {
                        self.renamed(from, to, &mut output);
                    }
                }
                RenameMode::From => {
                    for path in &event.paths {
                        // Keep ignored sources too: their matching To must not steal
                        // another source from the queue.
                        if let Some(path) = self.renames.push(RenameSource {
                            path: path.clone(),
                            tracker: event.tracker(),
                            at: now,
                        }) {
                            self.expired_source(&path, &mut output);
                        }
                    }
                }
                RenameMode::To => {
                    for path in &event.paths {
                        if let Some(from) = self.renames.take(path, event.tracker(), adjacent) {
                            self.renamed(&from, path, &mut output);
                        } else {
                            self.created(path, &mut output);
                        }
                    }
                }
                RenameMode::Any | RenameMode::Other => {
                    for path in &event.paths {
                        if path.exists() {
                            self.created(path, &mut output);
                        } else {
                            self.expired_source(path, &mut output);
                        }
                    }
                }
            },
            EventKind::Modify(_) => {
                for path in &event.paths {
                    if self.visible(path)
                        && !is_child_change_noise(&event.kind, path.is_dir())
                        && is_note_file(path)
                    {
                        output.push(Output::File("modify", path.clone()));
                    }
                }
            }
            EventKind::Remove(kind) => {
                for path in &event.paths {
                    if matches!(kind, RemoveKind::Any | RemoveKind::Other) {
                        self.expired_source(path, &mut output);
                    } else if path.is_dir() {
                        self.created(path, &mut output);
                    } else {
                        self.removed(path, kind == RemoveKind::Folder, &mut output);
                    }
                }
            }
            _ => {}
        }
        output
    }
}

#[derive(Default)]
struct FileBatch {
    pending: HashMap<PathBuf, &'static str>,
    first_at: Option<Instant>,
}
impl FileBatch {
    fn add(&mut self, path: PathBuf, kind: &'static str, now: Instant) {
        self.first_at.get_or_insert(now);
        self.pending
            .entry(path)
            .and_modify(|old| *old = merge_event_type(old, kind))
            .or_insert(kind);
    }
    fn deadline(&self) -> Option<Instant> {
        self.first_at.map(|at| at + COALESCE_WINDOW)
    }
    fn flush(&mut self) -> Vec<Output> {
        self.first_at = None;
        self.pending
            .drain()
            .map(|(path, kind)| {
                // Spot-check removals only, never rescan a root. Protect against
                // missing/reordered native create events during atomic replacement.
                let kind = if kind == "remove" && path.is_file() {
                    "modify"
                } else {
                    kind
                };
                Output::File(kind, path)
            })
            .collect()
    }
}

/// One blocking consumer owns both deadlines; no callback-local expiry that
/// depends on a later To, and no idle polling or full-library rescan.
fn run_events(rx: mpsc::Receiver<Event>, roots: Vec<PathBuf>, overflow: Arc<AtomicBool>, mut emit: impl FnMut(Vec<Output>)) {
    let mut state = EventState::new(roots);
    let mut batch = FileBatch::default();
    let mut incoming = Vec::new();
    loop {
        if overflow.swap(false, Ordering::AcqRel) {
            emit(state.roots.iter().map(|root| Output::File("rescan", root.clone())).collect());
        }
        let now = Instant::now();
        incoming.extend(state.expire(now));
        let mut structure = Vec::new();
        for output in incoming.drain(..) {
            match output {
                Output::File(kind, path) => {
                    batch.add(path, kind, now);
                    if batch.pending.len() >= MAX_PENDING_EVENTS { emit(batch.flush()); }
                },
                output => structure.push(output),
            }
        }
        if !structure.is_empty() {
            emit(structure);
        }
        if batch.pending.len() >= MAX_PENDING_EVENTS || batch.deadline().map(|at| at <= now).unwrap_or(false) {
            emit(batch.flush());
        }
        let deadline = batch
            .deadline()
            .into_iter()
            .chain(state.renames.deadline())
            .min();
        let received = match deadline {
            Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        match received {
            Ok(event) => incoming = state.process(event, Instant::now()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let now = Instant::now();
                let mut final_events = Vec::new();
                for output in state.expire(now + RENAME_TTL) {
                    match output {
                        Output::File(kind, path) => batch.add(path, kind, now),
                        output => final_events.push(output),
                    }
                }
                final_events.extend(batch.flush());
                if !final_events.is_empty() { emit(final_events); }
                break;
            }
        }
    }
}

#[derive(Default)]
pub struct WatcherState(std::sync::Mutex<Option<notify::RecommendedWatcher>>);
impl WatcherState {
    pub fn replace_with(&self, create: impl FnOnce() -> Result<notify::RecommendedWatcher, String>) -> Result<(), String> {
        let mut watcher = self.0.lock().map_err(|_| "Watcher state is unavailable".to_string())?;
        let replacement = create()?;
        *watcher = Some(replacement);
        Ok(())
    }
    pub fn stop(&self) -> Result<(), String> {
        self.0.lock().map_err(|_| "Watcher state is unavailable".to_string())?.take();
        Ok(())
    }
}

fn enqueue_event(tx: &mpsc::SyncSender<Event>, event: Event, overflow: &AtomicBool) {
    if let Err(mpsc::TrySendError::Full(_)) = tx.try_send(event) { overflow.store(true, Ordering::Release); }
}

pub fn start_watcher(
    app_handle: AppHandle,
    paths: &[String],
) -> Result<notify::RecommendedWatcher, String> {
    let roots: Vec<PathBuf> = paths
        .iter()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .collect();
    let (tx, rx) = mpsc::sync_channel(MAX_PENDING_EVENTS);
    let overflow = Arc::new(AtomicBool::new(false));
    let callback_overflow = overflow.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        match res {
            Ok(event) => enqueue_event(&tx, event, &callback_overflow),
            Err(_) => {
                callback_overflow.store(true, Ordering::Release);
                enqueue_event(&tx, Event::new(EventKind::Other), &callback_overflow);
            }
        }
    })
    .map_err(|error| format!("Watcher creation failed: {error}"))?;
    watch_roots(&mut watcher, &roots)?;
    std::thread::Builder::new().name("miaoyan-file-events".into()).spawn(move || {
        run_events(rx, roots, overflow, |outputs| {
            let mut files: HashMap<&str, Vec<String>> = HashMap::new();
            for output in outputs {
                match output {
                    Output::File(kind, path) => files
                        .entry(kind)
                        .or_default()
                        .push(path.to_string_lossy().into_owned()),
                    Output::Structure {
                        kind,
                        path,
                        from,
                        to,
                    } => {
                        let _ = app_handle.emit(
                            "fs-structure",
                            serde_json::json!({
                                "kind": kind,
                                "path": path.as_ref().map(|p| p.to_string_lossy()),
                                "from": from.as_ref().map(|p| p.to_string_lossy()),
                                "to": to.as_ref().map(|p| p.to_string_lossy()),
                            }),
                        );
                    }
                }
            }
            for (kind, paths) in files {
                let _ = app_handle.emit(
                    "fs-change",
                    serde_json::json!({ "type": kind, "paths": paths }),
                );
            }
        })
    }).map_err(|error| format!("Watcher worker creation failed: {error}"))?;
    Ok(watcher)
}

/// One recursive registration per root. Per-directory Windows handles prevent
/// users from renaming/removing ancestor directories (ERROR_ACCESS_DENIED).
fn watch_roots<W: Watcher>(watcher: &mut W, roots: &[PathBuf]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        let key = std::fs::canonicalize(root).map_err(|error| format!("Cannot watch {}: {error}", root.display()))?;
        if seen.insert(key) { watcher.watch(root, RecursiveMode::Recursive).map_err(|error| format!("Cannot watch {}: {error}", root.display()))?; }
    }
    Ok(())
}

#[cfg(test)]
mod regression_tests {
    use super::*;

    fn source(path: &str, tracker: Option<usize>, at: Instant) -> RenameSource {
        RenameSource {
            path: PathBuf::from(path),
            tracker,
            at,
        }
    }

    #[test]
    fn coalescing_uses_the_final_state() {
        for (old, new, expected) in [
            ("remove", "create", "create"),
            ("remove", "modify", "modify"),
            ("create", "remove", "remove"),
            ("modify", "remove", "remove"),
            ("create", "modify", "create"),
            ("modify", "create", "create"),
            ("create", "create", "create"),
            ("modify", "modify", "modify"),
            ("remove", "remove", "remove"),
        ] {
            assert_eq!(merge_event_type(old, new), expected, "{old} -> {new}");
        }
    }

    #[test]
    fn invalid_roots_fail_and_failed_replacement_keeps_the_previous_watcher() {
        let fixture = Fixture::new();
        let state = WatcherState::default();
        let (tx, rx) = mpsc::channel();
        state.replace_with(|| {
            let mut watcher = notify::recommended_watcher(move |result: Result<Event, notify::Error>| { let _ = tx.send(result); }).map_err(|error| error.to_string())?;
            watch_roots(&mut watcher, std::slice::from_ref(&fixture.0))?;
            Ok(watcher)
        }).unwrap();
        assert!(state.replace_with(|| {
            let mut watcher = notify::recommended_watcher(|_: Result<Event, notify::Error>| {}).map_err(|error| error.to_string())?;
            watch_roots(&mut watcher, &[fixture.0.join("missing")])?;
            Ok(watcher)
        }).is_err());
        let path = fixture.0.join("still-watched.md");
        std::fs::write(&path, "content").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let event = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).expect("Previous watcher was lost").unwrap();
            if event.paths.contains(&path) { break; }
        }
        state.stop().unwrap();
    }

    #[test]
    fn overflow_is_nonblocking_and_requests_a_final_state_refresh() {
        let fixture = Fixture::new();
        let overflow = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::sync_channel(1);
        let event = || Event::new(EventKind::Create(notify::event::CreateKind::Folder)).add_path(fixture.0.clone());
        enqueue_event(&tx, event(), &overflow);
        enqueue_event(&tx, event(), &overflow);
        assert!(overflow.load(Ordering::Acquire));
        drop(tx);
        let mut output = Vec::new();
        run_events(rx, vec![fixture.0.clone()], overflow.clone(), |events| output.extend(events));
        assert!(output.contains(&Output::File("rescan", fixture.0.clone())));
        assert!(!overflow.load(Ordering::Acquire));
    }

    #[test]
    fn a_large_native_event_is_split_into_bounded_file_batches() {
        let fixture = Fixture::new();
        let (tx, rx) = mpsc::channel();
        let mut event = Event::new(EventKind::Create(notify::event::CreateKind::File));
        for index in 0..1400 { event = event.add_path(fixture.0.join(format!("{index}.md"))); }
        tx.send(event).unwrap(); drop(tx);
        let mut emitted = 0;
        run_events(rx, vec![fixture.0.clone()], Arc::new(AtomicBool::new(false)), |batch| {
            assert!(batch.len() <= MAX_PENDING_EVENTS, "Native batch exceeded its budget: {}", batch.len());
            emitted += batch.len();
        });
        assert_eq!(emitted, 1400);
    }

    #[test]
    fn disconnect_flushes_pending_files_and_unpaired_renames() {
        let fixture = Fixture::new();
        let note = fixture.0.join("note.md");
        std::fs::write(&note, "content").unwrap();
        let moved = fixture.0.join("moved-out");
        let (tx, rx) = mpsc::channel();
        tx.send(Event::new(EventKind::Create(notify::event::CreateKind::File)).add_path(note.clone())).unwrap();
        tx.send(Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From))).add_path(moved.clone())).unwrap();
        drop(tx);
        let mut output = Vec::new();
        run_events(rx, vec![fixture.0.clone()], Arc::new(AtomicBool::new(false)), |events| output.extend(events));
        assert!(output.contains(&Output::File("create", note)));
        assert!(output.contains(&Output::structure("path-remove", &moved)));
    }

    #[test]
    fn unknown_removal_handles_directories_named_like_notes_without_removing_recreations() {
        let fixture = Fixture::new();
        let path = fixture.0.join("docs.md");
        let mut state = EventState::new(vec![fixture.0.clone()]);
        let event = || Event::new(EventKind::Remove(RemoveKind::Any)).add_path(path.clone());
        let removed = state.process(event(), Instant::now());
        assert!(removed.contains(&Output::structure("path-remove", &path)));
        std::fs::create_dir(&path).unwrap();
        let recreated = state.process(event(), Instant::now());
        assert!(!recreated.contains(&Output::structure("path-remove", &path)));
        assert!(recreated.contains(&Output::structure("dir-create", &path)));
    }

    #[test]
    fn ambiguous_sources_must_not_be_paired_by_fifo() {
        let now = Instant::now();
        let mut pending = PendingRenames::default();
        pending.push(source("root/first", None, now));
        pending.push(source("root/second", None, now));
        assert_eq!(pending.take(Path::new("root/to"), None, true), None);
        assert_eq!(
            pending.expire(now + RENAME_TTL),
            vec![PathBuf::from("root/first"), PathBuf::from("root/second")]
        );
    }

    #[test]
    fn expired_sources_must_not_be_silently_discarded() {
        let root = std::env::temp_dir().join(format!("miaoyan-missing-{}", uuid::Uuid::new_v4()));
        let path = root.join("moved-out");
        let now = Instant::now();
        let mut state = EventState::new(vec![root]);
        state.process(
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                .add_path(path.clone()),
            now,
        );
        assert!(state
            .expire(now + RENAME_TTL - Duration::from_nanos(1))
            .is_empty());
        assert_eq!(
            state.expire(now + RENAME_TTL),
            vec![Output::structure("path-remove", &path)]
        );
        assert!(state.renames.deadline().is_none());
    }

    #[test]
    fn trackers_pair_out_of_order_and_never_fall_back_to_fifo() {
        let now = Instant::now();
        let mut pending = PendingRenames::default();
        pending.push(source("root/one", Some(1), now));
        pending.push(source("root/two", Some(2), now));
        assert_eq!(
            pending.take(Path::new("other/new-two"), Some(2), false),
            Some(PathBuf::from("root/two"))
        );
        assert_eq!(pending.take(Path::new("root/new-one"), Some(3), true), None);
        assert_eq!(pending.take(Path::new("root/new-one"), None, true), None);
        assert_eq!(
            pending.take(Path::new("root/new-one"), Some(1), false),
            Some(PathBuf::from("root/one"))
        );
    }

    #[test]
    fn trackerless_pairing_is_adjacent_single_source_same_parent_only() {
        let mut pending = PendingRenames::default();
        pending.push(source("root/old", None, Instant::now()));
        assert_eq!(pending.take(Path::new("elsewhere/new"), None, true), None);
        assert_eq!(pending.take(Path::new("root/new"), None, false), None);
        assert_eq!(
            pending.take(Path::new("root/new"), None, true),
            Some(PathBuf::from("root/old"))
        );
    }

    #[test]
    fn rename_queue_overflow_returns_sources_for_removal() {
        let now = Instant::now();
        let mut pending = PendingRenames::default();
        for i in 0..MAX_PENDING_RENAMES {
            assert!(pending
                .push(source(&format!("root/{i}"), Some(i), now))
                .is_none());
        }
        assert_eq!(
            pending.push(source("root/overflow", None, now)),
            Some(PathBuf::from("root/0"))
        );
        assert_eq!(pending.expire(now + RENAME_TTL).len(), MAX_PENDING_RENAMES);
        assert!(pending.deadline().is_none());
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("miaoyan-watcher-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn both_and_split_renames_cross_ignored_boundary_on_each_side() {
        for split in [false, true] {
            let fixture = Fixture::new();
            let root = &fixture.0;
            let normal = root.join("normal");
            let hidden = root.join(".hidden");
            std::fs::create_dir(&hidden).unwrap();
            let mut state = EventState::new(vec![root.clone()]);
            let now = Instant::now();
            let mut rename = |from: &Path, to: &Path| {
                if split {
                    state.process(
                        Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                            .add_path(from.to_path_buf())
                            .set_tracker(7),
                        now,
                    );
                    state.process(
                        Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
                            .add_path(to.to_path_buf())
                            .set_tracker(7),
                        now,
                    )
                } else {
                    state.process(
                        Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                            .add_path(from.to_path_buf())
                            .add_path(to.to_path_buf()),
                        now,
                    )
                }
            };
            assert_eq!(
                rename(&normal, &hidden),
                vec![Output::structure("path-remove", &normal)]
            );
            std::fs::rename(&hidden, &normal).unwrap();
            assert_eq!(
                rename(&hidden, &normal),
                vec![Output::structure("dir-create", &normal)]
            );
        }
    }

    #[test]
    fn supported_to_unsupported_extension_removes_old_note() {
        let fixture = Fixture::new();
        let from = fixture.0.join("old.md");
        let to = fixture.0.join("new.bin");
        std::fs::write(&to, b"synthetic").unwrap();
        let mut state = EventState::new(vec![fixture.0.clone()]);
        assert_eq!(
            state.process(
                Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                    .add_path(from.clone())
                    .add_path(to),
                Instant::now()
            ),
            vec![Output::File("remove", from)]
        );
    }

    #[test]
    fn explicit_hidden_root_is_visible_even_under_another_root() {
        let roots = [PathBuf::from("root"), PathBuf::from("root/.selected")];
        assert!(!under_ignored_relative(
            Path::new("root/.selected/note.md"),
            &roots
        ));
        assert!(under_ignored_relative(
            Path::new("root/.selected/.nested/note.md"),
            &roots
        ));
        assert!(under_ignored_relative(
            Path::new("elsewhere/note.md"),
            &roots
        ));
    }

    #[test]
    fn recreated_file_is_not_emitted_as_removed_even_without_create_event() {
        let fixture = Fixture::new();
        let path = fixture.0.join("note.md");
        let mut batch = FileBatch::default();
        batch.add(path.clone(), "remove", Instant::now());
        std::fs::write(&path, b"replacement").unwrap();
        assert_eq!(batch.flush(), vec![Output::File("modify", path)]);
        assert!(batch.deadline().is_none());
    }

    #[test]
    fn event_loop_expires_from_without_any_following_event() {
        let fixture = Fixture::new();
        let path = fixture.0.join("moved-out");
        let (tx, rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        let root = fixture.0.clone();
        let worker = std::thread::spawn(move || {
            run_events(rx, vec![root], Arc::new(AtomicBool::new(false)), |events| {
                let _ = out_tx.send(events);
            })
        });
        tx.send(
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                .add_path(path.clone()),
        )
        .unwrap();
        let output = out_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(output, vec![Output::structure("path-remove", &path)]);
        drop(tx);
        worker.join().unwrap();
    }

    #[test]
    fn unrelated_events_disable_trackerless_pairing() {
        let fixture = Fixture::new();
        let from = fixture.0.join("old");
        let to = fixture.0.join("new");
        std::fs::create_dir(&to).unwrap();
        let mut state = EventState::new(vec![fixture.0.clone()]);
        let now = Instant::now();
        state.process(
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                .add_path(from.clone()),
            now,
        );
        state.process(
            Event::new(EventKind::Access(notify::event::AccessKind::Any)),
            now,
        );
        let events = state.process(
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To))).add_path(to.clone()),
            now,
        );
        assert_eq!(events, vec![Output::structure("dir-create", &to)]);
        assert_eq!(
            state.expire(now + RENAME_TTL),
            vec![Output::structure("path-remove", &from)]
        );
    }

    #[test]
    fn expired_recreated_directory_is_not_removed() {
        let fixture = Fixture::new();
        let path = fixture.0.join("recreated");
        let now = Instant::now();
        let mut state = EventState::new(vec![fixture.0.clone()]);
        state.process(
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                .add_path(path.clone()),
            now,
        );
        std::fs::create_dir(&path).unwrap();
        assert_eq!(
            state.expire(now + RENAME_TTL),
            vec![Output::structure("dir-create", &path)]
        );
    }

    #[cfg(windows)]
    #[test]
    fn native_renames_into_and_out_of_hidden_directories_are_reported() {
        let fixture = Fixture::new();
        let normal = fixture.0.join("normal");
        let hidden = fixture.0.join(".hidden");
        std::fs::create_dir(&normal).unwrap();
        let (tx, rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
        .unwrap();
        watch_roots(&mut watcher, std::slice::from_ref(&fixture.0)).unwrap();
        let root = fixture.0.clone();
        let worker = std::thread::spawn(move || {
            run_events(rx, vec![root], Arc::new(AtomicBool::new(false)), |events| {
                let _ = out_tx.send(events);
            })
        });
        for (from, to, expected) in [
            (&normal, &hidden, Output::structure("path-remove", &normal)),
            (&hidden, &normal, Output::structure("dir-create", &normal)),
        ] {
            std::fs::rename(from, to).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let events = out_rx
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap();
                if events.contains(&expected) {
                    break;
                }
            }
        }
        drop(watcher);
        worker.join().unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn native_file_replacement_never_emits_a_stale_remove() {
        let fixture = Fixture::new();
        let path = fixture.0.join("note.md");
        std::fs::write(&path, b"old").unwrap();
        let (tx, rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
        .unwrap();
        watch_roots(&mut watcher, std::slice::from_ref(&fixture.0)).unwrap();
        let root = fixture.0.clone();
        let worker = std::thread::spawn(move || {
            run_events(rx, vec![root], Arc::new(AtomicBool::new(false)), |events| {
                let _ = out_tx.send(events);
            })
        });
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"replacement").unwrap();
        let deadline = Instant::now() + RENAME_TTL + COALESCE_WINDOW * 3;
        let mut observed = false;
        loop {
            match out_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(events) => {
                    for event in events {
                        if let Output::File(kind, changed) = event {
                            if changed == path {
                                assert_ne!(kind, "remove");
                                observed = true;
                            }
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(error) => panic!("watcher disconnected: {error}"),
            }
        }
        drop(watcher);
        worker.join().unwrap();
        assert!(observed, "replacement should produce a note update");
    }

    #[cfg(windows)]
    #[test]
    fn native_directory_move_out_eventually_removes_source() {
        let watched = Fixture::new();
        let outside = Fixture::new();
        let child = watched.0.join("child");
        std::fs::create_dir_all(child.join("nested")).unwrap();
        let (tx, rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
        .unwrap();
        watch_roots(&mut watcher, std::slice::from_ref(&watched.0)).unwrap();
        let root = watched.0.clone();
        let worker = std::thread::spawn(move || {
            run_events(rx, vec![root], Arc::new(AtomicBool::new(false)), |events| {
                let _ = out_tx.send(events);
            })
        });
        std::fs::rename(&child, outside.0.join("moved")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let events = out_rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if events.contains(&Output::structure("path-remove", &child)) {
                break;
            }
        }
        drop(watcher);
        worker.join().unwrap();
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root() -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("miaoyan-watcher-{}-{unique}", std::process::id()))
    }

    #[test]
    fn recursive_watch_keeps_subdirectories_renameable() {
        let root = temp_root();
        let child = root.join("child");
        fs::create_dir_all(child.join("grandchild")).unwrap();

        let mut watcher = notify::recommended_watcher(|res: Result<Event, notify::Error>| {
            let _ = res;
        })
        .unwrap();
        watch_roots(&mut watcher, std::slice::from_ref(&root)).unwrap();

        // 回归：逐目录监听时，grandchild 的句柄会让 parent/child 重命名报“拒绝访问”
        let renamed = root.join("child-renamed");
        fs::rename(&child, &renamed)
            .expect("watched roots must keep their subdirectories renameable");

        drop(watcher);
        fs::remove_dir_all(&root).ok();
    }

    // 回归：Windows 对目录内任意子项的新增/删除/重命名都会上报父目录 Modify(Any)。
    // 若把它当结构变化，创建/删除一个笔记就会触发全库重扫（7000+ 笔记约 4-6 秒）。
    #[test]
    fn child_entry_changes_on_directory_are_not_structure_events() {
        use notify::event::{CreateKind, RemoveKind};

        assert!(is_child_change_noise(
            &EventKind::Modify(ModifyKind::Any),
            true
        ));
        assert!(is_child_change_noise(
            &EventKind::Modify(ModifyKind::Metadata(notify::event::MetadataKind::Any)),
            true
        ));
        assert!(!is_child_change_noise(
            &EventKind::Modify(ModifyKind::Any),
            false
        ));
        assert!(!is_child_change_noise(
            &EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            true
        ));
        assert!(!is_child_change_noise(
            &EventKind::Create(CreateKind::Any),
            true
        ));
        assert!(!is_child_change_noise(
            &EventKind::Remove(RemoveKind::Any),
            true
        ));
        assert!(!is_child_change_noise(
            &EventKind::Modify(ModifyKind::Any),
            false
        ));
    }

    #[test]
    fn recursive_watch_reports_nested_changes() {
        let root = temp_root();
        let nested = root.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();

        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
        .unwrap();
        watch_roots(&mut watcher, std::slice::from_ref(&root)).unwrap();

        fs::write(nested.join("note.md"), "hello").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = rx
                .recv_timeout(remaining)
                .expect("nested note change should be reported");
            if event
                .paths
                .iter()
                .any(|p| p.file_name().map(|n| n == "note.md").unwrap_or(false))
            {
                break;
            }
        }

        drop(watcher);
        fs::remove_dir_all(&root).ok();
    }
}
