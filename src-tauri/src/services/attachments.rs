//! Reference discovery only: never reserialize Markdown or copy whole asset directories.
use std::{cell::RefCell, collections::BTreeSet, path::{Component, Path, PathBuf}};
use html5ever::tokenizer::{BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts, StartTag, states};
use pulldown_cmark::{Event, Options, Parser, Tag};
use super::persistence::{regular_bytes, relative_to, Warning};

#[derive(Default)]
struct References {
    urls: RefCell<Vec<String>>,
    warnings: RefCell<Vec<String>>,
}
impl TokenSink for References {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        if let Token::TagToken(tag) = token {
            if tag.kind != StartTag { return TokenSinkResult::Continue; }
            let name = tag.name.as_ref();
            for attr in tag.attrs {
                let key = attr.name.local.as_ref();
                if matches!(key, "src" | "href" | "poster" | "data") {
                    self.urls.borrow_mut().push(attr.value.to_string());
                } else if key == "srcset" || key == "style" || key.starts_with(':') || key.starts_with("v-bind:") || key.starts_with("on") {
                    self.warnings.borrow_mut().push(format!("Unverified HTML attribute: {key}"));
                }
            }
            return match name {
                "script" => { self.warnings.borrow_mut().push("Script-generated resources are unverified".into()); TokenSinkResult::RawData(states::ScriptData) },
                "style" => { self.warnings.borrow_mut().push("CSS resources are unverified".into()); TokenSinkResult::RawData(states::Rawtext) },
                "textarea" | "title" => TokenSinkResult::RawData(states::Rcdata),
                "xmp" | "iframe" | "noembed" | "noframes" => TokenSinkResult::RawData(states::Rawtext),
                "base" => { self.warnings.borrow_mut().push("HTML base URL needs confirmation".into()); TokenSinkResult::Continue },
                _ => TokenSinkResult::Continue,
            };
        }
        TokenSinkResult::Continue
    }
}

fn references(text: &str, html: bool) -> (Vec<String>, Vec<String>) {
    let mut urls = Vec::new();
    let mut fragments = String::new();
    if html { fragments.push_str(text); } else {
        for event in Parser::new_ext(text, Options::all()) {
            match event {
                Event::Start(Tag::Image { dest_url, .. } | Tag::Link { dest_url, .. }) => urls.push(dest_url.to_string()),
                Event::Html(raw) | Event::InlineHtml(raw) => { fragments.push_str(&raw); fragments.push('\n'); },
                _ => (), // Code events (including fenced diagrams) are deliberately ignored.
            }
        }
    }
    let input = BufferQueue::default();
    input.push_back(fragments.into());
    let tokenizer = Tokenizer::new(References::default(), TokenizerOpts::default());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    urls.extend(tokenizer.sink.urls.into_inner());
    (urls, tokenizer.sink.warnings.into_inner())
}

fn decode_url(url: &str) -> Option<String> {
    let mut bytes = Vec::new(); let raw = url.as_bytes(); let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' {
            let hex = std::str::from_utf8(raw.get(i + 1..i + 3)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?); i += 3;
        } else { bytes.push(raw[i]); i += 1; }
    }
    String::from_utf8(bytes).ok()
}

pub struct AssetCopy { pub source: PathBuf, pub target: PathBuf, pub bytes: Vec<u8> }
#[derive(Default)]
pub struct Plan { pub copies: Vec<AssetCopy>, pub warnings: Vec<Warning> }

/// `moving_root` is the entire directory being renamed, or the source note's parent.
/// Only destinations under `target_root` are writable. Parent traversal never escapes it.
pub fn plan(text: &str, note: &Path, destination_note: &Path, moving_root: &Path, target_root: &Path, directory_move: bool) -> Plan {
    let mut plan = Plan::default();
    let html = note.extension().is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"));
    let (urls, warnings) = references(text, html);
    plan.warnings.extend(warnings.into_iter().map(|message| Warning::new("UnverifiedAttachment", note, message)));
    let mut seen = BTreeSet::new();
    for url in urls {
        let url = url.trim();
        if url.is_empty() || url.starts_with('#') { continue; }
        if ["https:", "http:", "data:", "mailto:", "tel:"].iter().any(|prefix| url.to_ascii_lowercase().starts_with(prefix)) || url.starts_with("//") { continue; }
        let warn = |reason: &str| Warning::new("UnverifiedAttachment", note, format!("{reason}: {url}"));
        let raw = url.split(['#', '?']).next().unwrap_or(url);
        let Some(decoded) = decode_url(raw) else { plan.warnings.push(warn("Invalid URL encoding")); continue; };
        if decoded.contains(['{', '}', '\\', ':']) || decoded.chars().any(char::is_control) || Path::new(&decoded).is_absolute() {
            plan.warnings.push(warn("Dynamic or absolute local reference")); continue;
        }
        let normalize = |base: &Path| -> Option<PathBuf> {
            let mut path = base.to_path_buf();
            for part in Path::new(&decoded).components() {
                match part { Component::Normal(p) => path.push(p), Component::CurDir => (), Component::ParentDir => { if !path.pop() { return None; } }, _ => return None }
            }
            Some(path)
        };
        let Some(source) = normalize(note.parent().unwrap_or(moving_root)) else { plan.warnings.push(warn("Invalid path")); continue; };
        let Some(target) = normalize(destination_note.parent().unwrap_or(target_root)) else { plan.warnings.push(warn("Invalid target")); continue; };
        if relative_to(&source, moving_root).is_none() || relative_to(&target, target_root).is_none() {
            plan.warnings.push(warn("Reference leaves the relocation root; no files copied outside destination")); continue;
        }
        // Check every component: symlinks/junctions must not escape either root.
        let bytes = match regular_bytes(&source) {
            Ok(bytes) => bytes,
            Err(e) => { plan.warnings.push(warn(&e.message)); continue; }
        };
        if directory_move || source == target { continue; }
        if seen.insert(target.clone()) { plan.copies.push(AssetCopy { source, target, bytes }); }
    }
    plan
}
