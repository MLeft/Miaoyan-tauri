use std::fs;
use std::path::Path;
use tauri::command;
use crate::models::{NoteMetadata, NoteContent, Project, AppConfig};
use crate::services::storage;

#[command]
pub fn get_projects(root_path: String) -> Vec<Project> {
    let path = Path::new(&root_path);
    storage::scan_projects(path)
}

#[command]
pub fn get_all_notes(root_path: String) -> Vec<NoteMetadata> {
    let path = Path::new(&root_path);
    storage::scan_notes(path)
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

/// Post-process HTML to add bidirectional footnote linking.
/// Adds id="fnref-N" to footnote reference sup elements
/// and a back-link inside definitions so clicking navigates back.
fn add_footnote_backlinks(html: String) -> String {
    let mut result = html;
    let mut ref_counter: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    // Step 1: Add id="fnref-N" to each <sup class="footnote-reference">
    // Using r##"..."## raw strings so # inside the regex is not ambiguous
    let ref_re = regex::Regex::new(r##"<sup class="footnote-reference"><a href="#([^"]+)">"##).unwrap();
    let mut ref_indices: Vec<(usize, usize, String, usize)> = Vec::new();

    for cap in ref_re.captures_iter(&result.clone()) {
        let footnote_id = cap[1].to_string();
        let count = ref_counter.entry(footnote_id.clone()).or_insert(0);
        *count += 1;
        let m = cap.get(0).unwrap();
        ref_indices.push((m.start(), m.end(), footnote_id, *count));
    }

    // Apply from end to start to preserve byte positions
    for (start, end, footnote_id, occurrence) in ref_indices.into_iter().rev() {
        let fnref_id = format!("fnref-{}-{}", footnote_id, occurrence);
        let replacement = format!(
            r##"<sup class="footnote-reference" id="{}"><a href="#{}">"##,
            fnref_id, footnote_id
        );
        result.replace_range(start..end, &replacement);
    }

    // Step 2: For each footnote definition, add back-link at end of last <p>
    // pulldown-cmark generates:
    //   <div class="footnote-definition" id="N"><sup ...>N</sup><p>text</p></div>
    // We want ↩ appended inside the last </p> before </div>, matching original cmark-gfm style.
    let def_block_re = regex::Regex::new(
        r##"(<div class="footnote-definition" id="([^"]+)">)([\s\S]*?)(</div>)"##
    ).unwrap();

    result = def_block_re.replace_all(&result, |caps: &regex::Captures| {
        let open_tag = &caps[1];
        let footnote_id = &caps[2];
        let inner = &caps[3];
        let close_tag = &caps[4];
        let backref = format!(
            r##" <a class="footnote-backref" href="#fnref-{}-1">↩</a>"##,
            footnote_id
        );
        // Insert ↩ before the last </p> inside this definition block
        if let Some(last_p_pos) = inner.rfind("</p>") {
            let mut new_inner = inner.to_string();
            new_inner.insert_str(last_p_pos, &backref);
            format!("{}{}{}", open_tag, new_inner, close_tag)
        } else {
            // No <p>, append backref before closing div
            format!("{}{}{}{}", open_tag, inner, backref, close_tag)
        }
    }).to_string();

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
