use notify::{Watcher, RecursiveMode, Event, EventKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;
use crate::services::storage;

/// 监听线程的控制消息
pub enum WatchMsg {
    /// 新建目录 → 补注册监听
    WatchDir(PathBuf),
    /// 停止并释放当前 watcher
    Stop,
}

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
    new_dir_tx: mpsc::Sender<WatchMsg>,
) -> Option<notify::RecommendedWatcher> {
    let handle = app_handle.clone();
    let roots: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let roots_for_cb = roots.clone();
    let tx_for_cb = new_dir_tx.clone();

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
                // 新建目录 → 请求追加监听（逐目录非递归注册模式下必须动态补注册）
                if matches!(event.kind, EventKind::Create(_)) {
                    for p in &event.paths {
                        if p.is_dir() && !under_ignored_relative(p, &roots_for_cb) {
                            let _ = tx_for_cb.send(WatchMsg::WatchDir(p.clone()));
                        }
                    }
                }

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

    // 逐目录非递归注册：只监听笔记相关目录，跳过 .git / node_modules /
    // 构建产物等忽略目录，避免代码仓库活动产生事件风暴
    for root in &roots {
        if !root.exists() {
            continue;
        }
        let _ = watcher.watch(root, RecursiveMode::NonRecursive);
        for entry in WalkDir::new(root)
            .into_iter()
            .filter_entry(|e| {
                if e.depth() == 0 {
                    return true;
                }
                !storage::is_ignored_dir(&e.file_name().to_string_lossy())
            })
            .filter_map(|e| e.ok())
        {
            if entry.depth() > 0 && entry.file_type().is_dir() {
                let _ = watcher.watch(entry.path(), RecursiveMode::NonRecursive);
            }
        }
    }

    Some(watcher)
}
