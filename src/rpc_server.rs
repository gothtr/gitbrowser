//! GitBrowser RPC Server — JSON-RPC over stdin/stdout for Electron integration.
//!
//! Protocol: one JSON object per line (newline-delimited JSON).
//! Request:  {"id":1, "method":"bookmark.add", "params":{"url":"...","title":"..."}}
//! Response: {"id":1, "result":{...}} or {"id":1, "error":"..."}

use std::cell::RefCell;
use std::io::{self, BufRead, Write};

use gitbrowser::app::App;
use gitbrowser::managers::bookmark_manager::{BookmarkManager, BookmarkManagerTrait};
use gitbrowser::managers::history_manager::{HistoryManager, HistoryManagerTrait};
use gitbrowser::services::settings_engine::SettingsEngineTrait;
use gitbrowser::services::localization_engine::LocalizationEngineTrait;

use serde_json::{json, Value};

fn main() {
    let app = RefCell::new(App::new("gitbrowser.db").expect("Failed to initialize GitBrowser"));

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

fn handle_method(app: &RefCell<App>, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        // ─── Bookmarks ───
        "bookmark.add" => {
            let url = params.get("url").and_then(|v| v.as_str()).ok_or("missing url")?;
            let title = params.get("title").and_then(|v| v.as_str()).ok_or("missing title")?;
            let folder = params.get("folder_id").and_then(|v| v.as_str());
            let a = app.borrow();
            let conn = a.db.connection();
            let mut mgr = BookmarkManager::new(conn);
            let bm_id = mgr.add_bookmark(url, title, folder).map_err(|e| e.to_string())?;
            Ok(json!({"id": bm_id, "url": url, "title": title}))
        }
        "bookmark.list" => {
            let folder = params.get("folder_id").and_then(|v| v.as_str());
            let a = app.borrow();
            let conn = a.db.connection();
            let mgr = BookmarkManager::new(conn);
            let bms = mgr.list_bookmarks(folder).map_err(|e| e.to_string())?;
            let arr: Vec<Value> = bms.iter().map(|b| json!({"id":b.id,"url":b.url,"title":b.title,"folder_id":b.folder_id})).collect();
            Ok(json!(arr))
        }
        "bookmark.search" => {
            let query = params.get("query").and_then(|v| v.as_str()).ok_or("missing query")?;
            let a = app.borrow();
            let conn = a.db.connection();
            let mgr = BookmarkManager::new(conn);
            let bms = mgr.search_bookmarks(query).map_err(|e| e.to_string())?;
            let arr: Vec<Value> = bms.iter().map(|b| json!({"id":b.id,"url":b.url,"title":b.title})).collect();
            Ok(json!(arr))
        }
        "bookmark.delete" => {
            let id = params.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let a = app.borrow();
            let conn = a.db.connection();
            let mut mgr = BookmarkManager::new(conn);
            mgr.remove_bookmark(id).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }

        // ─── History ───
        "history.record" => {
            let url = params.get("url").and_then(|v| v.as_str()).ok_or("missing url")?;
            let title = params.get("title").and_then(|v| v.as_str()).ok_or("missing title")?;
            let a = app.borrow();
            let conn = a.db.connection();
            let mut mgr = HistoryManager::new(conn);
            mgr.record_visit(url, title).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "history.search" => {
            let query = params.get("query").and_then(|v| v.as_str()).ok_or("missing query")?;
            let a = app.borrow();
            let conn = a.db.connection();
            let mgr = HistoryManager::new(conn);
            let entries = mgr.search_history(query).map_err(|e| e.to_string())?;
            let arr: Vec<Value> = entries.iter().map(|h| json!({"id":h.id,"url":h.url,"title":h.title,"visit_count":h.visit_count,"visit_time":h.visit_time})).collect();
            Ok(json!(arr))
        }
        "history.recent" => {
            let a = app.borrow();
            let conn = a.db.connection();
            let mgr = HistoryManager::new(conn);
            let entries = mgr.list_history(None).map_err(|e| e.to_string())?;
            let arr: Vec<Value> = entries.iter().map(|h| json!({"id":h.id,"url":h.url,"title":h.title,"visit_count":h.visit_count,"visit_time":h.visit_time})).collect();
            Ok(json!(arr))
        }
        "history.delete" => {
            let id = params.get("id").and_then(|v| v.as_str()).ok_or("missing id")?;
            let a = app.borrow();
            let conn = a.db.connection();
            let mut mgr = HistoryManager::new(conn);
            mgr.delete_entry(id).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "history.clear" => {
            let a = app.borrow();
            let conn = a.db.connection();
            let mut mgr = HistoryManager::new(conn);
            mgr.clear_all().map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }

        // ─── Settings ───
        "settings.get" => {
            let a = app.borrow();
            let settings = a.settings_engine.get_settings();
            let json_val = serde_json::to_value(settings).map_err(|e| e.to_string())?;
            Ok(json_val)
        }
        "settings.set" => {
            let key = params.get("key").and_then(|v| v.as_str()).ok_or("missing key")?;
            let value = params.get("value").cloned().ok_or("missing value")?;
            let mut a = app.borrow_mut();
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
            let a = app.borrow();
            let text = a.localization_engine.t(key, None);
            Ok(json!({"text": text}))
        }
        "i18n.locale" => {
            let a = app.borrow();
            let locale = a.localization_engine.get_locale();
            Ok(json!({"locale": locale}))
        }

        // ─── Session ───
        "session.save" => {
            let tabs_val = params.get("tabs").ok_or("missing tabs")?;
            // Save session data to a file for simplicity
            let session_path = "session.json";
            let data = serde_json::to_string(tabs_val).map_err(|e| e.to_string())?;
            std::fs::write(session_path, data).map_err(|e| e.to_string())?;
            Ok(json!({"ok": true}))
        }
        "session.restore" => {
            let session_path = "session.json";
            match std::fs::read_to_string(session_path) {
                Ok(data) => {
                    let tabs: Value = serde_json::from_str(&data).unwrap_or(json!([]));
                    Ok(tabs)
                }
                Err(_) => Ok(json!([]))
            }
        }

        // ─── Ping ───
        "ping" => Ok(json!({"pong": true})),

        _ => Err(format!("unknown method: {}", method)),
    }
}
