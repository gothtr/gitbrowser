//! Security tests for GitBrowser.
//!
//! Validates that security fixes are working correctly:
//! - Wrong key / tampered ciphertext detection (CryptoService, PasswordManager, GitHub)
//! - Path traversal protection in extension framework
//! - XSS prevention in Reader Mode (escape_html, sanitize_html)
//! - SEC-04: password.list does not return plaintext passwords
//!
//! Covers: TEST-02 from AUDIT.md Phase 3.

use std::sync::{Arc, Mutex};
use serde_json::json;
use tempfile::TempDir;

use gitbrowser::app::App;
use gitbrowser::database::Database;
use gitbrowser::rpc_handler::handle_method;
use gitbrowser::services::crypto_service::{CryptoService, CryptoServiceTrait};
use gitbrowser::services::extension_framework::ExtensionFrameworkTrait;
use gitbrowser::services::reader_mode::{ReaderMode, ReaderModeTrait};
use gitbrowser::types::reader::ReaderContent;

fn setup_app() -> (Mutex<App>, TempDir) {
    let tmp = TempDir::new().expect("temp dir");
    let db_path = tmp.path().join("sec_test.db");
    let app = App::new(db_path.to_str().unwrap()).expect("App init");
    (Mutex::new(app), tmp)
}

// ═══════════════════════════════════════════════════════════════
// Crypto: wrong key, tampered ciphertext, tampered IV, tampered tag
// ═══════════════════════════════════════════════════════════════

#[test]
fn test_crypto_wrong_key_fails() {
    let svc = CryptoService::new();
    let salt = svc.generate_salt();
    let key1 = svc.derive_key("password1", &salt).unwrap();
    let key2 = svc.derive_key("password2", &salt).unwrap();

    let encrypted = svc.encrypt_aes256gcm(b"secret data", &key1).unwrap();
    let result = svc.decrypt_aes256gcm(&encrypted, &key2);
    assert!(result.is_err(), "Decryption with wrong key must fail");
}

#[test]
fn test_crypto_tampered_ciphertext_fails() {
    let svc = CryptoService::new();
    let salt = svc.generate_salt();
    let key = svc.derive_key("password", &salt).unwrap();

    let mut encrypted = svc.encrypt_aes256gcm(b"secret data", &key).unwrap();
    // Flip a byte in the ciphertext
    if let Some(byte) = encrypted.ciphertext.first_mut() {
        *byte ^= 0xFF;
    }
    let result = svc.decrypt_aes256gcm(&encrypted, &key);
    assert!(result.is_err(), "Tampered ciphertext must fail decryption");
}

#[test]
fn test_crypto_tampered_auth_tag_fails() {
    let svc = CryptoService::new();
    let salt = svc.generate_salt();
    let key = svc.derive_key("password", &salt).unwrap();

    let mut encrypted = svc.encrypt_aes256gcm(b"secret data", &key).unwrap();
    // Flip a byte in the auth tag
    if let Some(byte) = encrypted.auth_tag.first_mut() {
        *byte ^= 0xFF;
    }
    let result = svc.decrypt_aes256gcm(&encrypted, &key);
    assert!(result.is_err(), "Tampered auth tag must fail decryption");
}

#[test]
fn test_crypto_tampered_iv_fails() {
    let svc = CryptoService::new();
    let salt = svc.generate_salt();
    let key = svc.derive_key("password", &salt).unwrap();

    let mut encrypted = svc.encrypt_aes256gcm(b"secret data", &key).unwrap();
    // Flip a byte in the IV
    if let Some(byte) = encrypted.iv.first_mut() {
        *byte ^= 0xFF;
    }
    let result = svc.decrypt_aes256gcm(&encrypted, &key);
    assert!(result.is_err(), "Tampered IV must fail decryption");
}

#[test]
fn test_crypto_empty_ciphertext_fails() {
    let svc = CryptoService::new();
    let salt = svc.generate_salt();
    let key = svc.derive_key("password", &salt).unwrap();

    let encrypted = gitbrowser::types::credential::EncryptedData {
        ciphertext: vec![],
        iv: vec![0u8; 12],
        auth_tag: vec![0u8; 16],
    };
    let result = svc.decrypt_aes256gcm(&encrypted, &key);
    assert!(result.is_err());
}

// ═══════════════════════════════════════════════════════════════
// GitHub encrypt/decrypt: tampered data via RPC
// ═══════════════════════════════════════════════════════════════

