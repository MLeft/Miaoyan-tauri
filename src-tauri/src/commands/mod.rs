pub mod file_association;
pub use file_association::*;

use std::fs;
use std::path::Path;
use std::process::Command as StdCommand;
use tauri::command;
use tauri::{Emitter, Manager};
use crate::models::{NoteMetadata, NoteContent, Project, AppConfig, BacklinkItem};
use crate::services::storage;
use crate::services::cloud_sync::{self, CloudSyncInfo};
use uuid::Uuid;

mod scan;
use crate::services::scanning::{ScanRun, ScanState};

#[command]
pub fn start_scan_session(window: tauri::WebviewWindow, state: tauri::State<'_, ScanState>) -> String {
    state.open(window.label())
}

#[command]
pub fn invalidate_scan(window: tauri::WebviewWindow, state: tauri::State<'_, ScanState>, session_id: String, lane: String, generation: u64) {
    state.invalidate(window.label(), &session_id, &lane, generation);
}

#[command]
pub fn release_scan_lane(window: tauri::WebviewWindow, state: tauri::State<'_, ScanState>, session_id: String, lane: String, generation: u64) {
    state.release(window.label(), &session_id, &lane, generation);
}

#[command]
pub async fn get_projects(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<'_, ScanState>, root_path: String, extra_folders: Vec<String>, scan_id: String, session_id: String, lane: String, generation: u64) -> Result<Vec<Project>, String> {
    let Some(run) = state.begin(window.label(), &session_id, &lane, generation) else { return Err("Scan canceled".into()); };
    tauri::async_runtime::spawn_blocking(move || {
        let cancelled = || run.is_cancelled();
        let paths = scan::project_paths(root_path, extra_folders, &cancelled).map_err(|error| format!("Project discovery failed: {error}"))?;
        if cancelled() { return Err("Scan canceled".into()); }
        let projects: Vec<_> = paths.into_iter().take_while(|_| !cancelled()).map(|path| {
            let project = Project {
                name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(), children: Vec::new(), is_root: false,
            };
            scan::emit(&app, "miaoyan://project-chunk", &scan_id, scan::ProjectDiscovery { project: &project, scanning: true });
            project
        }).collect();
        let result = scan::bounded_map(projects, |mut project| {
            match storage::scan_projects(Path::new(&project.path), &cancelled) {
                Ok(children) => {
                    project.children = children;
                    if !cancelled() { scan::emit(&app, "miaoyan://project-chunk", &scan_id, &project); }
                    Ok(project)
                }
                Err(error) => Err(error),
            }
        }, &cancelled).map_err(|error| error.to_string());
        if cancelled() { return Err("Scan canceled".into()); }
        let projects = result?
            .into_iter()
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(|error| format!("Project scan failed: {error}"))?;
        Ok(projects)
    }).await.map_err(|error| format!("Scan task failed: {error}"))?
}

/// Same wire payload, borrowed while serializing to avoid cloning every note.
#[derive(serde::Serialize, Clone)]
pub struct NotesChunk<'a> {
    pub dir: &'a str,
    pub notes: &'a [NoteMetadata],
}

fn scan_extra_project(app: &tauri::AppHandle, f: String, scan_id: &str, run: &ScanRun) -> std::io::Result<Option<Project>> {
    let pb = std::path::PathBuf::from(&f);
    if run.is_cancelled() || !pb.is_dir() { return Ok(None); }
    let mut project = Project {
        name: pb.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: f, children: Vec::new(), is_root: false,
    };
    scan::emit(&app, "miaoyan://project-chunk", &scan_id, scan::ProjectDiscovery { project: &project, scanning: true });
    project.children = storage::scan_projects(&pb, &|| run.is_cancelled())?;
    if !run.is_cancelled() { scan::emit(app, "miaoyan://project-chunk", scan_id, &project); }
    Ok(Some(project))
}

