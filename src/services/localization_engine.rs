use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::types::errors::LocaleError;

/// Supported locales.
const SUPPORTED_LOCALES: &[&str] = &["en", "ru"];

/// Default locale when system locale is not supported.
const DEFAULT_LOCALE: &str = "en";

/// Trait defining the localization engine interface.
pub trait LocalizationEngineTrait {
    fn initialize(&mut self) -> Result<(), LocaleError>;
    fn set_locale(&mut self, lang: &str) -> Result<(), LocaleError>;
    fn get_locale(&self) -> &str;
    fn t(&self, key: &str, params: Option<&HashMap<String, String>>) -> String;
    fn plural(&self, key: &str, count: u64, params: Option<&HashMap<String, String>>) -> String;
    fn detect_system_locale(&self) -> String;
    fn get_available_locales(&self) -> Vec<String>;
}

/// Localization engine managing translations for Russian and English.
pub struct LocalizationEngine {
    /// Current active locale (e.g., "en" or "ru").
    current_locale: String,
    /// Loaded locale data: maps locale name to its parsed JSON value.
    locales: HashMap<String, Value>,
    /// Path to the directory containing locale JSON files.
    locales_dir: PathBuf,
}

impl LocalizationEngine {
    /// Creates a new LocalizationEngine with the given locales directory path.
    pub fn new(locales_dir: impl Into<PathBuf>) -> Self {
        Self {
            current_locale: DEFAULT_LOCALE.to_string(),
            locales: HashMap::new(),
            locales_dir: locales_dir.into(),
        }
    }

    /// Creates a new LocalizationEngine using the default `locales/` directory.
    pub fn with_default_path() -> Self {
        Self::new("locales")
    }

    /// Looks up a nested key in a JSON value using dot notation.
    /// For example, "tabs.new_tab" looks up `value["tabs"]["new_tab"]`.
    fn lookup_key<'a>(data: &'a Value, key: &str) -> Option<&'a Value> {
        let parts: Vec<&str> = key.split('.').collect();
        let mut current = data;
        for part in parts {
            match current.get(part) {
                Some(val) => current = val,
                None => return None,
            }
        }
        Some(current)
    }

    /// Replaces `{param_name}` placeholders in a string with values from the params map.
    fn interpolate(template: &str, params: &HashMap<String, String>) -> String {
        let mut result = template.to_string();
        for (key, value) in params {
            let placeholder = format!("{{{}}}", key);
            result = result.replace(&placeholder, value);
        }
        result
    }

    /// Determines the Russian plural form for a given count.
    /// Returns one of: "one", "few", "many", "other".
    fn russian_plural_form(count: u64) -> &'static str {
        let mod10 = count % 10;
        let mod100 = count % 100;

        if mod10 == 1 && mod100 != 11 {
            "one"
        } else if (2..=4).contains(&mod10) && !(12..=14).contains(&mod100) {
            "few"
        } else if mod10 == 0 || (5..=9).contains(&mod10) || (11..=14).contains(&mod100) {
            "many"
        } else {
            "other"
        }
    }

    /// Determines the English plural form for a given count.
    /// Returns one of: "one", "other".
    fn english_plural_form(count: u64) -> &'static str {
        if count == 1 {
            "one"
        } else {
            "other"
        }
    }

    /// Returns the plural form suffix for the current locale.
    fn get_plural_form(&self, count: u64) -> &'static str {
        match self.current_locale.as_str() {
            "ru" => Self::russian_plural_form(count),
            _ => Self::english_plural_form(count),
        }
    }
}

impl LocalizationEngineTrait for LocalizationEngine {
    /// Loads all locale JSON files from the locales directory.
    fn initialize(&mut self) -> Result<(), LocaleError> {
        let dir = &self.locales_dir;

        if !dir.exists() {
            return Err(LocaleError::FileNotFound(
                dir.to_string_lossy().to_string(),
            ));
        }

        for locale in SUPPORTED_LOCALES {
            let file_path = dir.join(format!("{}.json", locale));
            if file_path.exists() {
                let content = fs::read_to_string(&file_path).map_err(|e| {
                    LocaleError::FileNotFound(format!(
                        "{}: {}",
                        file_path.to_string_lossy(),
                        e
                    ))
                })?;
                let data: Value = serde_json::from_str(&content).map_err(|e| {
                    LocaleError::FileNotFound(format!(
                        "Failed to parse {}: {}",
                        file_path.to_string_lossy(),
                        e
                    ))
                })?;
                self.locales.insert(locale.to_string(), data);
            }
        }

        // At least one locale must be loaded
        if self.locales.is_empty() {
            return Err(LocaleError::FileNotFound(
                "No locale files found".to_string(),
            ));
        }

        Ok(())
    }

