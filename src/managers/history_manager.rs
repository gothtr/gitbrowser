//! History Manager for GitBrowser.
//!
//! Implements `HistoryManagerTrait` — recording visits, searching, listing,
//! and clearing browsing history, backed by SQLite via `rusqlite`.

use rusqlite::{params, Connection};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::types::errors::HistoryError;
use crate::types::history::HistoryEntry;

/// Trait defining history management operations.
pub trait HistoryManagerTrait {
    fn record_visit(&mut self, url: &str, title: &str) -> Result<String, HistoryError>;
    fn search_history(&self, query: &str) -> Result<Vec<HistoryEntry>, HistoryError>;
    fn list_history(&self, date: Option<&str>) -> Result<Vec<HistoryEntry>, HistoryError>;
    fn delete_entry(&mut self, id: &str) -> Result<(), HistoryError>;
    fn clear_all(&mut self) -> Result<(), HistoryError>;
    fn is_recording_enabled(&self) -> bool;
    fn set_recording_enabled(&mut self, enabled: bool);
}

/// History manager backed by a SQLite connection.
pub struct HistoryManager<'a> {
    conn: &'a Connection,
    recording_enabled: bool,
}

impl<'a> HistoryManager<'a> {
    /// Creates a new `HistoryManager` using the provided database connection.
    pub fn new(conn: &'a Connection) -> Self {
        Self {
            conn,
            recording_enabled: true,
        }
    }

    /// Returns the current UNIX timestamp in seconds.
    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }

    /// Parses a "YYYY-MM-DD" date string into a UNIX timestamp (start of day UTC).
    fn parse_date_to_timestamp(date: &str) -> Result<i64, String> {
        let parts: Vec<&str> = date.split('-').collect();
        if parts.len() != 3 {
            return Err(format!("Invalid date format: {}", date));
        }
        let year: i64 = parts[0]
            .parse()
            .map_err(|_| format!("Invalid year: {}", parts[0]))?;
        let month: i64 = parts[1]
            .parse()
            .map_err(|_| format!("Invalid month: {}", parts[1]))?;
        let day: i64 = parts[2]
            .parse()
            .map_err(|_| format!("Invalid day: {}", parts[2]))?;

        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return Err(format!("Invalid date: {}", date));
        }

        // Simple days-from-epoch calculation (UTC)
        // Using a basic algorithm to convert year/month/day to UNIX timestamp
        let mut y = year;
        let mut m = month;
        if m <= 2 {
            y -= 1;
            m += 12;
        }
        let days = 365 * y + y / 4 - y / 100 + y / 400 + (153 * (m - 3) + 2) / 5 + day - 719469;
        Ok(days * 86400)
    }

    /// Reads a single `HistoryEntry` row into a struct.
    fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<HistoryEntry> {
        Ok(HistoryEntry {
            id: row.get(0)?,
            url: row.get(1)?,
            title: row.get(2)?,
            visit_time: row.get(3)?,
            visit_count: row.get(4)?,
        })
    }
}

impl<'a> HistoryManagerTrait for HistoryManager<'a> {
    /// Records a page visit. If the URL already exists, increments visit_count
    /// and updates the visit_time and title. Returns the entry ID.
    fn record_visit(&mut self, url: &str, title: &str) -> Result<String, HistoryError> {
        if !self.recording_enabled {
            return Err(HistoryError::DatabaseError(
                "Recording is disabled (private mode)".to_string(),
            ));
        }

        let now = Self::now();

        // Check if URL already exists in history
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM history WHERE url = ?1",
                params![url],
                |row| row.get(0),
            )
            .ok();

