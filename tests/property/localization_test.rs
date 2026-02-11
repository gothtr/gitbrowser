//! Property-based tests for locale key completeness.
//!
//! **Validates: Requirements 18.1**
//!
//! These tests verify that the English and Russian locale files have
//! matching key coverage. For every non-plural key in English, the
//! Russian locale must also contain that key, and vice versa.
//! Plural keys are validated separately: English requires `_one`/`_other`
//! forms, while Russian requires `_one`/`_few`/`_many`/`_other` forms.

use proptest::prelude::*;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

/// Known plural suffixes across both locales.
const PLURAL_SUFFIXES: &[&str] = &["_one", "_few", "_many", "_other"];

/// Load a locale JSON file and return the parsed Value.
fn load_locale(path: &str) -> Value {
    let content = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("Failed to read locale file {}: {}", path, e));
    serde_json::from_str(&content)
        .unwrap_or_else(|e| panic!("Failed to parse locale file {}: {}", path, e))
}

/// Flatten a nested JSON object into dot-notation keys.
/// E.g., {"tabs": {"new_tab": "..."}} becomes ["tabs.new_tab"].
fn flatten_keys(value: &Value, prefix: &str, keys: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                let full_key = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{}.{}", prefix, k)
                };
                match v {
                    Value::Object(_) => flatten_keys(v, &full_key, keys),
                    _ => {
                        keys.insert(full_key);
                    }
                }
            }
        }
        _ => {
            if !prefix.is_empty() {
                keys.insert(prefix.to_string());
            }
        }
    }
}

/// Check if a dot-notation key is a plural form key.
/// A key is plural if its last segment ends with one of the PLURAL_SUFFIXES.
fn is_plural_key(key: &str) -> bool {
    let last_segment = key.rsplit('.').next().unwrap_or(key);
    PLURAL_SUFFIXES.iter().any(|suffix| last_segment.ends_with(suffix))
}

/// Extract the plural base from a key by stripping the plural suffix.
/// E.g., "common.tabs_one" -> "common.tabs"
fn plural_base(key: &str) -> Option<String> {
    let last_segment = key.rsplit('.').next().unwrap_or(key);
    for suffix in PLURAL_SUFFIXES {
        if last_segment.ends_with(suffix) {
            let prefix_part = if key.contains('.') {
                let dot_pos = key.rfind('.').unwrap();
                &key[..dot_pos + 1]
            } else {
                ""
            };
            let base_segment = &last_segment[..last_segment.len() - suffix.len()];
            return Some(format!("{}{}", prefix_part, base_segment));
        }
    }
    None
}

/// Collect all plural bases and their available suffixes from a set of keys.
fn collect_plural_groups(keys: &BTreeSet<String>) -> HashMap<String, BTreeSet<String>> {
    let mut groups: HashMap<String, BTreeSet<String>> = HashMap::new();
    for key in keys {
        if is_plural_key(key) {
            if let Some(base) = plural_base(key) {
                let last_segment = key.rsplit('.').next().unwrap_or(key);
                for suffix in PLURAL_SUFFIXES {
                    if last_segment.ends_with(suffix) {
                        groups
                            .entry(base.clone())
                            .or_default()
                            .insert(suffix.to_string());
                        break;
                    }
                }
            }
        }
    }
    groups
}

/// Get all flattened keys from both locale files, separated into
/// regular and plural categories.
struct LocaleData {
    en_regular: BTreeSet<String>,
    ru_regular: BTreeSet<String>,
    en_plural_groups: HashMap<String, BTreeSet<String>>,
    ru_plural_groups: HashMap<String, BTreeSet<String>>,
}

fn load_locale_data() -> LocaleData {
    let en = load_locale("locales/en.json");
    let ru = load_locale("locales/ru.json");

    let mut en_keys = BTreeSet::new();
    let mut ru_keys = BTreeSet::new();
    flatten_keys(&en, "", &mut en_keys);
    flatten_keys(&ru, "", &mut ru_keys);

    let en_regular: BTreeSet<String> = en_keys.iter().filter(|k| !is_plural_key(k)).cloned().collect();
    let ru_regular: BTreeSet<String> = ru_keys.iter().filter(|k| !is_plural_key(k)).cloned().collect();

    let en_plural_groups = collect_plural_groups(&en_keys);
    let ru_plural_groups = collect_plural_groups(&ru_keys);

    LocaleData {
        en_regular,
        ru_regular,
        en_plural_groups,
        ru_plural_groups,
    }
}

