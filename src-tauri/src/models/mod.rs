use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMetadata {
    pub id: String,
    pub title: String,
    pub path: String,
    pub folder: String,
    pub created_at: DateTime<Utc>,
    pub modified_at: DateTime<Utc>,
    pub pinned: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteContent {
    pub id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    pub path: String,
    pub children: Vec<Project>,
    pub is_root: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub storage_path: String,
    pub theme: String,
    pub language: String,
    pub editor_font_family: String,
    pub editor_font_size: u32,
    pub preview_font_family: String,
    pub preview_font_size: u32,
    pub code_font_family: String,
    pub show_sidebar: bool,
    pub show_notes_list: bool,
    pub split_mode: String,
    pub auto_save_interval: u64,
    #[serde(default = "default_button_display")]
    pub button_display: String,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub quick_launch_shortcut: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            storage_path: String::new(),
            theme: "system".to_string(),
            language: "en".to_string(),
            editor_font_family: "ui-monospace".to_string(),
            editor_font_size: 15,
            preview_font_family: "system-ui".to_string(),
            preview_font_size: 15,
            code_font_family: "Menlo, monospace".to_string(),
            show_sidebar: true,
            show_notes_list: true,
            split_mode: "split".to_string(),
            auto_save_interval: 1500,
            button_display: "always".to_string(),
            always_on_top: false,
            quick_launch_shortcut: String::new(),
        }
    }
}

fn default_button_display() -> String {
    "always".to_string()
}
