//! GitBrowser RPC Server — JSON-RPC over stdin/stdout for Electron integration.
//!
//! Protocol: one JSON object per line (newline-delimited JSON).
//! Request:  {"id":1, "method":"bookmark.add", "params":{"url":"...","title":"..."}}
//! Response: {"id":1, "result":{...}} or {"id":1, "error":"..."}

use std::sync::Mutex;
use std::io::{self, BufRead, Write};

use gitbrowser::app::App;
use gitbrowser::managers::bookmark_manager::{BookmarkManager, BookmarkManagerTrait};
use gitbrowser::managers::history_manager::{HistoryManager, HistoryManagerTrait};
use gitbrowser::services::password_manager::PasswordManagerTrait;
use gitbrowser::services::settings_engine::SettingsEngineTrait;
use gitbrowser::services::localization_engine::LocalizationEngineTrait;
use gitbrowser::services::github_integration::GitHubIntegrationTrait;
use gitbrowser::services::extension_framework::ExtensionFrameworkTrait;
use gitbrowser::services::ai_assistant::AIAssistantTrait;

use serde_json::{json, Value};

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 { result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char); } else { result.push('='); }
        if chunk.len() > 2 { result.push(CHARS[(triple & 0x3F) as usize] as char); } else { result.push('='); }
    }
    result
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let input = input.trim_end_matches('=');
    let mut buf = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in input.chars() {
        let val = match c {
            'A'..='Z' => (c as u32) - ('A' as u32),
            'a'..='z' => (c as u32) - ('a' as u32) + 26,
            '0'..='9' => (c as u32) - ('0' as u32) + 52,
            '+' => 62, '/' => 63,
            _ => return Err(format!("invalid base64 char: {}", c)),
        };
        acc = (acc << 6) | val;
        bits += 6;
        if bits >= 8 { bits -= 8; buf.push((acc >> bits) as u8); acc &= (1 << bits) - 1; }
    }
    Ok(buf)
}

fn main() {
    let app = Mutex::new(App::new("gitbrowser.db").expect("Failed to initialize GitBrowser"));

    // Signal ready
    let ready = json!({"event":"ready","version":env!("CARGO_PKG_VERSION")});
    println!("{}", ready);
    io::stdout().flush().unwrap();

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() { continue; }

        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let err = json!({"id":null,"error":format!("parse error: {}",e)});
                println!("{}", err);
                io::stdout().flush().unwrap();
                continue;
            }
        };

        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or(json!({}));

        let result = handle_method(&app, method, &params);

        let response = match result {
            Ok(val) => json!({"id": id, "result": val}),
            Err(err) => json!({"id": id, "error": err}),
        };
        println!("{}", response);
        io::stdout().flush().unwrap();
    }
}

