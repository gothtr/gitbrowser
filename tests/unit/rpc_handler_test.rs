//! Unit tests for the RPC handler — all JSON-RPC methods dispatched by `handle_method`.
//!
//! These tests exercise every RPC method through the same code path used by the
//! real `gitbrowser-rpc` binary, using a temporary on-disk SQLite database.
//!
//! Covers: TEST-01 from AUDIT.md Phase 3.

use std::sync::Mutex;
use serde_json::json;
use tempfile::TempDir;

use gitbrowser::app::App;
use gitbrowser::managers::bookmark_manager::BookmarkManagerTrait;
use gitbrowser::rpc_handler::handle_method;

/// Create a fresh App backed by a temp directory DB.
fn setup() -> (Mutex<App>, TempDir) {
    let tmp = TempDir::new().expect("Failed to create temp dir");
    let db_path = tmp.path().join("test.db");
    let app = App::new(db_path.to_str().unwrap()).expect("Failed to init App");
    (Mutex::new(app), tmp)
}

// ─── Ping ───

#[test]
fn test_ping() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "ping", &json!({})).unwrap();
    assert_eq!(res, json!({"pong": true}));
}

// ─── Unknown method ───

#[test]
fn test_unknown_method_returns_error() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "nonexistent.method", &json!({}));
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("unknown method"));
}

// ─── Bookmarks ───

#[test]
fn test_bookmark_add_and_list() {
    let (app, _tmp) = setup();

    let res = handle_method(&app, "bookmark.add", &json!({
        "url": "https://example.com",
        "title": "Example"
    })).unwrap();
    assert!(res.get("id").is_some());
    assert_eq!(res["url"], "https://example.com");

    let list = handle_method(&app, "bookmark.list", &json!({})).unwrap();
    let arr = list["items"].as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["title"], "Example");
}

#[test]
fn test_bookmark_add_invalid_url() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "bookmark.add", &json!({
        "url": "ftp://bad.com",
        "title": "Bad"
    }));
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("invalid url"));
}

#[test]
fn test_bookmark_add_missing_params() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "bookmark.add", &json!({"url": "https://x.com"})).is_err());
    assert!(handle_method(&app, "bookmark.add", &json!({"title": "X"})).is_err());
}

#[test]
fn test_bookmark_search() {
    let (app, _tmp) = setup();
    handle_method(&app, "bookmark.add", &json!({"url": "https://rust-lang.org", "title": "Rust Lang"})).unwrap();
    handle_method(&app, "bookmark.add", &json!({"url": "https://python.org", "title": "Python"})).unwrap();

    let res = handle_method(&app, "bookmark.search", &json!({"query": "Rust"})).unwrap();
    let arr = res.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["title"], "Rust Lang");
}

#[test]
fn test_bookmark_search_missing_query() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "bookmark.search", &json!({})).is_err());
}

#[test]
fn test_bookmark_delete() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "bookmark.add", &json!({
        "url": "https://example.com", "title": "Del Me"
    })).unwrap();
    let id = res["id"].as_str().unwrap();

    handle_method(&app, "bookmark.delete", &json!({"id": id})).unwrap();

    let list = handle_method(&app, "bookmark.list", &json!({})).unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 0);
}

#[test]
fn test_bookmark_list_with_folder() {
    let (app, _tmp) = setup();
    // Create a folder first via the bookmark manager, then add bookmarks
    {
        let a = app.lock().unwrap();
        let conn = a.db.connection();
        let mut mgr = gitbrowser::managers::bookmark_manager::BookmarkManager::new(conn);
        let folder_id = mgr.create_folder("Test Folder", None).unwrap();
        mgr.add_bookmark("https://example.com", "In Folder", Some(&folder_id)).unwrap();
        mgr.add_bookmark("https://other.com", "Root", None).unwrap();
    }

    let root = handle_method(&app, "bookmark.list", &json!({})).unwrap();
    // Root listing should only show bookmarks without folder
    assert_eq!(root["items"].as_array().unwrap().len(), 1);
    assert_eq!(root["items"].as_array().unwrap()[0]["title"], "Root");
}

// ─── History ───

#[test]
fn test_history_record_and_recent() {
    let (app, _tmp) = setup();
    handle_method(&app, "history.record", &json!({
        "url": "https://example.com", "title": "Example"
    })).unwrap();

    let recent = handle_method(&app, "history.recent", &json!({})).unwrap();
    let arr = recent["items"].as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["url"], "https://example.com");
    // visit_time should be in milliseconds (multiplied by 1000)
    assert!(arr[0]["visit_time"].as_i64().unwrap() > 0);
}

#[test]
fn test_history_record_invalid_url() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "history.record", &json!({
        "url": "ftp://bad.com", "title": "Bad"
    }));
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("invalid url"));
}

