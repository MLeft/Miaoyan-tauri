mod commands;
mod models;
mod services;

use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_projects,
            get_all_notes,
            get_notes_in_folder,
            read_note,
            write_note,
            create_note,
            delete_note,
            rename_note,
            create_folder,
            search_notes,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
