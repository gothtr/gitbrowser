use ring::aead::{self, Aad, BoundKey, Nonce, NonceSequence, UnboundKey, AES_256_GCM};
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use std::num::NonZeroU32;
use zeroize::Zeroize;

use crate::types::credential::EncryptedData;
use crate::types::errors::CryptoError;

/// PBKDF2 iteration count for key derivation.
const PBKDF2_ITERATIONS: u32 = 100_000;

/// Salt length in bytes for PBKDF2.
const SALT_LENGTH: usize = 16;

/// AES-256-GCM key length in bytes.
const KEY_LENGTH: usize = 32;

/// AES-256-GCM nonce/IV length in bytes.
const NONCE_LENGTH: usize = 12;

/// AES-256-GCM authentication tag length in bytes.
const TAG_LENGTH: usize = 16;

/// Trait defining cryptographic operations for the browser.
pub trait CryptoServiceTrait {
    /// Derives an encryption key from a password and salt using PBKDF2.
    fn derive_key(&self, password: &str, salt: &[u8]) -> Result<Vec<u8>, CryptoError>;

    /// Encrypts plaintext using AES-256-GCM, returning ciphertext, IV, and auth tag.
    fn encrypt_aes256gcm(
        &self,
        plaintext: &[u8],
        key: &[u8],
    ) -> Result<EncryptedData, CryptoError>;

    /// Decrypts data encrypted with AES-256-GCM.
    fn decrypt_aes256gcm(
        &self,
        encrypted: &EncryptedData,
        key: &[u8],
    ) -> Result<Vec<u8>, CryptoError>;

    /// Generates a cryptographically secure random salt.
    fn generate_salt(&self) -> Vec<u8>;

    /// Generates cryptographically secure random bytes of the specified length.
    fn generate_random_bytes(&self, length: usize) -> Vec<u8>;

    /// Securely clears sensitive data from memory by overwriting with zeros.
    fn zeroize_memory(&self, data: &mut [u8]);
}

/// A nonce sequence that uses a single nonce value.
/// Used for one-shot encryption/decryption operations.
struct SingleNonce {
    nonce: Option<[u8; NONCE_LENGTH]>,
}

impl SingleNonce {
    fn new(nonce_bytes: [u8; NONCE_LENGTH]) -> Self {
        Self {
            nonce: Some(nonce_bytes),
        }
    }
}

impl NonceSequence for SingleNonce {
    fn advance(&mut self) -> Result<Nonce, ring::error::Unspecified> {
        self.nonce
            .take()
            .map(|n| Nonce::assume_unique_for_key(n))
            .ok_or(ring::error::Unspecified)
    }
}

/// Implementation of cryptographic services using the `ring` crate.
pub struct CryptoService {
    rng: SystemRandom,
}

impl CryptoService {
    /// Creates a new CryptoService instance.
    pub fn new() -> Self {
        Self {
            rng: SystemRandom::new(),
        }
    }
}

impl Default for CryptoService {
    fn default() -> Self {
        Self::new()
    }
}

impl CryptoServiceTrait for CryptoService {
    fn derive_key(&self, password: &str, salt: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let iterations = NonZeroU32::new(PBKDF2_ITERATIONS)
            .ok_or_else(|| CryptoError::KeyDerivation("Invalid iteration count".to_string()))?;

        let mut key = vec![0u8; KEY_LENGTH];
        pbkdf2::derive(
            pbkdf2::PBKDF2_HMAC_SHA256,
            iterations,
            salt,
            password.as_bytes(),
            &mut key,
        );

        Ok(key)
    }

    fn encrypt_aes256gcm(
        &self,
        plaintext: &[u8],
        key: &[u8],
    ) -> Result<EncryptedData, CryptoError> {
        if key.len() != KEY_LENGTH {
            return Err(CryptoError::InvalidKey(format!(
                "Key must be {} bytes, got {}",
                KEY_LENGTH,
                key.len()
            )));
        }

        // Generate a random nonce/IV
        let mut nonce_bytes = [0u8; NONCE_LENGTH];
        self.rng
            .fill(&mut nonce_bytes)
            .map_err(|_| CryptoError::RandomGeneration("Failed to generate nonce".to_string()))?;

        // Create the sealing key
        let unbound_key = UnboundKey::new(&AES_256_GCM, key)
            .map_err(|_| CryptoError::Encryption("Failed to create encryption key".to_string()))?;

        let nonce_sequence = SingleNonce::new(nonce_bytes);
        let mut sealing_key = aead::SealingKey::new(unbound_key, nonce_sequence);

        // Prepare the buffer: plaintext + space for the auth tag
        let mut in_out = plaintext.to_vec();
        sealing_key
            .seal_in_place_append_tag(Aad::empty(), &mut in_out)
            .map_err(|_| CryptoError::Encryption("Encryption operation failed".to_string()))?;

        // The ring crate appends the auth tag to the ciphertext.
        // Split them: last TAG_LENGTH bytes are the auth tag.
        let tag_start = in_out.len() - TAG_LENGTH;
        let auth_tag = in_out[tag_start..].to_vec();
        let ciphertext = in_out[..tag_start].to_vec();

        Ok(EncryptedData {
            ciphertext,
            iv: nonce_bytes.to_vec(),
            auth_tag,
        })
    }