// **Property 3: Locale key completeness**
//
// *For any* key present in the English locale, the Russian locale SHALL
// also contain that key, and vice versa.
//
// **Validates: Requirements 18.1**
proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    /// For any randomly sampled regular (non-plural) key from the English locale,
    /// the Russian locale must also contain that key.
    #[test]
    fn en_regular_key_exists_in_ru(
        idx in 0usize..1000
    ) {
        let data = load_locale_data();
        if data.en_regular.is_empty() {
            return Ok(());
        }
        let keys: Vec<&String> = data.en_regular.iter().collect();
        let key = keys[idx % keys.len()];
        prop_assert!(
            data.ru_regular.contains(key),
            "English regular key '{}' is missing from Russian locale",
            key
        );
    }

    /// For any randomly sampled regular (non-plural) key from the Russian locale,
    /// the English locale must also contain that key.
    #[test]
    fn ru_regular_key_exists_in_en(
        idx in 0usize..1000
    ) {
        let data = load_locale_data();
        if data.ru_regular.is_empty() {
            return Ok(());
        }
        let keys: Vec<&String> = data.ru_regular.iter().collect();
        let key = keys[idx % keys.len()];
        prop_assert!(
            data.en_regular.contains(key),
            "Russian regular key '{}' is missing from English locale",
            key
        );
    }

    /// For any randomly sampled plural base from the English locale,
    /// English must have at least _one and _other forms.
    #[test]
    fn en_plural_base_has_required_forms(
        idx in 0usize..1000
    ) {
        let data = load_locale_data();
        if data.en_plural_groups.is_empty() {
            return Ok(());
        }
        let bases: Vec<(&String, &BTreeSet<String>)> = data.en_plural_groups.iter().collect();
        let (base, suffixes) = bases[idx % bases.len()];
        prop_assert!(
            suffixes.contains("_one"),
            "English plural base '{}' is missing '_one' form (has: {:?})",
            base,
            suffixes
        );
        prop_assert!(
            suffixes.contains("_other"),
            "English plural base '{}' is missing '_other' form (has: {:?})",
            base,
            suffixes
        );
    }

    /// For any randomly sampled plural base from the Russian locale,
    /// Russian must have _one, _few, _many, and _other forms.
    #[test]
    fn ru_plural_base_has_required_forms(
        idx in 0usize..1000
    ) {
        let data = load_locale_data();
        if data.ru_plural_groups.is_empty() {
            return Ok(());
        }
        let bases: Vec<(&String, &BTreeSet<String>)> = data.ru_plural_groups.iter().collect();
        let (base, suffixes) = bases[idx % bases.len()];
        prop_assert!(
            suffixes.contains("_one"),
            "Russian plural base '{}' is missing '_one' form (has: {:?})",
            base,
            suffixes
        );
        prop_assert!(
            suffixes.contains("_few"),
            "Russian plural base '{}' is missing '_few' form (has: {:?})",
            base,
            suffixes
        );
        prop_assert!(
            suffixes.contains("_many"),
            "Russian plural base '{}' is missing '_many' form (has: {:?})",
            base,
            suffixes
        );
        prop_assert!(
            suffixes.contains("_other"),
            "Russian plural base '{}' is missing '_other' form (has: {:?})",
            base,
            suffixes
        );
    }

    /// For any randomly sampled plural base from English, the Russian locale
    /// must also have a plural group with the same base.
    #[test]
    fn en_plural_base_exists_in_ru(
        idx in 0usize..1000
    ) {
        let data = load_locale_data();
        if data.en_plural_groups.is_empty() {
            return Ok(());
        }
        let bases: Vec<&String> = data.en_plural_groups.keys().collect();
        let base = bases[idx % bases.len()];
        prop_assert!(
            data.ru_plural_groups.contains_key(base),
            "English plural base '{}' has no corresponding plural group in Russian locale",
            base
        );
    }

    /// For any randomly sampled plural base from Russian, the English locale
    /// must also have a plural group with the same base.
    #[test]
    fn ru_plural_base_exists_in_en(
        idx in 0usize..1000
    ) {
        let data = load_locale_data();
        if data.ru_plural_groups.is_empty() {
            return Ok(());
        }
        let bases: Vec<&String> = data.ru_plural_groups.keys().collect();
        let base = bases[idx % bases.len()];
        prop_assert!(
            data.en_plural_groups.contains_key(base),
            "Russian plural base '{}' has no corresponding plural group in English locale",
            base
        );
    }
}
