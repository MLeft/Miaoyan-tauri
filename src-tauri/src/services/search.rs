use std::collections::HashMap;
use std::io::{self, Read};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex, atomic::{AtomicBool, Ordering}};
use crate::models::NoteMetadata;
use super::storage;

#[derive(Clone, Default)]
pub struct SearchState(Arc<Mutex<HashMap<String, WindowSearch>>>);

struct WindowSearch {
    session: String,
    generation: u64,
    active: Option<Arc<AtomicBool>>,
}

pub struct SearchRun {
    state: SearchState,
    window: String,
    session: String,
    generation: u64,
    canceled: Arc<AtomicBool>,
}

impl SearchState {
    pub fn open(&self, window: &str) -> String {
        let session = uuid::Uuid::new_v4().to_string();
        let previous = self.0.lock().unwrap().insert(window.to_owned(), WindowSearch { session: session.clone(), generation: 0, active: None });
        if let Some(active) = previous.and_then(|previous| previous.active) { active.store(true, Ordering::Release); }
        session
    }

    pub fn invalidate(&self, window: &str, session: &str, generation: u64) {
        let mut windows = self.0.lock().unwrap();
        if let Some(current) = windows.get_mut(window) {
            if current.session == session && generation > current.generation {
                current.generation = generation;
                if let Some(active) = current.active.take() { active.store(true, Ordering::Release); }
            }
        }
    }

    pub fn begin(&self, window: &str, session: &str, generation: u64) -> Option<SearchRun> {
        let mut windows = self.0.lock().unwrap();
        let current = windows.get_mut(window)?;
        if current.session != session || generation < current.generation || (generation == current.generation && current.active.is_some()) { return None; }
        if let Some(active) = current.active.take() { active.store(true, Ordering::Release); }
        current.generation = generation;
        let canceled = Arc::new(AtomicBool::new(false));
        current.active = Some(canceled.clone());
        Some(SearchRun { state: self.clone(), window: window.to_owned(), session: session.to_owned(), generation, canceled })
    }

    pub fn stop(&self, window: &str) {
        if let Some(active) = self.0.lock().unwrap().remove(window).and_then(|current| current.active) { active.store(true, Ordering::Release); }
    }
}

impl SearchRun {
    pub fn is_cancelled(&self) -> bool { self.canceled.load(Ordering::Acquire) }
}

