// GitBrowser Settings Engine
// Manages user settings: loading, saving, updating individual values, and resetting to defaults.
// Settings are stored as a JSON file at the platform-specific config path.

use std::fs;
use std::path::Path;

use crate::platform;
use crate::types::errors::SettingsError;
use crate::types::settings::BrowserSettings;

/// Trait defining the settings engine interface.
pub trait SettingsEngineTrait {
    fn load(&mut self) -> Result<BrowserSettings, SettingsError>;
    fn save(&self) -> Result<(), SettingsError>;
    fn get_settings(&self) -> &BrowserSettings;
    fn set_value(&mut self, key: &str, value: serde_json::Value) -> Result<(), SettingsError>;
    fn reset(&mut self) -> Result<(), SettingsError>;
    fn get_config_path(&self) -> &str;
}

/// Settings engine implementation that persists settings as JSON on disk.
pub struct SettingsEngine {
    config_path: String,
    settings: BrowserSettings,
}

impl SettingsEngine {
    /// Creates a new SettingsEngine.
    ///
    /// If `path_override` is `Some`, uses that path for the config file.
    /// Otherwise, uses the platform-specific config directory with `settings.json`.
    pub fn new(path_override: Option<String>) -> Self {
        let config_path = match path_override {
            Some(p) => p,
            None => {
                let config_dir = platform::get_config_dir();
                config_dir
                    .join("settings.json")
                    .to_string_lossy()
                    .to_string()
            }
        };

        Self {
            config_path,
            settings: BrowserSettings::default(),
        }
    }
}

impl SettingsEngineTrait for SettingsEngine {
    /// Loads settings from the JSON config file.
    ///
    /// If the file does not exist, returns default settings.
    /// If the file exists but is malformed, returns a serialization error.
    fn load(&mut self) -> Result<BrowserSettings, SettingsError> {
        let path = Path::new(&self.config_path);

        if !path.exists() {
            self.settings = BrowserSettings::default();
            return Ok(self.settings.clone());
        }

        let content = fs::read_to_string(path)
            .map_err(|e| SettingsError::IoError(format!("Failed to read config file: {}", e)))?;

        let settings: BrowserSettings = serde_json::from_str(&content).map_err(|e| {
            SettingsError::SerializationError(format!("Failed to parse config file: {}", e))
        })?;

        self.settings = settings;
        Ok(self.settings.clone())
    }

