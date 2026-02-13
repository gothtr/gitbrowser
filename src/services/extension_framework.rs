//! Extension Framework for GitBrowser.
//!
//! Manages browser extension lifecycle: install, enable/disable, uninstall,
//! content script matching, and performance impact tracking.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;

use crate::database::connection::Database;
use crate::types::errors::ExtensionError;
use crate::types::extension::{ContentScript, ExtensionInfo, ExtensionManifest, ExtensionPermission};

/// Trait defining extension framework operations.
pub trait ExtensionFrameworkTrait {
    fn install(&mut self, extension_path: &str) -> Result<String, ExtensionError>;
    fn uninstall(&mut self, extension_id: &str) -> Result<(), ExtensionError>;
    fn enable(&mut self, extension_id: &str) -> Result<(), ExtensionError>;
    fn disable(&mut self, extension_id: &str) -> Result<(), ExtensionError>;
    fn get_extension(&self, extension_id: &str) -> Option<&ExtensionInfo>;
    fn list_extensions(&self) -> Vec<&ExtensionInfo>;
    fn measure_performance_impact(&self, extension_id: &str) -> u64;
    /// Returns all content scripts from enabled extensions that match the given URL.
    fn get_content_scripts_for_url(&self, url: &str) -> Vec<MatchedContentScript>;
    /// Check if an extension has a specific permission.
    fn has_permission(&self, extension_id: &str, permission: &ExtensionPermission) -> bool;
    /// Check if an extension has permission to inject content scripts (requires PageContent).
    fn check_content_script_permission(&self, extension_id: &str) -> bool;
}

/// A content script matched to a URL, with resolved file contents.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MatchedContentScript {
    pub extension_id: String,
    pub extension_name: String,
    pub js: Vec<String>,
    pub css: Vec<String>,
    pub run_at: String,
}

/// Extension framework backed by SQLite with in-memory cache.
pub struct ExtensionFramework {
    db: Arc<Database>,
    extensions: Vec<ExtensionInfo>,
}

impl ExtensionFramework {
    pub fn new(db: Arc<Database>) -> Self {
        let mut fw = Self {
            db,
            extensions: Vec::new(),
        };
        fw.load_from_db();
        fw
    }

    fn load_from_db(&mut self) {
        let conn = self.db.connection();
        let stmt = conn.prepare(
            "SELECT id, name, version, enabled, permissions, COALESCE(install_path, ''), COALESCE(content_scripts, '[]') FROM extensions ORDER BY name"
        );

        let mut stmt = match stmt {
            Ok(s) => s,
            Err(_) => {
                // Fallback: try without content_scripts column for older DBs
                let mut stmt2 = conn.prepare(
                    "SELECT id, name, version, enabled, permissions FROM extensions ORDER BY name"
                ).unwrap();
                self.extensions = stmt2.query_map([], |row| {
                    let perms_json: String = row.get(4)?;
                    let permissions: Vec<ExtensionPermission> =
                        serde_json::from_str(&perms_json).unwrap_or_default();
                    Ok(ExtensionInfo {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        version: row.get(2)?,
                        enabled: row.get::<_, i32>(3)? != 0,
                        permissions,
                        performance_impact_ms: 0,
                        install_path: String::new(),
                        content_scripts: Vec::new(),
                    })
                }).unwrap().filter_map(|r| r.ok()).collect();
                return;
            }
        };

        self.extensions = stmt.query_map([], |row| {
            let perms_json: String = row.get(4)?;
            let permissions: Vec<ExtensionPermission> =
                serde_json::from_str(&perms_json).unwrap_or_default();
            let install_path: String = row.get(5)?;
            let cs_json: String = row.get(6)?;
            let content_scripts: Vec<ContentScript> =
                serde_json::from_str(&cs_json).unwrap_or_default();
            Ok(ExtensionInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                version: row.get(2)?,
                enabled: row.get::<_, i32>(3)? != 0,
                permissions,
                performance_impact_ms: 0,
                install_path,
                content_scripts,
            })
        }).unwrap().filter_map(|r| r.ok()).collect();
    }

    fn find_index(&self, id: &str) -> Result<usize, ExtensionError> {
        self.extensions.iter().position(|e| e.id == id)
            .ok_or_else(|| ExtensionError::NotFound(id.to_string()))
    }

    /// Parse a manifest.json from the given extension directory path.
    fn parse_manifest(extension_path: &str) -> Result<ExtensionManifest, ExtensionError> {
        let manifest_path = std::path::Path::new(extension_path).join("manifest.json");
        let content = std::fs::read_to_string(&manifest_path)
            .map_err(|e| ExtensionError::InvalidManifest(format!("Cannot read manifest.json: {}", e)))?;
        let manifest: ExtensionManifest = serde_json::from_str(&content)
            .map_err(|e| ExtensionError::InvalidManifest(format!("Invalid manifest.json: {}", e)))?;
        Ok(manifest)
    }

    /// Read a file from the extension directory, returning its contents as a string.
    /// SEC-09: Canonicalize path and verify it stays within the extension directory.
    fn read_extension_file(base_path: &str, relative: &str) -> Result<String, ExtensionError> {
        let base = std::path::Path::new(base_path)
            .canonicalize()
            .map_err(|e| ExtensionError::LoadError(format!("Invalid base path: {}", e)))?;
        let full = std::path::Path::new(base_path)
            .join(relative)
            .canonicalize()
            .map_err(|e| ExtensionError::LoadError(format!("Cannot resolve {}: {}", relative, e)))?;
        if !full.starts_with(&base) {
            return Err(ExtensionError::LoadError(format!(
                "Path traversal blocked: {} escapes extension directory",
                relative
            )));
        }
        std::fs::read_to_string(&full)
            .map_err(|e| ExtensionError::LoadError(format!("Cannot read {}: {}", relative, e)))
    }
}

