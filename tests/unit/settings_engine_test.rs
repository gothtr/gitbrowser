//! Integration-level unit tests for the SettingsEngine public API.
//!
//! These tests exercise the SettingsEngine through its public trait interface,
//! validating default loading, value persistence, and reset behavior.
//!
//! Requirements: 6.2 (settings changes saved immediately), 6.3 (reset restores defaults)

use gitbrowser::services::settings_engine::{SettingsEngine, SettingsEngineTrait};
use gitbrowser::types::settings::BrowserSettings;
use tempfile::TempDir;

/// Helper: create a SettingsEngine backed by a temp directory that lives for the
/// duration of the test (the caller holds the `TempDir` handle).
fn engine_in_temp(dir: &TempDir) -> SettingsEngine {
    let path = dir
        .path()
        .join("settings.json")
        .to_string_lossy()
        .to_string();
    SettingsEngine::new(Some(path))
}

/// When no config file exists on disk, `load()` must return the built-in
/// default `BrowserSettings` so the browser can start with sensible values.
///
/// Validates: Requirement 6.2 (settings available even without prior config)
#[test]
fn test_load_defaults_when_no_config_file_exists() {
    let dir = TempDir::new().unwrap();
    let mut engine = engine_in_temp(&dir);

    let settings = engine.load().unwrap();

    assert_eq!(
        settings,
        BrowserSettings::default(),
        "Loading without a config file must return default settings"
    );
}

/// After calling `set_value`, the change must be persisted to disk so that a
/// completely new SettingsEngine instance reading the same file sees the update.
///
/// Validates: Requirement 6.2 (changes saved immediately)
#[test]
fn test_set_value_persists_changes() {
    let dir = TempDir::new().unwrap();

    // First engine: load defaults, then change the language to Russian.
    {
        let mut engine = engine_in_temp(&dir);
        engine.load().unwrap();
        engine
            .set_value(
                "general.language",
                serde_json::Value::String("ru".to_string()),
            )
            .unwrap();
    }

    // Second engine: load from the same path and verify the change survived.
    {
        let mut engine2 = engine_in_temp(&dir);
        let loaded = engine2.load().unwrap();
        assert_eq!(
            loaded.general.language, "ru",
            "set_value must persist the change so a new engine instance reads it back"
        );
    }
}

/// After modifying settings and calling `reset()`, all values must revert to
/// factory defaults and the defaults must be persisted to disk.
///
/// Validates: Requirement 6.3 (reset restores factory defaults)
#[test]
fn test_reset_restores_defaults() {
    let dir = TempDir::new().unwrap();

    // Modify several settings, then reset.
    {
        let mut engine = engine_in_temp(&dir);
        engine.load().unwrap();

        engine
            .set_value(
                "general.language",
                serde_json::Value::String("ru".to_string()),
            )
            .unwrap();
        engine
            .set_value("appearance.font_size", serde_json::json!(20))
            .unwrap();

        // Confirm the modifications took effect
        assert_eq!(engine.get_settings().general.language, "ru");
        assert_eq!(engine.get_settings().appearance.font_size, 20);

        // Reset to defaults
        engine.reset().unwrap();

        assert_eq!(
            *engine.get_settings(),
            BrowserSettings::default(),
            "In-memory settings must equal defaults after reset"
        );
    }

    // Verify the reset was also persisted to disk.
    {
        let mut engine2 = engine_in_temp(&dir);
        let loaded = engine2.load().unwrap();
        assert_eq!(
            loaded,
            BrowserSettings::default(),
            "Reset must persist defaults to disk so a new engine reads them back"
        );
    }
}
