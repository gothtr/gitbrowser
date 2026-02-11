//! Password Manager for GitBrowser.
//!
//! Manages encrypted credential storage with master-password-based unlock,
//! password generation, and import/export functionality.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use uuid::Uuid;

use crate::database::connection::Database;
use crate::services::crypto_service::{CryptoService, CryptoServiceTrait};
use crate::types::credential::{CredentialEntry, EncryptedData, PasswordGenOptions};
use crate::types::errors::CryptoError;

/// Trait defining password management operations.
pub trait PasswordManagerTrait {
    fn unlock(&mut self, master_password: &str) -> Result<bool, CryptoError>;
    fn lock(&mut self);
    fn is_unlocked(&self) -> bool;
    fn save_credential(&mut self, url: &str, username: &str, password: &str) -> Result<String, CryptoError>;
    fn get_credentials(&self, url: &str) -> Result<Vec<CredentialEntry>, CryptoError>;
    fn list_all_credentials(&self) -> Result<Vec<CredentialEntry>, CryptoError>;
    fn decrypt_password(&self, entry: &CredentialEntry) -> Result<String, CryptoError>;
    fn update_credential(&mut self, id: &str, username: Option<&str>, password: Option<&str>) -> Result<(), CryptoError>;
    fn delete_credential(&mut self, id: &str) -> Result<(), CryptoError>;
    fn generate_password(&self, options: &PasswordGenOptions) -> String;
    fn export_encrypted(&self, master_password: &str, file_path: &str) -> Result<(), CryptoError>;
    fn import_encrypted(&mut self, master_password: &str, file_path: &str) -> Result<u32, CryptoError>;
}

const MASTER_KEY_SALT_KEY: &str = "gitbrowser_master_salt";
const MASTER_KEY_VERIFY_PLAINTEXT: &[u8] = b"gitbrowser-master-key-verify-v1";

/// Password manager backed by SQLite + CryptoService.
pub struct PasswordManager {
    db: Arc<Database>,
    crypto: CryptoService,
    derived_key: Option<Vec<u8>>,
}

impl PasswordManager {
    pub fn new(db: Arc<Database>) -> Self {
        Self {
            db,
            crypto: CryptoService::new(),
            derived_key: None,
        }
    }

    /// Returns a clone of the derived master key if the manager is unlocked.
    /// Used by other services (GitHub, AI) to encrypt secrets with the master password.
    pub fn get_derived_key(&self) -> Option<Vec<u8>> {
        self.derived_key.clone()
    }

    /// Ensures the master salt and verification token exist in the database.
    /// Returns the salt bytes.
    fn get_or_create_master_salt(&self) -> Result<Vec<u8>, CryptoError> {
        let conn = self.db.connection();

        // Try to read existing salt
        let existing: Option<Vec<u8>> = conn
            .query_row(
                "SELECT encrypted_password FROM credentials WHERE id = ?1",
                params![MASTER_KEY_SALT_KEY],
                |row| row.get(0),
            )
            .ok();

        if let Some(salt) = existing {
            return Ok(salt);
        }

        // Generate new salt and store it
        let salt = self.crypto.generate_salt();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;

        conn.execute(
            "INSERT OR IGNORE INTO credentials (id, url, username, encrypted_password, iv, auth_tag, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![MASTER_KEY_SALT_KEY, "", "", salt, Vec::<u8>::new(), Vec::<u8>::new(), now, now],
        ).map_err(|e| CryptoError::Encryption(e.to_string()))?;

        Ok(salt)
    }

    /// Gets or creates the verification token for master password validation.
    fn get_verification_token(&self) -> Option<EncryptedData> {
        let conn = self.db.connection();
        conn.query_row(
            "SELECT encrypted_password, iv, auth_tag FROM credentials WHERE id = 'gitbrowser_master_verify'",
            [],
            |row| {
                Ok(EncryptedData {
                    ciphertext: row.get(0)?,
                    iv: row.get(1)?,
                    auth_tag: row.get(2)?,
                })
            },
        ).ok()
    }

    fn store_verification_token(&self, encrypted: &EncryptedData) -> Result<(), CryptoError> {
        let conn = self.db.connection();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        conn.execute(
            "INSERT OR REPLACE INTO credentials (id, url, username, encrypted_password, iv, auth_tag, created_at, updated_at) VALUES ('gitbrowser_master_verify', '', '', ?1, ?2, ?3, ?4, ?5)",
            params![encrypted.ciphertext, encrypted.iv, encrypted.auth_tag, now, now],
        ).map_err(|e| CryptoError::Encryption(e.to_string()))?;
        Ok(())
    }

    fn require_unlocked(&self) -> Result<&Vec<u8>, CryptoError> {
        self.derived_key.as_ref().ok_or(CryptoError::InvalidKey("Password manager is locked".to_string()))
    }

    fn now_ts() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
    }
}

