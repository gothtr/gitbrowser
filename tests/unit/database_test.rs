//! Unit tests for the GitBrowser database layer (connection + migrations).

use gitbrowser::database::Database;

#[test]
fn test_open_in_memory_succeeds() {
    let db = Database::open_in_memory();
    assert!(db.is_ok(), "open_in_memory should succeed");
}

#[test]
fn test_migrations_create_all_tables() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    let expected_tables = [
        "bookmarks",
        "bookmark_folders",
        "history",
        "credentials",
        "downloads",
        "site_permissions",
        "ai_chat_messages",
        "extensions",
        "crash_logs",
        "sessions",
        "github_auth",
        "github_sync",
    ];

    for table in &expected_tables {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get(0),
            )
            .unwrap_or(false);
        assert!(exists, "Table '{}' should exist after migrations", table);
    }
}

#[test]
fn test_migrations_create_indexes() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    let expected_indexes = [
        "idx_history_url",
        "idx_history_visit_time",
        "idx_credentials_url",
    ];

    for index in &expected_indexes {
        let exists: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='index' AND name=?1",
                [index],
                |row| row.get(0),
            )
            .unwrap_or(false);
        assert!(exists, "Index '{}' should exist after migrations", index);
    }
}

#[test]
fn test_migrations_are_idempotent() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    // Running migrations a second time should not fail
    let result = gitbrowser::database::migrations::run_all(db.connection());
    assert!(result.is_ok(), "Running migrations twice should succeed (idempotent)");
}

#[test]
fn test_open_file_database() {
    let dir = std::env::temp_dir().join("gitbrowser_test_db");
    std::fs::create_dir_all(&dir).ok();
    let db_path = dir.join("test.db");

    // Clean up any previous test run
    let _ = std::fs::remove_file(&db_path);

    let db = Database::open(&db_path);
    assert!(db.is_ok(), "open with file path should succeed");

    // Verify the file was created
    assert!(db_path.exists(), "Database file should exist on disk");

    // Clean up
    drop(db);
    let _ = std::fs::remove_file(&db_path);
    let _ = std::fs::remove_dir(&dir);
}

#[test]
fn test_bookmarks_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    // Insert a bookmark to verify the schema is correct
    conn.execute(
        "INSERT INTO bookmarks (id, url, title, folder_id, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, 0, 1700000000, 1700000000)",
        ["bk-1", "https://example.com", "Example"],
    )
    .expect("Should be able to insert into bookmarks table");

    let (url, title): (String, String) = conn
        .query_row(
            "SELECT url, title FROM bookmarks WHERE id = ?1",
            ["bk-1"],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("Should be able to query bookmarks");

    assert_eq!(url, "https://example.com");
    assert_eq!(title, "Example");
}

#[test]
fn test_bookmark_folders_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO bookmark_folders (id, name, parent_id, position)
         VALUES (?1, ?2, NULL, 0)",
        ["folder-1", "My Folder"],
    )
    .expect("Should be able to insert into bookmark_folders table");

    let name: String = conn
        .query_row(
            "SELECT name FROM bookmark_folders WHERE id = ?1",
            ["folder-1"],
            |row| row.get(0),
        )
        .expect("Should be able to query bookmark_folders");

    assert_eq!(name, "My Folder");
}

#[test]
fn test_bookmarks_foreign_key_to_folders() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    // Create a folder first
    conn.execute(
        "INSERT INTO bookmark_folders (id, name, parent_id, position)
         VALUES ('folder-1', 'Test Folder', NULL, 0)",
        [],
    )
    .expect("Should insert folder");

    // Insert a bookmark referencing the folder
    conn.execute(
        "INSERT INTO bookmarks (id, url, title, folder_id, position, created_at, updated_at)
         VALUES ('bk-1', 'https://example.com', 'Example', 'folder-1', 0, 1700000000, 1700000000)",
        [],
    )
    .expect("Should insert bookmark with valid folder_id");
}

