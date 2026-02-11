use serde::{Deserialize, Serialize};

/// Manifest describing an extension's metadata and capabilities.
/// Corresponds to the `manifest.json` file in an extension directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub homepage_url: String,
    pub permissions: Vec<ExtensionPermission>,
    /// Path to the background script (relative to extension root).
    pub background: Option<String>,
    /// Content scripts to inject into matching pages.
    #[serde(default)]
    pub content_scripts: Vec<ContentScript>,
    /// Toolbar button configuration.
    pub toolbar_button: Option<ToolbarButton>,
    /// Minimum GitBrowser version required.
    #[serde(default)]
    pub min_browser_version: String,
}

/// Permissions an extension can request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionPermission {
    /// Access to page content via content scripts.
    PageContent,
    /// Local key-value storage for the extension.
    Storage,
    /// Ability to add a toolbar button.
    Toolbar,
    /// Access to tab management APIs.
    Tabs,
    /// Ability to make network requests.
    Network,
    /// Access to bookmark APIs.
    Bookmarks,
    /// Ability to show notifications.
    Notifications,
}

/// A content script injected into matching pages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentScript {
    /// URL match patterns (glob-style). E.g. `["*://*.github.com/*"]`
    pub matches: Vec<String>,
    /// JavaScript files to inject (relative to extension root).
    #[serde(default)]
    pub js: Vec<String>,
    /// CSS files to inject (relative to extension root).
    #[serde(default)]
    pub css: Vec<String>,
    /// When to inject: "document_start", "document_end", or "document_idle" (default).
    #[serde(default = "default_run_at")]
    pub run_at: String,
}

fn default_run_at() -> String {
    "document_idle".to_string()
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
    /// Path where the extension is installed on disk.
    #[serde(default)]
    pub install_path: String,
    /// Parsed content scripts from the manifest.
    #[serde(default)]
    pub content_scripts: Vec<ContentScript>,
}