impl PasswordManagerTrait for PasswordManager {
    fn unlock(&mut self, master_password: &str) -> Result<bool, CryptoError> {
        let salt = self.get_or_create_master_salt()?;
        let key = self.crypto.derive_key(master_password, &salt)?;

        // Check if verification token exists
        if let Some(verify_token) = self.get_verification_token() {
            // Verify by decrypting
            match self.crypto.decrypt_aes256gcm(&verify_token, &key) {
                Ok(plaintext) => {
                    if plaintext == MASTER_KEY_VERIFY_PLAINTEXT {
                        self.derived_key = Some(key);
                        return Ok(true);
                    }
                    return Ok(false);
                }
                Err(_) => return Ok(false),
            }
        }

        // First time: create verification token
        let encrypted = self.crypto.encrypt_aes256gcm(MASTER_KEY_VERIFY_PLAINTEXT, &key)?;
        self.store_verification_token(&encrypted)?;
        self.derived_key = Some(key);
        Ok(true)
    }

    fn lock(&mut self) {
        if let Some(ref mut key) = self.derived_key {
            self.crypto.zeroize_memory(key);
        }
        self.derived_key = None;
    }

    fn is_unlocked(&self) -> bool {
        self.derived_key.is_some()
    }

    fn save_credential(&mut self, url: &str, username: &str, password: &str) -> Result<String, CryptoError> {
        let key = self.require_unlocked()?.clone();
        let encrypted = self.crypto.encrypt_aes256gcm(password.as_bytes(), &key)?;
        let id = Uuid::new_v4().to_string();
        let now = Self::now_ts();

        self.db.connection().execute(
            "INSERT INTO credentials (id, url, username, encrypted_password, iv, auth_tag, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, url, username, encrypted.ciphertext, encrypted.iv, encrypted.auth_tag, now, now],
        ).map_err(|e| CryptoError::Encryption(e.to_string()))?;

        Ok(id)
    }

