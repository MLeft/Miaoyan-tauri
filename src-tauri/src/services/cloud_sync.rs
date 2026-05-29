use serde::{Serialize, Deserialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum SyncStatus {
    Available,
    Unavailable,
    Syncing,
    Synced,
    Error(String),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CloudSyncInfo {
    pub status: SyncStatus,
    pub icloud_path: Option<String>,
}

/// 检测 iCloud Drive 是否可用
pub fn detect_icloud() -> CloudSyncInfo {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().unwrap_or_default();
        let icloud_path = home.join("Library/Mobile Documents/com~apple~CloudDocs");
        if icloud_path.exists() {
            CloudSyncInfo {
                status: SyncStatus::Available,
                icloud_path: Some(icloud_path.to_string_lossy().to_string()),
            }
        } else {
            CloudSyncInfo {
                status: SyncStatus::Unavailable,
                icloud_path: None,
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        CloudSyncInfo {
            status: SyncStatus::Unavailable,
            icloud_path: None,
        }
    }
}

/// 检测指定路径是否在 iCloud 目录内
pub fn is_in_icloud(path: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().unwrap_or_default();
        let icloud_path = home.join("Library/Mobile Documents");
        path.starts_with(&icloud_path.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

/// macOS: 通过 xattr 读取文件同步状态
#[cfg(target_os = "macos")]
pub fn get_file_sync_status(path: &str) -> SyncStatus {
    use std::process::Command;
    let output = Command::new("xattr")
        .args(["-p", "com.apple.icloud.metadata", path])
        .output();

    match output {
        Ok(o) if o.status.success() => SyncStatus::Synced,
        _ => {
            // 检查是否有 .icloud 占位文件
            let p = PathBuf::from(path);
            let filename = p.file_name().unwrap_or_default().to_string_lossy();
            let icloud_file = p.with_file_name(format!(".{}.icloud", filename));
            if icloud_file.exists() {
                SyncStatus::Syncing
            } else {
                SyncStatus::Synced
            }
        }
    }
}

/// 非 macOS: 返回不可用
#[cfg(not(target_os = "macos"))]
pub fn get_file_sync_status(_path: &str) -> SyncStatus {
    SyncStatus::Unavailable
}

/// 获取同步状态字符串表示，供前端使用
pub fn sync_status_str(path: &str) -> &'static str {
    if !is_in_icloud(path) {
        return "unavailable";
    }
    match get_file_sync_status(path) {
        SyncStatus::Synced => "synced",
        SyncStatus::Syncing => "syncing",
        _ => "unavailable",
    }
}
