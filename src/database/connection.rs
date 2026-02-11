//! SQLite database connection management for GitBrowser.
//!
//! Provides the [`Database`] struct that wraps a `rusqlite::Connection`
//! and automatically runs schema migrations on open.

use rusqlite::Connection;
use std::path::Path;

use super::migrations;

/// Core database wrapper providing SQLite connection management.
///
/// The `Database` struct owns a `rusqlite::Connection` and ensures that
/// all required tables and indexes are created when the database is opened.
pub struct Database {
    conn: Connection,
}

impl Database {
    /// Opens (or creates) a SQLite database at the given file path and runs migrations.
    ///
    /// # Arguments
    /// * `path` - File system path where the SQLite database file will be stored.
    ///
    /// # Errors
    /// Returns `rusqlite::Error` if the connection cannot be established or migrations fail.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        let db = Self { conn };
        db.run_migrations()?;
        Ok(db)
    }

    /// Opens an in-memory SQLite database and runs migrations.
    ///
    /// Useful for testing — the database is discarded when the `Database` is dropped.
    ///
    /// # Errors
    /// Returns `rusqlite::Error` if the connection cannot be established or migrations fail.
    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn };
        db.run_migrations()?;
        Ok(db)
    }

    /// Runs all schema migrations, creating tables and indexes if they do not exist.
    ///
    /// Uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` so the
    /// method is idempotent and safe to call on every startup.
    fn run_migrations(&self) -> Result<(), rusqlite::Error> {
        migrations::run_all(&self.conn)
    }

    /// Returns a reference to the underlying `rusqlite::Connection`.
    ///
    /// This allows other modules (managers, services) to execute queries
    /// against the database.
    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}
