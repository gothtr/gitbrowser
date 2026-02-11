use serde::{Deserialize, Serialize};

/// Represents a single history entry for a visited page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: String,
    pub url: String,
    pub title: String,
    pub visit_time: i64,
    pub visit_count: i32,
}
