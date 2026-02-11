use serde::{Deserialize, Serialize};

/// Represents a browser tab with its current state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tab {
    pub id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub pinned: bool,
    pub muted: bool,
    pub loading: bool,
    pub crashed: bool,
    pub scroll_position: ScrollPosition,
    pub created_at: i64,
}

/// Scroll position within a web page.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ScrollPosition {
    pub x: f64,
    pub y: f64,
}
