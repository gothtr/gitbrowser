//! Unit tests for the AI Assistant.
//!
//! Tests API key storage/retrieval, chat history, provider config, and rekey.
//!
//! Covers: TEST-05 from AUDIT.md Phase 3.

use std::sync::Arc;

use gitbrowser::database::Database;
use gitbrowser::services::ai_assistant::{AIAssistant, AIAssistantTrait};
use gitbrowser::services::crypto_service::{CryptoService, CryptoServiceTrait};
use gitbrowser::types::ai::{AIProvider, AIProviderName};

fn setup() -> AIAssistant {
    let db = Arc::new(Database::open_in_memory().unwrap());
    AIAssistant::new(db).unwrap()
}

// ─── API Key Storage ───

#[test]
fn test_set_and_get_api_key() {
    let mut ai = setup();
    ai.set_api_key(&AIProviderName::OpenAI, "sk-test123").unwrap();

    let key = ai.get_api_key(&AIProviderName::OpenAI).unwrap();
    assert_eq!(key, Some("sk-test123".to_string()));
}

#[test]
fn test_get_api_key_when_none() {
    let ai = setup();
    let key = ai.get_api_key(&AIProviderName::Anthropic).unwrap();
    assert_eq!(key, None);
}

#[test]
fn test_set_api_key_overwrites() {
    let mut ai = setup();
    ai.set_api_key(&AIProviderName::OpenAI, "sk-first").unwrap();
    ai.set_api_key(&AIProviderName::OpenAI, "sk-second").unwrap();

    let key = ai.get_api_key(&AIProviderName::OpenAI).unwrap();
    assert_eq!(key, Some("sk-second".to_string()));
}

#[test]
fn test_multiple_provider_keys_independent() {
    let mut ai = setup();
    ai.set_api_key(&AIProviderName::OpenAI, "sk-openai").unwrap();
    ai.set_api_key(&AIProviderName::Anthropic, "sk-anthropic").unwrap();
    ai.set_api_key(&AIProviderName::DeepSeek, "sk-deepseek").unwrap();

    assert_eq!(ai.get_api_key(&AIProviderName::OpenAI).unwrap(), Some("sk-openai".to_string()));
    assert_eq!(ai.get_api_key(&AIProviderName::Anthropic).unwrap(), Some("sk-anthropic".to_string()));
    assert_eq!(ai.get_api_key(&AIProviderName::DeepSeek).unwrap(), Some("sk-deepseek".to_string()));
}

// ─── Chat History ───

#[test]
fn test_chat_history_initially_empty() {
    let ai = setup();
    let history = ai.get_chat_history().unwrap();
    assert!(history.is_empty());
}

#[test]
fn test_clear_chat_history() {
    let mut ai = setup();
    // History is empty, clear should succeed without error
    ai.clear_chat_history().unwrap();
    assert!(ai.get_chat_history().unwrap().is_empty());
}

// ─── Token Usage ───

#[test]
fn test_token_usage_initially_zero() {
    let ai = setup();
    let usage = ai.get_token_usage();
    assert_eq!(usage.total_tokens, 0);
    assert_eq!(usage.total_cost, 0.0);
}

// ─── Available Providers ───

#[test]
fn test_available_providers() {
    let ai = setup();
    let providers = ai.get_available_providers();
    assert!(providers.len() >= 4);

    let names: Vec<_> = providers.iter().map(|p| &p.name).collect();
    assert!(names.contains(&&AIProviderName::OpenAI));
    assert!(names.contains(&&AIProviderName::Anthropic));
    assert!(names.contains(&&AIProviderName::DeepSeek));
    assert!(names.contains(&&AIProviderName::OpenRouter));

    // Each provider should have at least one model
    for p in &providers {
        assert!(!p.models.is_empty(), "{} should have models", p.display_name);
        assert!(!p.api_endpoint.is_empty());
    }
}

// ─── Set Provider ───

#[test]
fn test_set_provider() {
    let mut ai = setup();
    ai.set_provider(AIProvider {
        name: AIProviderName::OpenAI,
        model: "gpt-4o".to_string(),
        api_endpoint: "https://api.openai.com/v1/chat/completions".to_string(),
        max_tokens: 4096,
    });
    // No getter for active_provider, but set_provider should not panic
}

// ─── Rekey with Master ───

#[test]
fn test_rekey_preserves_api_keys() {
    let mut ai = setup();
    ai.set_api_key(&AIProviderName::OpenAI, "sk-original").unwrap();
    ai.set_api_key(&AIProviderName::Anthropic, "sk-anthro").unwrap();

    let crypto = CryptoService::new();
    let salt = crypto.generate_salt();
    let master_key = crypto.derive_key("master_pass", &salt).unwrap();

    ai.rekey_with_master(&master_key).unwrap();

    // Keys should still be retrievable after rekey
    assert_eq!(ai.get_api_key(&AIProviderName::OpenAI).unwrap(), Some("sk-original".to_string()));
    assert_eq!(ai.get_api_key(&AIProviderName::Anthropic).unwrap(), Some("sk-anthro".to_string()));
}

#[test]
fn test_rekey_without_keys_succeeds() {
    let mut ai = setup();
    let crypto = CryptoService::new();
    let salt = crypto.generate_salt();
    let master_key = crypto.derive_key("master", &salt).unwrap();

    // Rekey with no keys stored should be a no-op
    ai.rekey_with_master(&master_key).unwrap();
}
