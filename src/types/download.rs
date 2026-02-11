use serde::{Deserialize, Serialize};

/// Status of a file download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DownloadStatus {
    Pending,
    InProgress,
    Paused,
    Completed,
    Failed(String),
}

/// Represents a file download with its progress and metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadItem {
    pub id: String,
    pub url: String,
    pub filename: String,
    pub filepath: String,
    pub size: Option<u64>,
    pub downloaded: u64,
    pub status: DownloadStatus,
    pub mime_type: Option<String>,
    pub started_at: i64,
    pub completed_at: Option<i64>,
}
