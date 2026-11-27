mod commands;
mod models;
mod services;

use commands::*;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = file_association::collect_markdown_args(&args);
            if !paths.is_empty() {
                let state = app.state::<file_association::PendingOpenFiles>();
                state.0.lock().unwrap().extend(paths);
                let _ = app.emit("miaoyan://open-files", ());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .manage(file_association::PendingOpenFiles(std::sync::Mutex::new(Vec::new())))
        .manage(services::persistence::Persistence::new(services::storage::get_config_dir()))
        .manage(services::watcher::WatcherState::default())
        .manage(services::search::SearchState::default())
        .manage(services::scanning::ScanState::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().state::<services::search::SearchState>().stop(window.label());
                window.app_handle().state::<services::scanning::ScanState>().stop(window.label());
                if window.label() == "main" {
                    let _ = window.app_handle().state::<services::watcher::WatcherState>().stop();
                }
            }
        })
        .setup(|app| {
            // 冷启动：由文件关联拉起时，从启动参数收集 .md/.markdown 路径
            let args: Vec<String> = std::env::args().collect();
            let paths = file_association::collect_markdown_args(&args);
            if !paths.is_empty() {
                let state = app.state::<file_association::PendingOpenFiles>();
                *state.0.lock().unwrap() = paths;
            }
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

                let shortcut = Shortcut::new(Some(Modifiers::META | Modifiers::ALT), Code::KeyM);
                if let Err(e) = app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }) {
                    eprintln!("Warning: failed to register global shortcut Alt+Meta+M: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_projects,
            get_all_notes,
            scan_folder,
            start_scan_session,
            invalidate_scan,
            release_scan_lane,
            read_directory_snapshot,
            scope_roots_overlap,
            get_notes_in_folder,
            get_notes_metadata,
            read_note,
            write_note,
            save_document_copy,
            resolve_document,
            get_document_recoveries,
            retry_document_recovery,
            create_note,
            delete_note,
            rename_note,
            create_folder,
            search_notes,
            start_search_session,
            invalidate_search,
            get_config,
            save_config,
            parse_markdown,
            start_watching,
            save_version,
            list_versions,
            get_version,
            restore_version,
            get_pinned_notes,
            toggle_pin,
            save_image,
            get_backlinks,
            save_sort_order,
            get_sort_order,
            set_always_on_top,
            upload_image,
            detect_cloud_sync,
            get_sync_status,
            encrypt_note,
            decrypt_note,
            verify_password,
            save_encrypted_note,
            remove_encryption,
            move_note,
            rename_folder,
            delete_folder,
            reveal_in_finder,
            open_in_terminal,
            write_log,
            write_logs,
            read_annotations,
            write_annotations,
            delete_annotations,
            get_pending_open_files,
            get_md_association_status,
            set_md_association,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
