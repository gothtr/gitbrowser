//! Privacy Engine for GitBrowser.
//!
//! Handles tracker/ad blocking, HTTPS enforcement, DNS-over-HTTPS,
//! private browsing mode, and anti-fingerprinting.

use crate::types::errors::PrivacyError;
use crate::types::privacy::PrivacyStats;

/// Trait defining privacy engine operations.
pub trait PrivacyEngineTrait {
    fn initialize(&mut self) -> Result<(), PrivacyError>;
    fn should_block_request(&self, url: &str, resource_type: &str) -> bool;
    fn upgrade_to_https(&self, url: &str) -> Option<String>;
    fn configure_dns_over_https(&mut self, provider: &str) -> Result<(), PrivacyError>;
    fn enable_private_mode(&mut self);
    fn disable_private_mode(&mut self);
    fn is_private_mode(&self) -> bool;
    fn get_stats(&self) -> &PrivacyStats;
    fn clear_private_data(&mut self) -> Result<(), PrivacyError>;
}

/// Known tracker domains for basic blocking without the adblock crate.
const TRACKER_DOMAINS: &[&str] = &[
    "google-analytics.com", "googletagmanager.com", "doubleclick.net",
    "facebook.net", "fbcdn.net", "analytics.google.com",
    "adservice.google.com", "pagead2.googlesyndication.com",
    "amazon-adsystem.com", "scorecardresearch.com",
    "quantserve.com", "hotjar.com", "mixpanel.com",
];

/// Privacy engine implementation.
pub struct PrivacyEngine {
    private_mode: bool,
    stats: PrivacyStats,
    doh_provider: Option<String>,
    tracker_blocking_enabled: bool,
    https_enforcement_enabled: bool,
}

impl PrivacyEngine {
    pub fn new() -> Self {
        Self {
            private_mode: false,
            stats: PrivacyStats::default(),
            doh_provider: None,
            tracker_blocking_enabled: true,
            https_enforcement_enabled: true,
        }
    }

    fn is_tracker_url(&self, url: &str) -> bool {
        let url_lower = url.to_lowercase();
        TRACKER_DOMAINS.iter().any(|domain| url_lower.contains(domain))
    }
}

impl Default for PrivacyEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl PrivacyEngineTrait for PrivacyEngine {
    fn initialize(&mut self) -> Result<(), PrivacyError> {
        self.stats = PrivacyStats::default();
        Ok(())
    }

    fn should_block_request(&self, url: &str, _resource_type: &str) -> bool {
        if !self.tracker_blocking_enabled {
            return false;
        }
        self.is_tracker_url(url)
    }

    fn upgrade_to_https(&self, url: &str) -> Option<String> {
        if !self.https_enforcement_enabled {
            return None;
        }
        if url.starts_with("http://") {
            Some(url.replacen("http://", "https://", 1))
        } else {
            None
        }
    }

    fn configure_dns_over_https(&mut self, provider: &str) -> Result<(), PrivacyError> {
        if provider.is_empty() {
            return Err(PrivacyError::DnsError("Provider URL cannot be empty".to_string()));
        }
        self.doh_provider = Some(provider.to_string());
        Ok(())
    }

    fn enable_private_mode(&mut self) {
        self.private_mode = true;
    }

    fn disable_private_mode(&mut self) {
        self.private_mode = false;
    }

    fn is_private_mode(&self) -> bool {
        self.private_mode
    }

    fn get_stats(&self) -> &PrivacyStats {
        &self.stats
    }

    fn clear_private_data(&mut self) -> Result<(), PrivacyError> {
        // In a full implementation, this would clear cookies, cache, etc.
        // For now, reset stats for the private session.
        self.stats = PrivacyStats::default();
        Ok(())
    }
}
