use serde::{Deserialize, Serialize};

/// Represents a saved bookmark.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub url: String,
    pub title: String,
    pub folder_id: Option<String>,
    pub position: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Represents a folder for organizing bookmarks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookmarkFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub position: i32,
}