        match existing {
            Some(id) => {
                // Update existing entry: increment visit_count, update time and title
                self.conn
                    .execute(
                        "UPDATE history SET visit_count = visit_count + 1, visit_time = ?1, title = ?2 WHERE id = ?3",
                        params![now, title, id],
                    )
                    .map_err(|e| HistoryError::DatabaseError(e.to_string()))?;
                Ok(id)
            }
            None => {
                // Insert new entry
                let id = Uuid::new_v4().to_string();
                self.conn
                    .execute(
                        "INSERT INTO history (id, url, title, visit_time, visit_count) VALUES (?1, ?2, ?3, ?4, 1)",
                        params![id, url, title, now],
                    )
                    .map_err(|e| HistoryError::DatabaseError(e.to_string()))?;
                Ok(id)
            }
        }
    }

    /// Searches history entries by title or URL using SQL LIKE.
    fn search_history(&self, query: &str) -> Result<Vec<HistoryEntry>, HistoryError> {
        let pattern = format!("%{}%", query);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, url, title, visit_time, visit_count \
                 FROM history WHERE title LIKE ?1 OR url LIKE ?2 \
                 ORDER BY visit_time DESC",
            )
            .map_err(|e| HistoryError::DatabaseError(e.to_string()))?;

        let rows = stmt
            .query_map(params![pattern, pattern], Self::row_to_entry)
            .map_err(|e| HistoryError::DatabaseError(e.to_string()))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| HistoryError::DatabaseError(e.to_string()))?);
        }
        Ok(results)
    }

    /// Lists history entries ordered by visit_time DESC.
    /// If `date` is provided (format "YYYY-MM-DD"), filters to that day.
    fn list_history(&self, date: Option<&str>) -> Result<Vec<HistoryEntry>, HistoryError> {
        match date {
            Some(d) => {
                // Parse date string to get start/end timestamps for the day
                let start = Self::parse_date_to_timestamp(d)
                    .map_err(|e| HistoryError::DatabaseError(e))?;
                let end = start + 86400; // +24 hours

                let mut stmt = self
                    .conn
                    .prepare(
                        "SELECT id, url, title, visit_time, visit_count \
                         FROM history WHERE visit_time >= ?1 AND visit_time < ?2 \
                         ORDER BY visit_time DESC",
                    )
                    .map_err(|e| HistoryError::DatabaseError(e.to_string()))?;

                let rows = stmt
                    .query_map(params![start, end], Self::row_to_entry)
                    .map_err(|e| HistoryError::DatabaseError(e.to_string()))?;

                let mut results = Vec::new();
                for row in rows {
                    results.push(row.map_err(|e| HistoryError::DatabaseError(e.to_string()))?);
                }
                Ok(results)
            }
            None => {
                let mut stmt = self
                    .conn
                    .prepare(
                        "SELECT id, url, title, visit_time, visit_count \
                         FROM history ORDER BY visit_time DESC",
                    )
                    .map_err(|e| HistoryError::DatabaseError(e.to_string()))?;

                let rows = stmt
                    .query_map([], Self::row_to_entry)
                    .map_err(|e| HistoryError::DatabaseError(e.to_string()))?;

                let mut results = Vec::new();
                for row in rows {
                    results.push(row.map_err(|e| HistoryError::DatabaseError(e.to_string()))?);
                }
                Ok(results)
            }
        }
    }

    /// Deletes a single history entry by ID.
    fn delete_entry(&mut self, id: &str) -> Result<(), HistoryError> {
        let affected = self
            .conn
            .execute("DELETE FROM history WHERE id = ?1", params![id])
            .map_err(|e| HistoryError::DatabaseError(e.to_string()))?;

        if affected == 0 {
            return Err(HistoryError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// Clears all history entries.
    fn clear_all(&mut self) -> Result<(), HistoryError> {
        self.conn
            .execute("DELETE FROM history", [])
            .map_err(|e| HistoryError::DatabaseError(e.to_string()))?;
        Ok(())
    }

    /// Returns whether history recording is enabled.
    fn is_recording_enabled(&self) -> bool {
        self.recording_enabled
    }

    /// Enables or disables history recording (for private mode integration).
    fn set_recording_enabled(&mut self, enabled: bool) {
        self.recording_enabled = enabled;
    }
}
