use std::fs;
use std::path::Path;
use std::process::Command as StdCommand;
use tauri::command;
use crate::models::{NoteMetadata, NoteContent, Project, AppConfig, BacklinkItem};
use crate::services::storage;
use crate::services::cloud_sync::{self, CloudSyncInfo};
use crate::services::encryption;
use uuid::Uuid;

#[command]
pub fn get_projects(root_path: String, extra_folders: Vec<String>) -> Vec<Project> {
    let mut projects = storage::scan_projects(Path::new(&root_path));
    for folder in extra_folders {
        let p = Path::new(&folder);
        if p.exists() && p.is_dir() {
            let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            let children = storage::scan_projects(p);
            projects.push(Project { name, path: folder, children, is_root: false });
        }
    }
    projects
}

#[command]
pub fn get_all_notes(root_path: String, extra_folders: Vec<String>) -> Vec<NoteMetadata> {
    let mut notes = storage::scan_notes(Path::new(&root_path));
    for folder in extra_folders {
        let p = Path::new(&folder);
        if p.exists() && p.is_dir() {
            notes.extend(storage::scan_notes(p));
        }
    }
    notes
}

#[command]
pub fn get_notes_in_folder(folder_path: String, root_path: String) -> Vec<NoteMetadata> {
    let folder = Path::new(&folder_path);
    let root = Path::new(&root_path);
    storage::scan_notes_in_folder(folder, root)
}

#[command]
pub fn read_note(path: String) -> Result<NoteContent, String> {
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(NoteContent {
        id: path,
        content,
    })
}

#[command]
pub fn write_note(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(&path, &content)
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

#[command]
pub fn create_note(folder_path: String, title: String) -> Result<NoteMetadata, String> {
    let file_name = format!("{}.md", title);
    let path = Path::new(&folder_path).join(&file_name);
    if path.exists() {
        return Err("File already exists".to_string());
    }
    fs::write(&path, "")
        .map_err(|e| format!("Failed to create file: {}", e))?;
    let metadata = fs::metadata(&path)
        .map_err(|e| format!("Failed to read metadata: {}", e))?;
    let created_at: chrono::DateTime<chrono::Utc> = metadata.created()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH).into();
    let modified_at: chrono::DateTime<chrono::Utc> = metadata.modified()
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH).into();
    Ok(NoteMetadata {
        id: path.to_string_lossy().to_string(),
        title,
        path: path.to_string_lossy().to_string(),
        folder: folder_path,
        created_at,
        modified_at,
        pinned: false,
        size: 0,
        is_encrypted: false,
    })
}

#[command]
pub fn delete_note(path: String) -> Result<(), String> {
    trash::delete(&path)
        .map_err(|e| format!("Failed to delete: {}", e))?;
    Ok(())
}

#[command]
pub fn rename_note(old_path: String, new_title: String) -> Result<String, String> {
    let old = Path::new(&old_path);
    let ext = old.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let new_name = format!("{}.{}", new_title, ext);
    let new_path = old.parent()
        .ok_or("Invalid path")?
        .join(&new_name);
    if new_path.exists() {
        return Err("A file with that name already exists".to_string());
    }
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(new_path.to_string_lossy().to_string())
}

#[command]
pub fn create_folder(parent_path: String, name: String) -> Result<String, String> {
    let path = Path::new(&parent_path).join(&name);
    fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create folder: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

#[command]
pub fn rename_folder(old_path: String, new_name: String) -> Result<String, String> {
    let path = Path::new(&old_path);
    if !path.exists() {
        return Err("Folder does not exist".to_string());
    }
    let new_path = path.parent()
        .unwrap_or(path)
        .join(&new_name);
    if new_path.exists() {
        return Err(format!("Folder already exists: {}", new_name));
    }
    fs::rename(&path, &new_path)
        .map_err(|e| format!("Failed to rename folder: {}", e))?;
    Ok(new_path.to_string_lossy().to_string())
}

#[command]
pub fn delete_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Folder does not exist".to_string());
    }
    fs::remove_dir_all(p)
        .map_err(|e| format!("Failed to delete folder: {}", e))
}

