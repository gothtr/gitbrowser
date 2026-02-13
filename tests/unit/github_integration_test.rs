//! Unit tests for GitHub Integration.
//!
//! Tests token storage/retrieval, encryption, logout, and rekey with master password.
//!
//! Covers: TEST-04 from AUDIT.md Phase 3.

use std::sync::Arc;

use gitbrowser::database::Database;
use gitbrowser::services::crypto_service::{CryptoService, CryptoServiceTrait};
use gitbrowser::services::github_integration::{GitHubIntegration, GitHubIntegrationTrait};

fn setup() -> GitHubIntegration {
    let db = Arc::new(Database::open_in_memory().unwrap());
    GitHubIntegration::new(db).unwrap()
}

#[test]
fn test_store_and_get_token() {
    let gh = setup();
    gh.store_token("ghp_abc123", "testuser", Some("https://avatar.url")).unwrap();

    let token = gh.get_token().unwrap();
    assert_eq!(token, Some("ghp_abc123".to_string()));
}

#[test]
fn test_get_token_when_none_stored() {
    let gh = setup();
    let token = gh.get_token().unwrap();
    assert_eq!(token, None);
}

#[test]
fn test_store_token_overwrites_previous() {
    let gh = setup();
    gh.store_token("ghp_first", "user1", None).unwrap();
    gh.store_token("ghp_second", "user2", None).unwrap();

    let token = gh.get_token().unwrap();
    assert_eq!(token, Some("ghp_second".to_string()));
}

#[test]
fn test_logout_clears_token() {
    let db = Arc::new(Database::open_in_memory().unwrap());
    let gh1 = GitHubIntegration::new(db.clone()).unwrap();
    gh1.store_token("ghp_token", "user", None).unwrap();

    // Create a new instance to pick up the authenticated state from DB
    let mut gh2 = GitHubIntegration::new(db).unwrap();
    assert!(gh2.is_authenticated());

    gh2.logout().unwrap();
    assert!(!gh2.is_authenticated());

    let token = gh2.get_token().unwrap();
    assert_eq!(token, None);
}

#[test]
fn test_encrypt_decrypt_sync_roundtrip() {
    let gh = setup();
    let data = b"bookmark data to sync";

    let encrypted = gh.encrypt_for_sync(data).unwrap();
    assert!(!encrypted.ciphertext.is_empty());
    assert!(!encrypted.iv.is_empty());
    assert!(!encrypted.auth_tag.is_empty());

    let decrypted = gh.decrypt_from_sync(&encrypted).unwrap();
    assert_eq!(decrypted, data);
}

#[test]
fn test_encrypt_decrypt_empty_data() {
    let gh = setup();
    let encrypted = gh.encrypt_for_sync(b"").unwrap();
    let decrypted = gh.decrypt_from_sync(&encrypted).unwrap();
    assert_eq!(decrypted, b"");
}

#[test]
fn test_encrypt_decrypt_large_data() {
    let gh = setup();
    let data = vec![0x42u8; 100_000]; // 100KB
    let encrypted = gh.encrypt_for_sync(&data).unwrap();
    let decrypted = gh.decrypt_from_sync(&encrypted).unwrap();
    assert_eq!(decrypted, data);
}

#[test]
fn test_decrypt_with_tampered_ciphertext_fails() {
    let gh = setup();
    let mut encrypted = gh.encrypt_for_sync(b"secret").unwrap();
    encrypted.ciphertext[0] ^= 0xFF;

    let result = gh.decrypt_from_sync(&encrypted);
    assert!(result.is_err());
}

#[test]
fn test_decrypt_with_tampered_tag_fails() {
    let gh = setup();
    let mut encrypted = gh.encrypt_for_sync(b"secret").unwrap();
    encrypted.auth_tag[0] ^= 0xFF;

    let result = gh.decrypt_from_sync(&encrypted);
    assert!(result.is_err());
}

#[test]
fn test_rekey_with_master_preserves_token() {
    let mut gh = setup();
    gh.store_token("ghp_original", "user", None).unwrap();

    // Derive a master key
    let crypto = CryptoService::new();
    let salt = crypto.generate_salt();
    let master_key = crypto.derive_key("master_password", &salt).unwrap();

    // Rekey — token should be re-encrypted with master key
    gh.rekey_with_master(&master_key).unwrap();

    // Token should still be retrievable
    let token = gh.get_token().unwrap();
    assert_eq!(token, Some("ghp_original".to_string()));
}

#[test]
fn test_rekey_without_stored_token_succeeds() {
    let mut gh = setup();
    let crypto = CryptoService::new();
    let salt = crypto.generate_salt();
    let master_key = crypto.derive_key("master", &salt).unwrap();

    // Rekey with no token stored should succeed (no-op)
    gh.rekey_with_master(&master_key).unwrap();
}

#[test]
fn test_is_authenticated_reflects_stored_token() {
    let db = Arc::new(Database::open_in_memory().unwrap());

    // Fresh instance — no token
    let gh1 = GitHubIntegration::new(db.clone()).unwrap();
    assert!(!gh1.is_authenticated());

    // Store a token
    gh1.store_token("ghp_x", "user", None).unwrap();

    // New instance from same DB should detect the token
    let gh2 = GitHubIntegration::new(db).unwrap();
    assert!(gh2.is_authenticated());
}
