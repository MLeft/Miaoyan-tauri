use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use chrono::{DateTime, Utc};
use crate::models::{NoteMetadata, Project};

/// 系统/重型目录名：扫描与监听时跳过（代码仓库、构建产物、系统目录等）
pub fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "Trash"
                | "node_modules"
                | "target"
                | "dist"
                | "build"
                | "__pycache__"
                | ".git"
                | "AppData"
                | "Local Settings"
                | "NetHood"
                | "PrintHood"
                | "Recent"
                | "SendTo"
                | "Cookies"
                | "$Recycle.Bin"
                | "System Volume Information"
                | "Library"
                | "Caches"
                | "Logs"
                | "Temporary Items"
        )
}

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
                    // Skip hidden / system directories
                    if is_ignored_dir(&name) {
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
    scan_notes_with_progress(root_path, |_| {})
}

/// 全量扫描（带进度回调）：每收录一个笔记文件调用一次 on_file，参数为当前累计数量。
pub fn scan_notes_with_progress(root_path: &Path, mut on_file: impl FnMut(usize)) -> Vec<NoteMetadata> {
    let mut notes = Vec::new();
    if !root_path.exists() {
        return notes;
    }

    for entry in WalkDir::new(root_path)
        .into_iter()
        .filter_entry(|e| {
            // 根目录始终放行：额外文件夹本身可能是隐藏目录（如 .multica）
            if e.depth() == 0 {
                return true;
            }
            // Skip hidden / system directories and Trash folder
            !is_ignored_dir(&e.file_name().to_string_lossy())
        })
        .filter_map(|e| e.ok())
    {
        let file_type = entry.file_type();
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();

        let ext = path.extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        
        if ext != "md" && ext != "markdown" && ext != "txt" && ext != "html" && ext != "htm" && !is_encrypted_file(path) {
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
            on_file(notes.len());
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
                if ext != "md" && ext != "markdown" && ext != "txt" && ext != "html" && ext != "htm" && !is_encrypted_file(&path) {
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

pub fn build_note_metadata(path: &Path, root_path: &Path) -> Option<NoteMetadata> {
    let metadata = fs::metadata(path).ok()?;
    let encrypted = is_encrypted_file(path);
    // For encrypted files (.md.encrypted), strip both suffixes to get the title
    let title = if encrypted {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        name.trim_end_matches(".encrypted")
            .trim_end_matches(".md")
            .to_string()
    } else {
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
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

/// 判断是否为可收录的笔记文件（扩展名白名单 + 非隐藏文件，与扫描 walker 的过滤规则一致）
pub fn is_note_file(path: &Path) -> bool {
    let ext = path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let ext_ok = ext == "md" || ext == "markdown" || ext == "txt" || ext == "html" || ext == "htm" || is_encrypted_file(path);
    if !ext_ok {
        return false;
    }
    !path.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false)
}

/// 快速统计笔记文件总数（只遍历目录树套用过滤规则，不读文件元数据，供渐进加载先报总数）
pub fn count_note_files(root_path: &Path) -> usize {
    if !root_path.exists() {
        return 0;
    }
    WalkDir::new(root_path)
        .into_iter()
        .filter_entry(|e| {
            // 根目录始终放行：额外文件夹本身可能是隐藏目录（如 .multica）
            if e.depth() == 0 {
                return true;
            }
            !is_ignored_dir(&e.file_name().to_string_lossy())
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_note_file(e.path()))
        .count()
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
