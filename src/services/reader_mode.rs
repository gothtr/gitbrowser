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

    /// SEC-10: Escape HTML special characters to prevent XSS in text content.
    fn escape_html(input: &str) -> String {
        let mut result = String::with_capacity(input.len());
        for ch in input.chars() {
            match ch {
                '&' => result.push_str("&amp;"),
                '<' => result.push_str("&lt;"),
                '>' => result.push_str("&gt;"),
                '"' => result.push_str("&quot;"),
                '\'' => result.push_str("&#x27;"),
                _ => result.push(ch),
            }
        }
        result
    }

    /// SEC-10: Sanitize HTML content by removing dangerous elements and attributes.
    fn sanitize_html(html: &str) -> String {
        let mut result = html.to_string();

        // Remove <script>...</script> tags and their content (case-insensitive)
        loop {
            let lower = result.to_lowercase();
            if let Some(start) = lower.find("<script") {
                if let Some(end) = lower[start..].find("</script>") {
                    let remove_end = start + end + "</script>".len();
                    result = format!("{}{}", &result[..start], &result[remove_end..]);
                    continue;
                } else {
                    // Unclosed script tag — remove from <script to end
                    result = result[..start].to_string();
                    break;
                }
            }
            break;
        }

        // Remove on* event handler attributes (e.g. onclick, onerror, onload)
        let on_attr_re_patterns = [
            "onerror", "onclick", "onload", "onmouseover", "onfocus", "onblur",
            "onsubmit", "onchange", "oninput", "onkeydown", "onkeyup", "onkeypress",
            "onmousedown", "onmouseup", "onmouseenter", "onmouseleave", "oncontextmenu",
            "ondblclick", "ondrag", "ondrop", "onresize", "onscroll", "onwheel",
        ];
        for attr in &on_attr_re_patterns {
            loop {
                let lower = result.to_lowercase();
                if let Some(pos) = lower.find(attr) {
                    // Check it's inside a tag (preceded by space or quote)
                    if pos > 0 {
                        let before = result.as_bytes()[pos - 1];
                        if before == b' ' || before == b'"' || before == b'\'' || before == b'\t' || before == b'\n' {
                            // Find the end of the attribute value
                            if let Some(eq_pos) = lower[pos..].find('=') {
                                let after_eq = pos + eq_pos + 1;
                                let rest = &result[after_eq..].trim_start();
                                let attr_end = if rest.starts_with('"') {
                                    rest[1..].find('"').map(|i| after_eq + (result.len() - after_eq - rest.len()) + 1 + i + 1)
                                } else if rest.starts_with('\'') {
                                    rest[1..].find('\'').map(|i| after_eq + (result.len() - after_eq - rest.len()) + 1 + i + 1)
                                } else {
                                    rest.find(|c: char| c.is_whitespace() || c == '>')
                                        .map(|i| after_eq + (result.len() - after_eq - rest.len()) + i)
                                };
                                if let Some(end) = attr_end {
                                    result = format!("{}{}", &result[..pos - 1], &result[end..]);
                                    continue;
                                }
                            }
                        }
                    }
                    // Not a real attribute match, skip past it
                    break;
                }
                break;
            }
        }

        // Remove javascript: URLs in href/src attributes
        let result_lower = result.to_lowercase();
        if result_lower.contains("javascript:") {
            // Simple replacement: replace javascript: with blocked:
            let mut out = String::with_capacity(result.len());
            let mut i = 0;
            let bytes = result.as_bytes();
            while i < bytes.len() {
                if i + 11 <= bytes.len() && result[i..i + 11].eq_ignore_ascii_case("javascript:") {
                    out.push_str("blocked:");
                    i += 11;
                } else {
                    out.push(bytes[i] as char);
                    i += 1;
                }
            }
            result = out;
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

        // SEC-10: HTML-escape the title to prevent XSS
        let safe_title = Self::escape_html(&content.title);
        // SEC-10: Sanitize content HTML (strip script tags, event handlers, javascript: URLs)
        let safe_content = Self::sanitize_html(&content.content);

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
            safe_title, content.estimated_read_time_minutes, safe_content
        )
    }

    fn update_settings(&mut self, settings: ReaderSettings) {
        self.settings = settings;
    }

    fn get_settings(&self) -> &ReaderSettings {
        &self.settings
    }
}
