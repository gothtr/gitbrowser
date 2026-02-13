//! Schema migrations for the GitBrowser SQLite database.
//!
//! Uses a `schema_version` table to track which migrations have been applied.
//! Each migration runs exactly once and is recorded with a timestamp.

use rusqlite::Connection;

/// Current schema version. Bump this when adding a new migration.
pub const CURRENT_SCHEMA_VERSION: i32 = 2;

/// Returns the current schema version from the database (0 if table doesn't exist).
pub fn get_schema_version(conn: &Connection) -> i32 {
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

/// Runs all pending schema migrations against the provided connection.
///
/// Migrations are versioned — each runs exactly once and is recorded in
/// the `schema_version` table. Safe to call on every startup.
///
/// # Errors
/// Returns `rusqlite::Error` if any SQL statement fails.
pub fn run_all(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Enable WAL and foreign keys (always, not versioned)
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS schema_version (
             version INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL,
             description TEXT NOT NULL
         );"
    )?;

    let current = get_schema_version(conn);

    if current < 1 {
        migration_v1(conn)?;
        record_version(conn, 1, "Initial schema: all core tables")?;
    }

    if current < 2 {
        migration_v2(conn)?;
        record_version(conn, 2, "Add content_scripts to extensions, uses_master to secure_store")?;
    }

    Ok(())
}

fn record_version(conn: &Connection, version: i32, description: &str) -> Result<(), rusqlite::Error> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR IGNORE INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)",
        rusqlite::params![version, now, description],
    )?;
    Ok(())
}

/// V1: Create all core tables.
fn migration_v1(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS bookmark_folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT,
            position INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (parent_id) REFERENCES bookmark_folders(id)
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            folder_id TEXT,
            position INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (folder_id) REFERENCES bookmark_folders(id)
        );

        CREATE TABLE IF NOT EXISTS history (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            visit_time INTEGER NOT NULL,
            visit_count INTEGER NOT NULL DEFAULT 1
        );

        CREATE INDEX IF NOT EXISTS idx_history_url ON history(url);
        CREATE INDEX IF NOT EXISTS idx_history_visit_time ON history(visit_time);

        CREATE TABLE IF NOT EXISTS credentials (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            username TEXT NOT NULL,
            encrypted_password BLOB NOT NULL,
            iv BLOB NOT NULL,
            auth_tag BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_credentials_url ON credentials(url);

        CREATE TABLE IF NOT EXISTS downloads (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            filename TEXT NOT NULL,
            filepath TEXT NOT NULL,
            size INTEGER,
            downloaded INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            mime_type TEXT,
            started_at INTEGER NOT NULL,
            completed_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS site_permissions (
            id TEXT PRIMARY KEY,
            origin TEXT NOT NULL,
            permission_type TEXT NOT NULL,
            value TEXT NOT NULL DEFAULT 'ask',
            updated_at INTEGER NOT NULL,
            UNIQUE(origin, permission_type)
        );

        CREATE TABLE IF NOT EXISTS ai_chat_messages (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            encrypted_content BLOB NOT NULL,
            iv BLOB NOT NULL,
            auth_tag BLOB NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            tokens_used INTEGER,
            cost REAL,
            timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS extensions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            install_path TEXT NOT NULL,
            permissions TEXT NOT NULL,
            content_scripts TEXT NOT NULL DEFAULT '[]',
            installed_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS crash_logs (
            id TEXT PRIMARY KEY,
            tab_url TEXT,
            error_type TEXT NOT NULL,
            error_message TEXT,
            timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            encrypted_data BLOB NOT NULL,
            iv BLOB NOT NULL,
            auth_tag BLOB NOT NULL,
            timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS github_auth (
            id TEXT PRIMARY KEY DEFAULT 'default',
            encrypted_token BLOB NOT NULL,
            iv BLOB NOT NULL,
            auth_tag BLOB NOT NULL,
            login TEXT NOT NULL,
            avatar_url TEXT,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS github_sync (
            id TEXT PRIMARY KEY,
            sync_type TEXT NOT NULL,
            gist_id TEXT NOT NULL,
            last_synced_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS secure_store (
            key TEXT PRIMARY KEY,
            ciphertext BLOB NOT NULL,
            iv BLOB NOT NULL,
            auth_tag BLOB NOT NULL,
            updated_at INTEGER NOT NULL,
            uses_master INTEGER NOT NULL DEFAULT 0
        );
        "
    )
}

/// V2: Add columns for older databases that were created before V1 included them.
fn migration_v2(conn: &Connection) -> Result<(), rusqlite::Error> {
    // content_scripts column on extensions
    if conn.prepare("SELECT content_scripts FROM extensions LIMIT 0").is_err() {
        let _ = conn.execute_batch(
            "ALTER TABLE extensions ADD COLUMN content_scripts TEXT NOT NULL DEFAULT '[]';"
        );
    }
    // uses_master column on secure_store
    if conn.prepare("SELECT uses_master FROM secure_store LIMIT 0").is_err() {
        let _ = conn.execute_batch(
            "ALTER TABLE secure_store ADD COLUMN uses_master INTEGER NOT NULL DEFAULT 0;"
        );
    }
    Ok(())
}
