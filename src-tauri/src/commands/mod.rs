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
pub async fn get_projects(root_path: String, extra_folders: Vec<String>) -> Vec<Project> {
    // 后台线程池执行 + 多根并行扫描，避免阻塞 UI 主线程
    tauri::async_runtime::spawn_blocking(move || {
        let root_handle = {
            let rp = root_path.clone();
            std::thread::spawn(move || storage::scan_projects(Path::new(&rp)))
        };
        let extra_handles: Vec<_> = extra_folders
            .into_iter()
            .map(|f| {
                std::thread::spawn(move || {
                    let p = Path::new(&f);
                    if p.exists() && p.is_dir() {
                        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                        let children = storage::scan_projects(p);
                        Some(Project { name, path: f, children, is_root: false })
                    } else {
                        None
                    }
                })
            })
            .collect();
        let mut projects = root_handle.join().unwrap_or_default();
        for h in extra_handles {
            if let Ok(Some(proj)) = h.join() {
                projects.push(proj);
            }
        }
        projects
    })
    .await
    .unwrap_or_default()
}

#[command]
pub async fn get_all_notes(root_path: String, extra_folders: Vec<String>) -> Vec<NoteMetadata> {
    // 后台线程池执行 + 多根并行扫描，避免阻塞 UI 主线程
    tauri::async_runtime::spawn_blocking(move || {
        let mut roots = vec![root_path];
        roots.extend(extra_folders);
        let handles: Vec<_> = roots
            .into_iter()
            .map(|r| std::thread::spawn(move || storage::scan_notes(Path::new(&r))))
            .collect();
        let mut notes: Vec<NoteMetadata> = Vec::new();
        for h in handles {
            if let Ok(mut n) = h.join() {
                notes.append(&mut n);
            }
        }
        notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        notes
    })
    .await
    .unwrap_or_default()
}

#[command]
pub fn get_notes_in_folder(folder_path: String, root_path: String) -> Vec<NoteMetadata> {
    let folder = Path::new(&folder_path);
    let root = Path::new(&root_path);
    storage::scan_notes_in_folder(folder, root)
}

/// 按路径批量获取笔记元数据（增量刷新用，避免全量重扫目录）
#[command]
pub fn get_notes_metadata(paths: Vec<String>, root_path: String, extra_folders: Vec<String>) -> Vec<NoteMetadata> {
    let mut roots: Vec<std::path::PathBuf> = Vec::with_capacity(extra_folders.len() + 1);
    if !root_path.is_empty() {
        roots.push(std::path::PathBuf::from(&root_path));
    }
    for f in &extra_folders {
        roots.push(std::path::PathBuf::from(f));
    }
    paths
        .iter()
        .filter_map(|p| {
            let path = Path::new(p);
            let root = roots.iter().find(|r| path.starts_with(r)).unwrap_or(roots.first()?);
            storage::build_note_metadata(path, root)
        })
        .collect()
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
    // Use title as-is if it already has a supported extension, otherwise append .md
    let file_name = if title.ends_with(".md") || title.ends_with(".markdown") || title.ends_with(".txt") || title.ends_with(".html") || title.ends_with(".htm") {
        title.clone()
    } else {
        format!("{}.md", title)
    };
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
        title: file_name,
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
    // If new_title already contains the extension, use it directly
    let new_name = if new_title.ends_with(&format!(".{}",  ext)) {
        new_title
    } else {
        format!("{}.{}", new_title, ext)
    };
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
    #[cfg(target_os = "macos")]
    {
        StdCommand::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Finder: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        StdCommand::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = p.parent().unwrap_or(p);
        StdCommand::new("xdg-open")
            .arg(parent.to_string_lossy().to_string())
            .spawn()
            .map_err(|e| format!("Failed to reveal in file manager: {}", e))?;
    }
    Ok(())
}