#[command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    StdCommand::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    Ok(())
}

#[command]
pub fn open_in_terminal(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    StdCommand::new("open")
        .args(["-a", "Terminal", &path])
        .spawn()
        .map_err(|e| format!("Failed to open in Terminal: {}", e))?;
    Ok(())
}

#[command]
pub fn search_notes(root_path: String, query: String) -> Vec<NoteMetadata> {
    if query.is_empty() {
        return storage::scan_notes(Path::new(&root_path));
    }
    let all_notes = storage::scan_notes(Path::new(&root_path));
    let query_lower = query.to_lowercase();
    let mut results: Vec<(NoteMetadata, u32)> = all_notes.into_iter()
        .filter_map(|note| {
            let mut score = 0u32;
            if note.title.to_lowercase().contains(&query_lower) {
                score += 100;
                if note.title.to_lowercase().starts_with(&query_lower) {
                    score += 50;
                }
            }
            if let Ok(content) = fs::read_to_string(&note.path) {
                if content.to_lowercase().contains(&query_lower) {
                    score += 10;
                }
            }
            if score > 0 { Some((note, score)) } else { None }
        })
        .collect();
    results.sort_by(|a, b| b.1.cmp(&a.1));
    results.into_iter().map(|(note, _)| note).collect()
}

#[command]
pub fn get_config() -> AppConfig {
    let config_path = storage::get_config_dir().join("config.json");
    if config_path.exists() {
        if let Ok(content) = fs::read_to_string(&config_path) {
            if let Ok(config) = serde_json::from_str::<AppConfig>(&content) {
                return config;
            }
        }
    }
    AppConfig::default()
}

#[command]
pub fn save_config(config: AppConfig) -> Result<(), String> {
    let config_dir = storage::ensure_config_dir();
    let config_path = config_dir.join("config.json");
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, content)
        .map_err(|e| format!("Failed to save config: {}", e))?;
    Ok(())
}

#[command]
pub fn parse_markdown(content: String) -> String {
    use pulldown_cmark::{Parser, Options, html, Event, Tag};

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    // Build byte_offset -> line_number lookup (1-based)
    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(content.char_indices().filter_map(|(i, c)| {
            if c == '\n' { Some(i + 1) } else { None }
        }))
        .collect();
    let byte_to_line = |byte: usize| -> usize {
        match line_starts.binary_search(&byte) {
            Ok(i) => i + 1,
            Err(i) => i,
        }
    };

    // Determine which HTML tag name a block-level Tag maps to
    let block_html_tag = |tag: &Tag| -> Option<&'static str> {
        match tag {
            Tag::Paragraph => Some("p"),
            Tag::Heading { level, .. } => Some(match level {
                pulldown_cmark::HeadingLevel::H1 => "h1",
                pulldown_cmark::HeadingLevel::H2 => "h2",
                pulldown_cmark::HeadingLevel::H3 => "h3",
                pulldown_cmark::HeadingLevel::H4 => "h4",
                pulldown_cmark::HeadingLevel::H5 => "h5",
                pulldown_cmark::HeadingLevel::H6 => "h6",
            }),
            Tag::BlockQuote(_) => Some("blockquote"),
            Tag::CodeBlock(_) => Some("pre"),
            Tag::List(None) => Some("ul"),
            Tag::List(Some(_)) => Some("ol"),
            Tag::Item => Some("li"),
            Tag::Table(_) => Some("table"),
            _ => None,
        }
    };

    // Collect (tag_name, line_number) in document order for injection
    let parser = Parser::new_ext(&content, options);
    let offset_events: Vec<(Event, std::ops::Range<usize>)> =
        parser.into_offset_iter().collect();

    let mut block_annotations: Vec<(String, usize)> = Vec::new();
    for (event, range) in &offset_events {
        if let Event::Start(tag) = event {
            if let Some(html_tag) = block_html_tag(tag) {
                let line = byte_to_line(range.start);
                block_annotations.push((html_tag.to_string(), line));
            }
        }
    }

    // Render HTML with SoftBreak -> HardBreak
    let events_final: Vec<Event> = offset_events.into_iter().map(|(e, _)| {
        if matches!(e, Event::SoftBreak) { Event::HardBreak } else { e }
    }).collect();

    let mut html_output = String::new();
    html::push_html(&mut html_output, events_final.into_iter());

    // Inject data-sourcepos attributes on block tags (in document order)
    html_output = inject_sourcepos(html_output, &block_annotations);

    // Post-process: add footnote back-links and reference IDs
    html_output = add_footnote_backlinks(html_output);

    html_output
}

