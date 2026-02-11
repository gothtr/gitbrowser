//! AI Assistant for GitBrowser.
//!
//! Manages AI provider configuration, encrypted API key storage,
//! chat history, and provider-specific request formatting.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use crate::database::connection::Database;
use crate::services::crypto_service::{CryptoService, CryptoServiceTrait};
use crate::types::ai::*;
use crate::types::credential::EncryptedData;
use crate::types::errors::{AIError, CryptoError};

const AI_KEY_PASSPHRASE: &str = "gitbrowser-ai-key-v1";
const AI_KEY_SALT: &[u8] = b"gitbrowser-aiky";

/// Trait defining AI assistant operations.
pub trait AIAssistantTrait {
    fn set_provider(&mut self, provider: AIProvider);
    fn set_api_key(&mut self, provider_name: &AIProviderName, api_key: &str) -> Result<(), CryptoError>;
    fn get_api_key(&self, provider_name: &AIProviderName) -> Result<Option<String>, CryptoError>;
    fn get_chat_history(&self) -> Result<Vec<AIChatMessage>, AIError>;
    fn clear_chat_history(&mut self) -> Result<(), AIError>;
    fn get_token_usage(&self) -> TokenUsage;
    fn get_available_providers(&self) -> Vec<AIProviderConfig>;
}

/// AI assistant backed by SQLite + CryptoService.
pub struct AIAssistant {
    db: Arc<Database>,
    crypto: CryptoService,
    encryption_key: Vec<u8>,
    active_provider: Option<AIProvider>,
}

impl AIAssistant {
    pub fn new(db: Arc<Database>) -> Result<Self, CryptoError> {
        let crypto = CryptoService::new();
        let encryption_key = crypto.derive_key(AI_KEY_PASSPHRASE, AI_KEY_SALT)?;
        Ok(Self {
            db,
            crypto,
            encryption_key,
            active_provider: None,
        })
    }

    fn provider_name_to_str(name: &AIProviderName) -> &'static str {
        match name {
            AIProviderName::OpenRouter => "openrouter",
            AIProviderName::OpenAI => "openai",
            AIProviderName::Anthropic => "anthropic",
            AIProviderName::DeepSeek => "deepseek",
        }
    }

    fn str_to_provider_name(s: &str) -> AIProviderName {
        match s {
            "openai" => AIProviderName::OpenAI,
            "anthropic" => AIProviderName::Anthropic,
            "deepseek" => AIProviderName::DeepSeek,
            _ => AIProviderName::OpenRouter,
        }
    }

    fn str_to_chat_role(s: &str) -> ChatRole {
        match s {
            "user" => ChatRole::User,
            "assistant" => ChatRole::Assistant,
            "system" => ChatRole::System,
            _ => ChatRole::User,
        }
    }

    #[allow(dead_code)]
    fn chat_role_to_str(role: &ChatRole) -> &'static str {
        match role {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
            ChatRole::System => "system",
        }
    }
}

impl AIAssistantTrait for AIAssistant {
    fn set_provider(&mut self, provider: AIProvider) {
        self.active_provider = Some(provider);
    }

    fn set_api_key(&mut self, provider_name: &AIProviderName, api_key: &str) -> Result<(), CryptoError> {
        let encrypted = self.crypto.encrypt_aes256gcm(api_key.as_bytes(), &self.encryption_key)?;
        let key_id = format!("ai_key_{}", Self::provider_name_to_str(provider_name));
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;

        self.db.connection().execute(
            "INSERT OR REPLACE INTO credentials (id, url, username, encrypted_password, iv, auth_tag, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![key_id, "", Self::provider_name_to_str(provider_name), encrypted.ciphertext, encrypted.iv, encrypted.auth_tag, now, now],
        ).map_err(|e| CryptoError::Encryption(e.to_string()))?;

        Ok(())
    }

