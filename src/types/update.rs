use serde::{Deserialize, Serialize};

/// Information about an available browser update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub changelog: String,
    pub download_url: String,
    pub sha256: String,
    pub published_at: String,
    pub file_size: u64,
}

/// Progress of an update download.
#[derive(Debug, Clone)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
}
