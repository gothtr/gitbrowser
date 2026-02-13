use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::ai::AIProviderName;

/// Top-level browser settings container.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BrowserSettings {
    pub general: GeneralSettings,
    pub privacy: PrivacySettings,
    pub appearance: AppearanceSettings,
    pub shortcuts: HashMap<String, String>,
    pub ai: AISettings,
    pub performance: PerformanceSettings,
}

impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            general: GeneralSettings::default(),
            privacy: PrivacySettings::default(),
            appearance: AppearanceSettings::default(),
            shortcuts: Self::default_shortcuts(),
            ai: AISettings::default(),
            performance: PerformanceSettings::default(),
        }
    }
}

impl BrowserSettings {
    /// Returns the default keyboard shortcuts.
    pub fn default_shortcuts() -> HashMap<String, String> {
        let mut shortcuts = HashMap::new();
        shortcuts.insert("new_tab".to_string(), "Ctrl+T".to_string());
        shortcuts.insert("close_tab".to_string(), "Ctrl+W".to_string());
        shortcuts.insert("reload".to_string(), "Ctrl+R".to_string());
        shortcuts.insert("back".to_string(), "Alt+Left".to_string());
        shortcuts.insert("forward".to_string(), "Alt+Right".to_string());
        shortcuts.insert("address_bar".to_string(), "Ctrl+L".to_string());
        shortcuts.insert("find".to_string(), "Ctrl+F".to_string());
        shortcuts.insert("bookmarks".to_string(), "Ctrl+B".to_string());
        shortcuts.insert("history".to_string(), "Ctrl+H".to_string());
        shortcuts.insert("downloads".to_string(), "Ctrl+J".to_string());
        shortcuts.insert("settings".to_string(), "Ctrl+Comma".to_string());
        shortcuts.insert("private_mode".to_string(), "Ctrl+Shift+N".to_string());
        shortcuts.insert("ai_assistant".to_string(), "Ctrl+Shift+A".to_string());
        shortcuts
    }
}

/// General browser settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GeneralSettings {
    pub language: String,
    pub startup_behavior: StartupBehavior,
    pub homepage: String,
    pub default_search_engine: String,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            language: "en".to_string(),
            startup_behavior: StartupBehavior::Restore,
            homepage: "about:newtab".to_string(),
            default_search_engine: "google".to_string(),
        }
    }
}

/// What the browser does on startup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum StartupBehavior {
    Restore,
    NewTab,
    Homepage,
}

/// Privacy-related settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PrivacySettings {
    pub tracker_blocking: bool,
    pub ad_blocking: bool,
    pub https_enforcement: bool,
    pub dns_over_https: bool,
    pub dns_provider: String,
    pub anti_fingerprinting: bool,
    pub clear_data_on_exit: bool,
    #[serde(default)]
    pub telemetry_consent: bool,
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            tracker_blocking: true,
            ad_blocking: true,
            https_enforcement: true,
            dns_over_https: true,
            dns_provider: "https://cloudflare-dns.com/dns-query".to_string(),
            anti_fingerprinting: true,
            clear_data_on_exit: false,
            telemetry_consent: false,
        }
    }
}

/// Appearance and visual settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppearanceSettings {
    pub theme: ThemeMode,
    pub accent_color: String,
    pub font_size: u32,
    #[serde(default = "default_true")]
    pub show_telegram: bool,
    #[serde(default = "default_true")]
    pub show_github: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: ThemeMode::System,
            accent_color: "#2ea44f".to_string(),
            font_size: 14,
            show_telegram: true,
            show_github: true,
        }
    }
}

/// Theme mode selection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ThemeMode {
    Dark,
    Light,
    System,
}

/// AI assistant settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AISettings {
    pub active_provider: Option<AIProviderName>,
    pub active_model: Option<String>,
}

impl Default for AISettings {
    fn default() -> Self {
        Self {
            active_provider: None,
            active_model: None,
        }
    }
}

/// Performance tuning settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PerformanceSettings {
    pub tab_suspend_timeout_minutes: u32,
    pub lazy_load_images: bool,
}

impl Default for PerformanceSettings {
    fn default() -> Self {
        Self {
            tab_suspend_timeout_minutes: 30,
            lazy_load_images: true,
        }
    }
}
