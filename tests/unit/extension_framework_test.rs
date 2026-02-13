//! Unit tests for the Extension Framework.
//!
//! Tests install, uninstall, enable/disable, content script URL matching,
//! and path traversal protection.
//!
//! Covers: TEST-03 from AUDIT.md Phase 3.

use std::sync::Arc;
use tempfile::TempDir;

use gitbrowser::database::Database;
use gitbrowser::services::extension_framework::{ExtensionFramework, ExtensionFrameworkTrait};

/// Create a temp extension directory with a valid manifest.json.
fn create_test_extension(tmp: &TempDir, name: &str, content_scripts_json: &str) -> String {
    let ext_dir = tmp.path().join(name);
    std::fs::create_dir_all(&ext_dir).unwrap();
    let manifest = format!(r#"{{
        "id": "{name}",
        "name": "{name}",
        "version": "1.0.0",
        "permissions": ["pagecontent"],
        "content_scripts": {content_scripts_json}
    }}"#);
    std::fs::write(ext_dir.join("manifest.json"), manifest).unwrap();
    ext_dir.to_str().unwrap().to_string()
}

fn setup() -> (ExtensionFramework, TempDir) {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let fw = ExtensionFramework::new(db);
    let tmp = TempDir::new().unwrap();
    (fw, tmp)
}

// ─── Install / Uninstall ───

#[test]
fn test_install_valid_extension() {
    let (mut fw, tmp) = setup();
    let ext_path = create_test_extension(&tmp, "test-ext", "[]");

    let id = fw.install(&ext_path).unwrap();
    assert_eq!(id, "test-ext");
    assert_eq!(fw.list_extensions().len(), 1);
    assert_eq!(fw.list_extensions()[0].name, "test-ext");
    assert!(fw.list_extensions()[0].enabled);
}

#[test]
fn test_install_extension_without_manifest_uses_fallback() {
    let (mut fw, tmp) = setup();
    let ext_dir = tmp.path().join("no-manifest-ext");
    std::fs::create_dir_all(&ext_dir).unwrap();
    // No manifest.json — should still install with fallback values

    let id = fw.install(ext_dir.to_str().unwrap()).unwrap();
    assert!(!id.is_empty());
    assert_eq!(fw.list_extensions().len(), 1);
}

#[test]
fn test_uninstall_extension() {
    let (mut fw, tmp) = setup();
    let ext_path = create_test_extension(&tmp, "to-remove", "[]");
    let id = fw.install(&ext_path).unwrap();

    fw.uninstall(&id).unwrap();
    assert_eq!(fw.list_extensions().len(), 0);
}

#[test]
fn test_uninstall_nonexistent_returns_error() {
    let (mut fw, _tmp) = setup();
    let result = fw.uninstall("nonexistent-id");
    assert!(result.is_err());
}

// ─── Enable / Disable ───

#[test]
fn test_disable_and_enable_extension() {
    let (mut fw, tmp) = setup();
    let ext_path = create_test_extension(&tmp, "toggle-ext", "[]");
    let id = fw.install(&ext_path).unwrap();

    // Initially enabled
    assert!(fw.get_extension(&id).unwrap().enabled);

    fw.disable(&id).unwrap();
    assert!(!fw.get_extension(&id).unwrap().enabled);

    fw.enable(&id).unwrap();
    assert!(fw.get_extension(&id).unwrap().enabled);
}

#[test]
fn test_enable_nonexistent_returns_error() {
    let (mut fw, _tmp) = setup();
    assert!(fw.enable("nope").is_err());
    assert!(fw.disable("nope").is_err());
}

// ─── Content Script URL Matching ───

