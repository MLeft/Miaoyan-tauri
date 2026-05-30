use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use chrono::{DateTime, Utc};
use crate::models::{NoteMetadata, Project};

pub fn scan_projects(root_path: &Path) -> Vec<Project> {
    let mut projects = Vec::new();
    if !root_path.exists() || !root_path.is_dir() {
        return projects;
    }

    match fs::read_dir(root_path) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let name = path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    // Skip hidden directories
                    if name.starts_with('.') {
                        continue;
                    }
                    let children = scan_projects(&path);
                    projects.push(Project {
                        name,
                        path: path.to_string_lossy().to_string(),
                        children,
                        is_root: false,
                    });
                }
            }
        }
        Err(_) => {}
    }

    projects.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    projects
}

pub fn scan_notes(root_path: &Path) -> Vec<NoteMetadata> {
    let mut notes = Vec::new();
    if !root_path.exists() {
        return notes;
    }

    for entry in WalkDir::new(root_path)
        .into_iter()
        .filter_entry(|e| {
            // Skip hidden directories and Trash folder
            let name = e.file_name().to_string_lossy();
            !name.starts_with('.') && name != "Trash"
        })
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        
        let ext = path.extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        
        if ext != "md" && ext != "markdown" && ext != "txt" && !is_encrypted_file(path) {
            continue;
        }

        // Skip hidden files
        if let Some(name) = path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }

        if let Some(meta) = build_note_metadata(path, root_path) {
            notes.push(meta);
        }
    }

    notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    notes
}

pub fn scan_notes_in_folder(folder_path: &Path, root_path: &Path) -> Vec<NoteMetadata> {
    let mut notes = Vec::new();
    if !folder_path.exists() {
        return notes;
    }

    match fs::read_dir(folder_path) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let ext = path.extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                if ext != "md" && ext != "markdown" && ext != "txt" && !is_encrypted_file(&path) {
                    continue;
                }
                if let Some(name) = path.file_name() {
                    if name.to_string_lossy().starts_with('.') {
                        continue;
                    }
                }
                if let Some(meta) = build_note_metadata(&path, root_path) {
                    notes.push(meta);
                }
            }
        }
        Err(_) => {}
    }

    notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    notes
}

fn build_note_metadata(path: &Path, root_path: &Path) -> Option<NoteMetadata> {
    let metadata = fs::metadata(path).ok()?;
    let encrypted = is_encrypted_file(path);
    // For encrypted files (.md.encrypted), strip both suffixes to get the title
    let title = if encrypted {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        name.trim_end_matches(".encrypted")
            .trim_end_matches(".md")
            .to_string()
    } else {
        let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        if ext == "md" || ext == "markdown" {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        } else {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        }
    };
    
    let folder = path.parent()
        .map(|p| {
            p.strip_prefix(root_path)
                .unwrap_or(p)
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default();

    let created_at: DateTime<Utc> = metadata.created()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        .into();
    let modified_at: DateTime<Utc> = metadata.modified()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        .into();

    let id = path.to_string_lossy().to_string();

    Some(NoteMetadata {
        id,
        title,
        path: path.to_string_lossy().to_string(),
        folder,
        created_at,
        modified_at,
        pinned: false,
        size: metadata.len(),
        is_encrypted: encrypted,
    })
}

/// Check if path is an encrypted note (.md.encrypted)
fn is_encrypted_file(path: &Path) -> bool {
    path.to_string_lossy().ends_with(".md.encrypted")
}

pub fn get_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("miaoyan")
}

pub fn ensure_config_dir() -> PathBuf {
    let config_dir = get_config_dir();
    if !config_dir.exists() {
        let _ = fs::create_dir_all(&config_dir);
    }
    config_dir
}
