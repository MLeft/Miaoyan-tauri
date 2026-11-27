use chrono::{DateTime, Duration, FixedOffset, NaiveDate};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::Mutex,
};

pub const MAX_BATCH_MESSAGES: usize = 100;
pub const MAX_BATCH_BYTES: usize = 1024 * 1024;
const MAX_FILE_BYTES: usize = 5 * 1024 * 1024;
const RETENTION_DAYS: i64 = 7;

// The app is single-instance. All command callers serialize maintenance, rotation
// and append under the same lock, on the blocking pool rather than the UI runtime.
static WRITER: Mutex<()> = Mutex::new(());

pub fn validate_batch(messages: &[String]) -> Result<(), String> {
    if messages.len() > MAX_BATCH_MESSAGES {
        return Err("Log batch exceeds 100 messages".into());
    }
    let mut bytes = 0usize;
    for message in messages {
        // Subtraction avoids overflow even for adversarial input lengths.
        if message.len() > MAX_BATCH_BYTES - bytes {
            return Err("Log batch exceeds 1 MiB".into());
        }
        bytes += message.len();
    }
    Ok(())
}

fn render_batch(now: DateTime<FixedOffset>, messages: &[String]) -> Result<String, String> {
    let prefix = format!("[{}] ", now.format("%H:%M:%S%.3f"));
    // Reserve a boundary newline for an unterminated legacy file. New files and
    // properly terminated files skip this first byte when appending.
    let mut output = String::from("\n");
    for message in messages {
        let normalized = message.replace("\r\n", "\n").replace('\r', "\n");
        let lines = if normalized.is_empty() {
            "\n"
        } else {
            &normalized
        };
        for line in lines.lines() {
            let added = prefix.len() + line.len() + 1;
            if added > MAX_FILE_BYTES - output.len() {
                return Err("Timestamped log batch exceeds 5 MiB".into());
            }
            output.push_str(&prefix);
            output.push_str(line);
            output.push('\n');
        }
    }
    Ok(output)
}

/// Only the exact names owned by this logger qualify for retention/compaction.
fn owned_date(name: &str) -> Option<NaiveDate> {
    let date = name
        .strip_suffix(".log.1")
        .or_else(|| name.strip_suffix(".log"))?;
    if date.len() != 10 {
        return None;
    }
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    (parsed.format("%Y-%m-%d").to_string() == date).then_some(parsed)
}

fn regular_file_len(path: &Path) -> io::Result<u64> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(metadata.len()),
        Ok(_) => Err(io::Error::other("Log target is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

fn compact_tail(path: &Path, length: u64) -> io::Result<()> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(length - MAX_FILE_BYTES as u64))?;
    let mut tail = Vec::with_capacity(MAX_FILE_BYTES);
    file.take(MAX_FILE_BYTES as u64).read_to_end(&mut tail)?;
    // Prefer complete lines. A huge single line still keeps only its bounded
    // tail, skipping any partial UTF-8 code point at the cut boundary.
    let start = tail
        .iter()
        .position(|byte| *byte == b'\n')
        .filter(|i| i + 1 < tail.len())
        .map(|i| i + 1)
        .unwrap_or_else(|| {
            tail.iter()
                .position(|byte| byte & 0xc0 != 0x80)
                .unwrap_or(tail.len())
        });
    super::storage::write_atomic(path, &tail[start..])
}

fn maintain(directory: &Path, today: NaiveDate) -> io::Result<()> {
    let oldest = today - Duration::days(RETENTION_DAYS - 1);
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        // Do not follow foreign symlinks or recurse into similarly named dirs.
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(date) = name.to_str().and_then(owned_date) else {
            continue;
        };
        let path = entry.path();
        // Strict seven-calendar-day window, including today (also removes
        // future-dated owned files after a clock rollback).
        if date < oldest || date > today {
            fs::remove_file(path)?;
        } else {
            let length = entry.metadata()?.len();
            if length > MAX_FILE_BYTES as u64 {
                compact_tail(&path, length)?;
            }
        }
    }
    Ok(())
}

/// All filesystem work is injected with directory/time and called on spawn_blocking.
/// Tests call this function only with disposable directories, never the home resolver.
pub fn write_batch(
    directory: &Path,
    now: DateTime<FixedOffset>,
    messages: &[String],
) -> Result<(), String> {
    validate_batch(messages)?;
    if messages.is_empty() {
        return Ok(());
    }
    // Bound timestamp expansion too, before touching the filesystem.
    let payload = render_batch(now, messages)?;
    let _guard = WRITER
        .lock()
        .map_err(|_| "Log writer lock poisoned".to_string())?;
    let write = || -> io::Result<()> {
        fs::create_dir_all(directory)?;
        maintain(directory, now.date_naive())?;
        let name = now.format("%Y-%m-%d");
        let active = directory.join(format!("{name}.log"));
        let length = regular_file_len(&active)?;
        if length + payload.len() as u64 > MAX_FILE_BYTES as u64 {
            let backup = directory.join(format!("{name}.log.1"));
            regular_file_len(&backup)?; // Refuse symlink/non-file replacement.
            let mut previous = Vec::with_capacity(length as usize);
            File::open(&active)?
                .take(MAX_FILE_BYTES as u64)
                .read_to_end(&mut previous)?;
            // Copy/replace atomically before resetting the active file. Any
            // failure leaves an intact original in active and/or the backup.
            super::storage::write_atomic(&backup, &previous)?;
            super::storage::write_atomic(&active, b"")?;
        }
        // Exactly one append handle per batch, never per message. Reading the
        // last byte on that same handle repairs a missing legacy boundary.
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&active)?;
        let mut needs_boundary = false;
        if file.metadata()?.len() > 0 {
            file.seek(SeekFrom::End(-1))?;
            let mut last = [0u8; 1];
            file.read_exact(&mut last)?;
            needs_boundary = last[0] != b'\n';
        }
        let bytes = payload.as_bytes();
        file.write_all(if needs_boundary { bytes } else { &bytes[1..] })
    };
    write().map_err(|error| format!("Failed to write logs: {error}"))
}

#[cfg(test)]
#[path = "logging_tests.rs"]
mod tests;
