//! Crash Recovery for GitBrowser.
//!
//! Logs crash events and provides session recovery after crashes.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use uuid::Uuid;

use crate::database::connection::Database;
use crate::managers::session_manager::{SessionManager, SessionManagerTrait};
use crate::types::errors::CrashError;
use crate::types::privacy::CrashLogEntry;
use crate::types::session::SessionData;

/// Trait defining crash recovery operations.
pub trait CrashRecoveryTrait {
    fn log_crash(&mut self, entry: CrashLogEntry) -> Result<(), CrashError>;
    fn get_crash_logs(&self) -> Result<Vec<CrashLogEntry>, CrashError>;
    fn has_unrecovered_crash(&self) -> bool;
    fn mark_crash_recovered(&mut self) -> Result<(), CrashError>;
    fn get_last_session_for_recovery(&self) -> Result<Option<SessionData>, CrashError>;
}

/// Crash recovery backed by SQLite.
pub struct CrashRecovery {
    db: Arc<Database>,
    unrecovered: bool,
}

impl CrashRecovery {
    pub fn new(db: Arc<Database>) -> Self {
        let unrecovered = {
            let conn = db.connection();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM crash_logs", [], |row| row.get(0))
                .unwrap_or(0);
            count > 0
        };
        Self { db, unrecovered }
    }
}

impl CrashRecoveryTrait for CrashRecovery {
    fn log_crash(&mut self, entry: CrashLogEntry) -> Result<(), CrashError> {
        let id = if entry.id.is_empty() {
            Uuid::new_v4().to_string()
        } else {
            entry.id.clone()
        };

        let timestamp = if entry.timestamp == 0 {
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
        } else {
            entry.timestamp
        };

        self.db.connection().execute(
            "INSERT INTO crash_logs (id, tab_url, error_type, error_message, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, entry.tab_url, entry.error_type, entry.error_message, timestamp],
        ).map_err(|e| CrashError::DatabaseError(e.to_string()))?;

        self.unrecovered = true;
        Ok(())
    }

    fn get_crash_logs(&self) -> Result<Vec<CrashLogEntry>, CrashError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(
            "SELECT id, tab_url, error_type, error_message, timestamp FROM crash_logs ORDER BY timestamp DESC"
        ).map_err(|e| CrashError::DatabaseError(e.to_string()))?;

        let logs = stmt.query_map([], |row| {
            Ok(CrashLogEntry {
                id: row.get(0)?,
                tab_url: row.get(1)?,
                error_type: row.get(2)?,
                error_message: row.get(3)?,
                timestamp: row.get(4)?,
            })
        }).map_err(|e| CrashError::DatabaseError(e.to_string()))?;

        let mut result = Vec::new();
        for log in logs {
            result.push(log.map_err(|e| CrashError::DatabaseError(e.to_string()))?);
        }
        Ok(result)
    }

    fn has_unrecovered_crash(&self) -> bool {
        self.unrecovered
    }

    fn mark_crash_recovered(&mut self) -> Result<(), CrashError> {
        self.db.connection().execute("DELETE FROM crash_logs", [])
            .map_err(|e| CrashError::DatabaseError(e.to_string()))?;
        self.unrecovered = false;
        Ok(())
    }

    fn get_last_session_for_recovery(&self) -> Result<Option<SessionData>, CrashError> {
        let session_mgr = SessionManager::new(self.db.clone())
            .map_err(|e| CrashError::RecoveryFailed(e.to_string()))?;
        session_mgr.restore_session()
            .map_err(|e| CrashError::RecoveryFailed(e.to_string()))
    }
}