/// All roots share a single bounded worker set. Progress counts successful
/// metadata reads, including top-level files; no speculative denominator.
fn scan_root_notes(app: &tauri::AppHandle, roots: Vec<String>, scan_id: &str, run: &ScanRun) -> Result<Vec<NoteMetadata>, String> {
    // Serialize progress emissions as well as increments so they cannot regress
    // when workers finish concurrently (only a tiny critical section per file).
    let counter = std::sync::Mutex::new(0usize);
    let cancelled = || run.is_cancelled();
    let tasks = scan::note_tasks(roots, &cancelled).map_err(|error| format!("Note discovery failed: {error}"))?;
    let chunks = scan::bounded_map(tasks, |task| {
        scan::scan_task(task, || {
            let mut total = counter.lock().unwrap();
            if cancelled() { return; }
            *total += 1;
            if *total % 200 == 0 { scan::emit(app, "miaoyan://scan-progress", scan_id, *total); }
        }, &cancelled).inspect(|(dir, notes)| {
            if !cancelled() { scan::emit(app, "miaoyan://notes-chunk", scan_id, NotesChunk { dir, notes }); }
        })
    }, &cancelled).map_err(|error| error.to_string())?;
    if cancelled() { return Err("Scan canceled".into()); }
    let notes: Vec<_> = chunks
        .into_iter()
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|error| format!("Note scan failed: {error}"))?
        .into_iter()
        .flat_map(|(_, notes)| notes)
        .collect();
    scan::emit(app, "miaoyan://scan-progress", scan_id, notes.len());
    Ok(notes)
}

#[command]
pub async fn get_all_notes(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<'_, ScanState>, root_path: String, extra_folders: Vec<String>, scan_id: String, session_id: String, lane: String, generation: u64) -> Result<Vec<NoteMetadata>, String> {
    let Some(run) = state.begin(window.label(), &session_id, &lane, generation) else { return Err("Scan canceled".into()); };
    tauri::async_runtime::spawn_blocking(move || {
        let roots = std::iter::once(root_path).chain(extra_folders).collect();
        let mut notes = scan_root_notes(&app, roots, &scan_id, &run)?;
        if run.is_cancelled() { return Err("Scan canceled".into()); }
        scan::emit(&app, "miaoyan://scan-total", &scan_id, notes.len());
        notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        if run.is_cancelled() { Err("Scan canceled".into()) } else { Ok(notes) }
    }).await.map_err(|error| format!("Scan task failed: {error}"))?
}

/// 增量导入单个外部文件夹：只扫新目录（project-chunk/notes-chunk/scan-progress 复用渐进协议，前端监听即合并），
/// 避免 extra_folders 变更触发全库重扫（历史上导入仅 1 个文件的目录也会重扫 2000+ 文件）
#[command]
pub async fn scan_folder(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<'_, ScanState>, folder: String, scan_id: String, session_id: String, lane: String, generation: u64) -> Result<Vec<NoteMetadata>, String> {
    let Some(run) = state.begin(window.label(), &session_id, &lane, generation) else { return Err("Scan canceled".into()); };
    tauri::async_runtime::spawn_blocking(move || {
        scan_extra_project(&app, folder.clone(), &scan_id, &run).map_err(|error| format!("Project discovery failed: {error}"))?;
        let mut notes = scan_root_notes(&app, vec![folder], &scan_id, &run)?;
        notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
        if run.is_cancelled() { Err("Scan canceled".into()) } else { Ok(notes) }
    }).await.map_err(|error| format!("Scan task failed: {error}"))?
}

#[command]
pub async fn scope_roots_overlap(removed_roots: Vec<String>, roots: Vec<String>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let retained: Vec<_> = roots.into_iter().map(std::path::PathBuf::from).collect();
        for removed in removed_roots {
            if storage::root_scopes_overlap(Path::new(&removed), &retained).map_err(|error| format!("Scope validation failed: {error}"))? { return Ok(true); }
        }
        Ok(false)
    }).await.map_err(|error| format!("Scope validation worker failed: {error}"))?
}

#[command]
pub async fn read_directory_snapshot(path: String) -> Result<storage::DirectorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || storage::read_directory_snapshot(Path::new(&path)).map_err(|error| format!("Directory refresh failed: {error}")))
        .await.map_err(|error| format!("Directory worker failed: {error}"))?
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
pub async fn read_note(app: tauri::AppHandle, path: String) -> Result<NoteContent, PersistenceError> {
    run_persistence(app, move |state| state.read_document(Path::new(&path))).await
}