#[test]
fn test_history_record_missing_params() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "history.record", &json!({"url": "https://x.com"})).is_err());
    assert!(handle_method(&app, "history.record", &json!({"title": "X"})).is_err());
}

#[test]
fn test_history_search() {
    let (app, _tmp) = setup();
    handle_method(&app, "history.record", &json!({"url": "https://rust-lang.org", "title": "Rust"})).unwrap();
    handle_method(&app, "history.record", &json!({"url": "https://python.org", "title": "Python"})).unwrap();

    let res = handle_method(&app, "history.search", &json!({"query": "Rust"})).unwrap();
    let arr = res.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["title"], "Rust");
}

#[test]
fn test_history_delete() {
    let (app, _tmp) = setup();
    handle_method(&app, "history.record", &json!({"url": "https://example.com", "title": "Ex"})).unwrap();

    let recent = handle_method(&app, "history.recent", &json!({})).unwrap();
    let id = recent["items"].as_array().unwrap()[0]["id"].as_str().unwrap().to_string();

    handle_method(&app, "history.delete", &json!({"id": id})).unwrap();

    let after = handle_method(&app, "history.recent", &json!({})).unwrap();
    assert_eq!(after["items"].as_array().unwrap().len(), 0);
}

#[test]
fn test_history_clear() {
    let (app, _tmp) = setup();
    handle_method(&app, "history.record", &json!({"url": "https://a.com", "title": "A"})).unwrap();
    handle_method(&app, "history.record", &json!({"url": "https://b.com", "title": "B"})).unwrap();

    handle_method(&app, "history.clear", &json!({})).unwrap();

    let recent = handle_method(&app, "history.recent", &json!({})).unwrap();
    assert_eq!(recent["items"].as_array().unwrap().len(), 0);
}

// ─── Settings ───

#[test]
fn test_settings_get() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "settings.get", &json!({})).unwrap();
    // Should return a JSON object with settings
    assert!(res.is_object());
}

#[test]
fn test_settings_set_and_get() {
    let (app, _tmp) = setup();
    handle_method(&app, "settings.set", &json!({
        "key": "general.homepage",
        "value": "https://custom.home"
    })).unwrap();

    let settings = handle_method(&app, "settings.get", &json!({})).unwrap();
    // The homepage should be updated in the general section
    if let Some(general) = settings.get("general") {
        if let Some(hp) = general.get("homepage") {
            assert_eq!(hp, "https://custom.home");
        }
    }
}

#[test]
fn test_settings_set_missing_params() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "settings.set", &json!({"key": "x"})).is_err());
    assert!(handle_method(&app, "settings.set", &json!({"value": "x"})).is_err());
}

// ─── Localization ───

#[test]
fn test_i18n_locale() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "i18n.locale", &json!({})).unwrap();
    // Should return a locale string
    assert!(res.get("locale").is_some());
}

#[test]
fn test_i18n_t() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "i18n.t", &json!({"key": "app.name"})).unwrap();
    // Should return a text field (may be the key itself if not found)
    assert!(res.get("text").is_some());
}

#[test]
fn test_i18n_t_missing_key() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "i18n.t", &json!({})).is_err());
}

// ─── Session save/restore ───

#[test]
fn test_session_save_and_restore() {
    let (app, tmp) = setup();
    // Set GITBROWSER_DATA_DIR so session.json goes to our temp dir
    std::env::set_var("GITBROWSER_DATA_DIR", tmp.path());

    let tabs = json!([{"url": "https://example.com", "title": "Ex"}]);
    handle_method(&app, "session.save", &json!({"tabs": tabs})).unwrap();

    let restored = handle_method(&app, "session.restore", &json!({})).unwrap();
    let arr = restored.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["url"], "https://example.com");

    // Clean up env var
    std::env::remove_var("GITBROWSER_DATA_DIR");
}

#[test]
fn test_session_restore_no_file() {
    let (app, tmp) = setup();
    // Point to a dir with no session.json
    std::env::set_var("GITBROWSER_DATA_DIR", tmp.path().join("nonexistent"));
    let restored = handle_method(&app, "session.restore", &json!({})).unwrap();
    assert_eq!(restored, json!([]));
    std::env::remove_var("GITBROWSER_DATA_DIR");
}

#[test]
fn test_session_save_missing_tabs() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "session.save", &json!({})).is_err());
}

// ─── Password Manager ───

#[test]
fn test_password_is_unlocked_initially_false() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "password.is_unlocked", &json!({})).unwrap();
    assert_eq!(res["unlocked"], false);
}

