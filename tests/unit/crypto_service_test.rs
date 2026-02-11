//! Integration-level unit tests for the CryptoService public API.
//!
//! These tests exercise the CryptoService through its public trait interface,
//! validating encryption correctness, key handling, and secure memory clearing.
//!
//! Requirements: 14.3 (AES-256-GCM encryption), 15.10 (secure memory zeroization)

use gitbrowser::services::crypto_service::{CryptoService, CryptoServiceTrait};

/// Test that different plaintexts produce different ciphertexts when encrypted
/// with the same key. This validates that the encryption is not trivially
/// producing identical output for distinct inputs.
///
/// Validates: Requirement 14.3
#[test]
fn test_different_plaintexts_produce_different_ciphertexts() {
    let service = CryptoService::new();
    let salt = service.generate_salt();
    let key = service.derive_key("master_password", &salt).unwrap();

    let plaintext_a = b"username:alice";
    let plaintext_b = b"username:bob";

    let encrypted_a = service.encrypt_aes256gcm(plaintext_a, &key).unwrap();
    let encrypted_b = service.encrypt_aes256gcm(plaintext_b, &key).unwrap();

    // Ciphertexts must differ for different plaintexts
    assert_ne!(
        encrypted_a.ciphertext, encrypted_b.ciphertext,
        "Different plaintexts must produce different ciphertexts"
    );
}

/// Test that decryption with a wrong key fails. This ensures that data
/// encrypted with one key cannot be decrypted with a different key,
/// which is critical for password manager security.
///
/// Validates: Requirement 14.3
#[test]
fn test_decryption_with_wrong_key_fails() {
    let service = CryptoService::new();

    let salt = service.generate_salt();
    let correct_key = service.derive_key("correct_password", &salt).unwrap();
    let wrong_key = service.derive_key("wrong_password", &salt).unwrap();

    let plaintext = b"super_secret_password_123";
    let encrypted = service.encrypt_aes256gcm(plaintext, &correct_key).unwrap();

    // Attempting to decrypt with the wrong key must fail
    let result = service.decrypt_aes256gcm(&encrypted, &wrong_key);
    assert!(
        result.is_err(),
        "Decryption with a wrong key must return an error"
    );
}

/// Test that zeroize_memory clears a buffer to all zeros. This validates
/// the secure memory clearing required for sensitive data like passwords
/// and encryption keys after use.
///
/// Validates: Requirement 15.10
#[test]
fn test_zeroize_memory_clears_buffer_to_zeros() {
    let service = CryptoService::new();

    // Create a buffer filled with non-zero sensitive data
    let mut sensitive_data = vec![0xABu8; 64];
    assert!(
        sensitive_data.iter().any(|&b| b != 0),
        "Buffer should contain non-zero data before zeroization"
    );

    service.zeroize_memory(&mut sensitive_data);

    // Every byte must be zero after zeroization
    assert!(
        sensitive_data.iter().all(|&b| b == 0),
        "All bytes must be zero after zeroize_memory"
    );
}
