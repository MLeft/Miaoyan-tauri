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

    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        match res {
            Ok(event) => {
                let event_type = match event.kind {
                    EventKind::Create(_) => "create",
                    EventKind::Modify(_) => "modify",
                    EventKind::Remove(_) => "remove",
                    _ => return,
                };
                let paths: Vec<String> = event.paths.iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                // 只转发与笔记相关的事件：忽略目录下的变更、临时文件、
                // 非支持扩展名的文件一律跳过；合并交给合流线程
                for p in &paths {
                    let pb = Path::new(p);
                    if under_ignored_relative(pb, &roots_for_cb) {
                        continue;
                    }
                    let relevant = pb.is_dir() || is_note_file(pb);
                    if relevant {
                        let _ = evt_tx.send((p.clone(), event_type));
                    }
                }
            }
            Err(_) => {}
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
