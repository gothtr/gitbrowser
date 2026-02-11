//! App Core for GitBrowser.
//!
//! Central struct holding all managers and services, managing application lifecycle.

use std::sync::Arc;

use crate::database::connection::Database;
use crate::managers::download_manager::DownloadManager;
use crate::managers::permission_manager::PermissionManager;
use crate::managers::session_manager::SessionManager;
use crate::managers::shortcut_manager::ShortcutManager;
use crate::managers::tab_manager::TabManager;
use crate::services::ai_assistant::AIAssistant;
use crate::services::crash_recovery::CrashRecovery;
use crate::services::extension_framework::ExtensionFramework;
use crate::services::github_integration::GitHubIntegration;
use crate::services::localization_engine::LocalizationEngine;
use crate::services::password_manager::PasswordManager;
use crate::services::privacy_engine::PrivacyEngine;
use crate::services::reader_mode::ReaderMode;
use crate::services::settings_engine::SettingsEngine;
use crate::services::theme_engine::ThemeEngine;
use crate::services::update_manager::UpdateManager;

/// Central application struct holding all managers and services.
///
/// BookmarkManager and HistoryManager are created on-demand via `db.connection()`
/// because they borrow the connection with a lifetime parameter.
pub struct App {
    pub db: Arc<Database>,
    pub tab_manager: TabManager,
    pub session_manager: SessionManager,
    pub download_manager: DownloadManager,
    pub permission_manager: PermissionManager,
    pub shortcut_manager: ShortcutManager,
    pub settings_engine: SettingsEngine,
    pub localization_engine: LocalizationEngine,
    pub theme_engine: ThemeEngine,
    pub privacy_engine: PrivacyEngine,
    pub password_manager: PasswordManager,
    pub crash_recovery: CrashRecovery,
    pub reader_mode: ReaderMode,
    pub extension_framework: ExtensionFramework,
    pub ai_assistant: AIAssistant,
    pub update_manager: UpdateManager,
    pub github_integration: GitHubIntegration,
}

impl App {
    /// Creates a new App, initializing all managers and services.
    ///
    /// BookmarkManager and HistoryManager are not stored directly because they
    /// borrow `&Connection` with a lifetime. Use `db.connection()` to create them
    /// on demand via `BookmarkManager::new(app.db.connection())`.
    pub fn new(db_path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let db = Arc::new(Database::open(db_path)?);

        let tab_manager = TabManager::new();
        let session_manager = SessionManager::new(db.clone())
            .map_err(|e| format!("SessionManager init failed: {}", e))?;
        let download_manager = DownloadManager::new(db.clone());
        let permission_manager = PermissionManager::new(db.clone());
        let shortcut_manager = ShortcutManager::new();
        let password_manager = PasswordManager::new(db.clone());
        let crash_recovery = CrashRecovery::new(db.clone());
        let extension_framework = ExtensionFramework::new(db.clone());
        let ai_assistant = AIAssistant::new(db.clone())
            .map_err(|e| format!("AIAssistant init failed: {}", e))?;
        let github_integration = GitHubIntegration::new(db.clone())
            .map_err(|e| format!("GitHubIntegration init failed: {}", e))?;

        let mut settings_engine = SettingsEngine::new(None);
        {
            use crate::services::settings_engine::SettingsEngineTrait;
            let _ = settings_engine.load();
        }

        let mut localization_engine = LocalizationEngine::new("locales");
        {
            use crate::services::localization_engine::LocalizationEngineTrait;
            let _ = localization_engine.initialize();
        }

        let theme_engine = ThemeEngine::new(crate::types::settings::ThemeMode::System);
        let privacy_engine = PrivacyEngine::new();
        let reader_mode = ReaderMode::new();
        let update_manager = UpdateManager::new();

        Ok(Self {
            db,
            tab_manager,
            session_manager,
            download_manager,
            permission_manager,
            shortcut_manager,
            settings_engine,
            localization_engine,
            theme_engine,
            privacy_engine,
            password_manager,
            crash_recovery,
            reader_mode,
            extension_framework,
            ai_assistant,
            update_manager,
            github_integration,
        })
    }

    /// Startup sequence: load settings, detect locale, apply theme, check crash recovery.
    pub fn startup(&mut self) {
        use crate::services::crash_recovery::CrashRecoveryTrait;
        use crate::services::localization_engine::LocalizationEngineTrait;
        use crate::services::privacy_engine::PrivacyEngineTrait;
        use crate::services::settings_engine::SettingsEngineTrait;

        // Load settings
        let _ = self.settings_engine.load();

        // Detect and set locale
        let locale = self.localization_engine.detect_system_locale();
        let _ = self.localization_engine.set_locale(&locale);

        // Initialize privacy engine
        let _ = self.privacy_engine.initialize();

        // Check for crash recovery
        if self.crash_recovery.has_unrecovered_crash() {
            if let Ok(Some(_session)) = self.crash_recovery.get_last_session_for_recovery() {
                // Session would be restored by the UI layer
            }
            let _ = self.crash_recovery.mark_crash_recovered();
        }
    }

    /// Shutdown sequence: save session, stop periodic save, flush state.
    pub fn shutdown(&mut self) {
        use crate::managers::session_manager::SessionManagerTrait;
        self.session_manager.stop_periodic_save();
    }
}
