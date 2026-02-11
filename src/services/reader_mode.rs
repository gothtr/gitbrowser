//! Reader Mode for GitBrowser.
//!
//! Extracts article content from web pages and formats it for distraction-free reading.

use crate::types::errors::ReaderError;
use crate::types::reader::{FontFamily, ReaderContent, ReaderSettings};

/// Trait defining reader mode operations.
pub trait ReaderModeTrait {
    fn is_article_page(&self, html: &str, url: &str) -> bool;
    fn extract_content(&self, html: &str, url: &str) -> Result<ReaderContent, ReaderError>;
    fn format_for_display(&self, content: &ReaderContent, settings: &ReaderSettings) -> String;
    fn update_settings(&mut self, settings: ReaderSettings);
    fn get_settings(&self) -> &ReaderSettings;
}

/// Reader mode implementation using heuristic content extraction.
pub struct ReaderMode {
    settings: ReaderSettings,
}

impl ReaderMode {
    pub fn new() -> Self {
        Self {
            settings: ReaderSettings {
                font_size: 18,
                font_family: FontFamily::SansSerif,
                background_color: "#ffffff".to_string(),
                line_height: 1.6,
                max_width: 680,
            },
        }
    }

    /// Estimates reading time based on word count (~200 words/min).
    fn estimate_read_time(text: &str) -> u32 {
        let word_count = text.split_whitespace().count();
        ((word_count as f64) / 200.0).ceil().max(1.0) as u32
    }

    /// Strips HTML tags to get plain text.
    fn strip_tags(html: &str) -> String {
        let mut result = String::with_capacity(html.len());
        let mut in_tag = false;
        for ch in html.chars() {
            match ch {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => result.push(ch),
                _ => {}
            }
        }
        result
    }

    /// Extracts content between a given tag pair.
    fn extract_between_tags(html: &str, tag: &str) -> Option<String> {
        let open = format!("<{}", tag);
        let close = format!("</{}>", tag);
        if let Some(start_idx) = html.find(&open) {
            if let Some(tag_end) = html[start_idx..].find('>') {
                let content_start = start_idx + tag_end + 1;
                if let Some(end_idx) = html[content_start..].find(&close) {
                    return Some(html[content_start..content_start + end_idx].to_string());
                }
            }
        }
        None
    }
}

impl Default for ReaderMode {
    fn default() -> Self {
        Self::new()
    }
}

impl ReaderModeTrait for ReaderMode {
    fn is_article_page(&self, html: &str, _url: &str) -> bool {
        let html_lower = html.to_lowercase();
        let has_article_tag = html_lower.contains("<article");
        let text = Self::strip_tags(html);
        let text_len = text.len();
        let html_len = html.len();

        // Heuristic: article tag present, or high text-to-HTML ratio with sufficient length
        if has_article_tag {
            return true;
        }

        if html_len > 0 {
            let ratio = text_len as f64 / html_len as f64;
            return ratio > 0.3 && text_len > 500;
        }

        false
    }

    fn extract_content(&self, html: &str, _url: &str) -> Result<ReaderContent, ReaderError> {
        // Try to extract from <article> tag first
        let content_html = Self::extract_between_tags(html, "article")
            .or_else(|| Self::extract_between_tags(html, "main"))
            .or_else(|| Self::extract_between_tags(html, "body"))
            .ok_or(ReaderError::NotAnArticle)?;

        let text_content = Self::strip_tags(&content_html);
        if text_content.trim().len() < 100 {
            return Err(ReaderError::NotAnArticle);
        }

        // Try to extract title
        let title = Self::extract_between_tags(html, "title")
            .map(|t| Self::strip_tags(&t))
            .unwrap_or_else(|| "Untitled".to_string());

        let estimated_read_time = Self::estimate_read_time(&text_content);

        Ok(ReaderContent {
            title,
            content: content_html,
            text_content,
            author: None,
            publish_date: None,
            site_name: None,
            estimated_read_time_minutes: estimated_read_time,
        })
    }

    fn format_for_display(&self, content: &ReaderContent, settings: &ReaderSettings) -> String {
        let font_family = match settings.font_family {
            FontFamily::Serif => "Georgia, 'Times New Roman', serif",
            FontFamily::SansSerif => "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
            FontFamily::Monospace => "'SF Mono', 'Fira Code', monospace",
        };

        format!(
            r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body {{ font-family: {}; font-size: {}px; line-height: {}; background: {}; max-width: {}px; margin: 0 auto; padding: 2em; color: #24292f; }}
h1 {{ font-size: 1.8em; margin-bottom: 0.5em; }}
.meta {{ color: #656d76; margin-bottom: 2em; }}
</style></head><body>
<h1>{}</h1>
<div class="meta">{} min read</div>
<div class="content">{}</div>
</body></html>"#,
            font_family, settings.font_size, settings.line_height,
            settings.background_color, settings.max_width,
            content.title, content.estimated_read_time_minutes, content.content
        )
    }

    fn update_settings(&mut self, settings: ReaderSettings) {
        self.settings = settings;
    }

    fn get_settings(&self) -> &ReaderSettings {
        &self.settings
    }
}