#[test]
fn test_content_scripts_match_all_urls() {
    let (mut fw, tmp) = setup();
    let ext_dir = tmp.path().join("all-urls-ext");
    std::fs::create_dir_all(&ext_dir).unwrap();
    std::fs::write(ext_dir.join("inject.js"), "console.log('injected');").unwrap();

    let manifest = r#"{
        "id": "all-urls-ext",
        "name": "All URLs",
        "version": "1.0.0",
        "permissions": ["pagecontent"],
        "content_scripts": [{
            "matches": ["<all_urls>"],
            "js": ["inject.js"],
            "run_at": "document_end"
        }]
    }"#;
    std::fs::write(ext_dir.join("manifest.json"), manifest).unwrap();
    fw.install(ext_dir.to_str().unwrap()).unwrap();

    let scripts = fw.get_content_scripts_for_url("https://example.com/page");
    assert_eq!(scripts.len(), 1);
    assert_eq!(scripts[0].js.len(), 1);
    assert!(scripts[0].js[0].contains("console.log"));
}

#[test]
fn test_content_scripts_match_specific_domain() {
    let (mut fw, tmp) = setup();
    let ext_dir = tmp.path().join("domain-ext");
    std::fs::create_dir_all(&ext_dir).unwrap();
    std::fs::write(ext_dir.join("script.js"), "// github only").unwrap();

    let manifest = r#"{
        "id": "domain-ext",
        "name": "GitHub Only",
        "version": "1.0.0",
        "permissions": ["pagecontent"],
        "content_scripts": [{
            "matches": ["*://*.github.com/*"],
            "js": ["script.js"]
        }]
    }"#;
    std::fs::write(ext_dir.join("manifest.json"), manifest).unwrap();
    fw.install(ext_dir.to_str().unwrap()).unwrap();

    // Should match github.com
    assert_eq!(fw.get_content_scripts_for_url("https://github.com/user/repo").len(), 1);
    // Should match subdomain
    assert_eq!(fw.get_content_scripts_for_url("https://api.github.com/repos").len(), 1);
    // Should NOT match other domains
    assert_eq!(fw.get_content_scripts_for_url("https://example.com").len(), 0);
}

#[test]
fn test_disabled_extension_scripts_not_returned() {
    let (mut fw, tmp) = setup();
    let ext_dir = tmp.path().join("disabled-ext");
    std::fs::create_dir_all(&ext_dir).unwrap();
    std::fs::write(ext_dir.join("s.js"), "// code").unwrap();

    let manifest = r#"{
        "id": "disabled-ext",
        "name": "Disabled",
        "version": "1.0.0",
        "permissions": ["pagecontent"],
        "content_scripts": [{"matches": ["<all_urls>"], "js": ["s.js"]}]
    }"#;
    std::fs::write(ext_dir.join("manifest.json"), manifest).unwrap();
    let id = fw.install(ext_dir.to_str().unwrap()).unwrap();

    assert_eq!(fw.get_content_scripts_for_url("https://example.com").len(), 1);

    fw.disable(&id).unwrap();
    assert_eq!(fw.get_content_scripts_for_url("https://example.com").len(), 0);
}

// ─── Path Traversal Protection (SEC-09) ───

#[test]
fn test_content_script_path_traversal_blocked() {
    let (mut fw, tmp) = setup();
    let ext_dir = tmp.path().join("evil-ext");
    std::fs::create_dir_all(&ext_dir).unwrap();

    // Create a secret file outside the extension directory
    std::fs::write(tmp.path().join("secret.txt"), "SENSITIVE DATA").unwrap();

    let manifest = r#"{
        "id": "evil-ext",
        "name": "Evil",
        "version": "1.0.0",
        "permissions": ["pagecontent"],
        "content_scripts": [{
            "matches": ["<all_urls>"],
            "js": ["../secret.txt"]
        }]
    }"#;
    std::fs::write(ext_dir.join("manifest.json"), manifest).unwrap();
    fw.install(ext_dir.to_str().unwrap()).unwrap();

    // The traversal file should NOT be readable — scripts should be empty
    let scripts = fw.get_content_scripts_for_url("https://example.com");
    // Either no scripts returned (because js was empty after filtering)
    // or the content doesn't contain the secret
    for s in &scripts {
        for js in &s.js {
            assert!(!js.contains("SENSITIVE DATA"),
                "Path traversal must not expose files outside extension directory");
        }
    }
}

