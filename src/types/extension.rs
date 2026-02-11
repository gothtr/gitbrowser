use serde::{Deserialize, Serialize};

/// Manifest describing an extension's metadata and capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub permissions: Vec<ExtensionPermission>,
    pub background: Option<String>,
    pub content_scripts: Option<Vec<ContentScript>>,
    pub toolbar_button: Option<ToolbarButton>,
}

/// Permissions an extension can request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ExtensionPermission {
    PageContent,
    Storage,
    Toolbar,
    Tabs,
    Network,
}

/// A content script injected into matching pages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentScript {
    pub matches: Vec<String>,
    pub js: Vec<String>,
    pub css: Option<Vec<String>>,
}

/// Configuration for an extension's toolbar button.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolbarButton {
    pub icon: String,
    pub title: String,
    pub popup: Option<String>,
}

/// Runtime information about an installed extension.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub permissions: Vec<ExtensionPermission>,
    pub performance_impact_ms: u64,
}
