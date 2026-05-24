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
    #[serde(default)]
    pub is_encrypted: bool,
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
    #[serde(default = "default_preview_width")]
    pub preview_width: String,
    #[serde(default = "default_line_ending")]
    pub line_ending: String,
    #[serde(default = "default_title_font_size")]
    pub title_font_size: f64,
    #[serde(default = "default_presentation_font_size")]
    pub presentation_font_size: f64,
    #[serde(default = "default_line_height")]
    pub line_height: f64,
    #[serde(default = "default_line_spacing")]
    pub line_spacing: f64,
    #[serde(default = "default_letter_spacing")]
    pub letter_spacing: f64,
    #[serde(default = "default_image_upload_service")]
    pub image_upload_service: String,
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
            preview_width: default_preview_width(),
            line_ending: default_line_ending(),
            title_font_size: default_title_font_size(),
            presentation_font_size: default_presentation_font_size(),
            line_height: default_line_height(),
            line_spacing: default_line_spacing(),
            letter_spacing: default_letter_spacing(),
            image_upload_service: default_image_upload_service(),
        }
    }
}

fn default_button_display() -> String {
    "always".to_string()
}

fn default_preview_width() -> String {
    "800".to_string()
}

fn default_line_ending() -> String {
    "lf".to_string()
}

fn default_title_font_size() -> f64 {
    20.0
}

fn default_presentation_font_size() -> f64 {
    24.0
}

fn default_line_height() -> f64 {
    1.3
}

fn default_line_spacing() -> f64 {
    3.0
}

fn default_letter_spacing() -> f64 {
    0.5
}

fn default_image_upload_service() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacklinkItem {
    pub title: String,
    pub path: String,
    pub context: String,
}