/// Inject data-sourcepos="N" on opening block tags in document order.
/// Walks the HTML string once, matching each tag with its precomputed line number.
fn inject_sourcepos(html: String, annotations: &[(String, usize)]) -> String {
    if annotations.is_empty() {
        return html;
    }
    let mut result = html;
    let mut search_pos = 0usize;

    for (tag_name, line) in annotations {
        let needle = format!("<{}", tag_name);
        // Search from current position
        if let Some(rel) = result[search_pos..].find(&needle) {
            let abs = search_pos + rel;
            // Verify this is a full tag match: next char after tag_name must be '>', ' ', '\n', '\r', or '/'
            let after = abs + needle.len();
            let next_char = result[after..].chars().next();
            let is_full_match = matches!(next_char, Some('>') | Some(' ') | Some('\n') | Some('\r') | Some('/'));
            if is_full_match {
                let insert_at = after;
                let attr = format!(" data-sourcepos=\"{}\"", line);
                result.insert_str(insert_at, &attr);
                search_pos = insert_at + attr.len();
            } else {
                // Not a full tag match (e.g., <pre when we want <p), try searching further
                let mut offset = search_pos + rel + 1;
                let mut found = false;
                while let Some(rel2) = result[offset..].find(&needle) {
                    let abs2 = offset + rel2;
                    let after2 = abs2 + needle.len();
                    let nc = result[after2..].chars().next();
                    if matches!(nc, Some('>') | Some(' ') | Some('\n') | Some('\r') | Some('/')) {
                        let attr = format!(" data-sourcepos=\"{}\"", line);
                        result.insert_str(after2, &attr);
                        search_pos = after2 + attr.len();
                        found = true;
                        break;
                    }
                    offset = abs2 + 1;
                }
                if !found {
                    break;
                }
            }
        } else {
            break;
        }
    }
    result
}