    fn get_credentials(&self, url: &str) -> Result<Vec<CredentialEntry>, CryptoError> {
        let _key = self.require_unlocked()?;
        let conn = self.db.connection();
        let mut stmt = conn.prepare(
            "SELECT id, url, username, encrypted_password, iv, auth_tag, created_at, updated_at FROM credentials WHERE url = ?1 AND id NOT LIKE 'gitbrowser_%'"
        ).map_err(|e| CryptoError::Encryption(e.to_string()))?;

        let entries = stmt.query_map(params![url], |row| {
            Ok(CredentialEntry {
                id: row.get(0)?,
                url: row.get(1)?,
                username: row.get(2)?,
                encrypted_password: row.get(3)?,
                iv: row.get(4)?,
                auth_tag: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        }).map_err(|e| CryptoError::Encryption(e.to_string()))?;

        let mut result = Vec::new();
        for entry in entries {
            result.push(entry.map_err(|e| CryptoError::Encryption(e.to_string()))?);
        }
        Ok(result)
    }

    fn list_all_credentials(&self) -> Result<Vec<CredentialEntry>, CryptoError> {
        let _key = self.require_unlocked()?;
        let conn = self.db.connection();
        let mut stmt = conn.prepare(
            "SELECT id, url, username, encrypted_password, iv, auth_tag, created_at, updated_at FROM credentials WHERE id NOT LIKE 'gitbrowser_%' ORDER BY updated_at DESC"
        ).map_err(|e| CryptoError::Encryption(e.to_string()))?;

        let entries = stmt.query_map(params![], |row| {
            Ok(CredentialEntry {
                id: row.get(0)?,
                url: row.get(1)?,
                username: row.get(2)?,
                encrypted_password: row.get(3)?,
                iv: row.get(4)?,
                auth_tag: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        }).map_err(|e| CryptoError::Encryption(e.to_string()))?;

        let mut result = Vec::new();
        for entry in entries {
            result.push(entry.map_err(|e| CryptoError::Encryption(e.to_string()))?);
        }
        Ok(result)
    }

    fn decrypt_password(&self, entry: &CredentialEntry) -> Result<String, CryptoError> {
        let key = self.require_unlocked()?;
        let encrypted = EncryptedData {
            ciphertext: entry.encrypted_password.clone(),
            iv: entry.iv.clone(),
            auth_tag: entry.auth_tag.clone(),
        };
        let plaintext = self.crypto.decrypt_aes256gcm(&encrypted, key)?;
        String::from_utf8(plaintext).map_err(|e| CryptoError::Decryption(e.to_string()))
    }

    fn update_credential(&mut self, id: &str, username: Option<&str>, password: Option<&str>) -> Result<(), CryptoError> {
        let key = self.require_unlocked()?.clone();
        let conn = self.db.connection();
        let now = Self::now_ts();

        if let Some(new_username) = username {
            conn.execute(
                "UPDATE credentials SET username = ?1, updated_at = ?2 WHERE id = ?3",
                params![new_username, now, id],
            ).map_err(|e| CryptoError::Encryption(e.to_string()))?;
        }

        if let Some(new_password) = password {
            let encrypted = self.crypto.encrypt_aes256gcm(new_password.as_bytes(), &key)?;
            conn.execute(
                "UPDATE credentials SET encrypted_password = ?1, iv = ?2, auth_tag = ?3, updated_at = ?4 WHERE id = ?5",
                params![encrypted.ciphertext, encrypted.iv, encrypted.auth_tag, now, id],
            ).map_err(|e| CryptoError::Encryption(e.to_string()))?;
        }

        Ok(())
    }

    fn delete_credential(&mut self, id: &str) -> Result<(), CryptoError> {
        let _key = self.require_unlocked()?;
        self.db.connection().execute(
            "DELETE FROM credentials WHERE id = ?1 AND id NOT LIKE 'gitbrowser_%'",
            params![id],
        ).map_err(|e| CryptoError::Encryption(e.to_string()))?;
        Ok(())
    }

    fn generate_password(&self, options: &PasswordGenOptions) -> String {
        let mut charset = String::new();
        if options.uppercase { charset.push_str("ABCDEFGHIJKLMNOPQRSTUVWXYZ"); }
        if options.lowercase { charset.push_str("abcdefghijklmnopqrstuvwxyz"); }
        if options.numbers { charset.push_str("0123456789"); }
        if options.symbols { charset.push_str("!@#$%^&*()-_=+[]{}|;:,.<>?"); }

        if charset.is_empty() {
            charset.push_str("abcdefghijklmnopqrstuvwxyz");
        }

        let chars: Vec<char> = charset.chars().collect();
        let random_bytes = self.crypto.generate_random_bytes(options.length);
        random_bytes.iter().map(|b| chars[*b as usize % chars.len()]).collect()
    }

    fn export_encrypted(&self, master_password: &str, file_path: &str) -> Result<(), CryptoError> {
        let _key = self.require_unlocked()?;
        let conn = self.db.connection();
        let mut stmt = conn.prepare(
            "SELECT id, url, username, encrypted_password, iv, auth_tag, created_at, updated_at FROM credentials WHERE id NOT LIKE 'gitbrowser_%'"
        ).map_err(|e| CryptoError::Encryption(e.to_string()))?;

        let entries: Vec<CredentialEntry> = stmt.query_map([], |row| {
            Ok(CredentialEntry {
                id: row.get(0)?, url: row.get(1)?, username: row.get(2)?,
                encrypted_password: row.get(3)?, iv: row.get(4)?, auth_tag: row.get(5)?,
                created_at: row.get(6)?, updated_at: row.get(7)?,
            })
        }).map_err(|e| CryptoError::Encryption(e.to_string()))?
        .filter_map(|e| e.ok())
        .collect();

        let json = serde_json::to_vec(&entries).map_err(|e| CryptoError::Encryption(e.to_string()))?;
        let export_salt = self.crypto.generate_salt();
        let export_key = self.crypto.derive_key(master_password, &export_salt)?;
        let encrypted = self.crypto.encrypt_aes256gcm(&json, &export_key)?;

        let export_data = serde_json::json!({
            "salt": export_salt,
            "data": encrypted,
        });
        let export_bytes = serde_json::to_vec(&export_data).map_err(|e| CryptoError::Encryption(e.to_string()))?;
        std::fs::write(file_path, export_bytes).map_err(|e| CryptoError::Encryption(e.to_string()))?;
        Ok(())
    }

    fn import_encrypted(&mut self, master_password: &str, file_path: &str) -> Result<u32, CryptoError> {
        let _key = self.require_unlocked()?;
        let file_bytes = std::fs::read(file_path).map_err(|e| CryptoError::Decryption(e.to_string()))?;
        let export_data: serde_json::Value = serde_json::from_slice(&file_bytes).map_err(|e| CryptoError::Decryption(e.to_string()))?;

        let salt: Vec<u8> = serde_json::from_value(export_data["salt"].clone()).map_err(|e| CryptoError::Decryption(e.to_string()))?;
        let encrypted: EncryptedData = serde_json::from_value(export_data["data"].clone()).map_err(|e| CryptoError::Decryption(e.to_string()))?;

        let export_key = self.crypto.derive_key(master_password, &salt)?;
        let json = self.crypto.decrypt_aes256gcm(&encrypted, &export_key)?;
        let entries: Vec<CredentialEntry> = serde_json::from_slice(&json).map_err(|e| CryptoError::Decryption(e.to_string()))?;

        let conn = self.db.connection();
        let mut count = 0u32;
        for entry in &entries {
            conn.execute(
                "INSERT OR REPLACE INTO credentials (id, url, username, encrypted_password, iv, auth_tag, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![entry.id, entry.url, entry.username, entry.encrypted_password, entry.iv, entry.auth_tag, entry.created_at, entry.updated_at],
            ).map_err(|e| CryptoError::Encryption(e.to_string()))?;
            count += 1;
        }
        Ok(count)
    }
}