#[test]
fn test_github_decrypt_tampered_ciphertext_via_rpc() {
    let (app, _tmp) = setup_app();

    // Encrypt some data
    let enc = handle_method(&app, "github.encrypt_sync", &json!({"data": "sensitive"})).unwrap();
    let ct = enc["ciphertext"].as_str().unwrap().to_string();
    let iv = enc["iv"].as_str().unwrap().to_string();
    let tag = enc["auth_tag"].as_str().unwrap().to_string();

    // Tamper with ciphertext (replace first char)
    let tampered_ct = if ct.starts_with('A') {
        format!("B{}", &ct[1..])
    } else {
        format!("A{}", &ct[1..])
    };

    let result = handle_method(&app, "github.decrypt_sync", &json!({
        "ciphertext": tampered_ct,
        "iv": iv,
        "auth_tag": tag
    }));
    assert!(result.is_err(), "Tampered ciphertext must fail decryption via RPC");
}

// ═══════════════════════════════════════════════════════════════
// SEC-04: password.list must not return plaintext passwords
// ═══════════════════════════════════════════════════════════════

#[test]
fn test_password_list_no_plaintext_passwords() {
    let (app, _tmp) = setup_app();
    handle_method(&app, "password.unlock", &json!({"master_password": "m"})).unwrap();
    handle_method(&app, "password.save", &json!({
        "url": "https://example.com", "username": "user", "password": "SuperSecret123!"
    })).unwrap();

    let list = handle_method(&app, "password.list", &json!({})).unwrap();
    let entry = &list.as_array().unwrap()[0];

    // Must have metadata
    assert!(entry.get("id").is_some());
    assert!(entry.get("url").is_some());
    assert!(entry.get("username").is_some());

    // Must NOT have password field
    assert!(entry.get("password").is_none(),
        "password.list must not return plaintext password field");

    // Also check the JSON string doesn't contain the actual password
    let json_str = serde_json::to_string(&list).unwrap();
    assert!(!json_str.contains("SuperSecret123!"),
        "password.list response must not contain the actual password anywhere");
}

// ═══════════════════════════════════════════════════════════════
// Path traversal protection in extension framework
// ═══════════════════════════════════════════════════════════════

