use notify::event::{ModifyKind, RenameMode};
use notify::{Watcher, RecursiveMode, Event, EventKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use crate::services::storage;

/// 判断路径相对监听根的部分是否落在忽略目录中。
/// 只检查根以下的层级，避免把隐藏的监听根本身（如 .multica）误判为忽略目录。
fn under_ignored_relative(pb: &Path, roots: &[PathBuf]) -> bool {
    let rel = roots
        .iter()
        .find_map(|r| pb.strip_prefix(r).ok())
        .unwrap_or(pb);
    rel.components()
        .any(|c| storage::is_ignored_dir(&c.as_os_str().to_string_lossy()))
}

/// 文件是否为笔记相关文件（扩展名白名单）
fn is_note_file(pb: &Path) -> bool {
    let name = pb.file_name().unwrap_or_default().to_string_lossy();
    if name.starts_with('.') || name.ends_with(".swp") || name.ends_with(".tmp") || name.ends_with('~') {
        return false;
    }
    let ext = pb.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    matches!(ext.as_str(), "md" | "markdown" | "txt" | "html" | "htm") || name.ends_with(".md.encrypted")
}

/// 目录的普通 Modify 事件只代表「某个子项变了」——Windows 对目录内任意文件的
/// 新建/删除/重命名都会上报父目录 Modify。子项自身已有独立事件，若把它当作
/// 结构变化处理，一次普通文件变更就会触发整棵目录树全量重扫。
fn is_child_change_noise(kind: &EventKind, is_dir: bool) -> bool {
    is_dir
        && matches!(kind, EventKind::Modify(kind) if !matches!(kind, ModifyKind::Name(_)))
}

/// 目录结构事件（目录新建/重命名/路径移除）单独走 fs-structure，
/// 前端按已知路径做增量增删换行，不再全量扫描
fn emit_structure(
    app: &AppHandle,
    kind: &str,
    path: Option<&str>,
    from: Option<&str>,
    to: Option<&str>,
) {
    let _ = app.emit(
        "fs-structure",
        serde_json::json!({ "kind": kind, "path": path, "from": from, "to": to }),
    );
}

/// 取出 1 秒内挂起的重命名源路径（Windows 把 From/To 拆成两条事件上报）
fn take_pending_rename(pending: &mut Vec<(String, Instant)>) -> Option<String> {
    pending.retain(|(_, at)| at.elapsed() < Duration::from_millis(1000));
    if pending.is_empty() {
        None
    } else {
        Some(pending.remove(0).0)
    }
}

/// 事件类型合并优先级：remove > create > modify（同一路径窗口内多次事件取最具破坏性的）
fn merge_event_type(old: &str, new: &str) -> &'static str {
    if old == "remove" || new == "remove" {
        return "remove";
    }
    if old == "create" && new == "create" {
        return "create";
    }
    // create+modify 保持 create；其余组合视为 modify
    if (old == "create" && new == "modify") || (old == "modify" && new == "create") {
        return "create";
    }
    "modify"
}

