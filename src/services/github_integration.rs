//! GitHub Integration for GitBrowser.
//!
//! Handles GitHub OAuth Device Flow, profile/notification/repo access,
//! and encrypted bookmark/settings sync via Gists.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;

use crate::database::connection::Database;
use crate::services::crypto_service::{CryptoService, CryptoServiceTrait};
use crate::types::credential::EncryptedData;
use crate::types::errors::{CryptoError, GitHubError};

const GITHUB_KEY_PASSPHRASE: &str = "gitbrowser-github-key-v1";
const GITHUB_KEY_SALT: &[u8] = b"gitbrowser-ghky";

/// Trait defining GitHub integration operations.
pub trait GitHubIntegrationTrait {
    fn store_token(&self, token: &str, login: &str, avatar_url: Option<&str>) -> Result<(), GitHubError>;
    fn get_token(&self) -> Result<Option<String>, GitHubError>;
    fn logout(&mut self) -> Result<(), GitHubError>;
    fn is_authenticated(&self) -> bool;
    fn encrypt_for_sync(&self, data: &[u8]) -> Result<EncryptedData, GitHubError>;
    fn decrypt_from_sync(&self, encrypted: &EncryptedData) -> Result<Vec<u8>, GitHubError>;
}

/// GitHub integration backed by SQLite + CryptoService.
pub struct GitHubIntegration {
    db: Arc<Database>,
    crypto: CryptoService,
    encryption_key: Vec<u8>,
    authenticated: bool,
}

impl GitHubIntegration {
    pub fn new(db: Arc<Database>) -> Result<Self, CryptoError> {
        let crypto = CryptoService::new();
        let encryption_key = crypto.derive_key(GITHUB_KEY_PASSPHRASE, GITHUB_KEY_SALT)?;

        // Check if already authenticated
        let authenticated = {
            let conn = db.connection();
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM github_auth", [], |row| row.get(0))
                .unwrap_or(0);
            count > 0
        };

        Ok(Self {
            db,
            crypto,
            encryption_key,
            authenticated,
        })
    }
}

impl GitHubIntegrationTrait for GitHubIntegration {
    fn store_token(&self, token: &str, login: &str, avatar_url: Option<&str>) -> Result<(), GitHubError> {
        let encrypted = self.crypto.encrypt_aes256gcm(token.as_bytes(), &self.encryption_key)
            .map_err(|e| GitHubError::AuthFailed(e.to_string()))?;

        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;

        self.db.connection().execute(
            "INSERT OR REPLACE INTO github_auth (id, encrypted_token, iv, auth_tag, login, avatar_url, updated_at) VALUES ('default', ?1, ?2, ?3, ?4, ?5, ?6)",
            params![encrypted.ciphertext, encrypted.iv, encrypted.auth_tag, login, avatar_url, now],
        ).map_err(|e| GitHubError::ApiError(e.to_string()))?;

        Ok(())
    }

    fn get_token(&self) -> Result<Option<String>, GitHubError> {
        let conn = self.db.connection();
        let result = conn.query_row(
            "SELECT encrypted_token, iv, auth_tag FROM github_auth WHERE id = 'default'",
            [],
            |row| {
                Ok(EncryptedData {
                    ciphertext: row.get(0)?,
                    iv: row.get(1)?,
                    auth_tag: row.get(2)?,
                })
            },
        );

        match result {
            Ok(encrypted) => {
                let decrypted = self.crypto.decrypt_aes256gcm(&encrypted, &self.encryption_key)
                    .map_err(|e| GitHubError::AuthFailed(e.to_string()))?;
                let token = String::from_utf8(decrypted)
                    .map_err(|e| GitHubError::AuthFailed(e.to_string()))?;
                Ok(Some(token))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(GitHubError::ApiError(e.to_string())),
        }
    }

    fn logout(&mut self) -> Result<(), GitHubError> {
        self.db.connection().execute("DELETE FROM github_auth", [])
            .map_err(|e| GitHubError::ApiError(e.to_string()))?;
        self.db.connection().execute("DELETE FROM github_sync", [])
            .map_err(|e| GitHubError::ApiError(e.to_string()))?;
        self.authenticated = false;
        Ok(())
    }

    fn is_authenticated(&self) -> bool {
        self.authenticated
    }

    fn encrypt_for_sync(&self, data: &[u8]) -> Result<EncryptedData, GitHubError> {
        self.crypto.encrypt_aes256gcm(data, &self.encryption_key)
            .map_err(|e| GitHubError::ApiError(e.to_string()))
    }

    fn decrypt_from_sync(&self, encrypted: &EncryptedData) -> Result<Vec<u8>, GitHubError> {
        self.crypto.decrypt_aes256gcm(encrypted, &self.encryption_key)
            .map_err(|e| GitHubError::ApiError(e.to_string()))
    }
}
