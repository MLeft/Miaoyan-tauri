use notify::{Watcher, RecursiveMode, Event, EventKind};
use std::path::Path;
use tauri::{AppHandle, Emitter};

pub fn start_watcher(app_handle: AppHandle, watch_path: &str) -> Option<notify::RecommendedWatcher> {
    let path = Path::new(watch_path).to_path_buf();
    if !path.exists() {
        return None;
    }

    let handle = app_handle.clone();
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
                let _ = handle.emit("fs-change", serde_json::json!({
                    "type": event_type,
                    "paths": paths,
                }));
            }
            Err(_) => {}
        }
    }).ok()?;

    watcher.watch(&path, RecursiveMode::Recursive).ok()?;
    Some(watcher)
}