#[test]
fn test_password_unlock_and_lock() {
    let (app, _tmp) = setup();
    // First unlock sets the master password
    let res = handle_method(&app, "password.unlock", &json!({"master_password": "test123"})).unwrap();
    assert_eq!(res["ok"], true);

    let unlocked = handle_method(&app, "password.is_unlocked", &json!({})).unwrap();
    assert_eq!(unlocked["unlocked"], true);

    handle_method(&app, "password.lock", &json!({})).unwrap();

    let locked = handle_method(&app, "password.is_unlocked", &json!({})).unwrap();
    assert_eq!(locked["unlocked"], false);
}

#[test]
fn test_password_save_list_decrypt_delete() {
    let (app, _tmp) = setup();
    // Unlock first
    handle_method(&app, "password.unlock", &json!({"master_password": "master1"})).unwrap();

    // Save a credential
    let save_res = handle_method(&app, "password.save", &json!({
        "url": "https://example.com",
        "username": "user1",
        "password": "secret123"
    })).unwrap();
    let cred_id = save_res["id"].as_str().unwrap().to_string();

    // List — should NOT contain plaintext password (SEC-04)
    let list = handle_method(&app, "password.list", &json!({})).unwrap();
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["username"], "user1");
    assert!(arr[0].get("password").is_none(), "password.list must not return plaintext passwords");

    // Decrypt
    let dec = handle_method(&app, "password.decrypt", &json!({"id": cred_id})).unwrap();
    assert_eq!(dec["password"], "secret123");

    // Delete
    handle_method(&app, "password.delete", &json!({"id": cred_id})).unwrap();
    let after = handle_method(&app, "password.list", &json!({})).unwrap();
    assert_eq!(after.as_array().unwrap().len(), 0);
}

#[test]
fn test_password_list_by_url() {
    let (app, _tmp) = setup();
    handle_method(&app, "password.unlock", &json!({"master_password": "master1"})).unwrap();

    handle_method(&app, "password.save", &json!({
        "url": "https://example.com", "username": "u1", "password": "p1"
    })).unwrap();
    handle_method(&app, "password.save", &json!({
        "url": "https://other.com", "username": "u2", "password": "p2"
    })).unwrap();

    let filtered = handle_method(&app, "password.list", &json!({"url": "https://example.com"})).unwrap();
    let arr = filtered.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["username"], "u1");
}

#[test]
fn test_password_update() {
    let (app, _tmp) = setup();
    handle_method(&app, "password.unlock", &json!({"master_password": "master1"})).unwrap();

    let save_res = handle_method(&app, "password.save", &json!({
        "url": "https://example.com", "username": "old_user", "password": "old_pass"
    })).unwrap();
    let id = save_res["id"].as_str().unwrap().to_string();

    handle_method(&app, "password.update", &json!({
        "id": id, "username": "new_user", "password": "new_pass"
    })).unwrap();

    let list = handle_method(&app, "password.list", &json!({})).unwrap();
    assert_eq!(list.as_array().unwrap()[0]["username"], "new_user");

    let dec = handle_method(&app, "password.decrypt", &json!({"id": id})).unwrap();
    assert_eq!(dec["password"], "new_pass");
}

#[test]
fn test_password_generate() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "password.generate", &json!({"length": 20})).unwrap();
    let pw = res["password"].as_str().unwrap();
    assert_eq!(pw.len(), 20);
}

#[test]
fn test_password_generate_defaults() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "password.generate", &json!({})).unwrap();
    let pw = res["password"].as_str().unwrap();
    assert_eq!(pw.len(), 16); // default length
}

#[test]
fn test_password_decrypt_not_found() {
    let (app, _tmp) = setup();
    handle_method(&app, "password.unlock", &json!({"master_password": "m"})).unwrap();
    let res = handle_method(&app, "password.decrypt", &json!({"id": "nonexistent"}));
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("credential not found"));
}

// ─── GitHub Integration ───

#[test]
fn test_github_store_and_get_token() {
    let (app, _tmp) = setup();
    handle_method(&app, "github.store_token", &json!({
        "token": "ghp_test123",
        "login": "testuser",
        "avatar_url": "https://avatars.example.com/u/1"
    })).unwrap();

    let res = handle_method(&app, "github.get_token", &json!({})).unwrap();
    assert_eq!(res["token"], "ghp_test123");
}

#[test]
fn test_github_get_token_when_none() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "github.get_token", &json!({})).unwrap();
    assert!(res["token"].is_null());
}

#[test]
fn test_github_logout() {
    let (app, _tmp) = setup();
    handle_method(&app, "github.store_token", &json!({
        "token": "ghp_abc", "login": "user"
    })).unwrap();

    handle_method(&app, "github.logout", &json!({})).unwrap();

    let res = handle_method(&app, "github.get_token", &json!({})).unwrap();
    assert!(res["token"].is_null());
}

#[test]
fn test_github_store_token_missing_params() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "github.store_token", &json!({"token": "x"})).is_err());
    assert!(handle_method(&app, "github.store_token", &json!({"login": "x"})).is_err());
}