/// Check if a URL matches a content script pattern.
/// Supports patterns like: `*://*.example.com/*`, `https://example.com/*`, `<all_urls>`
fn url_matches_pattern(url: &str, pattern: &str) -> bool {
    if pattern == "<all_urls>" {
        return url.starts_with("http://") || url.starts_with("https://");
    }

    // Split pattern into scheme and rest
    let Some((scheme_pat, rest)) = pattern.split_once("://") else {
        return false;
    };

    // Check scheme
    let url_scheme = if url.starts_with("https://") {
        "https"
    } else if url.starts_with("http://") {
        "http"
    } else {
        return false;
    };

    if scheme_pat != "*" && scheme_pat != url_scheme {
        return false;
    }

    // Split rest into host pattern and path pattern
    let (host_pat, path_pat) = match rest.split_once('/') {
        Some((h, p)) => (h, format!("/{}", p)),
        None => (rest, "/".to_string()),
    };

    // Extract URL host and path
    let url_after_scheme = &url[url.find("://").unwrap() + 3..];
    let (url_host, url_path) = match url_after_scheme.find('/') {
        Some(i) => (&url_after_scheme[..i], &url_after_scheme[i..]),
        None => (url_after_scheme, "/"),
    };

    // Match host
    if host_pat != "*" {
        if host_pat.starts_with("*.") {
            let domain = &host_pat[2..];
            if url_host != domain && !url_host.ends_with(&format!(".{}", domain)) {
                return false;
            }
        } else if host_pat != url_host {
            return false;
        }
    }

    // Match path with simple glob
    simple_glob_match(&path_pat, url_path)
}

fn simple_glob_match(pattern: &str, text: &str) -> bool {
    if pattern == "/*" || pattern == "*" {
        return true;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut pos = 0;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() { continue; }
        match text[pos..].find(part) {
            Some(idx) => {
                if i == 0 && idx != 0 { return false; }
                pos += idx + part.len();
            }
            None => return false,
        }
    }
    true
}