/// Post-process HTML to convert pulldown-cmark footnote format to cmark-gfm compatible format.
///
/// pulldown-cmark generates:
///   <sup class="footnote-reference"><a href="#1">1</a></sup>
///   <div class="footnote-definition" id="1"><sup class="footnote-definition-label">1</sup>
///   <p>content</p></div>
///
/// Target cmark-gfm format:
///   <sup class="footnote-ref"><a href="#fn-1" id="fnref-1" data-footnote-ref>1</a></sup>
///   <section class="footnotes" data-footnotes><ol>
///   <li id="fn-1"><p>content <a href="#fnref-1" class="footnote-backref" data-footnote-backref aria-label="Back to content">↩</a></p></li>
///   </ol></section>
fn add_footnote_backlinks(html: String) -> String {
    let mut result = html;
    let mut ref_counter: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    // Step 1: Transform footnote references from pulldown-cmark to cmark-gfm format
    // <sup class="footnote-reference"><a href="#N"> → <sup class="footnote-ref"><a href="#fn-N" id="fnref-N" data-footnote-ref>
    // For multiple references to same footnote: id="fnref-N-2", id="fnref-N-3", etc.
    let ref_re =
        regex::Regex::new(r##"<sup class="footnote-reference"><a href="#([^"]+)">"##).unwrap();
    let mut ref_matches: Vec<(usize, usize, String, usize)> = Vec::new();

    for cap in ref_re.captures_iter(&result) {
        let footnote_id = cap[1].to_string();
        let count = ref_counter.entry(footnote_id.clone()).or_insert(0);
        *count += 1;
        let m = cap.get(0).unwrap();
        ref_matches.push((m.start(), m.end(), footnote_id, *count));
    }

    // Apply from end to start to preserve byte positions
    for (start, end, footnote_id, occurrence) in ref_matches.into_iter().rev() {
        let fnref_id = if occurrence == 1 {
            format!("fnref-{}", footnote_id)
        } else {
            format!("fnref-{}-{}", footnote_id, occurrence)
        };
        let replacement = format!(
            r##"<sup class="footnote-ref"><a href="#fn-{}" id="{}" data-footnote-ref>"##,
            footnote_id, fnref_id
        );
        result.replace_range(start..end, &replacement);
    }

    // Step 2: Transform footnote definitions from pulldown-cmark to cmark-gfm format
    // Collect all definition blocks, then remove them and rebuild as a <section>.
    let def_block_re = regex::Regex::new(
        r##"<div class="footnote-definition" id="([^"]+)"><sup class="footnote-definition-label">[^<]*</sup>([\s\S]*?)</div>"##
    ).unwrap();

    let mut definitions: Vec<(String, String)> = Vec::new();
    let result_clone = result.clone();
    for cap in def_block_re.captures_iter(&result_clone) {
        let footnote_id = cap[1].to_string();
        let content = cap[2].trim().to_string();
        definitions.push((footnote_id, content));
    }

    // Remove all definition divs from result
    result = def_block_re.replace_all(&result, "").to_string();

    if definitions.is_empty() {
        return result;
    }

    // Build the footnotes section in cmark-gfm format
    let mut section = String::from(r##"<section class="footnotes" data-footnotes><ol>"##);

    for (footnote_id, content) in &definitions {
        let backref = format!(
            r##" <a href="#fnref-{}" class="footnote-backref" data-footnote-backref aria-label="Back to content">↩</a>"##,
            footnote_id
        );

        let mut item_content = content.clone();
        // Insert backref before last </p>
        if let Some(pos) = item_content.rfind("</p>") {
            item_content.insert_str(pos, &backref);
        } else {
            // No <p> tag, append backref at end
            item_content.push_str(&backref);
        }

        section.push_str(&format!(
            r##"<li id="fn-{}">{}</li>"##,
            footnote_id, item_content
        ));
    }

    section.push_str("</ol></section>");
    result.push_str(&section);

    result
}

#[command]
pub fn start_watching(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    use crate::services::watcher;
    std::thread::spawn(move || {
        let _watcher = watcher::start_watcher(app_handle, &path);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
    Ok(())
}

// ===== Version History =====

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct VersionEntry {
    pub timestamp: String,
    pub filename: String,
    pub size: u64,
}

#[command]
pub fn save_version(note_path: String, content: String) -> Result<(), String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    note_path.hash(&mut hasher);
    let hash = format!("{:x}", hasher.finish());
    let versions_dir = storage::get_config_dir().join("versions").join(&hash);
    fs::create_dir_all(&versions_dir)
        .map_err(|e| format!("Failed to create versions dir: {}", e))?;
    let mut entries: Vec<_> = fs::read_dir(&versions_dir)
        .map_err(|e| format!("Failed to read versions dir: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|ext| ext == "md").unwrap_or(false))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    if let Some(latest) = entries.last() {
        if let Ok(latest_content) = fs::read_to_string(latest.path()) {
            if latest_content == content {
                return Ok(());
            }
        }
    }
    if entries.len() >= 20 {
        if let Some(oldest) = entries.first() {
            let _ = fs::remove_file(oldest.path());
        }
    }
    let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let version_file = versions_dir.join(format!("{}.md", timestamp));
    fs::write(&version_file, &content)
        .map_err(|e| format!("Failed to save version: {}", e))?;
    Ok(())
}

#[command]
pub fn list_versions(note_path: String) -> Vec<VersionEntry> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    note_path.hash(&mut hasher);
    let hash = format!("{:x}", hasher.finish());
    let versions_dir = storage::get_config_dir().join("versions").join(&hash);
    if !versions_dir.exists() {
        return Vec::new();
    }
    let mut entries: Vec<VersionEntry> = fs::read_dir(&versions_dir)
        .unwrap_or_else(|_| fs::read_dir(".").unwrap())
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|ext| ext == "md").unwrap_or(false))
        .filter_map(|e| {
            let metadata = e.metadata().ok()?;
            let filename = e.file_name().to_string_lossy().to_string();
            let timestamp = filename.trim_end_matches(".md").to_string();
            Some(VersionEntry { timestamp, filename, size: metadata.len() })
        })
        .collect();
    entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    entries
}

#[command]
pub fn get_version(note_path: String, version_filename: String) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    note_path.hash(&mut hasher);
    let hash = format!("{:x}", hasher.finish());
    let version_file = storage::get_config_dir()
        .join("versions").join(&hash).join(&version_filename);
    fs::read_to_string(&version_file)
        .map_err(|e| format!("Failed to read version: {}", e))
}

