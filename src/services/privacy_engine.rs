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
    /// Record a blocked request in stats. Call after should_block_request returns true.
    fn record_blocked(&mut self, url: &str);
    /// Record an HTTPS upgrade in stats.
    fn record_https_upgrade(&mut self);
}

/// Known tracker domains for basic blocking without the adblock crate.
const TRACKER_DOMAINS: &[&str] = &[
    // Google
    "google-analytics.com", "googletagmanager.com", "doubleclick.net",
    "analytics.google.com", "adservice.google.com", "pagead2.googlesyndication.com",
    "googleadservices.com", "googlesyndication.com", "google-analytics.l.google.com",
    // Facebook / Meta
    "facebook.net", "fbcdn.net", "pixel.facebook.com", "connect.facebook.net",
    "graph.facebook.com",
    // Amazon
    "amazon-adsystem.com", "aax.amazon-adsystem.com",
    // Analytics & tracking
    "scorecardresearch.com", "quantserve.com", "hotjar.com", "mixpanel.com",
    "segment.io", "segment.com", "amplitude.com", "heapanalytics.com",
    "fullstory.com", "mouseflow.com", "crazyegg.com", "luckyorange.com",
    "clarity.ms", "newrelic.com", "nr-data.net",
    // Ad networks
    "outbrain.com", "taboola.com", "criteo.com", "criteo.net",
    "adsrvr.org", "adnxs.com", "rubiconproject.com", "pubmatic.com",
    "openx.net", "casalemedia.com", "indexexchange.com",
    "moatads.com", "doubleverify.com", "adsafeprotected.com",
    // Social trackers
    "platform.twitter.com", "syndication.twitter.com",
    "platform.linkedin.com", "snap.licdn.com",
    "static.ads-twitter.com",
    // Other trackers
    "bat.bing.com", "ads.yahoo.com", "yandex.ru/metrika",
    "mc.yandex.ru", "top-fwz1.mail.ru", "vk.com/rtrg",
    "tiktokcdn.com/tiktok/falcon", "analytics.tiktok.com",
];

/// Known ad-serving URL path patterns.
const AD_PATH_PATTERNS: &[&str] = &[
    "/ads/", "/ad/", "/adserver", "/adclick", "/pagead/",
    "/doubleclick/", "/adsense/", "/adview", "/adframe",
    "/sponsor", "/banner", "/popup",
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

    fn is_ad_url(&self, url: &str) -> bool {
        let url_lower = url.to_lowercase();
        AD_PATH_PATTERNS.iter().any(|pat| url_lower.contains(pat))
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
        let is_tracker = self.is_tracker_url(url);
        let is_ad = self.is_ad_url(url);
        is_tracker || is_ad
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

    fn record_blocked(&mut self, url: &str) {
        if self.is_tracker_url(url) {
            self.stats.trackers_blocked += 1;
        }
        if self.is_ad_url(url) {
            self.stats.ads_blocked += 1;
        }
    }

    fn record_https_upgrade(&mut self) {
        self.stats.https_upgrades += 1;
    }
}
