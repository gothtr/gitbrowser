//! RPC method handler for GitBrowser JSON-RPC protocol.
//!
//! Extracted from `rpc_server.rs` so it can be unit-tested independently.
//! The `handle_method` function dispatches JSON-RPC method calls to the
//! appropriate managers and services via the `App` struct.

use std::sync::Mutex;

use crate::app::App;
use crate::managers::bookmark_manager::{BookmarkManager, BookmarkManagerTrait};
use crate::managers::history_manager::{HistoryManager, HistoryManagerTrait};
use crate::services::password_manager::PasswordManagerTrait;
use crate::services::settings_engine::SettingsEngineTrait;
use crate::services::localization_engine::LocalizationEngineTrait;
use crate::services::github_integration::GitHubIntegrationTrait;
use crate::services::extension_framework::ExtensionFrameworkTrait;
use crate::services::ai_assistant::AIAssistantTrait;

use serde_json::{json, Value};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

/// Encode bytes to base64 string.
pub fn base64_encode(data: &[u8]) -> String {
    BASE64.encode(data)
}

/// Decode base64 string to bytes.
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    BASE64.decode(input).map_err(|e| format!("base64 decode error: {}", e))
}

/// Dispatch a JSON-RPC method call to the appropriate handler.
///
/// Returns `Ok(Value)` on success or `Err(String)` with an error message.
pub fn handle_method(app: &Mutex<App>, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        // ─── Bookmarks ───
        "bookmark.add" => {
            let url = params.get("url").and_then(|v| v.as_str()).ok_or("missing url")?;
            let title = params.get("title").and_then(|v| v.as_str()).ok_or("missing title")?;
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
            a.settings_engine.set_value(key, value).map_err(|e| e.to_string())?;
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
            let opts = crate::types::credential::PasswordGenOptions {
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
            let encrypted = crate::types::credential::EncryptedData {
                ciphertext: base64_decode(ciphertext).map_err(|e| e.to_string())?,
                iv: base64_decode(iv).map_err(|e| e.to_string())?,
                auth_tag: base64_decode(auth_tag).map_err(|e| e.to_string())?,
            };
            let a = app.lock().map_err(|e| e.to_string())?;
            let decrypted = a.github_integration.decrypt_from_sync(&encrypted).map_err(|e| e.to_string())?;
            let text = String::from_utf8(decrypted).map_err(|e| e.to_string())?;
            Ok(json!({"data": text}))
        }

        // ─── Secure secret storage ───
        "secret.store" => {
            let key = params.get("key").and_then(|v| v.as_str()).ok_or("missing key")?;
            let value = params.get("value").and_then(|v| v.as_str()).ok_or("missing value")?;
            let a = app.lock().map_err(|e| e.to_string())?;
            let encrypted = if let Some(master_key) = a.password_manager.get_derived_key() {
                let crypto = crate::services::crypto_service::CryptoService::new();
                use crate::services::crypto_service::CryptoServiceTrait;
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
                |row| Ok((crate::types::credential::EncryptedData {
                    ciphertext: row.get(0)?,
                    iv: row.get(1)?,
                    auth_tag: row.get(2)?,
                }, row.get::<_, i32>(3)?)),
            );
            match result {
                Ok((encrypted, uses_master)) => {
                    let decrypted = if uses_master != 0 {
                        if let Some(master_key) = a.password_manager.get_derived_key() {
                            let crypto = crate::services::crypto_service::CryptoService::new();
                            use crate::services::crypto_service::CryptoServiceTrait;
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
