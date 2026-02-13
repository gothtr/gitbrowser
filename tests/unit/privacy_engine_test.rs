//! Unit tests for the Privacy Engine.
//!
//! Tests tracker blocking, HTTPS upgrade, private mode, and DNS-over-HTTPS config.
//!
//! Covers: TEST-06 from AUDIT.md Phase 3.

use gitbrowser::services::privacy_engine::{PrivacyEngine, PrivacyEngineTrait};

fn setup() -> PrivacyEngine {
    let mut engine = PrivacyEngine::new();
    engine.initialize().unwrap();
    engine
}

// ─── Tracker Blocking ───

#[test]
fn test_blocks_google_analytics() {
    let engine = setup();
    assert!(engine.should_block_request("https://www.google-analytics.com/analytics.js", "script"));
}

#[test]
fn test_blocks_facebook_tracker() {
    let engine = setup();
    assert!(engine.should_block_request("https://connect.facebook.net/en_US/fbevents.js", "script"));
}

#[test]
fn test_blocks_doubleclick() {
    let engine = setup();
    assert!(engine.should_block_request("https://ad.doubleclick.net/ddm/ad/click", "image"));
}

#[test]
fn test_blocks_hotjar() {
    let engine = setup();
    assert!(engine.should_block_request("https://static.hotjar.com/c/hotjar.js", "script"));
}

#[test]
fn test_allows_normal_urls() {
    let engine = setup();
    assert!(!engine.should_block_request("https://example.com/page", "document"));
    assert!(!engine.should_block_request("https://github.com/user/repo", "document"));
    assert!(!engine.should_block_request("https://cdn.jsdelivr.net/npm/lib.js", "script"));
}

#[test]
fn test_blocks_google_tag_manager() {
    let engine = setup();
    assert!(engine.should_block_request("https://www.googletagmanager.com/gtm.js?id=GTM-XXX", "script"));
}

#[test]
fn test_blocks_mixpanel() {
    let engine = setup();
    assert!(engine.should_block_request("https://cdn.mixpanel.com/mixpanel.js", "script"));
}

// ─── HTTPS Upgrade ───

#[test]
fn test_upgrades_http_to_https() {
    let engine = setup();
    let upgraded = engine.upgrade_to_https("http://example.com/page");
    assert_eq!(upgraded, Some("https://example.com/page".to_string()));
}

#[test]
fn test_no_upgrade_for_https() {
    let engine = setup();
    let result = engine.upgrade_to_https("https://example.com/page");
    assert_eq!(result, None);
}

#[test]
fn test_no_upgrade_for_non_http() {
    let engine = setup();
    assert_eq!(engine.upgrade_to_https("ftp://files.example.com"), None);
}

// ─── Private Mode ───

#[test]
fn test_private_mode_initially_off() {
    let engine = setup();
    assert!(!engine.is_private_mode());
}

#[test]
fn test_enable_disable_private_mode() {
    let mut engine = setup();
    engine.enable_private_mode();
    assert!(engine.is_private_mode());

    engine.disable_private_mode();
    assert!(!engine.is_private_mode());
}

#[test]
fn test_clear_private_data() {
    let mut engine = setup();
    engine.enable_private_mode();
    engine.clear_private_data().unwrap();
    // Should not error, stats should be reset
    let stats = engine.get_stats();
    assert_eq!(stats.trackers_blocked, 0);
}

// ─── DNS-over-HTTPS ───

#[test]
fn test_configure_doh_valid() {
    let mut engine = setup();
    engine.configure_dns_over_https("https://dns.cloudflare.com/dns-query").unwrap();
}

#[test]
fn test_configure_doh_empty_fails() {
    let mut engine = setup();
    let result = engine.configure_dns_over_https("");
    assert!(result.is_err());
}

// ─── Stats ───

#[test]
fn test_initial_stats_zero() {
    let engine = setup();
    let stats = engine.get_stats();
    assert_eq!(stats.trackers_blocked, 0);
    assert_eq!(stats.https_upgrades, 0);
}