#[command]
pub async fn save_document_copy(app: tauri::AppHandle, source_path: String, target_path: String, content: String, annotation_draft: Option<String>, password: Option<String>, allow_warnings: bool) -> Result<NoteContent, PersistenceError> {
    let mut outcome = run_persistence(app.clone(), move |state| state.copy_document(Path::new(&source_path), Path::new(&target_path), &content, annotation_draft.as_deref(), password.as_deref(), allow_warnings)).await?;
    let snapshot = outcome.snapshot.take().unwrap();
    finish_mutation(&app, outcome);
    Ok(snapshot)
}

#[command]
pub async fn write_note(app: tauri::AppHandle, path: String, content: String, expected_version: String) -> Result<String, PersistenceError> {
    run_persistence(app, move |state| state.write_document(Path::new(&path), content.as_bytes(), &expected_version)).await
}

use crate::services::persistence::{Persistence, PersistenceError, MutationOutcome, RecoveryInfo, AnnotationRead, VersionEntry};

fn finish_mutation(app: &tauri::AppHandle, outcome: MutationOutcome) -> String {
    if !outcome.warnings.is_empty() {
        let _ = app.emit("document-operation-warning", &outcome.warnings);
    }
    outcome.path
}

#[command]
pub fn resolve_document(state: tauri::State<'_, Persistence>, path: String) -> Result<String, PersistenceError> {
    state.resolve(Path::new(&path))
}

#[command]
pub fn get_document_recoveries(state: tauri::State<'_, Persistence>) -> Result<Vec<RecoveryInfo>, PersistenceError> {
    state.recoveries()
}

#[command]
pub fn retry_document_recovery(state: tauri::State<'_, Persistence>, transaction_id: String) -> Result<(), PersistenceError> {
    state.retry_recovery(&transaction_id)
}

#[derive(serde::Serialize)]
pub struct CreatedNote {
    #[serde(flatten)]
    note: NoteMetadata,
    disk_version: String,
}

#[command]
pub fn create_note(app: tauri::AppHandle, state: tauri::State<'_, Persistence>, folder_path: String, title: String) -> Result<CreatedNote, PersistenceError> {
    let mut outcome = state.create_note(Path::new(&folder_path), &title)?;
    let disk_version = outcome.snapshot.take().unwrap().disk_version;
    let path = finish_mutation(&app, outcome);
    let now = chrono::Utc::now();
    Ok(CreatedNote { note: NoteMetadata {
        id: path.clone(),
        title: Path::new(&path).file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path, folder: folder_path, created_at: now, modified_at: now,
        pinned: false, size: 0, is_encrypted: false,
    }, disk_version })
}

#[command]
pub fn delete_note(app: tauri::AppHandle, state: tauri::State<'_, Persistence>, path: String) -> Result<(), PersistenceError> {
    finish_mutation(&app, state.delete(Path::new(&path))?);
    Ok(())
}

#[command]
pub fn rename_note(app: tauri::AppHandle, state: tauri::State<'_, Persistence>, old_path: String, new_title: String, allow_warnings: bool) -> Result<String, PersistenceError> {
    Ok(finish_mutation(&app, state.rename(Path::new(&old_path), &new_title, allow_warnings)?))
}

#[command]
pub fn create_folder(state: tauri::State<'_, Persistence>, parent_path: String, name: String) -> Result<String, PersistenceError> {
    state.create_folder(Path::new(&parent_path), &name)
}

#[command]
pub fn rename_folder(app: tauri::AppHandle, state: tauri::State<'_, Persistence>, old_path: String, new_name: String, allow_warnings: bool) -> Result<String, PersistenceError> {
    Ok(finish_mutation(&app, state.rename_folder(Path::new(&old_path), &new_name, allow_warnings)?))
}