#[command]
pub fn restore_version(note_path: String, version_filename: String) -> Result<(), String> {
    let content = get_version(note_path.clone(), version_filename)?;
    fs::write(&note_path, &content)
        .map_err(|e| format!("Failed to restore version: {}", e))?;
    Ok(())
}

// ===== Image Paste =====

#[command]
pub fn save_image(note_path: String, image_data: Vec<u8>, extension: String) -> Result<String, String> {
    let note_dir = Path::new(&note_path)
        .parent()
        .ok_or("Cannot determine note directory")?;
    let images_dir = note_dir.join("i");
    fs::create_dir_all(&images_dir)
        .map_err(|e| format!("Failed to create images directory: {}", e))?;

    let id = Uuid::new_v4();
    let filename = format!("img_{}.{}", id.as_simple(), extension);
    let file_path = images_dir.join(&filename);

    fs::write(&file_path, &image_data)
        .map_err(|e| format!("Failed to write image: {}", e))?;

    let relative_path = format!("i/{}", filename);
    Ok(relative_path)
}

// ===== Backlinks =====

#[command]
pub fn get_backlinks(root_path: String, note_title: String) -> Result<Vec<BacklinkItem>, String> {
    let root = Path::new(&root_path);
    if !root.exists() || !root.is_dir() {
        return Err("Invalid root path".to_string());
    }

    let mut backlinks = Vec::new();
    let note_title_lower = note_title.to_lowercase();
    let re = regex::Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]").unwrap();

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
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
        if ext != "md" && ext != "markdown" && ext != "txt" {
            continue;
        }

        // Skip hidden files
        if let Some(name) = path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Check each line for [[note_title]] or [[note_title|alias]]
        for line in content.lines() {
            let mut found = false;
            for cap in re.captures_iter(line) {
                let link_target = cap[1].trim().to_lowercase();
                if link_target == note_title_lower {
                    found = true;
                    break;
                }
            }
            if found {
                let title = path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                backlinks.push(BacklinkItem {
                    title,
                    path: path.to_string_lossy().to_string(),
                    context: line.trim().to_string(),
                });
                break; // Only add once per file
            }
        }
    }

    Ok(backlinks)
}

// ===== Window Management =====

