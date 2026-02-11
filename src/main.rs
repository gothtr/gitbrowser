//! GitBrowser — a privacy-focused minimal web browser with GitHub-style UI.
//!
//! Entry point: initializes a GTK4 application and displays the main browser window.
//! When built without the `gui` feature, runs an interactive console demo.

#[cfg(feature = "gui")]
fn main() {
    gitbrowser::ui::webview_app::run();
}

#[cfg(not(feature = "gui"))]
fn main() {
    println!();
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║              GitBrowser v{} — Demo Mode              ║", env!("CARGO_PKG_VERSION"));
    println!("║     Privacy-focused browser with GitHub-style UI           ║");
    println!("╚══════════════════════════════════════════════════════════════╝");
    println!();

    demo_database();
    demo_crypto();
    demo_settings();
    demo_localization();
    demo_theme();
    demo_tabs();
    demo_bookmarks();
    demo_history();
    demo_session();
    demo_password_manager();
    demo_permissions();
    demo_shortcuts();
    demo_downloads();
    demo_privacy();
    demo_crash_recovery();
    demo_reader_mode();
    demo_extensions();
    demo_ai_assistant();
    demo_update_manager();
    demo_github_integration();
    demo_app_core();

    println!();
    println!("═══════════════════════════════════════════════════════════════");
    println!("  ✅ All 21 components demonstrated successfully!");
    println!("  GitBrowser is ready for GTK4 UI integration.");
    println!("═══════════════════════════════════════════════════════════════");
}

#[cfg(not(feature = "gui"))]
fn section(name: &str) {
    println!("───────────────────────────────────────────────────────────────");
    println!("  📦 {}", name);
    println!("───────────────────────────────────────────────────────────────");
}

