//! Session Manager for GitBrowser.
//!
//! Handles saving and restoring browser sessions (open tabs, window bounds, scroll positions)
//! with AES-256-GCM encryption via CryptoService and SQLite persistence.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use uuid::Uuid;

use crate::database::connection::Database;
use crate::services::crypto_service::{CryptoService, CryptoServiceTrait};
use crate::types::credential::EncryptedData;
use crate::types::errors::SessionError;
use crate::types::session::SessionData;

/// Internal session encryption key derived from a fixed identifier.
/// In production this would use a machine-specific identifier; for now a fixed passphrase + salt.
const SESSION_KEY_PASSPHRASE: &str = "gitbrowser-session-key-v1";
const SESSION_KEY_SALT: &[u8] = b"gitbrowser-sess";

/// Trait defining session management operations.
pub trait SessionManagerTrait {
    fn start_periodic_save(&mut self, interval_secs: u64);
    fn stop_periodic_save(&mut self);
    fn save_session(&self, data: &SessionData) -> Result<(), SessionError>;
    fn restore_session(&self) -> Result<Option<SessionData>, SessionError>;
    fn has_session(&self) -> bool;
    fn clear_session(&self) -> Result<(), SessionError>;
}

/// Session manager implementation backed by SQLite + CryptoService.
pub struct SessionManager {
    db: Arc<Database>,
    crypto: CryptoService,
    encryption_key: Vec<u8>,
    periodic_save_interval: Option<u64>,
    periodic_save_running: bool,
}

impl SessionManager {
    /// Creates a new SessionManager.
    ///
    /// Derives an internal encryption key for session data on construction.
    pub fn new(db: Arc<Database>) -> Result<Self, SessionError> {
        let crypto = CryptoService::new();
        let encryption_key = crypto
            .derive_key(SESSION_KEY_PASSPHRASE, SESSION_KEY_SALT)
            .map_err(|e| SessionError::CryptoError(e.to_string()))?;

        Ok(Self {
            db,
            crypto,
            encryption_key,
            periodic_save_interval: None,
            periodic_save_running: false,
        })
    }

    /// Returns whether the periodic save timer is currently running.
    pub fn is_periodic_save_running(&self) -> bool {
        self.periodic_save_running
    }

    /// Returns the configured periodic save interval in seconds, if any.
    pub fn periodic_save_interval(&self) -> Option<u64> {
        self.periodic_save_interval
    }
}

impl SessionManagerTrait for SessionManager {
    /// Starts periodic session saving at the given interval.
    ///
    /// Stores the interval and sets the running flag. The actual tokio timer
    /// integration will happen in the wiring phase; for now this records intent.
    fn start_periodic_save(&mut self, interval_secs: u64) {
        self.periodic_save_interval = Some(interval_secs);
        self.periodic_save_running = true;
    }

    /// Stops periodic session saving.
    fn stop_periodic_save(&mut self) {
        self.periodic_save_running = false;
    }

    /// Saves session data: serializes to JSON, encrypts, and stores in SQLite.
    fn save_session(&self, data: &SessionData) -> Result<(), SessionError> {
        // Serialize to JSON
        let json = serde_json::to_vec(data)
            .map_err(|e| SessionError::SerializationError(e.to_string()))?;

        // Encrypt
        let encrypted = self
            .crypto
            .encrypt_aes256gcm(&json, &self.encryption_key)
            .map_err(|e| SessionError::CryptoError(e.to_string()))?;

        let id = Uuid::new_v4().to_string();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        // Store in SQLite sessions table
        self.db
            .connection()
            .execute(
                "INSERT INTO sessions (id, encrypted_data, iv, auth_tag, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, encrypted.ciphertext, encrypted.iv, encrypted.auth_tag, timestamp],
            )
            .map_err(|e| SessionError::DatabaseError(e.to_string()))?;

        Ok(())
    }

    /// Restores the most recent session from SQLite, decrypts, and returns SessionData.
    fn restore_session(&self) -> Result<Option<SessionData>, SessionError> {
        let conn = self.db.connection();

        let mut stmt = conn
            .prepare("SELECT encrypted_data, iv, auth_tag FROM sessions ORDER BY timestamp DESC LIMIT 1")
            .map_err(|e| SessionError::DatabaseError(e.to_string()))?;

        let result = stmt
            .query_row([], |row| {
                let ciphertext: Vec<u8> = row.get(0)?;
                let iv: Vec<u8> = row.get(1)?;
                let auth_tag: Vec<u8> = row.get(2)?;
                Ok((ciphertext, iv, auth_tag))
            });

        match result {
            Ok((ciphertext, iv, auth_tag)) => {
                let encrypted = EncryptedData {
                    ciphertext,
                    iv,
                    auth_tag,
                };

                let json_bytes = self
                    .crypto
                    .decrypt_aes256gcm(&encrypted, &self.encryption_key)
                    .map_err(|e| SessionError::CryptoError(e.to_string()))?;

                let session_data: SessionData = serde_json::from_slice(&json_bytes)
                    .map_err(|e| SessionError::SerializationError(e.to_string()))?;

                Ok(Some(session_data))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(SessionError::DatabaseError(e.to_string())),
        }
    }

    /// Returns true if at least one session exists in the database.
    fn has_session(&self) -> bool {
        let conn = self.db.connection();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap_or(0);
        count > 0
    }

    /// Removes all session data from the database.
    fn clear_session(&self) -> Result<(), SessionError> {
        self.db
            .connection()
            .execute("DELETE FROM sessions", [])
            .map_err(|e| SessionError::DatabaseError(e.to_string()))?;
        Ok(())
    }
}