fn handle_method(app: &Mutex<App>, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        // ─── Bookmarks ───
        "bookmark.add" => {
            let url = params.get("url").and_then(|v| v.as_str()).ok_or("missing url")?;
            let title = params.get("title").and_then(|v| v.as_str()).ok_or("missing title")?;
            // Validate URL format
            if !url.starts_with("http://") && !url.starts_with("https://") && !url.starts_with("gb://") {
                return Err("invalid url: must start with http://, https://, or gb://".to_string());
            }
            let folder = params.get("folder_id").and_then(|v| v.as_str());
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let mut mgr = BookmarkManager::new(conn);
            let bm_id = mgr.add_bookmark(url, title, folder).map_err(|e| e.to_string())?;
            Ok(json!({"id": bm_id, "url": url, "title": title}))
        }
        "bookmark.list" => {
            let folder = params.get("folder_id").and_then(|v| v.as_str());
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let mgr = BookmarkManager::new(conn);
            let bms = mgr.list_bookmarks(folder).map_err(|e| e.to_string())?;
            let arr: Vec<Value> = bms.iter().map(|b| json!({"id":b.id,"url":b.url,"title":b.title,"folder_id":b.folder_id})).collect();
            Ok(json!(arr))
        }
        "bookmark.search" => {
            let query = params.get("query").and_then(|v| v.as_str()).ok_or("missing query")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let mgr = BookmarkManager::new(conn);
            let bms = mgr.search_bookmarks(query).map_err(|e| e.to_string())?;
            let arr: Vec<Value> = bms.iter().map(|b| json!({"id":b.id,"url":b.url,"title":b.title})).collect();
            Ok(json!(arr))
        }
        "bookmark.delete" => {
            let id = params.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let mut mgr = BookmarkManager::new(conn);
            mgr.remove_bookmark(id).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }

        // ─── History ───
        "history.record" => {
            let url = params.get("url").and_then(|v| v.as_str()).ok_or("missing url")?;
            let title = params.get("title").and_then(|v| v.as_str()).ok_or("missing title")?;
            // Validate URL format
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err("invalid url: must start with http:// or https://".to_string());
            }
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let mut mgr = HistoryManager::new(conn);
            mgr.record_visit(url, title).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "history.search" => {
            let query = params.get("query").and_then(|v| v.as_str()).ok_or("missing query")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let mgr = HistoryManager::new(conn);
            let entries = mgr.search_history(query).map_err(|e| e.to_string())?;
            let arr: Vec<Value> = entries.iter().map(|h| json!({"id":h.id,"url":h.url,"title":h.title,"visit_count":h.visit_count,"visit_time":h.visit_time * 1000})).collect();
            Ok(json!(arr))
        }
        "history.recent" => {
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let mgr = HistoryManager::new(conn);
            let entries = mgr.list_history(None).map_err(|e| e.to_string())?;
            let arr: Vec<Value> = entries.iter().map(|h| json!({"id":h.id,"url":h.url,"title":h.title,"visit_count":h.visit_count,"visit_time":h.visit_time * 1000})).collect();
            Ok(json!(arr))
        }
        "history.delete" => {
            let id = params.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let mut mgr = HistoryManager::new(conn);
            mgr.delete_entry(id).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "history.clear" => {
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let mut mgr = HistoryManager::new(conn);
            mgr.clear_all().map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }

        // ─── Settings ───
        "settings.get" => {
            let a = app.lock().map_err(|e| e.to_string())?;
            let settings = a.settings_engine.get_settings();
            let json_val = serde_json::to_value(settings).map_err(|e| e.to_string())?;
            Ok(json_val)
        }
        "settings.set" => {
            let key = params.get("key").and_then(|v| v.as_str()).ok_or("missing key")?;
            let value = params.get("value").cloned().ok_or("missing value")?;
            let mut a = app.lock().map_err(|e| e.to_string())?;
            // Use the set_value method which handles key-path updates
            a.settings_engine.set_value(key, value).map_err(|e| e.to_string())?;
            // Also handle language change in localization engine
            if key == "general.language" || key == "language" {
                if let Some(lang) = params.get("value").and_then(|v| v.as_str()) {
                    let _ = a.localization_engine.set_locale(lang);
                }
            }
            let _ = a.settings_engine.save();
            Ok(json!({"ok": true}))
        }

        // ─── Localization ───
        "i18n.t" => {
            let key = params.get("key").and_then(|v| v.as_str()).ok_or("missing key")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let text = a.localization_engine.t(key, None);
            Ok(json!({"text": text}))
        }
        "i18n.locale" => {
            let a = app.lock().map_err(|e| e.to_string())?;
            let locale = a.localization_engine.get_locale();
            Ok(json!({"locale": locale}))
        }

        // ─── Session ───
        "session.save" => {
            let tabs_val = params.get("tabs").ok_or("missing tabs")?;
            // BUG-01: Use absolute path via user data directory instead of relative CWD
            let session_path = if let Ok(dir) = std::env::var("GITBROWSER_DATA_DIR") {
                std::path::PathBuf::from(dir).join("session.json")
            } else {
                std::path::PathBuf::from("session.json")
            };
            let data = serde_json::to_string(tabs_val).map_err(|e| e.to_string())?;
            std::fs::write(&session_path, data).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "session.restore" => {
            let session_path = if let Ok(dir) = std::env::var("GITBROWSER_DATA_DIR") {
                std::path::PathBuf::from(dir).join("session.json")
            } else {
                std::path::PathBuf::from("session.json")
            };
            match std::fs::read_to_string(&session_path) {
                Ok(data) => {
                    let tabs: Value = serde_json::from_str(&data).unwrap_or(json!([]));
                    Ok(tabs)
                }
                Err(_) => Ok(json!([]))
            }
        }

        // ─── Password Manager ───
        "password.unlock" => {
            let master = params.get("master_password").and_then(|v| v.as_str()).ok_or("missing master_password")?;
            let mut a = app.lock().map_err(|e| e.to_string())?;
            let ok = a.password_manager.unlock(master).map_err(|e| e.to_string())?;
            if ok {
                // Re-key GitHub and AI secrets with master password
                if let Some(master_key) = a.password_manager.get_derived_key() {
                    let _ = a.github_integration.rekey_with_master(&master_key);
                    let _ = a.ai_assistant.rekey_with_master(&master_key);
                }
            }
            Ok(json!({"ok": ok}))
        }
        "password.lock" => {
            let mut a = app.lock().map_err(|e| e.to_string())?;
            a.password_manager.lock();
            Ok(json!({"ok": true}))
        }
        "password.is_unlocked" => {
            let a = app.lock().map_err(|e| e.to_string())?;
            Ok(json!({"unlocked": a.password_manager.is_unlocked()}))
        }
        "password.list" => {
            let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let a = app.lock().map_err(|e| e.to_string())?;
            let creds = if url.is_empty() {
                a.password_manager.list_all_credentials().map_err(|e| e.to_string())?
            } else {
                a.password_manager.get_credentials(url).map_err(|e| e.to_string())?
            };
            // SEC-04: Do NOT return decrypted passwords in list — return metadata only
            let arr: Vec<Value> = creds.iter().map(|c| {
                json!({
                    "id": c.id, "url": c.url, "username": c.username,
                    "created_at": c.created_at, "updated_at": c.updated_at
                })
            }).collect();
            Ok(json!(arr))
        }
        "password.decrypt" => {
            let id = params.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let creds = a.password_manager.list_all_credentials().map_err(|e| e.to_string())?;
            let entry = creds.iter().find(|c| c.id == id).ok_or("credential not found")?;
            let pw = a.password_manager.decrypt_password(entry).map_err(|e| e.to_string())?;
            Ok(json!({"password": pw}))
        }
        "password.save" => {
            let url = params.get("url").and_then(|v| v.as_str()).ok_or("missing url")?;
            let username = params.get("username").and_then(|v| v.as_str()).ok_or("missing username")?;
            let password = params.get("password").and_then(|v| v.as_str()).ok_or("missing password")?;
            let mut a = app.lock().map_err(|e| e.to_string())?;
            let id = a.password_manager.save_credential(url, username, password).map_err(|e| e.to_string())?;
            Ok(json!({"id": id}))
        }
        "password.update" => {
            let id = params.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let username = params.get("username").and_then(|v| v.as_str());
            let password = params.get("password").and_then(|v| v.as_str());
            let mut a = app.lock().map_err(|e| e.to_string())?;
            a.password_manager.update_credential(id, username, password).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "password.delete" => {
            let id = params.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let mut a = app.lock().map_err(|e| e.to_string())?;
            a.password_manager.delete_credential(id).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "password.generate" => {
            let length = params.get("length").and_then(|v| v.as_u64()).unwrap_or(16) as usize;
            let uppercase = params.get("uppercase").and_then(|v| v.as_bool()).unwrap_or(true);
            let lowercase = params.get("lowercase").and_then(|v| v.as_bool()).unwrap_or(true);
            let numbers = params.get("numbers").and_then(|v| v.as_bool()).unwrap_or(true);
            let symbols = params.get("symbols").and_then(|v| v.as_bool()).unwrap_or(true);
            let a = app.lock().map_err(|e| e.to_string())?;
            let opts = gitbrowser::types::credential::PasswordGenOptions {
                length, uppercase, lowercase, numbers, symbols,
            };
            let pw = a.password_manager.generate_password(&opts);
            Ok(json!({"password": pw}))
        }

        // ─── Ping ───
        "ping" => Ok(json!({"pong": true})),

        // ─── Extensions ───
        "extension.list" => {
            let a = app.lock().map_err(|e| e.to_string())?;
            let exts = a.extension_framework.list_extensions();
            let arr: Vec<Value> = exts.iter().map(|e| json!({
                "id": e.id, "name": e.name, "version": e.version, "enabled": e.enabled,
                "permissions": e.permissions, "performance_impact_ms": e.performance_impact_ms,
                "install_path": e.install_path,
                "content_scripts": e.content_scripts
            })).collect();
            Ok(json!(arr))
        }
        "extension.install" => {
            let path = params.get("path").and_then(|v| v.as_str()).ok_or("missing path")?;
            let mut a = app.lock().map_err(|e| e.to_string())?;
            let id = a.extension_framework.install(path).map_err(|e| e.to_string())?;
            Ok(json!({"id": id}))
        }
        "extension.uninstall" => {
            let id = params.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let mut a = app.lock().map_err(|e| e.to_string())?;
            a.extension_framework.uninstall(id).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "extension.enable" => {
            let id = params.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let mut a = app.lock().map_err(|e| e.to_string())?;
            a.extension_framework.enable(id).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "extension.disable" => {
            let id = params.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let mut a = app.lock().map_err(|e| e.to_string())?;
            a.extension_framework.disable(id).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "extension.content_scripts" => {
            let url = params.get("url").and_then(|v| v.as_str()).ok_or("missing url")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let scripts = a.extension_framework.get_content_scripts_for_url(url);
            let arr: Vec<Value> = scripts.iter().map(|s| json!({
                "extension_id": s.extension_id,
                "extension_name": s.extension_name,
                "js": s.js,
                "css": s.css,
                "run_at": s.run_at
            })).collect();
            Ok(json!(arr))
        }

        // ─── GitHub (secure token storage) ───
        "github.store_token" => {
            let token = params.get("token").and_then(|v| v.as_str()).ok_or("missing token")?;
            let login = params.get("login").and_then(|v| v.as_str()).ok_or("missing login")?;
            let avatar_url = params.get("avatar_url").and_then(|v| v.as_str());
            let a = app.lock().map_err(|e| e.to_string())?;
            a.github_integration.store_token(token, login, avatar_url).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "github.get_token" => {
            let a = app.lock().map_err(|e| e.to_string())?;
            let token = a.github_integration.get_token().map_err(|e| e.to_string())?;
            Ok(json!({"token": token}))
        }
        "github.logout" => {
            let mut a = app.lock().map_err(|e| e.to_string())?;
            a.github_integration.logout().map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "github.encrypt_sync" => {
            let data = params.get("data").and_then(|v| v.as_str()).ok_or("missing data")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let encrypted = a.github_integration.encrypt_for_sync(data.as_bytes()).map_err(|e| e.to_string())?;
            Ok(json!({
                "ciphertext": base64_encode(&encrypted.ciphertext),
                "iv": base64_encode(&encrypted.iv),
                "auth_tag": base64_encode(&encrypted.auth_tag)
            }))
        }
        "github.decrypt_sync" => {
            let ciphertext = params.get("ciphertext").and_then(|v| v.as_str()).ok_or("missing ciphertext")?;
            let iv = params.get("iv").and_then(|v| v.as_str()).ok_or("missing iv")?;
            let auth_tag = params.get("auth_tag").and_then(|v| v.as_str()).ok_or("missing auth_tag")?;
            let encrypted = gitbrowser::types::credential::EncryptedData {
                ciphertext: base64_decode(ciphertext).map_err(|e| e.to_string())?,
                iv: base64_decode(iv).map_err(|e| e.to_string())?,
                auth_tag: base64_decode(auth_tag).map_err(|e| e.to_string())?,
            };
            let a = app.lock().map_err(|e| e.to_string())?;
            let decrypted = a.github_integration.decrypt_from_sync(&encrypted).map_err(|e| e.to_string())?;
            let text = String::from_utf8(decrypted).map_err(|e| e.to_string())?;
            Ok(json!({"data": text}))
        }

        // ─── Secure secret storage (uses master password when unlocked, fallback otherwise) ───
        "secret.store" => {
            let key = params.get("key").and_then(|v| v.as_str()).ok_or("missing key")?;
            let value = params.get("value").and_then(|v| v.as_str()).ok_or("missing value")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            // Prefer master password derived key; fall back to GitHub integration key
            let encrypted = if let Some(master_key) = a.password_manager.get_derived_key() {
                let crypto = gitbrowser::services::crypto_service::CryptoService::new();
                use gitbrowser::services::crypto_service::CryptoServiceTrait;
                crypto.encrypt_aes256gcm(value.as_bytes(), &master_key).map_err(|e| e.to_string())?
            } else {
                a.github_integration.encrypt_for_sync(value.as_bytes()).map_err(|e| e.to_string())?
            };
            let conn = a.db.connection();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS secure_store (key TEXT PRIMARY KEY, ciphertext BLOB, iv BLOB, auth_tag BLOB, updated_at INTEGER, uses_master INTEGER DEFAULT 0)",
                [],
            ).map_err(|e| e.to_string())?;
            let uses_master = if a.password_manager.get_derived_key().is_some() { 1i32 } else { 0i32 };
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
            conn.execute(
                "INSERT OR REPLACE INTO secure_store (key, ciphertext, iv, auth_tag, updated_at, uses_master) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![key, encrypted.ciphertext, encrypted.iv, encrypted.auth_tag, now, uses_master],
            ).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "secret.get" => {
            let key = params.get("key").and_then(|v| v.as_str()).ok_or("missing key")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let _ = conn.execute(
                "CREATE TABLE IF NOT EXISTS secure_store (key TEXT PRIMARY KEY, ciphertext BLOB, iv BLOB, auth_tag BLOB, updated_at INTEGER, uses_master INTEGER DEFAULT 0)",
                [],
            );
            let result = conn.query_row(
                "SELECT ciphertext, iv, auth_tag, COALESCE(uses_master, 0) FROM secure_store WHERE key = ?1",
                rusqlite::params![key],
                |row| Ok((gitbrowser::types::credential::EncryptedData {
                    ciphertext: row.get(0)?,
                    iv: row.get(1)?,
                    auth_tag: row.get(2)?,
                }, row.get::<_, i32>(3)?)),
            );
            match result {
                Ok((encrypted, uses_master)) => {
                    // Try master key first if available, then fallback
                    let decrypted = if uses_master != 0 {
                        if let Some(master_key) = a.password_manager.get_derived_key() {
                            let crypto = gitbrowser::services::crypto_service::CryptoService::new();
                            use gitbrowser::services::crypto_service::CryptoServiceTrait;
                            crypto.decrypt_aes256gcm(&encrypted, &master_key).map_err(|e| e.to_string())?
                        } else {
                            return Err("master password required to decrypt this secret".to_string());
                        }
                    } else {
                        a.github_integration.decrypt_from_sync(&encrypted).map_err(|e| e.to_string())?
                    };
                    let text = String::from_utf8(decrypted).map_err(|e| e.to_string())?;
                    Ok(json!({"value": text}))
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(json!({"value": null})),
                Err(e) => Err(e.to_string()),
            }
        }
        "secret.delete" => {
            let key = params.get("key").and_then(|v| v.as_str()).ok_or("missing key")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let conn = a.db.connection();
            let _ = conn.execute("DELETE FROM secure_store WHERE key = ?1", rusqlite::params![key]);
            Ok(json!({"ok": true}))
        }

        _ => Err(format!("unknown method: {}", method)),
    }
}
