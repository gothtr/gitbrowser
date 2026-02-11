use serde::{Deserialize, Serialize};

use super::tab::ScrollPosition;

/// Complete session data for save/restore.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionData {
    pub tabs: Vec<SessionTab>,
    pub active_tab_id: Option<String>,
    pub window_bounds: WindowBounds,
    pub timestamp: i64,
}

/// A tab's state as stored in a session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionTab {
    pub id: String,
    pub url: String,
    pub title: String,
    pub pinned: bool,
    pub scroll_position: ScrollPosition,
}

/// Window position and size.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