#[cfg(not(feature = "gui"))]
fn demo_database() {
    use gitbrowser::database::connection::Database;
    section("Database Layer");

    let db = Database::open_in_memory().expect("Failed to open database");
    let tables: Vec<String> = {
        let conn = db.connection();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    };
    println!("  Created {} tables: {}", tables.len(), tables.join(", "));
    println!("  ✓ Database + migrations OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_crypto() {
    use gitbrowser::services::crypto_service::{CryptoService, CryptoServiceTrait};
    section("Crypto Service");

    let crypto = CryptoService::new();
    let salt = crypto.generate_salt();
    let key = crypto.derive_key("my-secret-password", &salt).unwrap();
    println!("  Derived 256-bit key from password (PBKDF2, 100k iterations)");

    let plaintext = b"Hello, GitBrowser! This is secret data.";
    let encrypted = crypto.encrypt_aes256gcm(plaintext, &key).unwrap();
    println!("  Encrypted {} bytes -> {} bytes ciphertext + {} bytes IV + {} bytes tag",
        plaintext.len(), encrypted.ciphertext.len(), encrypted.iv.len(), encrypted.auth_tag.len());

    let decrypted = crypto.decrypt_aes256gcm(&encrypted, &key).unwrap();
    assert_eq!(decrypted, plaintext);
    println!("  Decrypted successfully: \"{}\"", String::from_utf8_lossy(&decrypted));

    let mut sensitive = vec![0xFFu8; 32];
    crypto.zeroize_memory(&mut sensitive);
    assert!(sensitive.iter().all(|&b| b == 0));
    println!("  Zeroized 32 bytes of sensitive memory");
    println!("  ✓ CryptoService OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_settings() {
    use gitbrowser::services::settings_engine::{SettingsEngine, SettingsEngineTrait};
    section("Settings Engine");

    let mut engine = SettingsEngine::new(Some("demo_settings.json".to_string()));
    let settings = engine.load().unwrap();
    println!("  Language: {}", settings.general.language);
    println!("  Theme: {:?}", settings.appearance.theme);
    println!("  Startup: {:?}", settings.general.startup_behavior);
    println!("  Tracker blocking: {}", settings.privacy.tracker_blocking);
    println!("  Tab suspend timeout: {} min", settings.performance.tab_suspend_timeout_minutes);

    engine.set_value("general.language", serde_json::json!("en")).unwrap();
    let updated = engine.get_settings();
    println!("  Changed language to: {}", updated.general.language);

    engine.reset().unwrap();
    println!("  Reset to defaults: language = {}", engine.get_settings().general.language);
    let _ = std::fs::remove_file("demo_settings.json");
    println!("  ✓ SettingsEngine OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_localization() {
    use std::collections::HashMap;
    use gitbrowser::services::localization_engine::{LocalizationEngine, LocalizationEngineTrait};
    section("Localization Engine (RU/EN)");

    let mut engine = LocalizationEngine::new("locales");
    engine.initialize().unwrap();

    // Russian
    engine.set_locale("ru").unwrap();
    println!("  [RU] {}", engine.t("tabs.new_tab", None));
    println!("  [RU] 1: {}", engine.plural("tabs", 1, None));
    println!("  [RU] 3: {}", engine.plural("tabs", 3, None));
    println!("  [RU] 5: {}", engine.plural("tabs", 5, None));
    println!("  [RU] 21: {}", engine.plural("tabs", 21, None));

    // English
    engine.set_locale("en").unwrap();
    println!("  [EN] {}", engine.t("tabs.new_tab", None));
    println!("  [EN] 1: {}", engine.plural("tabs", 1, None));
    println!("  [EN] 5: {}", engine.plural("tabs", 5, None));

    let mut params = HashMap::new();
    params.insert("count".to_string(), "42".to_string());
    println!("  [EN] {}", engine.t("ai.tokens_used", Some(&params)));
    println!("  Available locales: {:?}", engine.get_available_locales());
    println!("  ✓ LocalizationEngine OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_theme() {
    use gitbrowser::services::theme_engine::{ThemeEngine, ThemeEngineTrait};
    use gitbrowser::types::settings::ThemeMode;
    section("Theme Engine");

    let mut engine = ThemeEngine::new(ThemeMode::Dark);
    println!("  Current theme: {:?}", engine.get_theme());
    println!("  Accent color: {}", engine.get_accent_color());

    let vars = engine.get_css_variables();
    println!("  CSS variables ({} total):", vars.len());
    for (k, v) in vars.iter().take(5) {
        println!("    {} = {}", k, v);
    }

    engine.set_theme(ThemeMode::Light);
    println!("  Switched to: {:?}", engine.get_theme());

    engine.set_accent_color("#ff6600").unwrap();
    println!("  New accent: {}", engine.get_accent_color());
    println!("  ✓ ThemeEngine OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_tabs() {
    use gitbrowser::managers::tab_manager::{TabManager, TabManagerTrait};
    section("Tab Manager");

    let mut mgr = TabManager::new();
    let t1 = mgr.create_tab(Some("https://github.com"), true);
    let t2 = mgr.create_tab(Some("https://rust-lang.org"), false);
    let t3 = mgr.create_tab(Some("https://crates.io"), false);
    println!("  Created 3 tabs, count = {}", mgr.tab_count());

    mgr.pin_tab(&t1).unwrap();
    println!("  Pinned tab: {}", mgr.get_tab(&t1).unwrap().url);

    let dup_id = mgr.duplicate_tab(&t2).unwrap();
    println!("  Duplicated tab, count = {}", mgr.tab_count());

    mgr.mute_tab(&t3).unwrap();
    println!("  Muted tab: {} (muted={})", mgr.get_tab(&t3).unwrap().url, mgr.get_tab(&t3).unwrap().muted);

    mgr.close_tab(&dup_id).unwrap();
    println!("  Closed duplicate, count = {}", mgr.tab_count());

    mgr.suspend_tab(&t2).unwrap();
    println!("  Suspended tab: {}", mgr.get_tab(&t2).unwrap().url);

    println!("  Active tab: {}", mgr.get_active_tab().unwrap().url);
    println!("  Tab order: {:?}", mgr.get_tab_order().len());
    println!("  ✓ TabManager OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_bookmarks() {
    use gitbrowser::database::connection::Database;
    use gitbrowser::managers::bookmark_manager::{BookmarkManager, BookmarkManagerTrait};
    section("Bookmark Manager");

    let db = Database::open_in_memory().unwrap();
    let conn = db.connection();
    let mut mgr = BookmarkManager::new(conn);

    let folder_id = mgr.create_folder("Dev Resources", None).unwrap();
    println!("  Created folder: Dev Resources ({})", &folder_id[..8]);

    let b1 = mgr.add_bookmark("https://github.com", "GitHub", Some(&folder_id)).unwrap();
    let b2 = mgr.add_bookmark("https://docs.rs", "Docs.rs", Some(&folder_id)).unwrap();
    let _b3 = mgr.add_bookmark("https://crates.io", "Crates.io", None).unwrap();
    println!("  Added 3 bookmarks (2 in folder, 1 root)");

    let results = mgr.search_bookmarks("git").unwrap();
    println!("  Search 'git': found {} result(s)", results.len());

    let folder_bookmarks = mgr.list_bookmarks(Some(&folder_id)).unwrap();
    println!("  Folder contents: {} bookmark(s)", folder_bookmarks.len());

    mgr.update_bookmark(&b1, Some("https://github.com/explore"), Some("GitHub Explore")).unwrap();
    println!("  Updated bookmark title and URL");

    mgr.remove_bookmark(&b2).unwrap();
    println!("  Removed 1 bookmark, remaining in folder: {}", mgr.list_bookmarks(Some(&folder_id)).unwrap().len());
    println!("  ✓ BookmarkManager OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_history() {
    use gitbrowser::database::connection::Database;
    use gitbrowser::managers::history_manager::{HistoryManager, HistoryManagerTrait};
    section("History Manager");

    let db = Database::open_in_memory().unwrap();
    let conn = db.connection();
    let mut mgr = HistoryManager::new(conn);

    mgr.record_visit("https://github.com", "GitHub").unwrap();
    mgr.record_visit("https://rust-lang.org", "Rust").unwrap();
    mgr.record_visit("https://github.com", "GitHub").unwrap(); // repeat visit
    println!("  Recorded 3 visits (2 unique URLs)");

    let results = mgr.search_history("git").unwrap();
    println!("  Search 'git': {} result(s), visit_count = {}", results.len(), results[0].visit_count);

    let all = mgr.list_history(None).unwrap();
    println!("  Total history entries: {}", all.len());

    mgr.set_recording_enabled(false);
    let private_result = mgr.record_visit("https://private.com", "Private");
    let all2 = mgr.list_history(None).unwrap();
    println!("  Private mode: recording={}, blocked={}, entries still = {}", 
        mgr.is_recording_enabled(), private_result.is_err(), all2.len());

    mgr.set_recording_enabled(true);
    mgr.clear_all().unwrap();
    println!("  Cleared all history: {} entries", mgr.list_history(None).unwrap().len());
    println!("  ✓ HistoryManager OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_session() {
    use std::sync::Arc;
    use gitbrowser::database::connection::Database;
    use gitbrowser::managers::session_manager::{SessionManager, SessionManagerTrait};
    use gitbrowser::types::session::*;
    use gitbrowser::types::tab::ScrollPosition;
    section("Session Manager (encrypted)");

    let db = Arc::new(Database::open_in_memory().unwrap());
    let mut mgr = SessionManager::new(db).unwrap();

    let session = SessionData {
        tabs: vec![
            SessionTab {
                id: "tab-1".to_string(),
                url: "https://github.com".to_string(),
                title: "GitHub".to_string(),
                pinned: true,
                scroll_position: ScrollPosition { x: 0.0, y: 150.0 },
            },
            SessionTab {
                id: "tab-2".to_string(),
                url: "https://rust-lang.org".to_string(),
                title: "Rust".to_string(),
                pinned: false,
                scroll_position: ScrollPosition::default(),
            },
        ],
        active_tab_id: Some("tab-1".to_string()),
        window_bounds: WindowBounds { x: 100, y: 100, width: 1280, height: 800 },
        timestamp: 1700000000,
    };

    mgr.save_session(&session).unwrap();
    println!("  Saved session: {} tabs, encrypted with AES-256-GCM", session.tabs.len());

    let restored = mgr.restore_session().unwrap().unwrap();
    assert_eq!(restored.tabs.len(), session.tabs.len());
    assert_eq!(restored.active_tab_id, session.active_tab_id);
    println!("  Restored session: {} tabs, active = {:?}", restored.tabs.len(), restored.active_tab_id);
    println!("  Window: {}x{} at ({},{})", restored.window_bounds.width, restored.window_bounds.height,
        restored.window_bounds.x, restored.window_bounds.y);

    mgr.start_periodic_save(30);
    println!("  Periodic save: running={}, interval={}s", mgr.is_periodic_save_running(), mgr.periodic_save_interval().unwrap());

    mgr.clear_session().unwrap();
    assert!(!mgr.has_session());
    println!("  Cleared session: has_session = {}", mgr.has_session());
    println!("  ✓ SessionManager OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_password_manager() {
    use std::sync::Arc;
    use gitbrowser::database::connection::Database;
    use gitbrowser::services::password_manager::{PasswordManager, PasswordManagerTrait};
    use gitbrowser::types::credential::PasswordGenOptions;
    section("Password Manager (encrypted)");

    let db = Arc::new(Database::open_in_memory().unwrap());
    let mut mgr = PasswordManager::new(db);

    let unlocked = mgr.unlock("master-password-123").unwrap();
    println!("  Unlock with master password: {}", if unlocked { "SUCCESS" } else { "FAILED" });

    let id = mgr.save_credential("https://github.com", "user@example.com", "s3cret!Pass").unwrap();
    println!("  Saved credential for github.com ({})", &id[..8]);

    let creds = mgr.get_credentials("https://github.com").unwrap();
    println!("  Retrieved {} credential(s) for github.com", creds.len());
    println!("  Username: {}", creds[0].username);

    let password = mgr.generate_password(&PasswordGenOptions {
        length: 20,
        uppercase: true,
        lowercase: true,
        numbers: true,
        symbols: true,
    });
    println!("  Generated password (20 chars): {}", password);

    mgr.lock();
    println!("  Locked: is_unlocked = {}", mgr.is_unlocked());

    let fail = mgr.save_credential("https://test.com", "user", "pass");
    println!("  Save while locked: {}", if fail.is_err() { "correctly rejected" } else { "ERROR" });
    println!("  ✓ PasswordManager OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_permissions() {
    use std::sync::Arc;
    use gitbrowser::database::connection::Database;
    use gitbrowser::managers::permission_manager::{PermissionManager, PermissionManagerTrait};
    use gitbrowser::types::permission::*;
    section("Permission Manager");

    let db = Arc::new(Database::open_in_memory().unwrap());
    let mut mgr = PermissionManager::new(db);

    // Default is Ask
    let default = mgr.get_permission("https://example.com", &PermissionType::Camera);
    println!("  Default camera permission: {:?}", default);

    mgr.set_permission("https://github.com", PermissionType::Notifications, PermissionValue::Allow).unwrap();
    mgr.set_permission("https://github.com", PermissionType::Camera, PermissionValue::Deny).unwrap();
    mgr.set_permission("https://example.com", PermissionType::Geolocation, PermissionValue::Allow).unwrap();
    println!("  Set 3 permissions for 2 sites");

    let github_perms = mgr.get_site_permissions("https://github.com").unwrap();
    println!("  github.com has {} permission(s)", github_perms.len());

    let all = mgr.list_all_permissions().unwrap();
    println!("  Total permissions: {}", all.len());

    mgr.revoke_permission("https://github.com", &PermissionType::Camera).unwrap();
    let revoked = mgr.get_permission("https://github.com", &PermissionType::Camera);
    println!("  Revoked camera -> {:?}", revoked);

    mgr.reset_site_permissions("https://github.com").unwrap();
    let after_reset = mgr.get_site_permissions("https://github.com").unwrap();
    println!("  Reset github.com: {} permission(s) remaining", after_reset.len());
    println!("  ✓ PermissionManager OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_shortcuts() {
    use gitbrowser::managers::shortcut_manager::{ShortcutManager, ShortcutManagerTrait};
    section("Shortcut Manager");

    let mut mgr = ShortcutManager::new();
    let defaults = mgr.get_default_shortcuts();
    println!("  Loaded {} default shortcuts", defaults.len());

    println!("  new_tab = {:?}", mgr.get_shortcut("new_tab"));
    println!("  close_tab = {:?}", mgr.get_shortcut("close_tab"));
    println!("  ai_assistant = {:?}", mgr.get_shortcut("ai_assistant"));

    let conflict = mgr.has_conflict("Ctrl+T", None);
    println!("  Conflict for Ctrl+T: {:?}", conflict);

    mgr.register_shortcut("custom_action", "Ctrl+Shift+X").unwrap();
    println!("  Registered custom: Ctrl+Shift+X");

    let total = mgr.list_shortcuts().len();
    println!("  Total shortcuts: {}", total);
    println!("  ✓ ShortcutManager OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_downloads() {
    use std::sync::Arc;
    use gitbrowser::database::connection::Database;
    use gitbrowser::managers::download_manager::{DownloadManager, DownloadManagerTrait};
    section("Download Manager");

    let db = Arc::new(Database::open_in_memory().unwrap());
    let mut mgr = DownloadManager::new(db);

    let d1 = mgr.start_download("https://example.com/file.zip", "/tmp/file.zip").unwrap();
    let d2 = mgr.start_download("https://example.com/image.png", "/tmp/image.png").unwrap();
    println!("  Started 2 downloads");

    mgr.pause_download(&d1).unwrap();
    println!("  Paused download 1: {:?}", mgr.get_download(&d1).map(|d| format!("{:?}", d.status)));

    mgr.resume_download(&d1).unwrap();
    println!("  Resumed download 1: {:?}", mgr.get_download(&d1).map(|d| format!("{:?}", d.status)));

    mgr.cancel_download(&d2).unwrap();
    println!("  Cancelled download 2: {:?}", mgr.get_download(&d2).map(|d| format!("{:?}", d.status)));

    mgr.retry_download(&d2).unwrap();
    println!("  Retried download 2: {:?}", mgr.get_download(&d2).map(|d| format!("{:?}", d.status)));

    println!("  Total downloads: {}", mgr.list_downloads().len());
    println!("  ✓ DownloadManager OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_privacy() {
    use gitbrowser::services::privacy_engine::{PrivacyEngine, PrivacyEngineTrait};
    section("Privacy Engine");

    let mut engine = PrivacyEngine::new();
    engine.initialize().unwrap();

    let blocked = engine.should_block_request("https://google-analytics.com/collect", "script");
    println!("  Block google-analytics.com: {}", blocked);

    let not_blocked = engine.should_block_request("https://github.com/page", "document");
    println!("  Block github.com: {}", not_blocked);

    let upgraded = engine.upgrade_to_https("http://example.com/page");
    println!("  HTTPS upgrade: http://example.com -> {:?}", upgraded);

    let no_upgrade = engine.upgrade_to_https("https://secure.com");
    println!("  Already HTTPS: {:?}", no_upgrade);

    engine.enable_private_mode();
    println!("  Private mode: {}", engine.is_private_mode());

    engine.disable_private_mode();
    println!("  Private mode off: {}", engine.is_private_mode());

    engine.configure_dns_over_https("https://cloudflare-dns.com/dns-query").unwrap();
    println!("  DoH configured: Cloudflare");
    println!("  Stats: {:?}", engine.get_stats());
    println!("  ✓ PrivacyEngine OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_crash_recovery() {
    use std::sync::Arc;
    use gitbrowser::database::connection::Database;
    use gitbrowser::services::crash_recovery::{CrashRecovery, CrashRecoveryTrait};
    use gitbrowser::types::privacy::CrashLogEntry;
    section("Crash Recovery");

    let db = Arc::new(Database::open_in_memory().unwrap());
    let mut recovery = CrashRecovery::new(db);

    println!("  Has unrecovered crash: {}", recovery.has_unrecovered_crash());

    recovery.log_crash(CrashLogEntry {
        id: String::new(),
        tab_url: Some("https://crashy-site.com".to_string()),
        error_type: "WebProcessCrashed".to_string(),
        error_message: Some("Segmentation fault in renderer".to_string()),
        timestamp: 0,
    }).unwrap();
    println!("  Logged crash for crashy-site.com");
    println!("  Has unrecovered crash: {}", recovery.has_unrecovered_crash());

    let logs = recovery.get_crash_logs().unwrap();
    println!("  Crash logs: {} entry(s)", logs.len());
    println!("  Error: {} — {}", logs[0].error_type, logs[0].error_message.as_deref().unwrap_or(""));

    recovery.mark_crash_recovered().unwrap();
    println!("  Marked recovered: has_unrecovered = {}", recovery.has_unrecovered_crash());
    println!("  ✓ CrashRecovery OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_reader_mode() {
    use gitbrowser::services::reader_mode::{ReaderMode, ReaderModeTrait};
    section("Reader Mode");

    let reader = ReaderMode::new();

    let article_html = r#"<html><head><title>Rust is Great</title></head><body>
    <article><h1>Why Rust?</h1><p>Rust provides memory safety without garbage collection.
    It achieves this through its ownership system, which tracks references at compile time.
    This makes Rust ideal for systems programming, web browsers, and other performance-critical
    applications. The language has been growing rapidly in popularity since its 1.0 release.
    Many companies including Mozilla, Google, Microsoft, and Amazon are using Rust in production.
    The ecosystem is rich with crates for everything from web servers to embedded systems.</p></article>
    </body></html>"#;

    let is_article = reader.is_article_page(article_html, "https://blog.example.com/rust");
    println!("  Is article page: {}", is_article);

    let content = reader.extract_content(article_html, "https://blog.example.com/rust").unwrap();
    println!("  Title: {}", content.title);
    println!("  Read time: {} min", content.estimated_read_time_minutes);
    println!("  Text length: {} chars", content.text_content.len());

    let settings = reader.get_settings();
    println!("  Font: {:?}, size: {}px, line-height: {}", settings.font_family, settings.font_size, settings.line_height);

    let html = reader.format_for_display(&content, settings);
    println!("  Generated reader HTML: {} bytes", html.len());
    println!("  ✓ ReaderMode OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_extensions() {
    use std::sync::Arc;
    use gitbrowser::database::connection::Database;
    use gitbrowser::services::extension_framework::{ExtensionFramework, ExtensionFrameworkTrait};
    section("Extension Framework");

    let db = Arc::new(Database::open_in_memory().unwrap());
    let mut fw = ExtensionFramework::new(db);

    let ext1 = fw.install("/extensions/dark-reader").unwrap();
    let ext2 = fw.install("/extensions/ublock-origin").unwrap();
    println!("  Installed 2 extensions");

    println!("  Extensions: {}", fw.list_extensions().len());
    println!("  ext1: {} (enabled={})", fw.get_extension(&ext1).unwrap().name, fw.get_extension(&ext1).unwrap().enabled);

    fw.disable(&ext1).unwrap();
    println!("  Disabled ext1: enabled={}", fw.get_extension(&ext1).unwrap().enabled);

    fw.enable(&ext1).unwrap();
    println!("  Re-enabled ext1: enabled={}", fw.get_extension(&ext1).unwrap().enabled);

    let impact = fw.measure_performance_impact(&ext1);
    println!("  Performance impact: {}ms", impact);

    fw.uninstall(&ext2).unwrap();
    println!("  Uninstalled ext2, remaining: {}", fw.list_extensions().len());
    println!("  ✓ ExtensionFramework OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_ai_assistant() {
    use std::sync::Arc;
    use gitbrowser::database::connection::Database;
    use gitbrowser::services::ai_assistant::{AIAssistant, AIAssistantTrait};
    use gitbrowser::types::ai::*;
    section("AI Assistant");

    let db = Arc::new(Database::open_in_memory().unwrap());
    let mut ai = AIAssistant::new(db).unwrap();

    let providers = ai.get_available_providers();
    println!("  Available providers:");
    for p in &providers {
        println!("    {} — {} model(s): {}", p.display_name, p.models.len(), p.models.join(", "));
    }

    // Encrypt and store an API key
    ai.set_api_key(&AIProviderName::OpenAI, "sk-test-key-12345").unwrap();
    let retrieved = ai.get_api_key(&AIProviderName::OpenAI).unwrap();
    println!("  Stored & retrieved OpenAI key: {}", if retrieved.is_some() { "OK (encrypted)" } else { "MISSING" });

    let usage = ai.get_token_usage();
    println!("  Token usage: {} tokens, ${:.4} cost", usage.total_tokens, usage.total_cost);

    let history = ai.get_chat_history().unwrap();
    println!("  Chat history: {} messages", history.len());
    println!("  ✓ AIAssistant OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_update_manager() {
    use gitbrowser::services::update_manager::{UpdateManager, UpdateManagerTrait};
    section("Update Manager");

    let mut mgr = UpdateManager::new();
    println!("  Current version: {}", mgr.get_current_version());
    println!("  Auto-check enabled: {}", mgr.is_auto_check_enabled());

    mgr.set_auto_check_enabled(false);
    println!("  Disabled auto-check: {}", mgr.is_auto_check_enabled());

    println!("  Version comparison:");
    println!("    0.1.0 < 0.2.0: {}", UpdateManager::is_newer_version("0.1.0", "0.2.0"));
    println!("    0.1.0 < 0.1.0: {}", UpdateManager::is_newer_version("0.1.0", "0.1.0"));
    println!("    1.0.0 < 0.9.0: {}", UpdateManager::is_newer_version("1.0.0", "0.9.0"));
    println!("  ✓ UpdateManager OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_github_integration() {
    use std::sync::Arc;
    use gitbrowser::database::connection::Database;
    use gitbrowser::services::github_integration::{GitHubIntegration, GitHubIntegrationTrait};
    section("GitHub Integration");

    let db = Arc::new(Database::open_in_memory().unwrap());
    let mut gh = GitHubIntegration::new(db).unwrap();

    println!("  Authenticated: {}", gh.is_authenticated());

    gh.store_token("ghp_test_token_abc123", "octocat", Some("https://avatars.githubusercontent.com/u/583231")).unwrap();
    println!("  Stored OAuth token (encrypted)");

    let token = gh.get_token().unwrap();
    println!("  Retrieved token: {}", if token.is_some() { "OK" } else { "MISSING" });

    // Test sync encryption
    let data = b"bookmarks and settings data for sync";
    let encrypted = gh.encrypt_for_sync(data).unwrap();
    let decrypted = gh.decrypt_from_sync(&encrypted).unwrap();
    assert_eq!(decrypted, data);
    println!("  Sync encrypt/decrypt round-trip: OK");

    gh.logout().unwrap();
    println!("  Logged out: authenticated = {}", gh.is_authenticated());
    println!("  ✓ GitHubIntegration OK");
    println!();
}

#[cfg(not(feature = "gui"))]
fn demo_app_core() {
    use gitbrowser::app::App;
    section("App Core (full lifecycle)");

    let mut app = App::new(":memory:").unwrap();
    println!("  Initialized App with all 17+ components");

    app.startup();
    println!("  Startup sequence: settings → locale → theme → privacy → crash check");

    app.shutdown();
    println!("  Shutdown sequence: stop periodic save");
    println!("  ✓ App Core OK");
}