#[command]
pub fn delete_folder(app: tauri::AppHandle, state: tauri::State<'_, Persistence>, path: String) -> Result<(), PersistenceError> {
    finish_mutation(&app, state.delete(Path::new(&path))?);
    Ok(())
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
pub fn start_search_session(window: tauri::WebviewWindow, state: tauri::State<'_, crate::services::search::SearchState>) -> String {
    state.open(window.label())
}

#[command]
pub fn invalidate_search(window: tauri::WebviewWindow, state: tauri::State<'_, crate::services::search::SearchState>, session_id: String, generation: u64) {
    state.invalidate(window.label(), &session_id, generation);
}

#[command]
pub async fn search_notes(window: tauri::WebviewWindow, state: tauri::State<'_, crate::services::search::SearchState>, session_id: String, generation: u64, root_path: String, query: String, extra_folders: Vec<String>) -> Result<Vec<NoteMetadata>, String> {
    let Some(run) = state.begin(window.label(), &session_id, generation) else { return Ok(Vec::new()); };
    tauri::async_runtime::spawn_blocking(move || {
        if run.is_cancelled() || query.trim().is_empty() { return Ok(Vec::new()); }
        let roots = scan::note_roots(std::iter::once(root_path).chain(extra_folders).collect(), &|| run.is_cancelled()).map_err(|error| format!("Search discovery failed: {error}"))?;
        Ok(crate::services::search::search(&roots, &query, &run))
    }).await.map_err(|error| format!("Search failed: {error}"))?
}

#[command]
pub fn get_config() -> Result<AppConfig, String> {
    storage::load_config(&storage::get_config_dir().join("config.json"))
}

#[command]
pub fn save_config(config: AppConfig) -> Result<(), String> {
    let config_dir = storage::ensure_config_dir();
    let config_path = config_dir.join("config.json");
    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    storage::write_atomic(&config_path, content)
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
pub async fn start_watching(app_handle: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    use crate::services::watcher::{self, WatcherState};
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<WatcherState>();
        if paths.iter().all(String::is_empty) { return state.stop(); }
        state.replace_with(|| watcher::start_watcher(app_handle.clone(), &paths))
    }).await.map_err(|error| format!("Watcher initialization failed: {error}"))?
}

// ===== Version History =====

#[command]
pub async fn save_version(app: tauri::AppHandle, note_path: String, document_id: String, content: String, password: Option<String>) -> Result<VersionEntry, PersistenceError> {
    run_persistence(app, move |state| match password {
        Some(password) => state.save_encrypted_version(Path::new(&note_path), &document_id, &content, &password),
        None => state.save_version(Path::new(&note_path), &document_id, &content),
    }).await
}

#[command]
pub async fn list_versions(app: tauri::AppHandle, note_path: String) -> Result<Vec<VersionEntry>, PersistenceError> {
    run_persistence(app, move |state| state.list_versions(Path::new(&note_path))).await
}

#[command]
pub async fn get_version(app: tauri::AppHandle, note_path: String, document_id: String, version_filename: String, password: Option<String>) -> Result<String, PersistenceError> {
    run_persistence(app, move |state| match password {
        Some(password) => state.get_encrypted_version(Path::new(&note_path), &document_id, &version_filename, &password),
        None => state.get_version(Path::new(&note_path), &document_id, &version_filename),
    }).await
}