#[command]
pub async fn set_always_on_top(window: tauri::Window, enabled: bool) -> Result<(), String> {
    window.set_always_on_top(enabled).map_err(|e| e.to_string())
}

// ===== Sort Order =====

#[command]
pub fn save_sort_order(root_path: String, folder: String, order: Vec<String>) -> Result<(), String> {
    use std::collections::HashMap;
    let config_dir = storage::ensure_config_dir();
    let sort_file = config_dir.join("sort-order.json");

    // Read existing data
    let mut all_orders: HashMap<String, Vec<String>> = if sort_file.exists() {
        let content = fs::read_to_string(&sort_file)
            .map_err(|e| format!("Failed to read sort order file: {}", e))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        HashMap::new()
    };

    // Use folder path as key; if folder is empty, use root_path
    let key = if folder.is_empty() { root_path } else { folder };
    all_orders.insert(key, order);

    let content = serde_json::to_string_pretty(&all_orders)
        .map_err(|e| format!("Failed to serialize sort order: {}", e))?;
    fs::write(&sort_file, content)
        .map_err(|e| format!("Failed to save sort order: {}", e))?;
    Ok(())
}

#[command]
pub fn get_sort_order(root_path: String, folder: String) -> Vec<String> {
    use std::collections::HashMap;
    let config_dir = storage::get_config_dir();
    let sort_file = config_dir.join("sort-order.json");

    if !sort_file.exists() {
        return Vec::new();
    }

    let content = match fs::read_to_string(&sort_file) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    let all_orders: HashMap<String, Vec<String>> = match serde_json::from_str(&content) {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    let key = if folder.is_empty() { root_path } else { folder };
    all_orders.get(&key).cloned().unwrap_or_default()
}

// ===== Pin Management =====

#[command]
pub fn get_pinned_notes() -> Vec<String> {
    let pins_path = storage::get_config_dir().join("pins.json");
    if pins_path.exists() {
        if let Ok(content) = fs::read_to_string(&pins_path) {
            if let Ok(pins) = serde_json::from_str::<Vec<String>>(&content) {
                return pins;
            }
        }
    }
    Vec::new()
}

#[command]
pub fn toggle_pin(note_path: String) -> Result<Vec<String>, String> {
    let mut pins = get_pinned_notes();
    if pins.contains(&note_path) {
        pins.retain(|p| p != &note_path);
    } else {
        pins.push(note_path);
    }
    let pins_path = storage::get_config_dir().join("pins.json");
    let content = serde_json::to_string_pretty(&pins)
        .map_err(|e| format!("Failed to serialize pins: {}", e))?;
    fs::write(&pins_path, content)
        .map_err(|e| format!("Failed to save pins: {}", e))?;
    Ok(pins)
}

// ===== Image Upload =====

#[command]
pub async fn upload_image(image_data: Vec<u8>, filename: String, service: String) -> Result<String, String> {
    match service.as_str() {
        "picgo" | "piclist" => {
            let client = reqwest::Client::new();
            let base64_data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &image_data);
            let mime = if filename.ends_with(".jpg") || filename.ends_with(".jpeg") {
                "image/jpeg"
            } else if filename.ends_with(".gif") {
                "image/gif"
            } else {
                "image/png"
            };
            let body = serde_json::json!({
                "list": [format!("data:{};base64,{}", mime, base64_data)]
            });
            let resp = client
                .post("http://127.0.0.1:36677/upload")
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("Upload request failed: {}", e))?;
            let result: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse upload response: {}", e))?;
            if result["success"].as_bool() == Some(true) {
                let url = result["result"][0]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                if url.is_empty() {
                    Err("Upload succeeded but no URL returned".to_string())
                } else {
                    Ok(url)
                }
            } else {
                let msg = result["message"]
                    .as_str()
                    .unwrap_or("Upload failed")
                    .to_string();
                Err(msg)
            }
        }
        "upic" => Err("uPic upload via URL scheme is not yet supported".to_string()),
        "picsee" => Err("Picsee upload is not yet supported".to_string()),
        _ => Err(format!("Unknown upload service: {}", service)),
    }
}

