use super::*;
use std::{
    collections::HashSet,
    fs,
    io::{Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{Arc, Barrier},
};

// All entry points under test receive this disposable directory and a fixed clock.
// No command that resolves home/config directories is called here.
struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("miaoyan-logging-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn now() -> chrono::DateTime<chrono::FixedOffset> {
    chrono::DateTime::parse_from_rfc3339("2026-11-20T12:34:56.789+08:00").unwrap()
}
fn messages(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|s| s.to_string()).collect()
}

#[test]
fn batch_timestamps_every_physical_line_and_normalizes_boundaries() {
    let dir = Sandbox::new();
    write_batch(
        &dir.0,
        now(),
        &messages(&["first", "second\r\nthird\n", "fourth\rfifth", ""]),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path("2026-11-20.log")).unwrap(),
        concat!(
            "[12:34:56.789] first\n",
            "[12:34:56.789] second\n",
            "[12:34:56.789] third\n",
            "[12:34:56.789] fourth\n",
            "[12:34:56.789] fifth\n",
            "[12:34:56.789] \n"
        )
    );
}

#[test]
fn appending_to_an_unterminated_legacy_file_adds_a_boundary_newline() {
    let dir = Sandbox::new();
    fs::write(dir.path("2026-11-20.log"), "legacy").unwrap();
    write_batch(&dir.0, now(), &messages(&["new"])).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path("2026-11-20.log")).unwrap(),
        "legacy\n[12:34:56.789] new\n"
    );
}

#[test]
fn rejects_excessive_count_raw_bytes_and_timestamp_expansion_before_io() {
    let dir = Sandbox::new();
    for batch in [
        vec![String::new(); 101],
        vec!["x".repeat(1024 * 1024 + 1)],
        vec!["\n".repeat(1024 * 1024)],
    ] {
        assert!(write_batch(&dir.0, now(), &batch).is_err());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    }
}

#[test]
fn rotates_at_five_mib_and_replaces_only_one_backup() {
    let dir = Sandbox::new();
    let active = dir.path("2026-11-20.log");
    let backup = dir.path("2026-11-20.log.1");
    let seed = "x".repeat(5 * 1024 * 1024 - 10);
    fs::write(&active, &seed).unwrap();
    fs::write(&backup, "previous backup").unwrap();
    write_batch(&dir.0, now(), &messages(&["rotated"])).unwrap();
    assert_eq!(
        fs::read_to_string(&active).unwrap(),
        "[12:34:56.789] rotated\n"
    );
    assert_eq!(fs::read(&backup).unwrap(), seed.as_bytes());
    fs::write(&active, &seed).unwrap();
    write_batch(&dir.0, now(), &messages(&["again"])).unwrap();
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    assert_eq!(fs::metadata(&backup).unwrap().len(), seed.len() as u64);
    assert_eq!(
        fs::read_to_string(&active).unwrap(),
        "[12:34:56.789] again\n"
    );
}

#[test]
fn retention_keeps_today_and_six_previous_dates_only_and_ignores_foreign_names() {
    let dir = Sandbox::new();
    for day in [
        "2026-11-13",
        "2026-11-14",
        "2026-11-19",
        "2026-11-20",
        "2026-11-21",
    ] {
        for suffix in [".log", ".log.1"] {
            fs::write(dir.path(&format!("{day}{suffix}")), "owned\n").unwrap();
        }
    }
    let strangers = [
        "notes.txt",
        "2026-11-13.log.2",
        "2026-11-13.log.bak",
        "2026-2-01.log",
        "2026-02-30.log",
        "prefix-2026-11-13.log",
    ];
    for name in strangers {
        fs::write(dir.path(name), "foreign").unwrap();
    }
    fs::create_dir(dir.path("2026-11-12.log")).unwrap();
    write_batch(&dir.0, now(), &messages(&["current"])).unwrap();
    for day in ["2026-11-13", "2026-11-21"] {
        for suffix in [".log", ".log.1"] {
            assert!(!dir.path(&format!("{day}{suffix}")).exists());
        }
    }
    for day in ["2026-11-14", "2026-11-19", "2026-11-20"] {
        for suffix in [".log", ".log.1"] {
            assert!(dir.path(&format!("{day}{suffix}")).is_file());
        }
    }
    for name in strangers {
        assert_eq!(fs::read_to_string(dir.path(name)).unwrap(), "foreign");
    }
    assert!(dir.path("2026-11-12.log").is_dir());
}