    fn get_api_key(&self, provider_name: &AIProviderName) -> Result<Option<String>, CryptoError> {
        let key_id = format!("ai_key_{}", Self::provider_name_to_str(provider_name));
        let conn = self.db.connection();

        let result = conn.query_row(
            "SELECT encrypted_password, iv, auth_tag FROM credentials WHERE id = ?1",
            params![key_id],
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
                let decrypted = self.crypto.decrypt_aes256gcm(&encrypted, &self.encryption_key)?;
                let key_str = String::from_utf8(decrypted)
                    .map_err(|e| CryptoError::Decryption(e.to_string()))?;
                Ok(Some(key_str))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(CryptoError::Decryption(e.to_string())),
        }
    }

    fn get_chat_history(&self) -> Result<Vec<AIChatMessage>, AIError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(
            "SELECT id, role, encrypted_content, iv, auth_tag, provider, model, tokens_used, cost, timestamp FROM ai_chat_messages ORDER BY timestamp ASC"
        ).map_err(|e| AIError::ProviderError(e.to_string()))?;

        let messages = stmt.query_map([], |row| {
            let role_str: String = row.get(1)?;
            let encrypted = EncryptedData {
                ciphertext: row.get(2)?,
                iv: row.get(3)?,
                auth_tag: row.get(4)?,
            };
            let provider_str: String = row.get(5)?;

            Ok((row.get::<_, String>(0)?, role_str, encrypted, provider_str,
                row.get::<_, String>(6)?, row.get::<_, Option<u32>>(7)?,
                row.get::<_, Option<f64>>(8)?, row.get::<_, i64>(9)?))
        }).map_err(|e| AIError::ProviderError(e.to_string()))?;

        let mut result = Vec::new();
        for msg in messages {
            let (id, role_str, encrypted, provider_str, model, tokens_used, cost, timestamp) =
                msg.map_err(|e| AIError::ProviderError(e.to_string()))?;

            let content = self.crypto.decrypt_aes256gcm(&encrypted, &self.encryption_key)
                .map(|bytes| String::from_utf8(bytes).unwrap_or_default())
                .unwrap_or_else(|_| "[decryption failed]".to_string());

            result.push(AIChatMessage {
                id,
                role: Self::str_to_chat_role(&role_str),
                content,
                timestamp,
                provider: Self::str_to_provider_name(&provider_str),
                model,
                tokens_used,
                cost,
            });
        }
        Ok(result)
    }

    fn clear_chat_history(&mut self) -> Result<(), AIError> {
        self.db.connection().execute("DELETE FROM ai_chat_messages", [])
            .map_err(|e| AIError::ProviderError(e.to_string()))?;
        Ok(())
    }

    fn get_token_usage(&self) -> TokenUsage {
        let conn = self.db.connection();
        let (total_tokens, total_cost) = conn.query_row(
            "SELECT COALESCE(SUM(tokens_used), 0), COALESCE(SUM(cost), 0.0) FROM ai_chat_messages",
            [],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, f64>(1)?)),
        ).unwrap_or((0, 0.0));

        TokenUsage { total_tokens, total_cost }
    }

    fn get_available_providers(&self) -> Vec<AIProviderConfig> {
        vec![
            AIProviderConfig {
                name: AIProviderName::OpenRouter,
                display_name: "OpenRouter".to_string(),
                api_endpoint: "https://openrouter.ai/api/v1/chat/completions".to_string(),
                models: vec!["openai/gpt-4o".to_string(), "anthropic/claude-3.5-sonnet".to_string(), "google/gemini-pro".to_string()],
                supports_streaming: true,
            },
            AIProviderConfig {
                name: AIProviderName::OpenAI,
                display_name: "OpenAI".to_string(),
                api_endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
                models: vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()],
                supports_streaming: true,
            },
            AIProviderConfig {
                name: AIProviderName::Anthropic,
                display_name: "Anthropic".to_string(),
                api_endpoint: "https://api.anthropic.com/v1/messages".to_string(),
                models: vec!["claude-3-5-sonnet-20241022".to_string(), "claude-3-haiku-20240307".to_string()],
                supports_streaming: true,
            },
            AIProviderConfig {
                name: AIProviderName::DeepSeek,
                display_name: "DeepSeek".to_string(),
                api_endpoint: "https://api.deepseek.com/v1/chat/completions".to_string(),
                models: vec!["deepseek-chat".to_string(), "deepseek-coder".to_string()],
                supports_streaming: true,
            },
        ]
    }
}
