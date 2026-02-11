use serde::{Deserialize, Serialize};

/// Extracted article content for reader mode.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReaderContent {
    pub title: String,
    /// Cleaned HTML content.
    pub content: String,
    /// Plain text content.
    pub text_content: String,
    pub author: Option<String>,
    pub publish_date: Option<String>,
    pub site_name: Option<String>,
    pub estimated_read_time_minutes: u32,
}

/// User-configurable reader mode display settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReaderSettings {
    pub font_size: u32,
    pub font_family: FontFamily,
    pub background_color: String,
    pub line_height: f32,
    pub max_width: u32,
}

/// Font family options for reader mode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FontFamily {
    Serif,
    SansSerif,
    Monospace,
}