impl Drop for SearchRun {
    fn drop(&mut self) {
        let mut windows = self.state.0.lock().unwrap();
        if let Some(current) = windows.get_mut(&self.window) {
            if current.session == self.session && current.generation == self.generation && current.active.as_ref().is_some_and(|active| Arc::ptr_eq(active, &self.canceled)) {
                current.active = None;
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Position { matched: usize, found: bool }

struct LowercaseMatcher {
    pattern: Vec<char>,
    failure: Vec<usize>,
    position: Position,
    final_sigma: Option<Position>,
    preceding_cased: bool,
    ascii: bool,
}

impl LowercaseMatcher {
    fn new(query: &str) -> Self {
        let pattern: Vec<_> = query.chars().collect();
        let mut failure = vec![0; pattern.len()];
        for index in 1..pattern.len() {
            let mut matched = failure[index - 1];
            while matched > 0 && pattern[index] != pattern[matched] { matched = failure[matched - 1]; }
            if pattern[index] == pattern[matched] { matched += 1; }
            failure[index] = matched;
        }
        Self { pattern, failure, position: Position::default(), final_sigma: None, preceding_cased: false, ascii: query.is_ascii() }
    }

    fn advance(pattern: &[char], failure: &[usize], position: &mut Position, ch: char) {
        while position.matched > 0 && pattern[position.matched] != ch { position.matched = failure[position.matched - 1]; }
        if pattern[position.matched] == ch { position.matched += 1; }
        if position.matched == pattern.len() { position.found = true; position.matched = failure[position.matched - 1]; }
    }

    fn push_ascii(&mut self, text: &str, query: &str) {
        if self.position.matched > 0 {
            for ch in text.chars().take(self.pattern.len() - 1) { Self::advance(&self.pattern, &self.failure, &mut self.position, ch); }
        }
        if self.position.found || text.contains(query) { self.position.found = true; return; }
        self.position.matched = 0;
        for ch in text[text.len() - (self.pattern.len() - 1)..].chars() { Self::advance(&self.pattern, &self.failure, &mut self.position, ch); }
    }

    fn push(&mut self, ch: char) {
        // Final-sigma context cannot change an ASCII match.
        if self.ascii {
            for lowercase in ch.to_lowercase() { Self::advance(&self.pattern, &self.failure, &mut self.position, lowercase); }
            return;
        }
        let (cased, ignorable) = character_properties(ch);
        if !ignorable {
            if let Some(final_sigma) = self.final_sigma.take() {
                if !cased { self.position = final_sigma; }
            }
        }
        if ch == 'Σ' && self.preceding_cased {
            // Resolve final sigma with two matcher states, not an unbounded suffix buffer.
            let mut final_sigma = self.position;
            Self::advance(&self.pattern, &self.failure, &mut self.position, 'σ');
            Self::advance(&self.pattern, &self.failure, &mut final_sigma, 'ς');
            self.final_sigma = Some(final_sigma);
        } else {
            for lowercase in ch.to_lowercase() {
                Self::advance(&self.pattern, &self.failure, &mut self.position, lowercase);
                if let Some(final_sigma) = &mut self.final_sigma { Self::advance(&self.pattern, &self.failure, final_sigma, lowercase); }
            }
        }
        if !ignorable { self.preceding_cased = cased; }
    }

    fn found(&self) -> bool { self.position.found && self.final_sigma.is_none_or(|position| position.found) }
    fn finish(self) -> bool { self.final_sigma.unwrap_or(self.position).found }
}

fn character_properties(ch: char) -> (bool, bool) {
    if ch.is_ascii_alphabetic() { return (true, false); }
    if ch == ' ' || ch.is_ascii_control() || ch.is_ascii_digit() { return (false, false); }
    static PROPERTIES: LazyLock<regex::RegexSet> = LazyLock::new(|| regex::RegexSet::new([r"\p{Cased}", r"\p{Case_Ignorable}"]).unwrap());
    let mut bytes = [0; 4];
    let properties = PROPERTIES.matches(ch.encode_utf8(&mut bytes));
    (properties.matched(0), properties.matched(1))
}

fn content_matches(mut reader: impl Read, query_lower: &str, run: &SearchRun) -> io::Result<bool> {
    let mut matcher = LowercaseMatcher::new(query_lower);
    let mut buffer = [0u8; 65540];
    let mut carry = 0;
    loop {
        if run.is_cancelled() { return Err(io::Error::new(io::ErrorKind::Interrupted, "Search canceled")); }
        let count = match reader.read(&mut buffer[carry..65536]) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            other => other?,
        };
        if run.is_cancelled() { return Err(io::Error::new(io::ErrorKind::Interrupted, "Search canceled")); }
        if count == 0 {
            if carry > 0 { return Err(io::Error::new(io::ErrorKind::InvalidData, "Incomplete UTF-8")); }
            return Ok(matcher.finish());
        }
        let length = carry + count;
        let valid = match std::str::from_utf8(&buffer[..length]) {
            Ok(_) => length,
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
        };
        if !matcher.found() {
            if matcher.ascii && buffer[..valid].is_ascii() && valid >= query_lower.len() {
                buffer[..valid].make_ascii_lowercase();
                matcher.push_ascii(std::str::from_utf8(&buffer[..valid]).unwrap(), query_lower);
            } else {
                for (index, ch) in std::str::from_utf8(&buffer[..valid]).unwrap().chars().enumerate() {
                    if index % 4096 == 0 && run.is_cancelled() { return Err(io::Error::new(io::ErrorKind::Interrupted, "Search canceled")); }
                    matcher.push(ch);
                    if matcher.found() { break; }
                }
            }
        }
        buffer.copy_within(valid..length, 0);
        carry = length - valid;
    }
}

pub fn search(roots: &[PathBuf], query: &str, run: &SearchRun) -> Vec<NoteMetadata> {
    let query_lower = query.trim().to_lowercase();
    if query_lower.is_empty() || run.is_cancelled() { return Vec::new(); }
    let mut results = Vec::new();
    for root in roots {
        if run.is_cancelled() { return Vec::new(); }
        let mut matched = Vec::new();
        for entry in storage::scan_entries(root, &|| run.is_cancelled()) {
            if run.is_cancelled() { return Vec::new(); }
            let Ok(entry) = entry else { continue; };
            if !entry.file_type().is_file() || !storage::is_note_file(entry.path()) { continue; }
            let Ok(metadata) = entry.metadata() else { continue; };
            let Some(note) = storage::note_metadata(entry.path(), root, &metadata) else { continue; };
            let title = note.title.to_lowercase();
            let mut score = if title.contains(&query_lower) { 100 + if title.starts_with(&query_lower) { 50 } else { 0 } } else { 0 };
            if !note.is_encrypted && !storage::is_pdf_file(entry.path()) {
                if let Ok(file) = std::fs::File::open(entry.path()) {
                    if content_matches(file, &query_lower, run).unwrap_or(false) { score += 10; }
                }
            }
            if run.is_cancelled() { return Vec::new(); }
            if score > 0 { matched.push((note, score)); }
        }
        matched.sort_by(|a, b| b.0.modified_at.cmp(&a.0.modified_at));
        results.extend(matched);
    }
    if run.is_cancelled() { return Vec::new(); }
    results.sort_by(|a, b| b.1.cmp(&a.1));
    if run.is_cancelled() { return Vec::new(); }
    results.into_iter().map(|(note, _)| note).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    #[test]
    fn invalidation_before_start_rejects_old_queries_and_late_invalidation_keeps_current() {
        let state = SearchState::default();
        let session = state.open("main");
        state.invalidate("main", &session, 2);
        assert!(state.begin("main", &session, 1).is_none());
        let current = state.begin("main", &session, 2).unwrap();
        state.invalidate("main", &session, 2);
        state.invalidate("main", &session, 1);
        assert!(!current.is_cancelled());
        state.invalidate("main", &session, 3);
        assert!(current.is_cancelled());
    }

    #[test]
    fn replacement_session_and_window_shutdown_cancel_without_cross_window_effects() {
        let state = SearchState::default();
        let session = state.open("main");
        let old = state.begin("main", &session, 1).unwrap();
        let other_session = state.open("other");
        let other = state.begin("other", &other_session, 1).unwrap();
        let replacement = state.open("main");
        assert!(old.is_cancelled());
        assert!(state.begin("main", &session, 100).is_none());
        let current = state.begin("main", &replacement, 1).unwrap();
        state.invalidate("other", &replacement, 100);
        drop(old);
        assert!(!current.is_cancelled());
        assert!(!other.is_cancelled());
        state.stop("main");
        assert!(current.is_cancelled());
        assert!(state.begin("main", &replacement, 200).is_none());
        assert!(!other.is_cancelled());
    }

    struct Fragmented<R> { reader: R, limit: usize, max_request: usize }
    impl<R: Read> Read for Fragmented<R> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.max_request = self.max_request.max(buffer.len());
            let length = buffer.len().min(self.limit);
            self.reader.read(&mut buffer[..length])
        }
    }

    #[test]
    fn streamed_search_preserves_unicode_lowercase_and_substrings_across_read_boundaries() {
        let cases = [
            ("aaab", "aab", true), ("aaab", "abb", false),
            ("prefix 测试后缀", "测试", true), ("İstanbul", "i\u{307}STANBUL", true),
            ("ΟΣ Α", "ΟΣ", true), ("ΟΣΑ", "ΟΣ", false),
            ("ΟΣ\u{301} ", "ΟΣ\u{301}", true), ("ΟΣ\u{301}Α", "ΟΣ", false),
            ("ǅΣ!", "ǅΣ", true), ("Σ!", "Σ", true),
            ("AΣ'A", "AΣ", false), ("AΣ'!", "AΣ", true),
            ("Kneedle", "Kneedle", true), ("Σ'NEEDLE", "needle", true),
            ("aΣ'X", "ax", false), ("Σ'x", "'x", true),
        ];
        let state = SearchState::default();
        let session = state.open("main");
        let run = state.begin("main", &session, 1).unwrap();
        for (body, query, expected) in cases {
            assert_eq!(body.to_lowercase().contains(&query.to_lowercase()), expected);
            for limit in [1, 2, 3, 7] {
                let mut reader = Fragmented { reader: Cursor::new(body.as_bytes()), limit, max_request: 0 };
                assert_eq!(content_matches(&mut reader, &query.to_lowercase(), &run).unwrap(), expected, "body={body:?}, query={query:?}, read_limit={limit}");
            }
        }
    }

    #[test]
    fn ascii_matches_cross_large_buffer_edges_and_queries_larger_than_a_buffer() {
        let state = SearchState::default();
        let session = state.open("main");
        let run = state.begin("main", &session, 1).unwrap();
        for split in 1..6 {
            let body = format!("{}ABCDEF tail", "x".repeat(65536 - split));
            assert!(content_matches(Cursor::new(body.as_bytes()), "abcdef", &run).unwrap());
            assert!(!content_matches(Cursor::new(body.as_bytes()), "abcdeg", &run).unwrap());
        }
        let query = "a".repeat(65540);
        let body = format!("prefix{}tail", "A".repeat(65540));
        assert!(content_matches(Cursor::new(body.as_bytes()), &query, &run).unwrap());
    }

    #[test]
    fn final_sigma_context_survives_more_than_one_buffer_of_ignorable_characters() {
        let state = SearchState::default();
        let session = state.open("main");
        let run = state.begin("main", &session, 1).unwrap();
        let prefix = format!("AΣ{}", "\u{301}".repeat(40000));
        for (suffix, expected) in [("B", false), (" ", true), ("", true)] {
            let body = format!("{prefix}{suffix}");
            assert_eq!(content_matches(Cursor::new(body.as_bytes()), "aς", &run).unwrap(), expected);
        }
    }

    #[test]
    fn a_long_single_line_is_searched_with_bounded_reads_and_bad_utf8_still_rejects_a_body_match() {
        let state = SearchState::default();
        let session = state.open("main");
        let run = state.begin("main", &session, 1).unwrap();
        let mut body = vec![b'x'; 4 * 1024 * 1024];
        body.extend_from_slice("测试Needle".as_bytes());
        let mut reader = Fragmented { reader: Cursor::new(&body), limit: usize::MAX, max_request: 0 };
        assert!(content_matches(&mut reader, "测试needle", &run).unwrap());
        assert!(reader.max_request <= 65540);
        body.push(0xff);
        assert_eq!(content_matches(Cursor::new(&body), "测试needle", &run).unwrap_err().kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(content_matches(Cursor::new([b'x', 0xe4, 0xb8]), "x", &run).unwrap_err().kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn cancellation_during_a_read_stops_before_the_next_read() {
        let state = SearchState::default();
        let session = state.open("main");
        let run = state.begin("main", &session, 1).unwrap();
        struct Cancel<'a> { state: &'a SearchState, session: &'a str, reads: usize }
        impl Read for Cancel<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                assert_eq!(self.reads, 1, "Canceled search performed another read");
                buffer[..5].copy_from_slice(b"first");
                self.state.invalidate("main", self.session, 2);
                Ok(5)
            }
        }
        let mut reader = Cancel { state: &state, session: &session, reads: 0 };
        assert_eq!(content_matches(&mut reader, "later", &run).unwrap_err().kind(), std::io::ErrorKind::Interrupted);
        assert_eq!(reader.reads, 1);
    }

    #[cfg(windows)]
    fn peak_working_set() -> usize {
        #[repr(C)]
        struct Counters { size: u32, faults: u32, values: [usize; 8] }
        #[link(name = "kernel32")]
        extern "system" { fn GetCurrentProcess() -> *mut std::ffi::c_void; }
        #[link(name = "psapi")]
        extern "system" { fn GetProcessMemoryInfo(process: *mut std::ffi::c_void, counters: *mut Counters, size: u32) -> i32; }
        let mut counters = Counters { size: std::mem::size_of::<Counters>() as u32, faults: 0, values: [0; 8] };
        assert_ne!(unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.size) }, 0);
        counters.values[0]
    }