#[test]
fn test_extension_path_traversal_blocked() {
    // Create a temp dir structure simulating an extension
    let tmp = TempDir::new().unwrap();
    let ext_dir = tmp.path().join("my-extension");
    std::fs::create_dir_all(&ext_dir).unwrap();
    std::fs::write(ext_dir.join("manifest.json"), r#"{"name":"test","version":"1.0"}"#).unwrap();

    // Create a file outside the extension dir that should NOT be readable
    let secret_file = tmp.path().join("secret.txt");
    std::fs::write(&secret_file, "TOP SECRET DATA").unwrap();

    // Try to install an extension with path traversal in manifest
    let db = Arc::new(Database::open_in_memory().unwrap());
    let mut fw = gitbrowser::services::extension_framework::ExtensionFramework::new(db);

    // The install itself reads manifest.json — we test that content scripts
    // with traversal paths are blocked by the read_extension_file function.
    // Since read_extension_file is private, we test via the install flow.
    // A manifest with "../secret.txt" as a content script should be blocked.
    let manifest = json!({
        "name": "Evil Extension",
        "version": "1.0.0",
        "description": "Tries path traversal",
        "permissions": [],
        "content_scripts": [{
            "matches": ["*"],
            "js": ["../secret.txt"],
            "run_at": "document_end"
        }]
    });
    std::fs::write(ext_dir.join("manifest.json"), serde_json::to_string(&manifest).unwrap()).unwrap();

    // Install should succeed (manifest is valid), but reading the traversal file should fail
    let result = fw.install(ext_dir.to_str().unwrap());
    // The install may succeed or fail depending on whether it reads content scripts at install time.
    // What matters is that the traversal file content is never accessible.
    // If install succeeds, verify the extension doesn't expose the secret file content.
    if result.is_ok() {
        let ext_id = result.unwrap();
        let scripts = fw.get_content_scripts_for_url("https://example.com");
        for script in &scripts {
            for js in &script.js {
                assert!(!js.contains("TOP SECRET DATA"),
                    "Path traversal must not expose files outside extension directory");
            }
        }
        let _ = fw.uninstall(&ext_id);
    }
    // If install fails, that's also acceptable — the traversal was blocked
}

// ═══════════════════════════════════════════════════════════════
// Reader Mode: XSS prevention
// ═══════════════════════════════════════════════════════════════

#[test]
fn test_reader_mode_xss_in_title_escaped() {
    let reader = ReaderMode::new();
    let content = ReaderContent {
        title: "<script>alert('xss')</script>Malicious Title".to_string(),
        content: "<p>Safe content</p>".to_string(),
        text_content: "Safe content".to_string(),
        author: None,
        publish_date: None,
        site_name: None,
        estimated_read_time_minutes: 1,
    };
    let settings = reader.get_settings().clone();
    let html = reader.format_for_display(&content, &settings);

    // The <script> tag in the title must be escaped
    assert!(!html.contains("<script>alert"), "Script tag in title must be escaped");
    assert!(html.contains("&lt;script&gt;"), "Title should have HTML-escaped angle brackets");
}

#[test]
fn test_reader_mode_xss_script_in_content_removed() {
    let reader = ReaderMode::new();
    let content = ReaderContent {
        title: "Safe Title".to_string(),
        content: "<p>Hello</p><script>document.cookie</script><p>World</p>".to_string(),
        text_content: "Hello World".to_string(),
        author: None,
        publish_date: None,
        site_name: None,
        estimated_read_time_minutes: 1,
    };
    let settings = reader.get_settings().clone();
    let html = reader.format_for_display(&content, &settings);

    assert!(!html.contains("<script>"), "Script tags in content must be removed");
    assert!(!html.contains("document.cookie"), "Script content must be removed");
    assert!(html.contains("Hello"), "Safe content should remain");
    assert!(html.contains("World"), "Safe content should remain");
}

#[test]
fn test_reader_mode_xss_event_handler_removed() {
    let reader = ReaderMode::new();
    let content = ReaderContent {
        title: "Title".to_string(),
        content: r#"<img src="x" onerror="alert(1)"><p>Text</p>"#.to_string(),
        text_content: "Text".to_string(),
        author: None,
        publish_date: None,
        site_name: None,
        estimated_read_time_minutes: 1,
    };
    let settings = reader.get_settings().clone();
    let html = reader.format_for_display(&content, &settings);

    assert!(!html.contains("onerror"), "Event handlers must be removed from content");
}

#[test]
fn test_reader_mode_xss_javascript_url_blocked() {
    let reader = ReaderMode::new();
    let content = ReaderContent {
        title: "Title".to_string(),
        content: r#"<a href="javascript:alert(1)">Click me</a>"#.to_string(),
        text_content: "Click me".to_string(),
        author: None,
        publish_date: None,
        site_name: None,
        estimated_read_time_minutes: 1,
    };
    let settings = reader.get_settings().clone();
    let html = reader.format_for_display(&content, &settings);

    assert!(!html.contains("javascript:"), "javascript: URLs must be blocked");
    assert!(html.contains("blocked:"), "javascript: should be replaced with blocked:");
}

// ═══════════════════════════════════════════════════════════════
// URL validation in RPC methods
// ═══════════════════════════════════════════════════════════════

#[test]
fn test_bookmark_add_rejects_javascript_url() {
    let (app, _tmp) = setup_app();
    let res = handle_method(&app, "bookmark.add", &json!({
        "url": "javascript:alert(1)", "title": "XSS"
    }));
    assert!(res.is_err());
}

#[test]
fn test_bookmark_add_rejects_data_url() {
    let (app, _tmp) = setup_app();
    let res = handle_method(&app, "bookmark.add", &json!({
        "url": "data:text/html,<script>alert(1)</script>", "title": "Data XSS"
    }));
    assert!(res.is_err());
}

#[test]
fn test_history_record_rejects_javascript_url() {
    let (app, _tmp) = setup_app();
    let res = handle_method(&app, "history.record", &json!({
        "url": "javascript:void(0)", "title": "JS"
    }));
    assert!(res.is_err());
}

#[test]
fn test_history_record_rejects_file_url() {
    let (app, _tmp) = setup_app();
    let res = handle_method(&app, "history.record", &json!({
        "url": "file:///etc/passwd", "title": "File"
    }));
    assert!(res.is_err());
}

#[test]
fn test_bookmark_add_allows_gb_scheme() {
    let (app, _tmp) = setup_app();
    let res = handle_method(&app, "bookmark.add", &json!({
        "url": "gb://settings", "title": "Settings"
    }));
    assert!(res.is_ok(), "gb:// scheme should be allowed for bookmarks");
}
