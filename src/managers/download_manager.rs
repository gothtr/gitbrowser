//! Download Manager for GitBrowser.
//!
//! Manages file downloads with pause/resume/cancel support,
//! backed by SQLite for persistence.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use uuid::Uuid;

use crate::database::connection::Database;
use crate::types::download::{DownloadItem, DownloadStatus};
use crate::types::errors::DownloadError;

/// Trait defining download management operations.
pub trait DownloadManagerTrait {
    fn start_download(&mut self, url: &str, filepath: &str) -> Result<String, DownloadError>;
    fn pause_download(&mut self, id: &str) -> Result<(), DownloadError>;
    fn resume_download(&mut self, id: &str) -> Result<(), DownloadError>;
    fn cancel_download(&mut self, id: &str) -> Result<(), DownloadError>;
    fn retry_download(&mut self, id: &str) -> Result<(), DownloadError>;
    fn list_downloads(&self) -> Vec<&DownloadItem>;
    fn get_download(&self, id: &str) -> Option<&DownloadItem>;
}

fn status_to_str(s: &DownloadStatus) -> String {
    match s {
        DownloadStatus::Pending => "pending".to_string(),
        DownloadStatus::InProgress => "in_progress".to_string(),
        DownloadStatus::Paused => "paused".to_string(),
        DownloadStatus::Completed => "completed".to_string(),
        DownloadStatus::Failed(msg) => format!("failed:{}", msg),
    }
}

fn str_to_status(s: &str) -> DownloadStatus {
    match s {
        "pending" => DownloadStatus::Pending,
        "in_progress" => DownloadStatus::InProgress,
        "paused" => DownloadStatus::Paused,
        "completed" => DownloadStatus::Completed,
        other if other.starts_with("failed:") => DownloadStatus::Failed(other[7..].to_string()),
        _ => DownloadStatus::Pending,
    }
}

/// Download manager backed by SQLite with in-memory cache.
pub struct DownloadManager {
    db: Arc<Database>,
    downloads: Vec<DownloadItem>,
}

impl DownloadManager {
    pub fn new(db: Arc<Database>) -> Self {
        let mut mgr = Self {
            db,
            downloads: Vec::new(),
        };
        mgr.load_from_db();
        mgr
    }

    fn load_from_db(&mut self) {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(
            "SELECT id, url, filename, filepath, size, downloaded, status, mime_type, started_at, completed_at FROM downloads ORDER BY started_at DESC"
        ).unwrap();

        self.downloads = stmt.query_map([], |row| {
            let status_str: String = row.get(6)?;
            Ok(DownloadItem {
                id: row.get(0)?,
                url: row.get(1)?,
                filename: row.get(2)?,
                filepath: row.get(3)?,
                size: row.get(4)?,
                downloaded: row.get::<_, i64>(5)? as u64,
                status: str_to_status(&status_str),
                mime_type: row.get(7)?,
                started_at: row.get(8)?,
                completed_at: row.get(9)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect();
    }

    fn now_ts() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
    }

    fn find_index(&self, id: &str) -> Result<usize, DownloadError> {
        self.downloads.iter().position(|d| d.id == id)
            .ok_or_else(|| DownloadError::NotFound(id.to_string()))
    }

    fn persist(&self, item: &DownloadItem) -> Result<(), DownloadError> {
        self.db.connection().execute(
            "INSERT OR REPLACE INTO downloads (id, url, filename, filepath, size, downloaded, status, mime_type, started_at, completed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                item.id, item.url, item.filename, item.filepath,
                item.size, item.downloaded as i64, status_to_str(&item.status),
                item.mime_type, item.started_at, item.completed_at
            ],
        ).map_err(|e| DownloadError::FileSystemError(e.to_string()))?;
        Ok(())
    }
}

impl DownloadManagerTrait for DownloadManager {
    fn start_download(&mut self, url: &str, filepath: &str) -> Result<String, DownloadError> {
        let id = Uuid::new_v4().to_string();
        let filename = filepath.rsplit('/').next()
            .or_else(|| filepath.rsplit('\\').next())
            .unwrap_or(filepath)
            .to_string();

        let item = DownloadItem {
            id: id.clone(),
            url: url.to_string(),
            filename,
            filepath: filepath.to_string(),
            size: None,
            downloaded: 0,
            status: DownloadStatus::Pending,
            mime_type: None,
            started_at: Self::now_ts(),
            completed_at: None,
        };

        self.persist(&item)?;
        self.downloads.insert(0, item);
        Ok(id)
    }

    fn pause_download(&mut self, id: &str) -> Result<(), DownloadError> {
        let idx = self.find_index(id)?;
        match &self.downloads[idx].status {
            DownloadStatus::InProgress | DownloadStatus::Pending => {
                self.downloads[idx].status = DownloadStatus::Paused;
                self.persist(&self.downloads[idx].clone())?;
                Ok(())
            }
            DownloadStatus::Completed => Err(DownloadError::AlreadyCompleted(id.to_string())),
            _ => Ok(()),
        }
    }

    fn resume_download(&mut self, id: &str) -> Result<(), DownloadError> {
        let idx = self.find_index(id)?;
        match &self.downloads[idx].status {
            DownloadStatus::Paused => {
                self.downloads[idx].status = DownloadStatus::InProgress;
                self.persist(&self.downloads[idx].clone())?;
                Ok(())
            }
            DownloadStatus::Completed => Err(DownloadError::AlreadyCompleted(id.to_string())),
            _ => Ok(()),
        }
    }

    fn cancel_download(&mut self, id: &str) -> Result<(), DownloadError> {
        let idx = self.find_index(id)?;
        self.downloads[idx].status = DownloadStatus::Failed("Cancelled".to_string());
        self.persist(&self.downloads[idx].clone())?;
        Ok(())
    }

    fn retry_download(&mut self, id: &str) -> Result<(), DownloadError> {
        let idx = self.find_index(id)?;
        match &self.downloads[idx].status {
            DownloadStatus::Failed(_) => {
                self.downloads[idx].status = DownloadStatus::Pending;
                self.downloads[idx].downloaded = 0;
                self.persist(&self.downloads[idx].clone())?;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn list_downloads(&self) -> Vec<&DownloadItem> {
        self.downloads.iter().collect()
    }

    fn get_download(&self, id: &str) -> Option<&DownloadItem> {
        self.downloads.iter().find(|d| d.id == id)
    }
}
