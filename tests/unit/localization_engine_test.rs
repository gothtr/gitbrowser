//! Unit tests for the LocalizationEngine public API.
//!
//! These tests exercise locale initialization, Russian plural rules,
//! parameter interpolation, and fallback behavior for unsupported locales.
//!
//! Requirements: 18.2 (detect OS language, fallback to English),
//!               18.3 (switch language without restart),
//!               18.5 (plural rules for Russian and English)

use std::collections::HashMap;
use std::fs;

use rstest::rstest;
use tempfile::TempDir;

use gitbrowser::services::localization_engine::{
    LocalizationEngine, LocalizationEngineTrait,
};

/// Creates a temp directory with en.json and ru.json locale files matching
/// the structure used by the real application.
fn setup_locales(dir: &std::path::Path) {
    let en = serde_json::json!({
        "tabs": {
            "new_tab": "New Tab",
            "close_tab": "Close Tab"
        },
        "common": {
            "tabs_one": "{count} tab",
            "tabs_other": "{count} tabs"
        },
        "greeting": "Hello, {name}!",
        "multi_param": "{greeting}, welcome to {place}!"
    });

    let ru = serde_json::json!({
        "tabs": {
            "new_tab": "Новая вкладка",
            "close_tab": "Закрыть вкладку"
        },
        "common": {
            "tabs_one": "{count} вкладка",
            "tabs_few": "{count} вкладки",
            "tabs_many": "{count} вкладок",
            "tabs_other": "{count} вкладок"
        },
        "greeting": "Привет, {name}!",
        "multi_param": "{greeting}, добро пожаловать в {place}!"
    });

    fs::write(
        dir.join("en.json"),
        serde_json::to_string_pretty(&en).unwrap(),
    )
    .unwrap();
    fs::write(
        dir.join("ru.json"),
        serde_json::to_string_pretty(&ru).unwrap(),
    )
    .unwrap();
}

/// Helper: create an initialized LocalizationEngine backed by a temp directory.
fn initialized_engine(dir: &TempDir) -> LocalizationEngine {
    let mut engine = LocalizationEngine::new(dir.path());
    engine.initialize().unwrap();
    engine
}

// ---------------------------------------------------------------------------
// Russian plural rules (Requirement 18.5)
// ---------------------------------------------------------------------------

/// Russian plurals follow the pattern:
///   one:  1, 21, 31, 101, 121 …  → "вкладка"
///   few:  2-4, 22-24, 102-104 …  → "вкладки"
///   many: 0, 5-20, 25-30, 100 …  → "вкладок"
///
/// Validates: Requirement 18.5
#[rstest]
#[case(1,   "1 вкладка")]
#[case(21,  "21 вкладка")]
#[case(2,   "2 вкладки")]
#[case(3,   "3 вкладки")]
#[case(4,   "4 вкладки")]
#[case(5,   "5 вкладок")]
#[case(11,  "11 вкладок")]
#[case(12,  "12 вкладок")]
#[case(14,  "14 вкладок")]
#[case(20,  "20 вкладок")]
#[case(100, "100 вкладок")]
fn test_russian_plural_rules(#[case] count: u64, #[case] expected: &str) {
    let dir = TempDir::new().unwrap();
    setup_locales(dir.path());
    let mut engine = initialized_engine(&dir);
    engine.set_locale("ru").unwrap();

    let result = engine.plural("common.tabs", count, None);
    assert_eq!(result, expected, "Russian plural for count={count}");
}

// ---------------------------------------------------------------------------
// English plural rules (Requirement 18.5)
// ---------------------------------------------------------------------------

/// English plurals: one (count == 1) vs other (everything else).
///
/// Validates: Requirement 18.5
#[rstest]
#[case(1,  "1 tab")]
#[case(0,  "0 tabs")]
#[case(2,  "2 tabs")]
#[case(42, "42 tabs")]
fn test_english_plural_rules(#[case] count: u64, #[case] expected: &str) {
    let dir = TempDir::new().unwrap();
    setup_locales(dir.path());
    let engine = initialized_engine(&dir);

    let result = engine.plural("common.tabs", count, None);
    assert_eq!(result, expected, "English plural for count={count}");
}

