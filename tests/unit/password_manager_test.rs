//! Unit tests for the Password Manager.
//!
//! Tests unlock, lock, save/decrypt credentials, generate passwords, and update/delete.
//!
//! Covers: TEST-07 from AUDIT.md Phase 3.

use std::sync::Arc;

use gitbrowser::database::Database;
use gitbrowser::services::password_manager::{PasswordManager, PasswordManagerTrait};
use gitbrowser::types::credential::PasswordGenOptions;

fn setup() -> PasswordManager {
    let db = Arc::new(Database::open_in_memory().unwrap());
    PasswordManager::new(db)
}

// ─── Unlock / Lock ───

#[test]
fn test_initially_locked() {
    let mgr = setup();
    assert!(!mgr.is_unlocked());
}

#[test]
fn test_unlock_first_time_sets_master() {
    let mut mgr = setup();
    let ok = mgr.unlock("my_master_password").unwrap();
    assert!(ok);
    assert!(mgr.is_unlocked());
}

#[test]
fn test_unlock_with_correct_password() {
    let mut mgr = setup();
    mgr.unlock("correct_pass").unwrap();
    mgr.lock();

    let ok = mgr.unlock("correct_pass").unwrap();
    assert!(ok);
}

#[test]
fn test_unlock_with_wrong_password_fails() {
    let mut mgr = setup();
    mgr.unlock("correct_pass").unwrap();
    mgr.lock();

    let ok = mgr.unlock("wrong_pass").unwrap();
    assert!(!ok);
    assert!(!mgr.is_unlocked());
}

#[test]
fn test_lock() {
    let mut mgr = setup();
    mgr.unlock("pass").unwrap();
    assert!(mgr.is_unlocked());

    mgr.lock();
    assert!(!mgr.is_unlocked());
}

#[test]
fn test_derived_key_available_when_unlocked() {
    let mut mgr = setup();
    assert!(mgr.get_derived_key().is_none());

    mgr.unlock("pass").unwrap();
    assert!(mgr.get_derived_key().is_some());

    mgr.lock();
    assert!(mgr.get_derived_key().is_none());
}

// ─── Save / Get / Decrypt Credentials ───

#[test]
fn test_save_and_decrypt_credential() {
    let mut mgr = setup();
    mgr.unlock("master").unwrap();

    let id = mgr.save_credential("https://example.com", "user1", "secret123").unwrap();
    assert!(!id.is_empty());

    let creds = mgr.get_credentials("https://example.com").unwrap();
    assert_eq!(creds.len(), 1);
    assert_eq!(creds[0].username, "user1");

    let password = mgr.decrypt_password(&creds[0]).unwrap();
    assert_eq!(password, "secret123");
}

#[test]
fn test_list_all_credentials() {
    let mut mgr = setup();
    mgr.unlock("master").unwrap();

    mgr.save_credential("https://a.com", "u1", "p1").unwrap();
    mgr.save_credential("https://b.com", "u2", "p2").unwrap();

    let all = mgr.list_all_credentials().unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn test_get_credentials_filters_by_url() {
    let mut mgr = setup();
    mgr.unlock("master").unwrap();

    mgr.save_credential("https://a.com", "u1", "p1").unwrap();
    mgr.save_credential("https://b.com", "u2", "p2").unwrap();

    let a_creds = mgr.get_credentials("https://a.com").unwrap();
    assert_eq!(a_creds.len(), 1);
    assert_eq!(a_creds[0].username, "u1");
}

#[test]
fn test_save_credential_requires_unlock() {
    let mut mgr = setup();
    let result = mgr.save_credential("https://x.com", "u", "p");
    assert!(result.is_err());
}

#[test]
fn test_decrypt_requires_unlock() {
    let mut mgr = setup();
    mgr.unlock("master").unwrap();
    let id = mgr.save_credential("https://x.com", "u", "p").unwrap();
    let creds = mgr.list_all_credentials().unwrap();
    let entry = creds.iter().find(|c| c.id == id).unwrap().clone();

    mgr.lock();
    let result = mgr.decrypt_password(&entry);
    assert!(result.is_err());
}

// ─── Update / Delete ───

#[test]
fn test_update_credential_username() {
    let mut mgr = setup();
    mgr.unlock("master").unwrap();

    let id = mgr.save_credential("https://x.com", "old_user", "pass").unwrap();
    mgr.update_credential(&id, Some("new_user"), None).unwrap();

    let creds = mgr.list_all_credentials().unwrap();
    assert_eq!(creds[0].username, "new_user");
}

#[test]
fn test_update_credential_password() {
    let mut mgr = setup();
    mgr.unlock("master").unwrap();

    let id = mgr.save_credential("https://x.com", "user", "old_pass").unwrap();
    mgr.update_credential(&id, None, Some("new_pass")).unwrap();

    let creds = mgr.list_all_credentials().unwrap();
    let pw = mgr.decrypt_password(&creds[0]).unwrap();
    assert_eq!(pw, "new_pass");
}

#[test]
fn test_delete_credential() {
    let mut mgr = setup();
    mgr.unlock("master").unwrap();

    let id = mgr.save_credential("https://x.com", "u", "p").unwrap();
    assert_eq!(mgr.list_all_credentials().unwrap().len(), 1);

    mgr.delete_credential(&id).unwrap();
    assert_eq!(mgr.list_all_credentials().unwrap().len(), 0);
}

// ─── Password Generation ───

#[test]
fn test_generate_password_default_options() {
    let mgr = setup();
    let opts = PasswordGenOptions {
        length: 16, uppercase: true, lowercase: true, numbers: true, symbols: true,
    };
    let pw = mgr.generate_password(&opts);
    assert_eq!(pw.len(), 16);
}

#[test]
fn test_generate_password_custom_length() {
    let mgr = setup();
    let opts = PasswordGenOptions {
        length: 32, uppercase: true, lowercase: true, numbers: true, symbols: false,
    };
    let pw = mgr.generate_password(&opts);
    assert_eq!(pw.len(), 32);
}

#[test]
fn test_generate_password_only_lowercase() {
    let mgr = setup();
    let opts = PasswordGenOptions {
        length: 20, uppercase: false, lowercase: true, numbers: false, symbols: false,
    };
    let pw = mgr.generate_password(&opts);
    assert_eq!(pw.len(), 20);
    assert!(pw.chars().all(|c| c.is_ascii_lowercase()));
}

#[test]
fn test_generate_password_only_numbers() {
    let mgr = setup();
    let opts = PasswordGenOptions {
        length: 10, uppercase: false, lowercase: false, numbers: true, symbols: false,
    };
    let pw = mgr.generate_password(&opts);
    assert_eq!(pw.len(), 10);
    assert!(pw.chars().all(|c| c.is_ascii_digit()));
}

#[test]
fn test_generate_password_all_disabled_falls_back() {
    let mgr = setup();
    let opts = PasswordGenOptions {
        length: 12, uppercase: false, lowercase: false, numbers: false, symbols: false,
    };
    let pw = mgr.generate_password(&opts);
    // Should fallback to lowercase
    assert_eq!(pw.len(), 12);
}

#[test]
fn test_generate_password_uniqueness() {
    let mgr = setup();
    let opts = PasswordGenOptions {
        length: 20, uppercase: true, lowercase: true, numbers: true, symbols: true,
    };
    let pw1 = mgr.generate_password(&opts);
    let pw2 = mgr.generate_password(&opts);
    // Two random passwords should almost certainly differ
    assert_ne!(pw1, pw2);
}
