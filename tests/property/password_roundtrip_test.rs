//! Property-based tests for CryptoService encryption round-trip.
//!
//! **Validates: Requirements 14.3, 14.7, 14.8**
//!
//! These tests verify that the AES-256-GCM encryption/decryption cycle
//! preserves data integrity for arbitrary inputs.

use gitbrowser::services::crypto_service::{CryptoService, CryptoServiceTrait};
use proptest::prelude::*;

// **Property 1: Encryption round-trip**
//
// *For any* random plaintext bytes and derived key, encrypting then
// decrypting SHALL produce the original plaintext.
//
// **Validates: Requirements 14.3, 14.7, 14.8**
proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    #[test]
    fn encryption_roundtrip_preserves_plaintext(
        plaintext in proptest::collection::vec(any::<u8>(), 0..=1024),
        key in proptest::collection::vec(any::<u8>(), 32..=32),
    ) {
        let service = CryptoService::new();

        let encrypted = service
            .encrypt_aes256gcm(&plaintext, &key)
            .expect("Encryption should succeed for valid key");

        let decrypted = service
            .decrypt_aes256gcm(&encrypted, &key)
            .expect("Decryption should succeed with the same key");

        prop_assert_eq!(
            decrypted,
            plaintext,
            "Decrypted data must match original plaintext"
        );
    }
}
