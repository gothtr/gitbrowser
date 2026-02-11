//! Schema migrations for the GitBrowser SQLite database.
//!
//! All tables use `CREATE TABLE IF NOT EXISTS` so migrations are idempotent
//! and safe to run on every application startup.

use rusqlite::Connection;

/// Runs all schema migrations against the provided connection.
///
/// Creates every table and index required by the application. The function
/// is idempotent — calling it multiple times has no adverse effect.
///
/// # Errors
/// Returns `rusqlite::Error` if any SQL statement fails.
pub fn run_all(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "
        -- Enable WAL mode for better concurrent read performance
        PRAGMA journal_mode = WAL;

        -- Enable foreign key enforcement
        PRAGMA foreign_keys = ON;

        -- ===== Bookmark folders =====
        CREATE TABLE IF NOT EXISTS bookmark_folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT,
            position INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (parent_id) REFERENCES bookmark_folders(id)
        );

        -- ===== Bookmarks =====
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

        -- ===== History =====
        CREATE TABLE IF NOT EXISTS history (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            visit_time INTEGER NOT NULL,
            visit_count INTEGER NOT NULL DEFAULT 1
        );

        CREATE INDEX IF NOT EXISTS idx_history_url ON history(url);
        CREATE INDEX IF NOT EXISTS idx_history_visit_time ON history(visit_time);

        -- ===== Credentials (encrypted) =====
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

        -- ===== Downloads =====
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

        -- ===== Site permissions =====
        CREATE TABLE IF NOT EXISTS site_permissions (
            id TEXT PRIMARY KEY,
            origin TEXT NOT NULL,
            permission_type TEXT NOT NULL,
            value TEXT NOT NULL DEFAULT 'ask',
            updated_at INTEGER NOT NULL,
            UNIQUE(origin, permission_type)
        );

        -- ===== AI chat messages (encrypted) =====
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

        -- ===== Extensions =====
        CREATE TABLE IF NOT EXISTS extensions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            install_path TEXT NOT NULL,
            permissions TEXT NOT NULL,
            installed_at INTEGER NOT NULL
        );

        -- ===== Crash logs =====
        CREATE TABLE IF NOT EXISTS crash_logs (
            id TEXT PRIMARY KEY,
            tab_url TEXT,
            error_type TEXT NOT NULL,
            error_message TEXT,
            timestamp INTEGER NOT NULL
        );

        -- ===== Sessions (encrypted) =====
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            encrypted_data BLOB NOT NULL,
            iv BLOB NOT NULL,
            auth_tag BLOB NOT NULL,
            timestamp INTEGER NOT NULL
        );

        -- ===== GitHub auth (encrypted token) =====
        CREATE TABLE IF NOT EXISTS github_auth (
            id TEXT PRIMARY KEY DEFAULT 'default',
            encrypted_token BLOB NOT NULL,
            iv BLOB NOT NULL,
            auth_tag BLOB NOT NULL,
            login TEXT NOT NULL,
            avatar_url TEXT,
            updated_at INTEGER NOT NULL
        );

        -- ===== GitHub sync (Gist cache) =====
        CREATE TABLE IF NOT EXISTS github_sync (
            id TEXT PRIMARY KEY,
            sync_type TEXT NOT NULL,
            gist_id TEXT NOT NULL,
            last_synced_at INTEGER NOT NULL
        );
        ",
    )?;

    Ok(())
}
