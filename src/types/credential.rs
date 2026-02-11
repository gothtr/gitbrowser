use serde::{Deserialize, Serialize};

/// Represents a stored credential entry with encrypted password.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialEntry {
    pub id: String,
    pub url: String,
    pub username: String,
    pub encrypted_password: Vec<u8>,
    pub iv: Vec<u8>,
    pub auth_tag: Vec<u8>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Options for generating a random password.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordGenOptions {
    pub length: usize,
    pub uppercase: bool,
    pub lowercase: bool,
    pub numbers: bool,
    pub symbols: bool,
}

/// Encrypted data container used by CryptoService.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedData {
    pub ciphertext: Vec<u8>,
    pub iv: Vec<u8>,
    pub auth_tag: Vec<u8>,
}