// ===== Cloud Sync =====

#[command]
pub fn detect_cloud_sync() -> CloudSyncInfo {
    cloud_sync::detect_icloud()
}

#[command]
pub fn get_sync_status(path: String) -> String {
    cloud_sync::sync_status_str(&path).to_string()
}

// ===== Encryption =====

#[command]
pub async fn encrypt_note(path: String, password: String) -> Result<(), String> {
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let encrypted = encryption::encrypt(&content, &password)?;
    let encrypted_path = format!("{}.encrypted", path);
    fs::write(&encrypted_path, &encrypted)
        .map_err(|e| format!("Failed to write encrypted file: {}", e))?;
    fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete original file: {}", e))?;
    Ok(())
}

#[command]
pub async fn decrypt_note(path: String, password: String) -> Result<String, String> {
    let data = fs::read(&path)
        .map_err(|e| format!("Failed to read encrypted file: {}", e))?;
    encryption::decrypt(&data, &password)
}

#[command]
pub async fn verify_password(path: String, password: String) -> Result<bool, String> {
    let data = fs::read(&path)
        .map_err(|e| format!("Failed to read encrypted file: {}", e))?;
    match encryption::decrypt(&data, &password) {
        Ok(_) => Ok(true),
        Err(e) if e.contains("Invalid password") => Ok(false),
        Err(e) => Err(e),
    }
}

#[command]
pub async fn save_encrypted_note(path: String, content: String, password: String) -> Result<(), String> {
    let encrypted = encryption::encrypt(&content, &password)?;
    // path should be the .md.encrypted file path
    let encrypted_path = if path.ends_with(".encrypted") {
        path.clone()
    } else {
        format!("{}.encrypted", path)
    };
    if let Some(parent) = Path::new(&encrypted_path).parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    fs::write(&encrypted_path, &encrypted)
        .map_err(|e| format!("Failed to write encrypted file: {}", e))?;
    Ok(())
}

#[command]
pub async fn remove_encryption(path: String, password: String) -> Result<(), String> {
    // path is the .md.encrypted file
    let data = fs::read(&path)
        .map_err(|e| format!("Failed to read encrypted file: {}", e))?;
    let content = encryption::decrypt(&data, &password)?;
    // Write plaintext to .md file (strip .encrypted suffix)
    let md_path = path.trim_end_matches(".encrypted").to_string();
    fs::write(&md_path, &content)
        .map_err(|e| format!("Failed to write plaintext file: {}", e))?;
    fs::remove_file(&path)
        .map_err(|e| format!("Failed to delete encrypted file: {}", e))?;
    Ok(())
}

#[command]
pub fn move_note(source_path: String, target_folder: String) -> Result<String, String> {
    let src = Path::new(&source_path);
    let file_name = src.file_name().ok_or("Invalid source path".to_string())?;
    let dest = Path::new(&target_folder).join(file_name);
    if dest.exists() {
        return Err("Target file already exists".to_string());
    }
    fs::rename(&src, &dest)
        .map_err(|e| format!("Failed to move: {}", e))?;
    Ok(dest.to_string_lossy().to_string())
}

#[command]
pub fn write_log(storage_path: String, message: String) -> Result<(), String> {
    let log_dir = Path::new(&storage_path).join(".log");
    fs::create_dir_all(&log_dir)
        .map_err(|e| format!("Failed to create log dir: {}", e))?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let log_file = log_dir.join(format!("{}.log", today));
    let timestamp = chrono::Local::now().format("%H:%M:%S%.3f").to_string();
    let line = format!("[{}] {}\n", timestamp, message);
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .map_err(|e| format!("Failed to open log file: {}", e))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write log: {}", e))?;
    Ok(())
}
