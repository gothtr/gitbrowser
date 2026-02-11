use serde::{Deserialize, Serialize};

/// Supported AI provider names.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AIProviderName {
    OpenRouter,
    OpenAI,
    Anthropic,
    DeepSeek,
}

/// Configuration for an active AI provider connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIProvider {
    pub name: AIProviderName,
    pub model: String,
    pub api_endpoint: String,
    pub max_tokens: u32,
}

/// Context passed to the AI assistant from the current page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIContext {
    pub selected_text: Option<String>,
    pub page_content: Option<String>,
    pub page_url: Option<String>,
}

/// A single message in the AI chat history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIChatMessage {
    pub id: String,
    pub role: ChatRole,
    pub content: String,
    pub timestamp: i64,
    pub provider: AIProviderName,
    pub model: String,
    pub tokens_used: Option<u32>,
    pub cost: Option<f64>,
}

/// Role of a participant in an AI chat conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

/// Aggregated token usage statistics.
#[derive(Debug, Clone)]
pub struct TokenUsage {
    pub total_tokens: u64,
    pub total_cost: f64,
}

/// Static configuration for an AI provider including available models.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIProviderConfig {
    pub name: AIProviderName,
    pub display_name: String,
    pub api_endpoint: String,
    pub models: Vec<String>,
    pub supports_streaming: bool,
}