pub fn start_watcher(
    app_handle: AppHandle,
    paths: &[String],
) -> Option<notify::RecommendedWatcher> {
    let handle = app_handle.clone();
    let roots: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let roots_for_cb = roots.clone();

    // 事件合流：notify 对单次写盘会发出多个 Modify 事件（Data/Content/Metadata），
    // 且自动保存 1.5s 一次——在 200ms 窗口内按路径去重合并后再 emit，
    // 避免前端连续收到重复事件、重复走过滤与防抖链路
    let (evt_tx, evt_rx) = mpsc::channel::<(String, &'static str)>();
    let handle_for_coalescer = handle.clone();
    std::thread::spawn(move || {
        let window = Duration::from_millis(200);
        let mut pending: HashMap<String, &'static str> = HashMap::new();
        let mut first_at: Option<Instant> = None;
        loop {
            let timeout = first_at.map(|t| window.saturating_sub(t.elapsed()));
            match evt_rx.recv_timeout(timeout.unwrap_or(Duration::from_secs(3600))) {
                Ok((path, etype)) => {
                    if first_at.is_none() {
                        first_at = Some(Instant::now());
                    }
                    pending
                        .entry(path)
                        .and_modify(|e| *e = merge_event_type(e, etype))
                        .or_insert(etype);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    // 窗口到期：批量 emit 合并后的事件
                    if !pending.is_empty() {
                        // 多路径事件类型可能不同，逐类型分组 emit（与旧格式兼容）
                        let mut by_type: HashMap<&'static str, Vec<String>> = HashMap::new();
                        for (p, t) in pending.drain() {
                            by_type.entry(t).or_default().push(p);
                        }
                        for (event_type, ps) in by_type {
                            let _ = handle_for_coalescer.emit(
                                "fs-change",
                                serde_json::json!({ "type": event_type, "paths": ps }),
                            );
                        }
                    }
                    first_at = None;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    let handle_for_watcher = handle.clone();
    let mut pending_renames: Vec<(String, Instant)> = Vec::new();

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let Ok(event) = res else { return; };

        match event.kind {
            EventKind::Create(_) => {
                for p in &event.paths {
                    let pb = Path::new(p);
                    if under_ignored_relative(pb, &roots_for_cb) {
                        continue;
                    }
                    if pb.is_dir() {
                        emit_structure(&handle_for_watcher, "dir-create", Some(&p.to_string_lossy()), None, None);
                    } else if is_note_file(pb) {
                        let _ = evt_tx.send((p.to_string_lossy().to_string(), "create"));
                    }
                }
            }
            EventKind::Modify(ModifyKind::Name(mode)) => {
                match mode {
                    RenameMode::Both => {
                        // macOS/Linux 单事件带 [from, to] 两个路径
                        if event.paths.len() >= 2 {
                            let from = event.paths[0].to_string_lossy().to_string();
                            let to = event.paths[1].to_string_lossy().to_string();
                            if !under_ignored_relative(Path::new(&from), &roots_for_cb)
                                && !under_ignored_relative(Path::new(&to), &roots_for_cb)
                            {
                                if Path::new(&to).is_dir() {
                                    emit_structure(&handle_for_watcher, "dir-rename", None, Some(&from), Some(&to));
                                } else if is_note_file(Path::new(&to)) {
                                    let _ = evt_tx.send((from, "remove"));
                                    let _ = evt_tx.send((to, "create"));
                                }
                            }
                        }
                    }
                    RenameMode::From => {
                        for p in &event.paths {
                            let pb = Path::new(p);
                            if under_ignored_relative(pb, &roots_for_cb) {
                                continue;
                            }
                            // 改名后源路径已不存在，无法判断原本是否目录：
                            // 先挂起等待 To 配对；笔记源路径同时按删除上报，
                            // 保证配对失败时旧行也不会残留
                            if is_note_file(pb) {
                                let _ = evt_tx.send((p.to_string_lossy().to_string(), "remove"));
                            }
                            pending_renames.push((p.to_string_lossy().to_string(), Instant::now()));
                        }
                    }
                    RenameMode::To => {
                        for p in &event.paths {
                            let pb = Path::new(p);
                            if under_ignored_relative(pb, &roots_for_cb) {
                                continue;
                            }
                            let path = p.to_string_lossy().to_string();
                            if pb.is_dir() {
                                match take_pending_rename(&mut pending_renames) {
                                    Some(from) => emit_structure(
                                        &handle_for_watcher, "dir-rename", None, Some(&from), Some(&path),
                                    ),
                                    None => emit_structure(
                                        &handle_for_watcher, "dir-create", Some(&path), None, None,
                                    ),
                                }
                            } else if is_note_file(pb) {
                                let _ = take_pending_rename(&mut pending_renames);
                                let _ = evt_tx.send((path, "create"));
                            } else {
                                let _ = take_pending_rename(&mut pending_renames);
                            }
                        }
                    }
                    RenameMode::Any | RenameMode::Other => {
                        for p in &event.paths {
                            let pb = Path::new(p);
                            if under_ignored_relative(pb, &roots_for_cb) {
                                continue;
                            }
                            let path = p.to_string_lossy().to_string();
                            if pb.is_dir() {
                                emit_structure(&handle_for_watcher, "dir-create", Some(&path), None, None);
                            } else if is_note_file(pb) {
                                let _ = evt_tx.send((path, "create"));
                            }
                        }
                    }
                }
            }
            EventKind::Modify(_) => {
                for p in &event.paths {
                    let pb = Path::new(p);
                    if under_ignored_relative(pb, &roots_for_cb) {
                        continue;
                    }
                    if is_child_change_noise(&event.kind, pb.is_dir()) {
                        continue;
                    }
                    if is_note_file(pb) {
                        let _ = evt_tx.send((p.to_string_lossy().to_string(), "modify"));
                    }
                }
            }
            EventKind::Remove(_) => {
                for p in &event.paths {
                    let pb = Path::new(p);
                    if under_ignored_relative(pb, &roots_for_cb) {
                        continue;
                    }
                    if is_note_file(pb) {
                        let _ = evt_tx.send((p.to_string_lossy().to_string(), "remove"));
                    } else {
                        // 删除后的目录无法再 is_dir()：把非笔记路径交给前端，
                        // 由前端按已知目录/笔记前缀判断是否为目录移除
                        emit_structure(&handle_for_watcher, "path-remove", Some(&p.to_string_lossy()), None, None);
                    }
                }
            }
            _ => {}
        }
    }).ok()?;

    watch_roots(&mut watcher, &roots);

    Some(watcher)
}

/// 每个根目录只注册一条递归监听。
/// 逐目录监听会为每个子目录持有句柄，Windows 上会阻止父目录重命名/删除
/// （ERROR_ACCESS_DENIED），用户无法在资源管理器里整理笔记库。
fn watch_roots<W: Watcher>(watcher: &mut W, roots: &[PathBuf]) {
    for root in roots {
        if root.exists() {
            let _ = watcher.watch(root, RecursiveMode::Recursive);
        }
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
        std::env::temp_dir().join(format!(
            "miaoyan-watcher-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn recursive_watch_keeps_subdirectories_renameable() {
        let root = temp_root();
        let child = root.join("child");
        fs::create_dir_all(child.join("grandchild")).unwrap();

        let mut watcher =
            notify::recommended_watcher(|res: Result<Event, notify::Error>| {
                let _ = res;
            })
            .unwrap();
        watch_roots(&mut watcher, std::slice::from_ref(&root));

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

        assert!(is_child_change_noise(&EventKind::Modify(ModifyKind::Any), true));
        assert!(is_child_change_noise(&EventKind::Modify(ModifyKind::Metadata(notify::event::MetadataKind::Any)), true));
        assert!(!is_child_change_noise(&EventKind::Modify(ModifyKind::Any), false));
        assert!(!is_child_change_noise(
            &EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            true
        ));
        assert!(!is_child_change_noise(&EventKind::Create(CreateKind::Any), true));
        assert!(!is_child_change_noise(&EventKind::Remove(RemoveKind::Any), true));
        assert!(!is_child_change_noise(&EventKind::Modify(ModifyKind::Any), false));
    }

    #[test]
    fn recursive_watch_reports_nested_changes() {
        let root = temp_root();
        let nested = root.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();

        let (tx, rx) = mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            })
            .unwrap();
        watch_roots(&mut watcher, std::slice::from_ref(&root));

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