#[command]
pub fn open_in_terminal(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Path does not exist".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        StdCommand::new("open")
            .args(["-a", "Terminal", &path])
            .spawn()
            .map_err(|e| format!("Failed to open in Terminal: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        // Try Windows Terminal first, fall back to cmd
        let result = StdCommand::new("wt")
            .args(["-d", &path])
            .spawn();
        if result.is_err() {
            StdCommand::new("cmd")
                .args(["/c", "start", "cmd", "/k", "cd", "/d", &path])
                .spawn()
                .map_err(|e| format!("Failed to open in Terminal: {}", e))?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators
        for term in &["gnome-terminal", "konsole", "xterm"] {
            if StdCommand::new(term)
                .arg("--working-dir")
                .arg(&path)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        return Err("No supported terminal emulator found".to_string());
    }
    Ok(())
}

#[command]
pub async fn search_notes(root_path: String, query: String) -> Vec<NoteMetadata> {
    // 全文搜索代价高，后台线程池执行，避免阻塞 UI 主线程
    tauri::async_runtime::spawn_blocking(move || search_notes_impl(root_path, query))
        .await
        .unwrap_or_default()
}

fn search_notes_impl(root_path: String, query: String) -> Vec<NoteMetadata> {
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

    // 收集块级 Start 事件的标签与行号（文档序），用于注入 data-sourcepos
    let parser = Parser::new_ext(&content, options);
    let offset_events: Vec<(Event, std::ops::Range<usize>)> = parser.into_offset_iter().collect();

    let mut annotations: Vec<(&'static str, usize)> = Vec::new();
    for (event, range) in &offset_events {
        if let Event::Start(tag) = event {
            if let Some(html_tag) = block_html_tag(tag) {
                annotations.push((html_tag, byte_to_line(range.start)));
            }
        }
    }

    // 一次性渲染（保住 HtmlWriter 的表格对齐/表头状态、脚注编号、换行状态），
    // SoftBreak 转 HardBreak 与原逻辑一致
    let events_final = offset_events
        .into_iter()
        .map(|(e, _)| if matches!(e, Event::SoftBreak) { Event::HardBreak } else { e });
    let mut html_output = String::with_capacity(content.len() * 2);
    html::push_html(&mut html_output, events_final);

    // 线性注入 data-sourcepos（单次扫描 + 一次重建，无全文移动）
    let html_output = inject_sourcepos(html_output, &annotations);

    // Post-process: add footnote back-links and reference IDs
    let html_output = add_footnote_backlinks(html_output);

    html_output
}

/// Inject data-sourcepos="N" on opening block tags in document order.
///
/// 语义与旧的逐条 find+insert_str 实现一致，但只扫描 HTML 一次：
/// 预收集全部可注入点（标签名 + 位置），按注释顺序消费后一次性重建，
/// 避免每次 insert_str 移动后续全文的 O(块数×文档长) 开销。
fn inject_sourcepos(html: String, annotations: &[(&'static str, usize)]) -> String {
    if annotations.is_empty() {
        return html;
    }
    // 预扫描可注入点：'<' + 白名单标签名 + 紧跟 ' '/'>'/'\n'/'\r'/'/'
    let bytes = html.as_bytes();
    let mut points: Vec<(&'static str, usize)> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let rel = match html[i..].find('<') {
            Some(r) => r,
            None => break,
        };
        let lt = i + rel;
        let name_start = lt + 1;
        let name_end = bytes[name_start..]
            .iter()
            .position(|b| !b.is_ascii_alphanumeric())
            .map(|p| name_start + p)
            .unwrap_or(bytes.len());
        if name_end > name_start && name_end < bytes.len() {
            if matches!(bytes[name_end], b'>' | b' ' | b'\n' | b'\r' | b'/') {
                let tag: &'static str = match &html[name_start..name_end] {
                    "p" => "p",
                    "h1" => "h1",
                    "h2" => "h2",
                    "h3" => "h3",
                    "h4" => "h4",
                    "h5" => "h5",
                    "h6" => "h6",
                    "blockquote" => "blockquote",
                    "pre" => "pre",
                    "ul" => "ul",
                    "ol" => "ol",
                    "li" => "li",
                    "table" => "table",
                    _ => "",
                };
                if !tag.is_empty() {
                    points.push((tag, name_end));
                }
            }
        }
        i = lt + 1;
    }
    // 按注释顺序消费注入点；某条注释找不到匹配即 break（与旧实现一致）
    let mut inserts: Vec<(usize, usize)> = Vec::with_capacity(annotations.len());
    let mut pi = 0usize;
    'outer: for (tag, line) in annotations {
        while pi < points.len() {
            let (ptag, pos) = points[pi];
            pi += 1;
            if ptag == *tag {
                inserts.push((pos, *line));
                continue 'outer;
            }
        }
        break;
    }
    if inserts.is_empty() {
        return html;
    }
    // 一次性重建，插入点间无全文移动
    let mut out = String::with_capacity(html.len() + inserts.len() * 24);
    let mut last = 0usize;
    for (pos, line) in &inserts {
        out.push_str(&html[last..*pos]);
        out.push_str(" data-sourcepos=\"");
        out.push_str(&line.to_string());
        out.push('"');
        last = *pos;
    }
    out.push_str(&html[last..]);
    out
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
pub fn start_watching(app_handle: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    use crate::services::watcher;
    use crate::services::watcher::WatchMsg;
    use notify::Watcher;
    use std::sync::mpsc;
    use std::sync::{Mutex, OnceLock};

    // 同一时刻只保留一个 watcher：配置变化重新监听时先停掉旧的，避免事件翻倍
    static PREV_TX: OnceLock<Mutex<Option<mpsc::Sender<WatchMsg>>>> = OnceLock::new();
    let slot = PREV_TX.get_or_init(|| Mutex::new(None));
    if let Some(prev) = slot.lock().unwrap().take() {
        let _ = prev.send(WatchMsg::Stop);
    }

    let (tx, rx) = mpsc::channel::<WatchMsg>();
    *slot.lock().unwrap() = Some(tx.clone());

    std::thread::spawn(move || {
        let mut watcher = match watcher::start_watcher(app_handle, &paths, tx) {
            Some(w) => w,
            None => return,
        };
        // 阻塞等待控制消息（无事件时线程休眠，零 CPU）
        while let Ok(msg) = rx.recv() {
            match msg {
                WatchMsg::WatchDir(dir) => {
                    let _ = watcher.watch(&dir, notify::RecursiveMode::NonRecursive);
                }
                WatchMsg::Stop => break, // 退出后 watcher 被 drop，自动取消监听
            }
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
pub async fn get_backlinks(root_path: String, note_title: String) -> Result<Vec<BacklinkItem>, String> {
    // 反向链接需读全部笔记内容，后台线程池执行，避免阻塞 UI 主线程
    tauri::async_runtime::spawn_blocking(move || get_backlinks_impl(root_path, note_title))
        .await
        .map_err(|e| e.to_string())?
}

fn get_backlinks_impl(root_path: String, note_title: String) -> Result<Vec<BacklinkItem>, String> {
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
            // 根目录始终放行；其余层级跳过隐藏/系统目录（与 scan_notes 一致）
            if e.depth() == 0 {
                return true;
            }
            !storage::is_ignored_dir(&e.file_name().to_string_lossy())
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

/* ── Annotations ── */

fn annotations_path(note_path: &str) -> String {
    let p = Path::new(note_path);
    let stem = p.file_stem().unwrap_or_default().to_string_lossy();
    let parent = p.parent().unwrap_or(Path::new(""));
    parent.join(format!("{}.annotations.json", stem)).to_string_lossy().to_string()
}

#[command]
pub fn read_annotations(note_path: String) -> String {
    let path = annotations_path(&note_path);
    fs::read_to_string(&path).unwrap_or_else(|_| "[]".to_string())
}

#[command]
pub fn write_annotations(note_path: String, json: String) -> Result<(), String> {
    let path = annotations_path(&note_path);
    fs::write(&path, &json)
        .map_err(|e| format!("Failed to write annotations: {}", e))
}

#[command]
pub fn delete_annotations(note_path: String) -> Result<(), String> {
    let path = annotations_path(&note_path);
    if Path::new(&path).exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete annotations: {}", e))?;
    }
    Ok(())
}