    fn decrypt_aes256gcm(
        &self,
        encrypted: &EncryptedData,
        key: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        if key.len() != KEY_LENGTH {
            return Err(CryptoError::InvalidKey(format!(
                "Key must be {} bytes, got {}",
                KEY_LENGTH,
                key.len()
            )));
        }

        if encrypted.iv.len() != NONCE_LENGTH {
            return Err(CryptoError::Decryption(format!(
                "IV must be {} bytes, got {}",
                NONCE_LENGTH,
                encrypted.iv.len()
            )));
        }

        if encrypted.auth_tag.len() != TAG_LENGTH {
            return Err(CryptoError::Decryption(format!(
                "Auth tag must be {} bytes, got {}",
                TAG_LENGTH,
                encrypted.auth_tag.len()
            )));
        }

        // Reconstruct the nonce from the IV
        let mut nonce_bytes = [0u8; NONCE_LENGTH];
        nonce_bytes.copy_from_slice(&encrypted.iv);

        // Create the opening key
        let unbound_key = UnboundKey::new(&AES_256_GCM, key)
            .map_err(|_| CryptoError::Decryption("Failed to create decryption key".to_string()))?;

        let nonce_sequence = SingleNonce::new(nonce_bytes);
        let mut opening_key = aead::OpeningKey::new(unbound_key, nonce_sequence);

        // Reassemble ciphertext + auth tag (ring expects them concatenated)
        let mut in_out = Vec::with_capacity(encrypted.ciphertext.len() + encrypted.auth_tag.len());
        in_out.extend_from_slice(&encrypted.ciphertext);
        in_out.extend_from_slice(&encrypted.auth_tag);

        // Decrypt in place
        let plaintext = opening_key
            .open_in_place(Aad::empty(), &mut in_out)
            .map_err(|_| {
                CryptoError::Decryption(
                    "Decryption failed: invalid key or corrupted data".to_string(),
                )
            })?;

        Ok(plaintext.to_vec())
    }

    fn generate_salt(&self) -> Vec<u8> {
        let mut salt = vec![0u8; SALT_LENGTH];
        self.rng
            .fill(&mut salt)
            .expect("Failed to generate random salt");
        salt
    }