    /// Switches the active locale. Returns an error if the locale is not supported
    /// or not loaded.
    fn set_locale(&mut self, lang: &str) -> Result<(), LocaleError> {
        if !SUPPORTED_LOCALES.contains(&lang) {
            return Err(LocaleError::UnsupportedLocale(lang.to_string()));
        }
        if !self.locales.contains_key(lang) {
            return Err(LocaleError::FileNotFound(format!(
                "Locale '{}' not loaded",
                lang
            )));
        }
        self.current_locale = lang.to_string();
        Ok(())
    }

    /// Returns the current active locale.
    fn get_locale(&self) -> &str {
        &self.current_locale
    }

    /// Looks up a translation key using dot notation and optionally interpolates parameters.
    /// Returns the key itself if the translation is not found.
    fn t(&self, key: &str, params: Option<&HashMap<String, String>>) -> String {
        let data = match self.locales.get(&self.current_locale) {
            Some(d) => d,
            None => return key.to_string(),
        };

        let value = match Self::lookup_key(data, key) {
            Some(v) => v,
            None => return key.to_string(),
        };

        let text = match value.as_str() {
            Some(s) => s.to_string(),
            None => return key.to_string(),
        };

        match params {
            Some(p) => Self::interpolate(&text, p),
            None => text,
        }
    }

    /// Looks up a pluralized translation key. The base key is appended with the
    /// appropriate plural suffix (e.g., "_one", "_few", "_many", "_other") based
    /// on the count and current locale's plural rules.
    /// A `{count}` parameter is automatically added to the params.
    fn plural(&self, key: &str, count: u64, params: Option<&HashMap<String, String>>) -> String {
        let form = self.get_plural_form(count);
        let plural_key = format!("{}_{}", key, form);

        // Build params with count included
        let mut merged_params = match params {
            Some(p) => p.clone(),
            None => HashMap::new(),
        };
        merged_params
            .entry("count".to_string())
            .or_insert_with(|| count.to_string());

        // Try the specific plural form first
        let result = self.t(&plural_key, Some(&merged_params));

        // If the specific form wasn't found, try "_other" as fallback
        if result == plural_key {
            let other_key = format!("{}_other", key);
            let other_result = self.t(&other_key, Some(&merged_params));
            if other_result == other_key {
                // If even "_other" is not found, return the base key
                return key.to_string();
            }
            return other_result;
        }

        result
    }

    /// Detects the system locale by reading the `LANG` environment variable.
    /// Returns the language code (e.g., "ru" or "en"). Falls back to "en"
    /// if the system locale is not supported.
    fn detect_system_locale(&self) -> String {
        let lang = std::env::var("LANG").unwrap_or_default();

        // LANG is typically like "ru_RU.UTF-8" or "en_US.UTF-8"
        let lang_code = lang
            .split('_')
            .next()
            .unwrap_or("")
            .split('.')
            .next()
            .unwrap_or("");

        if SUPPORTED_LOCALES.contains(&lang_code) {
            lang_code.to_string()
        } else {
            DEFAULT_LOCALE.to_string()
        }
    }