#[command]
pub async fn restore_version(app: tauri::AppHandle, note_path: String, document_id: String, version_filename: String, password: Option<String>) -> Result<(), PersistenceError> {
    run_persistence(app, move |state| match password {
        Some(password) => state.restore_encrypted_version(Path::new(&note_path), &document_id, &version_filename, &password),
        None => state.restore_version(Path::new(&note_path), &document_id, &version_filename),
    }).await
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

    storage::write_atomic(&file_path, &image_data)
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
    storage::write_atomic(&sort_file, content)
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
pub fn get_pinned_notes(state: tauri::State<'_, Persistence>) -> Result<Vec<String>, PersistenceError> {
    state.pins()
}

#[command]
pub fn toggle_pin(state: tauri::State<'_, Persistence>, note_path: String) -> Result<Vec<String>, PersistenceError> {
    state.toggle_pin(Path::new(&note_path))
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

async fn run_persistence<T: Send + 'static>(app: tauri::AppHandle, operation: impl FnOnce(&Persistence) -> Result<T, PersistenceError> + Send + 'static) -> Result<T, PersistenceError> {
    tauri::async_runtime::spawn_blocking(move || operation(&app.state::<Persistence>()))
        .await.map_err(|error| PersistenceError::new("Unavailable", format!("Document worker failed: {error}"), &[]))?
}

#[command]
pub async fn encrypt_note(app: tauri::AppHandle, path: String, password: String, expected_version: Option<String>) -> Result<NoteContent, PersistenceError> {
    let mut outcome = run_persistence(app.clone(), move |state| state.set_encryption(Path::new(&path), &password, true, expected_version.as_deref())).await?;
    let snapshot = outcome.snapshot.take().unwrap();
    finish_mutation(&app, outcome);
    Ok(snapshot)
}

#[command]
pub async fn decrypt_note(app: tauri::AppHandle, path: String, password: String) -> Result<NoteContent, PersistenceError> {
    run_persistence(app, move |state| state.read_encrypted_document(Path::new(&path), &password)).await
}

#[command]
pub async fn verify_password(app: tauri::AppHandle, path: String, password: String) -> Result<bool, PersistenceError> {
    match run_persistence(app, move |state| state.read_encrypted_document(Path::new(&path), &password)).await {
        Ok(_) => Ok(true),
        Err(error) if error.code == "Encryption" && error.message.contains("Invalid password") => Ok(false),
        Err(error) => Err(error),
    }
}

#[command]
pub async fn save_encrypted_note(app: tauri::AppHandle, path: String, content: String, password: String, expected_version: String) -> Result<String, PersistenceError> {
    run_persistence(app, move |state| state.write_encrypted_document(Path::new(&path), &content, &password, &expected_version)).await
}

#[command]
pub async fn remove_encryption(app: tauri::AppHandle, path: String, password: String, expected_version: Option<String>) -> Result<NoteContent, PersistenceError> {
    let mut outcome = run_persistence(app.clone(), move |state| state.set_encryption(Path::new(&path), &password, false, expected_version.as_deref())).await?;
    let snapshot = outcome.snapshot.take().unwrap();
    finish_mutation(&app, outcome);
    Ok(snapshot)
}

#[command]
pub fn move_note(app: tauri::AppHandle, state: tauri::State<'_, Persistence>, source_path: String, target_folder: String, allow_warnings: bool) -> Result<String, PersistenceError> {
    Ok(finish_mutation(&app, state.move_note(Path::new(&source_path), Path::new(&target_folder), allow_warnings)?))
}

#[command]
pub async fn write_log(message: String) -> Result<(), String> {
    write_logs(vec![message]).await
}

#[command]
pub async fn write_logs(messages: Vec<String>) -> Result<(), String> {
    crate::services::logging::validate_batch(&messages)?;
    if messages.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // 日志不落在笔记文库内；路径解析和全部 IO 均留在 blocking pool。
        let log_dir = match dirs::home_dir() {
            Some(home) => home.join(".miaoyan").join("log"),
            None => storage::get_config_dir().join("log"),
        };
        crate::services::logging::write_batch(&log_dir, chrono::Local::now().fixed_offset(), &messages)
    })
    .await
    .map_err(|error| format!("Log task failed: {error}"))?
}

/* ── Annotations ── */

#[command]
pub async fn read_annotations(app: tauri::AppHandle, note_path: String, password: Option<String>) -> Result<AnnotationRead, PersistenceError> {
    run_persistence(app, move |state| match password {
        Some(password) => state.read_encrypted_annotations(Path::new(&note_path), &password),
        None => state.read_annotations(Path::new(&note_path)),
    }).await
}

#[command]
pub async fn write_annotations(app: tauri::AppHandle, note_path: String, document_id: String, json: String, expected_version: String, password: Option<String>) -> Result<String, PersistenceError> {
    run_persistence(app, move |state| match password {
        Some(password) => state.write_encrypted_annotations_checked(Path::new(&note_path), &document_id, &json, &password, &expected_version),
        None => state.write_annotations_checked(Path::new(&note_path), &document_id, &json, &expected_version),
    }).await
}

#[command]
pub async fn delete_annotations(app: tauri::AppHandle, note_path: String, document_id: String, expected_version: String, password: Option<String>) -> Result<String, PersistenceError> {
    run_persistence(app, move |state| match password {
        Some(password) => state.write_encrypted_annotations_checked(Path::new(&note_path), &document_id, "[]", &password, &expected_version),
        None => state.write_annotations_checked(Path::new(&note_path), &document_id, "[]", &expected_version),
    }).await
}