    fn generate_random_bytes(&self, length: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; length];
        self.rng
            .fill(&mut bytes)
            .expect("Failed to generate random bytes");
        bytes
    }

    fn zeroize_memory(&self, data: &mut [u8]) {
        data.zeroize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_key_produces_correct_length() {
        let service = CryptoService::new();
        let salt = service.generate_salt();
        let key = service.derive_key("test_password", &salt).unwrap();
        assert_eq!(key.len(), KEY_LENGTH);
    }

    #[test]
    fn test_derive_key_deterministic() {
        let service = CryptoService::new();
        let salt = vec![1u8; SALT_LENGTH];
        let key1 = service.derive_key("password", &salt).unwrap();
        let key2 = service.derive_key("password", &salt).unwrap();
        assert_eq!(key1, key2);
    }

    #[test]
    fn test_derive_key_different_passwords_produce_different_keys() {
        let service = CryptoService::new();
        let salt = service.generate_salt();
        let key1 = service.derive_key("password1", &salt).unwrap();
        let key2 = service.derive_key("password2", &salt).unwrap();
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_derive_key_different_salts_produce_different_keys() {
        let service = CryptoService::new();
        let salt1 = vec![1u8; SALT_LENGTH];
        let salt2 = vec![2u8; SALT_LENGTH];
        let key1 = service.derive_key("password", &salt1).unwrap();
        let key2 = service.derive_key("password", &salt2).unwrap();
        assert_ne!(key1, key2);
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let service = CryptoService::new();
        let key = service.generate_random_bytes(KEY_LENGTH);
        let plaintext = b"Hello, GitBrowser!";

        let encrypted = service.encrypt_aes256gcm(plaintext, &key).unwrap();
        let decrypted = service.decrypt_aes256gcm(&encrypted, &key).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_produces_correct_iv_length() {
        let service = CryptoService::new();
        let key = service.generate_random_bytes(KEY_LENGTH);
        let encrypted = service.encrypt_aes256gcm(b"test", &key).unwrap();
        assert_eq!(encrypted.iv.len(), NONCE_LENGTH);
    }

    #[test]
    fn test_encrypt_produces_correct_tag_length() {
        let service = CryptoService::new();
        let key = service.generate_random_bytes(KEY_LENGTH);
        let encrypted = service.encrypt_aes256gcm(b"test", &key).unwrap();
        assert_eq!(encrypted.auth_tag.len(), TAG_LENGTH);
    }

    #[test]
    fn test_encrypt_invalid_key_length() {
        let service = CryptoService::new();
        let short_key = vec![0u8; 16]; // Too short
        let result = service.encrypt_aes256gcm(b"test", &short_key);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_invalid_key_length() {
        let service = CryptoService::new();
        let encrypted = EncryptedData {
            ciphertext: vec![0u8; 10],
            iv: vec![0u8; NONCE_LENGTH],
            auth_tag: vec![0u8; TAG_LENGTH],
        };
        let short_key = vec![0u8; 16];
        let result = service.decrypt_aes256gcm(&encrypted, &short_key);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_with_wrong_key_fails() {
        let service = CryptoService::new();
        let key1 = service.generate_random_bytes(KEY_LENGTH);
        let key2 = service.generate_random_bytes(KEY_LENGTH);
        let plaintext = b"secret data";

        let encrypted = service.encrypt_aes256gcm(plaintext, &key1).unwrap();
        let result = service.decrypt_aes256gcm(&encrypted, &key2);
        assert!(result.is_err());
    }

    #[test]
    fn test_generate_salt_correct_length() {
        let service = CryptoService::new();
        let salt = service.generate_salt();
        assert_eq!(salt.len(), SALT_LENGTH);
    }

    #[test]
    fn test_generate_salt_unique() {
        let service = CryptoService::new();
        let salt1 = service.generate_salt();
        let salt2 = service.generate_salt();
        assert_ne!(salt1, salt2);
    }

    #[test]
    fn test_generate_random_bytes_correct_length() {
        let service = CryptoService::new();
        assert_eq!(service.generate_random_bytes(0).len(), 0);
        assert_eq!(service.generate_random_bytes(1).len(), 1);
        assert_eq!(service.generate_random_bytes(64).len(), 64);
        assert_eq!(service.generate_random_bytes(256).len(), 256);
    }

    #[test]
    fn test_zeroize_memory_clears_buffer() {
        let service = CryptoService::new();
        let mut data = vec![0xFFu8; 32];
        service.zeroize_memory(&mut data);
        assert!(data.iter().all(|&b| b == 0));
    }

    #[test]
    fn test_encrypt_empty_plaintext() {
        let service = CryptoService::new();
        let key = service.generate_random_bytes(KEY_LENGTH);
        let plaintext = b"";

        let encrypted = service.encrypt_aes256gcm(plaintext, &key).unwrap();
        let decrypted = service.decrypt_aes256gcm(&encrypted, &key).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_different_plaintexts_produce_different_ciphertexts() {
        let service = CryptoService::new();
        let key = service.generate_random_bytes(KEY_LENGTH);

        let encrypted1 = service.encrypt_aes256gcm(b"plaintext1", &key).unwrap();
        let encrypted2 = service.encrypt_aes256gcm(b"plaintext2", &key).unwrap();

        assert_ne!(encrypted1.ciphertext, encrypted2.ciphertext);
    }

    #[test]
    fn test_decrypt_invalid_iv_length() {
        let service = CryptoService::new();
        let key = service.generate_random_bytes(KEY_LENGTH);
        let encrypted = EncryptedData {
            ciphertext: vec![0u8; 10],
            iv: vec![0u8; 8], // Wrong length
            auth_tag: vec![0u8; TAG_LENGTH],
        };
        let result = service.decrypt_aes256gcm(&encrypted, &key);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_invalid_tag_length() {
        let service = CryptoService::new();
        let key = service.generate_random_bytes(KEY_LENGTH);
        let encrypted = EncryptedData {
            ciphertext: vec![0u8; 10],
            iv: vec![0u8; NONCE_LENGTH],
            auth_tag: vec![0u8; 8], // Wrong length
        };
        let result = service.decrypt_aes256gcm(&encrypted, &key);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_tampered_ciphertext_fails() {
        let service = CryptoService::new();
        let key = service.generate_random_bytes(KEY_LENGTH);
        let plaintext = b"sensitive data";

        let mut encrypted = service.encrypt_aes256gcm(plaintext, &key).unwrap();
        // Tamper with the ciphertext
        if !encrypted.ciphertext.is_empty() {
            encrypted.ciphertext[0] ^= 0xFF;
        }
        let result = service.decrypt_aes256gcm(&encrypted, &key);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_tampered_auth_tag_fails() {
        let service = CryptoService::new();
        let key = service.generate_random_bytes(KEY_LENGTH);
        let plaintext = b"sensitive data";

        let mut encrypted = service.encrypt_aes256gcm(plaintext, &key).unwrap();
        // Tamper with the auth tag
        encrypted.auth_tag[0] ^= 0xFF;
        let result = service.decrypt_aes256gcm(&encrypted, &key);
        assert!(result.is_err());
    }
}
