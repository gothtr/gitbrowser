use serde::{Deserialize, Serialize};

/// Aggregated privacy protection statistics.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PrivacyStats {
    pub trackers_blocked: u64,
    pub ads_blocked: u64,
    pub https_upgrades: u64,
    pub fingerprint_attempts_blocked: u64,
}

/// A crash log entry recording details of a tab or process crash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashLogEntry {
    pub id: String,
    pub tab_url: Option<String>,
    pub error_type: String,
    pub error_message: Option<String>,
    pub timestamp: i64,
}

/// Plural rules for localization (supports Russian and English).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluralRules {
    pub zero: Option<String>,
    pub one: String,
    /// For Russian: 2-4 form.
    pub few: Option<String>,
    /// For Russian: 5-20 form.
    pub many: Option<String>,
    pub other: String,
}