    #[test]
    #[ignore = "Isolated 64MiB long-line search CPU/RSS benchmark; run explicitly with --release"]
    fn long_file_resource_benchmark() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("miaoyan-search-large-{}.md", uuid::Uuid::new_v4()));
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }
        let _cleanup = Cleanup(path.clone());
        let mut file = std::fs::File::create(&path).unwrap();
        let chunk = [b'x'; 65536];
        for _ in 0..1024 { file.write_all(&chunk).unwrap(); }
        file.write_all(b"NEEDLE").unwrap(); drop(file);
        let state = SearchState::default();
        let session = state.open("fixture");
        let run = state.begin("fixture", &session, 1).unwrap();
        #[cfg(windows)] let before = peak_working_set();
        let mut durations = Vec::new();
        for _ in 0..3 {
            let started = std::time::Instant::now();
            assert!(content_matches(std::fs::File::open(&path).unwrap(), "needle", &run).unwrap());
            durations.push(started.elapsed().as_millis());
        }
        durations.sort();
        println!("stream_search_bytes=67108870 median_ms={} max_ms={}", durations[1], durations[2]);
        assert!(durations[1] < 250, "64MiB streaming search exceeded the 250ms CPU budget");
        #[cfg(windows)] {
            let growth = peak_working_set().saturating_sub(before);
            println!("stream_search_peak_working_set_growth_bytes={growth}");
            assert!(growth < 16 * 1024 * 1024, "Streaming search allocated a body-sized buffer");
        }
    }

    #[test]
    fn search_ranking_keeps_title_body_pdf_and_encryption_rules_and_cancellation_returns_no_partial_list() {
        let root = std::env::temp_dir().join(format!("miaoyan-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(root.clone());
        for (path, body) in [("needle-top.md", "NEEDLE"), ("a-needle.md", "plain"), ("nested/body.md", "a needle in the body"), ("hidden.md.encrypted", "needle"), ("binary.pdf", "needle"), ("needle.pdf", "binary")] {
            std::fs::write(root.join(path), body).unwrap();
        }
        let state = SearchState::default();
        let session = state.open("main");
        let run = state.begin("main", &session, 1).unwrap();
        let results = search(&[root.clone()], "needle", &run);
        assert_eq!(results.iter().map(|note| note.title.as_str()).collect::<Vec<_>>(), ["needle-top.md", "needle.pdf", "a-needle.md", "body.md"]);
        state.invalidate("main", &session, 2);
        assert!(search(&[root], "needle", &run).is_empty());
    }
}