// ─── CSS Content Scripts ───

#[test]
fn test_content_scripts_with_css() {
    let (mut fw, tmp) = setup();
    let ext_dir = tmp.path().join("css-ext");
    std::fs::create_dir_all(&ext_dir).unwrap();
    std::fs::write(ext_dir.join("style.css"), "body { background: red; }").unwrap();

    let manifest = r#"{
        "id": "css-ext",
        "name": "CSS Ext",
        "version": "1.0.0",
        "permissions": ["pagecontent"],
        "content_scripts": [{
            "matches": ["<all_urls>"],
            "css": ["style.css"]
        }]
    }"#;
    std::fs::write(ext_dir.join("manifest.json"), manifest).unwrap();
    fw.install(ext_dir.to_str().unwrap()).unwrap();

    let scripts = fw.get_content_scripts_for_url("https://example.com");
    assert_eq!(scripts.len(), 1);
    assert_eq!(scripts[0].css.len(), 1);
    assert!(scripts[0].css[0].contains("background: red"));
}

// ─── Performance Impact ───

#[test]
fn test_measure_performance_impact_default_zero() {
    let (mut fw, tmp) = setup();
    let ext_path = create_test_extension(&tmp, "perf-ext", "[]");
    let id = fw.install(&ext_path).unwrap();

    assert_eq!(fw.measure_performance_impact(&id), 0);
}

#[test]
fn test_measure_performance_nonexistent() {
    let (fw, _tmp) = setup();
    assert_eq!(fw.measure_performance_impact("nope"), 0);
}

// ─── get_extension ───

#[test]
fn test_get_extension_returns_none_for_unknown() {
    let (fw, _tmp) = setup();
    assert!(fw.get_extension("unknown").is_none());
}

#[test]
fn test_get_extension_returns_info() {
    let (mut fw, tmp) = setup();
    let ext_path = create_test_extension(&tmp, "info-ext", "[]");
    fw.install(&ext_path).unwrap();

    let ext = fw.get_extension("info-ext").unwrap();
    assert_eq!(ext.name, "info-ext");
    assert_eq!(ext.version, "1.0.0");
}

// ─── Permission Enforcement (FEAT-01) ───

#[test]
fn test_content_scripts_blocked_without_pagecontent_permission() {
    let (mut fw, tmp) = setup();
    let ext_dir = tmp.path().join("no-perm-ext");
    std::fs::create_dir_all(&ext_dir).unwrap();
    std::fs::write(ext_dir.join("inject.js"), "console.log('no perm');").unwrap();

    let manifest = r#"{
        "id": "no-perm-ext",
        "name": "No Permission",
        "version": "1.0.0",
        "permissions": ["storage"],
        "content_scripts": [{
            "matches": ["<all_urls>"],
            "js": ["inject.js"]
        }]
    }"#;
    std::fs::write(ext_dir.join("manifest.json"), manifest).unwrap();
    fw.install(ext_dir.to_str().unwrap()).unwrap();

    // Should return 0 scripts because extension lacks PageContent permission
    let scripts = fw.get_content_scripts_for_url("https://example.com");
    assert_eq!(scripts.len(), 0, "Extensions without PageContent permission must not inject content scripts");
}

#[test]
fn test_has_permission_check() {
    let (mut fw, tmp) = setup();
    let ext_path = create_test_extension(&tmp, "perm-check-ext", "[]");
    fw.install(&ext_path).unwrap();

    assert!(fw.has_permission("perm-check-ext", &gitbrowser::types::extension::ExtensionPermission::PageContent));
    assert!(!fw.has_permission("perm-check-ext", &gitbrowser::types::extension::ExtensionPermission::Network));
    assert!(!fw.has_permission("nonexistent", &gitbrowser::types::extension::ExtensionPermission::PageContent));
}