// ---------------------------------------------------------------------------
// Parameter interpolation (Requirement 18.3)
// ---------------------------------------------------------------------------

/// Single-parameter interpolation replaces `{name}` in the template.
///
/// Validates: Requirement 18.3
#[test]
fn test_parameter_interpolation_single() {
    let dir = TempDir::new().unwrap();
    setup_locales(dir.path());
    let engine = initialized_engine(&dir);

    let mut params = HashMap::new();
    params.insert("name".to_string(), "World".to_string());

    assert_eq!(engine.t("greeting", Some(&params)), "Hello, World!");
}

/// Multiple parameters are all replaced in a single template.
///
/// Validates: Requirement 18.3
#[test]
fn test_parameter_interpolation_multiple() {
    let dir = TempDir::new().unwrap();
    setup_locales(dir.path());
    let engine = initialized_engine(&dir);

    let mut params = HashMap::new();
    params.insert("greeting".to_string(), "Hi".to_string());
    params.insert("place".to_string(), "GitBrowser".to_string());

    assert_eq!(
        engine.t("multi_param", Some(&params)),
        "Hi, welcome to GitBrowser!"
    );
}

/// Parameter interpolation works in Russian locale too.
///
/// Validates: Requirement 18.3
#[test]
fn test_parameter_interpolation_russian() {
    let dir = TempDir::new().unwrap();
    setup_locales(dir.path());
    let mut engine = initialized_engine(&dir);
    engine.set_locale("ru").unwrap();

    let mut params = HashMap::new();
    params.insert("name".to_string(), "Мир".to_string());

    assert_eq!(engine.t("greeting", Some(&params)), "Привет, Мир!");
}

// ---------------------------------------------------------------------------
// Fallback to English for unsupported locales (Requirement 18.2)
// ---------------------------------------------------------------------------

/// When `set_locale` is called with an unsupported locale, it should return
/// an error and the engine should remain on the previous locale.
///
/// Validates: Requirement 18.2
#[test]
fn test_unsupported_locale_returns_error() {
    let dir = TempDir::new().unwrap();
    setup_locales(dir.path());
    let mut engine = initialized_engine(&dir);

    let result = engine.set_locale("fr");
    assert!(result.is_err(), "Setting unsupported locale should fail");
    assert_eq!(
        engine.get_locale(),
        "en",
        "Engine should remain on English after unsupported locale attempt"
    );
}

/// `detect_system_locale` falls back to English when the LANG env var
/// contains an unsupported locale.
///
/// Validates: Requirement 18.2
#[test]
fn test_detect_system_locale_fallback() {
    let engine = LocalizationEngine::with_default_path();

    // Set an unsupported locale
    unsafe { std::env::set_var("LANG", "ja_JP.UTF-8") };
    assert_eq!(
        engine.detect_system_locale(),
        "en",
        "Unsupported system locale should fall back to English"
    );

    // Restore
    unsafe { std::env::set_var("LANG", "en_US.UTF-8") };
}

// ---------------------------------------------------------------------------
// Locale switching (Requirement 18.3)
// ---------------------------------------------------------------------------

/// Switching locale changes the translations returned by `t()`.
///
/// Validates: Requirement 18.3
#[test]
fn test_locale_switching() {
    let dir = TempDir::new().unwrap();
    setup_locales(dir.path());
    let mut engine = initialized_engine(&dir);

    assert_eq!(engine.t("tabs.new_tab", None), "New Tab");

    engine.set_locale("ru").unwrap();
    assert_eq!(engine.t("tabs.new_tab", None), "Новая вкладка");

    engine.set_locale("en").unwrap();
    assert_eq!(engine.t("tabs.new_tab", None), "New Tab");
}

/// Missing keys return the key itself as a fallback.
#[test]
fn test_missing_key_returns_key() {
    let dir = TempDir::new().unwrap();
    setup_locales(dir.path());
    let engine = initialized_engine(&dir);

    assert_eq!(
        engine.t("nonexistent.key", None),
        "nonexistent.key",
        "Missing key should return the key string itself"
    );
}