#[test]
fn legacy_large_files_are_compacted_by_bounded_tail_reads_including_older_backups() {
    let dir = Sandbox::new();
    for name in ["2026-11-20.log", "2026-11-19.log", "2026-11-19.log.1"] {
        let mut file = fs::File::create(dir.path(name)).unwrap();
        // Exceed the production cap without depending on OS sparse-file support.
        file.set_len(8 * 1024 * 1024).unwrap();
        file.seek(SeekFrom::End(0)).unwrap();
        file.write_all("\nlast complete 中文 line\n".as_bytes())
            .unwrap();
    }
    write_batch(&dir.0, now(), &messages(&["new"])).unwrap();
    for name in ["2026-11-20.log", "2026-11-19.log", "2026-11-19.log.1"] {
        let path = dir.path(name);
        assert!(fs::metadata(&path).unwrap().len() <= 5 * 1024 * 1024);
        assert!(fs::read_to_string(path)
            .unwrap()
            .contains("last complete 中文 line\n"));
    }
}

#[test]
fn compaction_keeps_a_bounded_tail_even_for_a_single_oversized_terminated_line() {
    let dir = Sandbox::new();
    let path = dir.path("2026-11-19.log");
    let mut file = fs::File::create(&path).unwrap();
    file.set_len(8 * 1024 * 1024).unwrap();
    file.seek(SeekFrom::End(0)).unwrap();
    file.write_all(b"last bytes\n").unwrap();
    drop(file);
    write_batch(&dir.0, now(), &messages(&["today"])).unwrap();
    let data = fs::read(&path).unwrap();
    assert!(data.ends_with(b"last bytes\n"));
    assert!(data.len() <= 5 * 1024 * 1024);
}

#[test]
fn concurrent_batches_do_not_interleave_lines_or_race_rotation() {
    let dir = Sandbox::new();
    let active = dir.path("2026-11-20.log");
    fs::write(&active, "x".repeat(5 * 1024 * 1024 - 10)).unwrap();
    let barrier = Arc::new(Barrier::new(12));
    std::thread::scope(|scope| {
        for i in 0..12 {
            let barrier = barrier.clone();
            let path = &dir.0;
            scope.spawn(move || {
                barrier.wait();
                write_batch(
                    path,
                    now(),
                    &messages(&[&format!("batch-{i}-a"), &format!("batch-{i}-b")]),
                )
                .unwrap();
            });
        }
    });
    let text = fs::read_to_string(&active).unwrap();
    let lines: Vec<_> = text.lines().collect();
    assert_eq!(lines.len(), 24);
    let mut seen = HashSet::new();
    for pair in lines.chunks_exact(2) {
        let id = pair[0]
            .strip_prefix("[12:34:56.789] batch-")
            .unwrap()
            .strip_suffix("-a")
            .unwrap();
        assert_eq!(pair[1], format!("[12:34:56.789] batch-{id}-b"));
        assert!(seen.insert(id));
    }
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    assert!(fs::metadata(dir.path("2026-11-20.log.1")).unwrap().len() <= 5 * 1024 * 1024);
}

#[test]
fn empty_batch_does_not_create_a_log_directory() {
    let dir = Sandbox::new();
    let absent = dir.path("absent");
    write_batch(&absent, now(), &[]).unwrap();
    assert!(!absent.exists());
}