#[test]
fn test_history_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO history (id, url, title, visit_time, visit_count)
         VALUES ('h-1', 'https://example.com', 'Example', 1700000000, 3)",
        [],
    )
    .expect("Should insert into history");

    let visit_count: i32 = conn
        .query_row(
            "SELECT visit_count FROM history WHERE id = 'h-1'",
            [],
            |row| row.get(0),
        )
        .expect("Should query history");

    assert_eq!(visit_count, 3);
}

#[test]
fn test_credentials_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO credentials (id, url, username, encrypted_password, iv, auth_tag, created_at, updated_at)
         VALUES ('c-1', 'https://example.com', 'user', X'DEADBEEF', X'AABB', X'CCDD', 1700000000, 1700000000)",
        [],
    )
    .expect("Should insert into credentials");

    let username: String = conn
        .query_row(
            "SELECT username FROM credentials WHERE id = 'c-1'",
            [],
            |row| row.get(0),
        )
        .expect("Should query credentials");

    assert_eq!(username, "user");
}

#[test]
fn test_downloads_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO downloads (id, url, filename, filepath, size, downloaded, status, mime_type, started_at, completed_at)
         VALUES ('d-1', 'https://example.com/file.zip', 'file.zip', '/tmp/file.zip', 1024, 512, 'in_progress', 'application/zip', 1700000000, NULL)",
        [],
    )
    .expect("Should insert into downloads");

    let status: String = conn
        .query_row(
            "SELECT status FROM downloads WHERE id = 'd-1'",
            [],
            |row| row.get(0),
        )
        .expect("Should query downloads");

    assert_eq!(status, "in_progress");
}

#[test]
fn test_site_permissions_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO site_permissions (id, origin, permission_type, value, updated_at)
         VALUES ('sp-1', 'https://example.com', 'camera', 'allow', 1700000000)",
        [],
    )
    .expect("Should insert into site_permissions");

    // Test UNIQUE constraint on (origin, permission_type)
    let result = conn.execute(
        "INSERT INTO site_permissions (id, origin, permission_type, value, updated_at)
         VALUES ('sp-2', 'https://example.com', 'camera', 'deny', 1700000001)",
        [],
    );
    assert!(result.is_err(), "Duplicate (origin, permission_type) should violate UNIQUE constraint");
}

#[test]
fn test_ai_chat_messages_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO ai_chat_messages (id, role, encrypted_content, iv, auth_tag, provider, model, tokens_used, cost, timestamp)
         VALUES ('ai-1', 'user', X'AABB', X'CCDD', X'EEFF', 'openai', 'gpt-4', 150, 0.003, 1700000000)",
        [],
    )
    .expect("Should insert into ai_chat_messages");
}

#[test]
fn test_extensions_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO extensions (id, name, version, enabled, install_path, permissions, installed_at)
         VALUES ('ext-1', 'Ad Blocker', '1.0.0', 1, '/extensions/adblocker', 'PageContent,Storage', 1700000000)",
        [],
    )
    .expect("Should insert into extensions");
}

#[test]
fn test_crash_logs_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO crash_logs (id, tab_url, error_type, error_message, timestamp)
         VALUES ('crash-1', 'https://example.com', 'render_crash', 'WebProcess terminated', 1700000000)",
        [],
    )
    .expect("Should insert into crash_logs");
}

#[test]
fn test_sessions_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO sessions (id, encrypted_data, iv, auth_tag, timestamp)
         VALUES ('sess-1', X'AABBCCDD', X'1122', X'3344', 1700000000)",
        [],
    )
    .expect("Should insert into sessions");
}

#[test]
fn test_github_auth_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO github_auth (id, encrypted_token, iv, auth_tag, login, avatar_url, updated_at)
         VALUES ('default', X'AABB', X'CCDD', X'EEFF', 'octocat', 'https://avatars.githubusercontent.com/u/1', 1700000000)",
        [],
    )
    .expect("Should insert into github_auth");
}

#[test]
fn test_github_sync_table_schema() {
    let db = Database::open_in_memory().expect("open_in_memory failed");
    let conn = db.connection();

    conn.execute(
        "INSERT INTO github_sync (id, sync_type, gist_id, last_synced_at)
         VALUES ('sync-1', 'bookmarks', 'gist-abc123', 1700000000)",
        [],
    )
    .expect("Should insert into github_sync");
}