    /// Returns a list of all available (loaded) locales.
    fn get_available_locales(&self) -> Vec<String> {
        let mut locales: Vec<String> = self.locales.keys().cloned().collect();
        locales.sort();
        locales
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_locales(dir: &std::path::Path) {
        let en = serde_json::json!({
            "tabs": {
                "new_tab": "New Tab",
                "close_tab": "Close Tab"
            },
            "common": {
                "tabs_one": "{count} tab",
                "tabs_other": "{count} tabs"
            },
            "greeting": "Hello, {name}!"
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
            "greeting": "Привет, {name}!"
        });

        fs::write(dir.join("en.json"), serde_json::to_string_pretty(&en).unwrap()).unwrap();
        fs::write(dir.join("ru.json"), serde_json::to_string_pretty(&ru).unwrap()).unwrap();
    }

    #[test]
    fn test_initialize_loads_locales() {
        let tmp = tempfile::tempdir().unwrap();
        create_test_locales(tmp.path());

        let mut engine = LocalizationEngine::new(tmp.path());
        engine.initialize().unwrap();

        assert_eq!(engine.get_available_locales().len(), 2);
        assert!(engine.get_available_locales().contains(&"en".to_string()));
        assert!(engine.get_available_locales().contains(&"ru".to_string()));
    }

    #[test]
    fn test_initialize_fails_on_missing_dir() {
        let mut engine = LocalizationEngine::new("/nonexistent/path");
        let result = engine.initialize();
        assert!(result.is_err());
    }

    #[test]
    fn test_set_locale() {
        let tmp = tempfile::tempdir().unwrap();
        create_test_locales(tmp.path());

        let mut engine = LocalizationEngine::new(tmp.path());
        engine.initialize().unwrap();

        assert_eq!(engine.get_locale(), "en");

        engine.set_locale("ru").unwrap();
        assert_eq!(engine.get_locale(), "ru");

        engine.set_locale("en").unwrap();
        assert_eq!(engine.get_locale(), "en");
    }

    #[test]
    fn test_set_locale_unsupported() {
        let tmp = tempfile::tempdir().unwrap();
        create_test_locales(tmp.path());

        let mut engine = LocalizationEngine::new(tmp.path());
        engine.initialize().unwrap();

        let result = engine.set_locale("fr");
        assert!(result.is_err());
    }

    #[test]
    fn test_t_basic_lookup() {
        let tmp = tempfile::tempdir().unwrap();
        create_test_locales(tmp.path());

        let mut engine = LocalizationEngine::new(tmp.path());
        engine.initialize().unwrap();

        assert_eq!(engine.t("tabs.new_tab", None), "New Tab");
        assert_eq!(engine.t("tabs.close_tab", None), "Close Tab");

        engine.set_locale("ru").unwrap();
        assert_eq!(engine.t("tabs.new_tab", None), "Новая вкладка");
        assert_eq!(engine.t("tabs.close_tab", None), "Закрыть вкладку");
    }

    #[test]
    fn test_t_missing_key_returns_key() {
        let tmp = tempfile::tempdir().unwrap();
        create_test_locales(tmp.path());

        let mut engine = LocalizationEngine::new(tmp.path());
        engine.initialize().unwrap();

        assert_eq!(engine.t("nonexistent.key", None), "nonexistent.key");
    }

    #[test]
    fn test_t_parameter_interpolation() {
        let tmp = tempfile::tempdir().unwrap();
        create_test_locales(tmp.path());

        let mut engine = LocalizationEngine::new(tmp.path());
        engine.initialize().unwrap();

        let mut params = HashMap::new();
        params.insert("name".to_string(), "World".to_string());

        assert_eq!(engine.t("greeting", Some(&params)), "Hello, World!");

        engine.set_locale("ru").unwrap();
        assert_eq!(engine.t("greeting", Some(&params)), "Привет, World!");
    }

    #[test]
    fn test_plural_english() {
        let tmp = tempfile::tempdir().unwrap();
        create_test_locales(tmp.path());

        let mut engine = LocalizationEngine::new(tmp.path());
        engine.initialize().unwrap();

        assert_eq!(engine.plural("common.tabs", 1, None), "1 tab");
        assert_eq!(engine.plural("common.tabs", 2, None), "2 tabs");
        assert_eq!(engine.plural("common.tabs", 0, None), "0 tabs");
        assert_eq!(engine.plural("common.tabs", 100, None), "100 tabs");
    }

    #[test]
    fn test_plural_russian() {
        let tmp = tempfile::tempdir().unwrap();
        create_test_locales(tmp.path());

        let mut engine = LocalizationEngine::new(tmp.path());
        engine.initialize().unwrap();
        engine.set_locale("ru").unwrap();

        // one: 1, 21, 31, 101, 121
        assert_eq!(engine.plural("common.tabs", 1, None), "1 вкладка");
        assert_eq!(engine.plural("common.tabs", 21, None), "21 вкладка");
        assert_eq!(engine.plural("common.tabs", 101, None), "101 вкладка");

        // few: 2, 3, 4, 22, 23, 24
        assert_eq!(engine.plural("common.tabs", 2, None), "2 вкладки");
        assert_eq!(engine.plural("common.tabs", 3, None), "3 вкладки");
        assert_eq!(engine.plural("common.tabs", 4, None), "4 вкладки");
        assert_eq!(engine.plural("common.tabs", 22, None), "22 вкладки");

        // many: 0, 5-20, 25-30, 100, 111, 112
        assert_eq!(engine.plural("common.tabs", 0, None), "0 вкладок");
        assert_eq!(engine.plural("common.tabs", 5, None), "5 вкладок");
        assert_eq!(engine.plural("common.tabs", 11, None), "11 вкладок");
        assert_eq!(engine.plural("common.tabs", 12, None), "12 вкладок");
        assert_eq!(engine.plural("common.tabs", 14, None), "14 вкладок");
        assert_eq!(engine.plural("common.tabs", 20, None), "20 вкладок");
        assert_eq!(engine.plural("common.tabs", 100, None), "100 вкладок");
    }

    #[test]
    fn test_plural_with_extra_params() {
        let tmp = tempfile::tempdir().unwrap();
        create_test_locales(tmp.path());

        let mut engine = LocalizationEngine::new(tmp.path());
        engine.initialize().unwrap();

        let mut params = HashMap::new();
        params.insert("extra".to_string(), "value".to_string());

        // count should be auto-added
        assert_eq!(engine.plural("common.tabs", 1, Some(&params)), "1 tab");
    }

    // Note: detect_system_locale tests are combined into a single test
    // because std::env::set_var is not thread-safe and parallel tests
    // can interfere with each other's environment variables.
    #[test]
    fn test_detect_system_locale() {
        let engine = LocalizationEngine::with_default_path();

        // Test Russian locale detection
        unsafe { std::env::set_var("LANG", "ru_RU.UTF-8") };
        assert_eq!(engine.detect_system_locale(), "ru");

        // Test English locale detection
        unsafe { std::env::set_var("LANG", "en_US.UTF-8") };
        assert_eq!(engine.detect_system_locale(), "en");

        // Test unsupported locale falls back to English
        unsafe { std::env::set_var("LANG", "fr_FR.UTF-8") };
        assert_eq!(engine.detect_system_locale(), "en");

        // Test empty LANG falls back to English
        unsafe { std::env::set_var("LANG", "") };
        assert_eq!(engine.detect_system_locale(), "en");

        // Restore a sensible default
        unsafe { std::env::set_var("LANG", "en_US.UTF-8") };
    }

    #[test]
    fn test_russian_plural_rules_comprehensive() {
        // one: n % 10 == 1 && n % 100 != 11
        assert_eq!(LocalizationEngine::russian_plural_form(1), "one");
        assert_eq!(LocalizationEngine::russian_plural_form(21), "one");
        assert_eq!(LocalizationEngine::russian_plural_form(31), "one");
        assert_eq!(LocalizationEngine::russian_plural_form(101), "one");
        assert_eq!(LocalizationEngine::russian_plural_form(121), "one");

        // few: n % 10 in 2..=4 && n % 100 not in 12..=14
        assert_eq!(LocalizationEngine::russian_plural_form(2), "few");
        assert_eq!(LocalizationEngine::russian_plural_form(3), "few");
        assert_eq!(LocalizationEngine::russian_plural_form(4), "few");
        assert_eq!(LocalizationEngine::russian_plural_form(22), "few");
        assert_eq!(LocalizationEngine::russian_plural_form(23), "few");
        assert_eq!(LocalizationEngine::russian_plural_form(24), "few");
        assert_eq!(LocalizationEngine::russian_plural_form(102), "few");

        // many: n % 10 == 0 || n % 10 in 5..=9 || n % 100 in 11..=14
        assert_eq!(LocalizationEngine::russian_plural_form(0), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(5), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(6), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(7), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(8), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(9), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(10), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(11), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(12), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(13), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(14), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(15), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(20), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(100), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(111), "many");
        assert_eq!(LocalizationEngine::russian_plural_form(112), "many");
    }

    #[test]
    fn test_english_plural_rules() {
        assert_eq!(LocalizationEngine::english_plural_form(0), "other");
        assert_eq!(LocalizationEngine::english_plural_form(1), "one");
        assert_eq!(LocalizationEngine::english_plural_form(2), "other");
        assert_eq!(LocalizationEngine::english_plural_form(100), "other");
    }
}