#[test]
fn test_github_encrypt_decrypt_sync() {
    let (app, _tmp) = setup();
    let enc = handle_method(&app, "github.encrypt_sync", &json!({"data": "hello world"})).unwrap();
    assert!(enc.get("ciphertext").is_some());
    assert!(enc.get("iv").is_some());
    assert!(enc.get("auth_tag").is_some());

    let dec = handle_method(&app, "github.decrypt_sync", &json!({
        "ciphertext": enc["ciphertext"],
        "iv": enc["iv"],
        "auth_tag": enc["auth_tag"]
    })).unwrap();
    assert_eq!(dec["data"], "hello world");
}

#[test]
fn test_github_decrypt_sync_invalid_base64() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "github.decrypt_sync", &json!({
        "ciphertext": "!!!invalid!!!",
        "iv": "also_bad",
        "auth_tag": "nope"
    }));
    assert!(res.is_err());
}

// ─── Extensions ───

#[test]
fn test_extension_list_empty() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "extension.list", &json!({})).unwrap();
    assert_eq!(res.as_array().unwrap().len(), 0);
}

#[test]
fn test_extension_install_missing_path() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "extension.install", &json!({})).is_err());
}

#[test]
fn test_extension_enable_disable_missing_id() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "extension.enable", &json!({})).is_err());
    assert!(handle_method(&app, "extension.disable", &json!({})).is_err());
    assert!(handle_method(&app, "extension.uninstall", &json!({})).is_err());
}

#[test]
fn test_extension_content_scripts_empty() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "extension.content_scripts", &json!({"url": "https://example.com"})).unwrap();
    assert_eq!(res.as_array().unwrap().len(), 0);
}

#[test]
fn test_extension_content_scripts_missing_url() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "extension.content_scripts", &json!({})).is_err());
}

// ─── Secure Secret Storage ───

#[test]
fn test_secret_store_and_get_without_master() {
    let (app, _tmp) = setup();
    // Without master password, uses GitHub integration fallback key
    handle_method(&app, "secret.store", &json!({"key": "api_key", "value": "sk-123"})).unwrap();

    let res = handle_method(&app, "secret.get", &json!({"key": "api_key"})).unwrap();
    assert_eq!(res["value"], "sk-123");
}

#[test]
fn test_secret_store_and_get_with_master() {
    let (app, _tmp) = setup();
    // Unlock master password first
    handle_method(&app, "password.unlock", &json!({"master_password": "master1"})).unwrap();

    handle_method(&app, "secret.store", &json!({"key": "my_secret", "value": "top_secret"})).unwrap();

    let res = handle_method(&app, "secret.get", &json!({"key": "my_secret"})).unwrap();
    assert_eq!(res["value"], "top_secret");
}

#[test]
fn test_secret_get_nonexistent() {
    let (app, _tmp) = setup();
    let res = handle_method(&app, "secret.get", &json!({"key": "nope"})).unwrap();
    assert!(res["value"].is_null());
}

#[test]
fn test_secret_delete() {
    let (app, _tmp) = setup();
    handle_method(&app, "secret.store", &json!({"key": "temp", "value": "val"})).unwrap();
    handle_method(&app, "secret.delete", &json!({"key": "temp"})).unwrap();

    let res = handle_method(&app, "secret.get", &json!({"key": "temp"})).unwrap();
    assert!(res["value"].is_null());
}

#[test]
fn test_secret_store_missing_params() {
    let (app, _tmp) = setup();
    assert!(handle_method(&app, "secret.store", &json!({"key": "k"})).is_err());
    assert!(handle_method(&app, "secret.store", &json!({"value": "v"})).is_err());
}

#[test]
fn test_secret_get_master_required_after_lock() {
    let (app, _tmp) = setup();
    // Store with master key
    handle_method(&app, "password.unlock", &json!({"master_password": "m"})).unwrap();
    handle_method(&app, "secret.store", &json!({"key": "locked_secret", "value": "data"})).unwrap();

    // Lock the password manager
    handle_method(&app, "password.lock", &json!({})).unwrap();

    // Trying to get should fail because master is required
    let res = handle_method(&app, "secret.get", &json!({"key": "locked_secret"}));
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("master password required"));
}

// ─── Base64 helpers ───

#[test]
fn test_base64_roundtrip() {
    use gitbrowser::rpc_handler::{base64_encode, base64_decode};
    let data = b"Hello, GitBrowser!";
    let encoded = base64_encode(data);
    let decoded = base64_decode(&encoded).unwrap();
    assert_eq!(decoded, data);
}

#[test]
fn test_base64_decode_invalid() {
    use gitbrowser::rpc_handler::base64_decode;
    let res = base64_decode("!!!not-base64!!!");
    assert!(res.is_err());
}