    /// Saves the current settings to the JSON config file.
    ///
    /// Creates parent directories if they don't exist.
    fn save(&self) -> Result<(), SettingsError> {
        let path = Path::new(&self.config_path);

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                SettingsError::IoError(format!("Failed to create config directory: {}", e))
            })?;
        }

        let json = serde_json::to_string_pretty(&self.settings).map_err(|e| {
            SettingsError::SerializationError(format!("Failed to serialize settings: {}", e))
        })?;

        fs::write(path, json)
            .map_err(|e| SettingsError::IoError(format!("Failed to write config file: {}", e)))?;

        Ok(())
    }

    /// Returns a reference to the current in-memory settings.
    fn get_settings(&self) -> &BrowserSettings {
        &self.settings
    }

    /// Updates an individual setting by dot-notation key path.
    ///
    /// Converts the current settings to a `serde_json::Value`, navigates the
    /// dot-separated key path, updates the target value, then deserializes
    /// back into `BrowserSettings`. Saves to disk after a successful update.
    ///
    /// # Examples
    /// - `"general.language"` → updates `settings.general.language`
    /// - `"privacy.tracker_blocking"` → updates `settings.privacy.tracker_blocking`
    /// - `"appearance.theme"` → updates `settings.appearance.theme`
    fn set_value(&mut self, key: &str, value: serde_json::Value) -> Result<(), SettingsError> {
        if key.is_empty() {
            return Err(SettingsError::InvalidKey("Key cannot be empty".to_string()));
        }

        let parts: Vec<&str> = key.split('.').collect();
        if parts.is_empty() {
            return Err(SettingsError::InvalidKey(
                "Key cannot be empty".to_string(),
            ));
        }

        // Serialize current settings to a JSON Value
        let mut json_value = serde_json::to_value(&self.settings).map_err(|e| {
            SettingsError::SerializationError(format!("Failed to serialize settings: {}", e))
        })?;

        // Navigate to the target location and set the value
        {
            let mut current = &mut json_value;
            for (i, part) in parts.iter().enumerate() {
                if i == parts.len() - 1 {
                    // Last part — set the value
                    match current {
                        serde_json::Value::Object(map) => {
                            if !map.contains_key(*part) {
                                return Err(SettingsError::InvalidKey(format!(
                                    "Key '{}' not found in settings",
                                    key
                                )));
                            }
                            map.insert(part.to_string(), value.clone());
                        }
                        _ => {
                            return Err(SettingsError::InvalidKey(format!(
                                "Cannot navigate to key '{}': intermediate value is not an object",
                                key
                            )));
                        }
                    }
                } else {
                    // Intermediate part — navigate deeper
                    current = match current.get_mut(*part) {
                        Some(v) => v,
                        None => {
                            return Err(SettingsError::InvalidKey(format!(
                                "Key '{}' not found in settings",
                                key
                            )));
                        }
                    };
                }
            }
        }

        // Deserialize back into BrowserSettings to validate the new value
        let new_settings: BrowserSettings =
            serde_json::from_value(json_value).map_err(|e| {
                SettingsError::InvalidValue(format!(
                    "Invalid value for key '{}': {}",
                    key, e
                ))
            })?;

        self.settings = new_settings;

        // Persist to disk
        self.save()?;

        Ok(())
    }

    /// Resets all settings to factory defaults and saves to disk.
    fn reset(&mut self) -> Result<(), SettingsError> {
        self.settings = BrowserSettings::default();
        self.save()?;
        Ok(())
    }

    /// Returns the path to the config file.
    fn get_config_path(&self) -> &str {
        &self.config_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_config_path() -> String {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json").to_string_lossy().to_string();
        // Leak the tempdir so it doesn't get cleaned up during the test
        std::mem::forget(dir);
        path
    }

    #[test]
    fn test_load_defaults_when_no_file() {
        let path = temp_config_path();
        let mut engine = SettingsEngine::new(Some(path));
        let settings = engine.load().unwrap();
        assert_eq!(settings, BrowserSettings::default());
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        let path = temp_config_path();
        let mut engine = SettingsEngine::new(Some(path.clone()));

        // Load defaults
        engine.load().unwrap();

        // Modify a setting
        engine
            .set_value("general.language", serde_json::Value::String("ru".to_string()))
            .unwrap();

        // Create a new engine and load from disk
        let mut engine2 = SettingsEngine::new(Some(path));
        let loaded = engine2.load().unwrap();
        assert_eq!(loaded.general.language, "ru");
    }

    #[test]
    fn test_get_config_path() {
        let path = "/tmp/test_settings.json".to_string();
        let engine = SettingsEngine::new(Some(path.clone()));
        assert_eq!(engine.get_config_path(), path);
    }

    #[test]
    fn test_default_config_path_uses_platform() {
        let engine = SettingsEngine::new(None);
        let path = engine.get_config_path();
        assert!(path.contains("settings.json"));
        assert!(path.to_lowercase().contains("gitbrowser"));
    }

    #[test]
    fn test_reset_restores_defaults() {
        let path = temp_config_path();
        let mut engine = SettingsEngine::new(Some(path));
        engine.load().unwrap();

        // Change a setting
        engine
            .set_value("general.language", serde_json::Value::String("ru".to_string()))
            .unwrap();
        assert_eq!(engine.get_settings().general.language, "ru");

        // Reset
        engine.reset().unwrap();
        assert_eq!(engine.get_settings().general.language, "en");
        assert_eq!(*engine.get_settings(), BrowserSettings::default());
    }

    #[test]
    fn test_set_value_dot_notation() {
        let path = temp_config_path();
        let mut engine = SettingsEngine::new(Some(path));
        engine.load().unwrap();

        // Test setting various dot-notation paths
        engine
            .set_value(
                "privacy.tracker_blocking",
                serde_json::Value::Bool(false),
            )
            .unwrap();
        assert!(!engine.get_settings().privacy.tracker_blocking);

        engine
            .set_value(
                "appearance.font_size",
                serde_json::json!(18),
            )
            .unwrap();
        assert_eq!(engine.get_settings().appearance.font_size, 18);

        engine
            .set_value(
                "appearance.theme",
                serde_json::Value::String("Dark".to_string()),
            )
            .unwrap();
        assert_eq!(
            engine.get_settings().appearance.theme,
            crate::types::settings::ThemeMode::Dark
        );
    }

    #[test]
    fn test_set_value_invalid_key() {
        let path = temp_config_path();
        let mut engine = SettingsEngine::new(Some(path));
        engine.load().unwrap();

        let result = engine.set_value("nonexistent.key", serde_json::Value::Bool(true));
        assert!(result.is_err());
    }

    #[test]
    fn test_set_value_empty_key() {
        let path = temp_config_path();
        let mut engine = SettingsEngine::new(Some(path));
        engine.load().unwrap();

        let result = engine.set_value("", serde_json::Value::Bool(true));
        assert!(result.is_err());
    }

    #[test]
    fn test_set_value_invalid_value_type() {
        let path = temp_config_path();
        let mut engine = SettingsEngine::new(Some(path));
        engine.load().unwrap();

        // Try setting a boolean field to a string — should fail deserialization
        let result = engine.set_value(
            "privacy.tracker_blocking",
            serde_json::Value::String("not_a_bool".to_string()),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_set_value_shortcut() {
        let path = temp_config_path();
        let mut engine = SettingsEngine::new(Some(path));
        engine.load().unwrap();

        engine
            .set_value(
                "shortcuts.new_tab",
                serde_json::Value::String("Ctrl+Shift+T".to_string()),
            )
            .unwrap();
        assert_eq!(
            engine.get_settings().shortcuts.get("new_tab").unwrap(),
            "Ctrl+Shift+T"
        );
    }

    #[test]
    fn test_set_value_performance() {
        let path = temp_config_path();
        let mut engine = SettingsEngine::new(Some(path));
        engine.load().unwrap();

        engine
            .set_value(
                "performance.tab_suspend_timeout_minutes",
                serde_json::json!(60),
            )
            .unwrap();
        assert_eq!(engine.get_settings().performance.tab_suspend_timeout_minutes, 60);

        engine
            .set_value(
                "performance.lazy_load_images",
                serde_json::Value::Bool(false),
            )
            .unwrap();
        assert!(!engine.get_settings().performance.lazy_load_images);
    }

    #[test]
    fn test_load_malformed_json() {
        let path = temp_config_path();
        // Write malformed JSON
        if let Some(parent) = Path::new(&path).parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, "{ invalid json }").unwrap();

        let mut engine = SettingsEngine::new(Some(path));
        let result = engine.load();
        assert!(result.is_err());
    }

    #[test]
    fn test_default_settings_values() {
        let defaults = BrowserSettings::default();

        // General
        assert_eq!(defaults.general.language, "en");
        assert_eq!(defaults.general.startup_behavior, crate::types::settings::StartupBehavior::Restore);
        assert_eq!(defaults.general.homepage, "about:newtab");
        assert_eq!(defaults.general.default_search_engine, "google");

        // Privacy
        assert!(defaults.privacy.tracker_blocking);
        assert!(defaults.privacy.ad_blocking);
        assert!(defaults.privacy.https_enforcement);
        assert!(defaults.privacy.dns_over_https);
        assert_eq!(defaults.privacy.dns_provider, "https://cloudflare-dns.com/dns-query");
        assert!(defaults.privacy.anti_fingerprinting);
        assert!(!defaults.privacy.clear_data_on_exit);

        // Appearance
        assert_eq!(defaults.appearance.theme, crate::types::settings::ThemeMode::System);
        assert_eq!(defaults.appearance.accent_color, "#2ea44f");
        assert_eq!(defaults.appearance.font_size, 14);

        // Shortcuts
        assert_eq!(defaults.shortcuts.get("new_tab").unwrap(), "Ctrl+T");
        assert_eq!(defaults.shortcuts.get("close_tab").unwrap(), "Ctrl+W");
        assert_eq!(defaults.shortcuts.get("reload").unwrap(), "Ctrl+R");
        assert_eq!(defaults.shortcuts.get("back").unwrap(), "Alt+Left");
        assert_eq!(defaults.shortcuts.get("forward").unwrap(), "Alt+Right");
        assert_eq!(defaults.shortcuts.get("address_bar").unwrap(), "Ctrl+L");
        assert_eq!(defaults.shortcuts.get("find").unwrap(), "Ctrl+F");
        assert_eq!(defaults.shortcuts.get("bookmarks").unwrap(), "Ctrl+B");
        assert_eq!(defaults.shortcuts.get("history").unwrap(), "Ctrl+H");
        assert_eq!(defaults.shortcuts.get("downloads").unwrap(), "Ctrl+J");
        assert_eq!(defaults.shortcuts.get("settings").unwrap(), "Ctrl+Comma");
        assert_eq!(defaults.shortcuts.get("private_mode").unwrap(), "Ctrl+Shift+N");
        assert_eq!(defaults.shortcuts.get("ai_assistant").unwrap(), "Ctrl+Shift+A");

        // AI
        assert!(defaults.ai.active_provider.is_none());
        assert!(defaults.ai.active_model.is_none());

        // Performance
        assert_eq!(defaults.performance.tab_suspend_timeout_minutes, 30);
        assert!(defaults.performance.lazy_load_images);
    }
}