impl ExtensionFrameworkTrait for ExtensionFramework {
    fn install(&mut self, extension_path: &str) -> Result<String, ExtensionError> {
        // Try to parse manifest.json; fall back to placeholder if not found
        let (id, name, version, permissions, content_scripts) =
            match Self::parse_manifest(extension_path) {
                Ok(manifest) => (
                    if manifest.id.is_empty() { uuid::Uuid::new_v4().to_string() } else { manifest.id },
                    manifest.name,
                    manifest.version,
                    manifest.permissions,
                    manifest.content_scripts,
                ),
                Err(_) => {
                    let id = uuid::Uuid::new_v4().to_string();
                    let name = extension_path.rsplit('/').next()
                        .or_else(|| extension_path.rsplit('\\').next())
                        .unwrap_or(extension_path)
                        .to_string();
                    (id, name, "1.0.0".to_string(), Vec::new(), Vec::new())
                }
            };

        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        let perms_json = serde_json::to_string(&permissions)
            .map_err(|e| ExtensionError::InvalidManifest(e.to_string()))?;
        let cs_json = serde_json::to_string(&content_scripts)
            .map_err(|e| ExtensionError::InvalidManifest(e.to_string()))?;

        self.db.connection().execute(
            "INSERT INTO extensions (id, name, version, enabled, install_path, permissions, content_scripts, installed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, name, version, 1, extension_path, perms_json, cs_json, now],
        ).map_err(|e| ExtensionError::LoadError(e.to_string()))?;

        let info = ExtensionInfo {
            id: id.clone(),
            name,
            version,
            enabled: true,
            permissions,
            performance_impact_ms: 0,
            install_path: extension_path.to_string(),
            content_scripts,
        };
        self.extensions.push(info);
        Ok(id)
    }

    fn uninstall(&mut self, extension_id: &str) -> Result<(), ExtensionError> {
        let idx = self.find_index(extension_id)?;
        self.db.connection().execute(
            "DELETE FROM extensions WHERE id = ?1",
            params![extension_id],
        ).map_err(|e| ExtensionError::LoadError(e.to_string()))?;
        self.extensions.remove(idx);
        Ok(())
    }

    fn enable(&mut self, extension_id: &str) -> Result<(), ExtensionError> {
        let idx = self.find_index(extension_id)?;
        self.db.connection().execute(
            "UPDATE extensions SET enabled = 1 WHERE id = ?1",
            params![extension_id],
        ).map_err(|e| ExtensionError::LoadError(e.to_string()))?;
        self.extensions[idx].enabled = true;
        Ok(())
    }

    fn disable(&mut self, extension_id: &str) -> Result<(), ExtensionError> {
        let idx = self.find_index(extension_id)?;
        self.db.connection().execute(
            "UPDATE extensions SET enabled = 0 WHERE id = ?1",
            params![extension_id],
        ).map_err(|e| ExtensionError::LoadError(e.to_string()))?;
        self.extensions[idx].enabled = false;
        Ok(())
    }

    fn get_extension(&self, extension_id: &str) -> Option<&ExtensionInfo> {
        self.extensions.iter().find(|e| e.id == extension_id)
    }

    fn list_extensions(&self) -> Vec<&ExtensionInfo> {
        self.extensions.iter().collect()
    }

    fn measure_performance_impact(&self, extension_id: &str) -> u64 {
        self.extensions.iter()
            .find(|e| e.id == extension_id)
            .map(|e| e.performance_impact_ms)
            .unwrap_or(0)
    }

    fn get_content_scripts_for_url(&self, url: &str) -> Vec<MatchedContentScript> {
        let mut result = Vec::new();
        for ext in &self.extensions {
            if !ext.enabled { continue; }
            // FEAT-01: Enforce PageContent permission for content script injection
            if !ext.permissions.contains(&ExtensionPermission::PageContent) {
                continue;
            }
            for cs in &ext.content_scripts {
                let matched = cs.matches.iter().any(|pat| url_matches_pattern(url, pat));
                if !matched { continue; }

                // Read JS and CSS file contents from disk
                let js_contents: Vec<String> = cs.js.iter().filter_map(|f| {
                    Self::read_extension_file(&ext.install_path, f).ok()
                }).collect();
                let css_contents: Vec<String> = cs.css.iter().filter_map(|f| {
                    Self::read_extension_file(&ext.install_path, f).ok()
                }).collect();

                if !js_contents.is_empty() || !css_contents.is_empty() {
                    result.push(MatchedContentScript {
                        extension_id: ext.id.clone(),
                        extension_name: ext.name.clone(),
                        js: js_contents,
                        css: css_contents,
                        run_at: cs.run_at.clone(),
                    });
                }
            }
        }
        result
    }

    fn has_permission(&self, extension_id: &str, permission: &ExtensionPermission) -> bool {
        self.extensions.iter()
            .find(|e| e.id == extension_id)
            .map(|e| e.permissions.contains(permission))
            .unwrap_or(false)
    }

    fn check_content_script_permission(&self, extension_id: &str) -> bool {
        self.has_permission(extension_id, &ExtensionPermission::PageContent)
    }
}
