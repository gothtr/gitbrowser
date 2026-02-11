//! Extension Framework for GitBrowser.
//!
//! Manages browser extension lifecycle: install, enable/disable, uninstall,
//! and performance impact tracking.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;

use crate::database::connection::Database;
use crate::types::errors::ExtensionError;
use crate::types::extension::{ExtensionInfo, ExtensionPermission};

/// Trait defining extension framework operations.
pub trait ExtensionFrameworkTrait {
    fn install(&mut self, extension_path: &str) -> Result<String, ExtensionError>;
    fn uninstall(&mut self, extension_id: &str) -> Result<(), ExtensionError>;
    fn enable(&mut self, extension_id: &str) -> Result<(), ExtensionError>;
    fn disable(&mut self, extension_id: &str) -> Result<(), ExtensionError>;
    fn get_extension(&self, extension_id: &str) -> Option<&ExtensionInfo>;
    fn list_extensions(&self) -> Vec<&ExtensionInfo>;
    fn measure_performance_impact(&self, extension_id: &str) -> u64;
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
        let mut stmt = conn.prepare(
            "SELECT id, name, version, enabled, permissions FROM extensions ORDER BY name"
        ).unwrap();

        self.extensions = stmt.query_map([], |row| {
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
            })
        }).unwrap().filter_map(|r| r.ok()).collect();
    }

    fn find_index(&self, id: &str) -> Result<usize, ExtensionError> {
        self.extensions.iter().position(|e| e.id == id)
            .ok_or_else(|| ExtensionError::NotFound(id.to_string()))
    }
}

impl ExtensionFrameworkTrait for ExtensionFramework {
    fn install(&mut self, extension_path: &str) -> Result<String, ExtensionError> {
        // In a full implementation, this would read the manifest from the path.
        // For now, create a placeholder extension from the path name.
        let id = uuid::Uuid::new_v4().to_string();
        let name = extension_path.rsplit('/').next()
            .or_else(|| extension_path.rsplit('\\').next())
            .unwrap_or(extension_path)
            .to_string();

        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
        let permissions: Vec<ExtensionPermission> = Vec::new();
        let perms_json = serde_json::to_string(&permissions)
            .map_err(|e| ExtensionError::InvalidManifest(e.to_string()))?;

        self.db.connection().execute(
            "INSERT INTO extensions (id, name, version, enabled, install_path, permissions, installed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, name, "1.0.0", 1, extension_path, perms_json, now],
        ).map_err(|e| ExtensionError::LoadError(e.to_string()))?;

        let info = ExtensionInfo {
            id: id.clone(),
            name,
            version: "1.0.0".to_string(),
            enabled: true,
            permissions,
            performance_impact_ms: 0,
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
}
