use notify::{Watcher, RecursiveMode, Event, EventKind};
use std::path::Path;
use tauri::{AppHandle, Emitter};

pub fn start_watcher(app_handle: AppHandle, paths: &[String]) -> Option<notify::RecommendedWatcher> {
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
                // Skip temp files and editor swap files
                if paths.iter().all(|p| {
                    let name = Path::new(p).file_name().unwrap_or_default().to_string_lossy();
                    name.starts_with('.') || name.ends_with(".swp") || name.ends_with(".tmp") || name.ends_with('~')
                }) {
                    return;
                }
                let _ = handle.emit("fs-change", serde_json::json!({
                    "type": event_type,
                    "paths": paths,
                }));
            }
            Err(_) => {}
        }
    }).ok()?;

    for path_str in paths {
        let path = Path::new(path_str);
        if path.exists() {
            let _ = watcher.watch(path, RecursiveMode::Recursive);
        }
    }

    Some(watcher)
}
