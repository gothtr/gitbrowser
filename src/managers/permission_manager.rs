//! Permission Manager for GitBrowser.
//!
//! Manages per-site permission decisions (camera, microphone, geolocation, etc.)
//! stored in SQLite.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use uuid::Uuid;

use crate::database::connection::Database;
use crate::types::errors::PermissionError;
use crate::types::permission::{PermissionType, PermissionValue, SitePermission};

/// Trait defining permission management operations.
pub trait PermissionManagerTrait {
    fn set_permission(&mut self, origin: &str, perm_type: PermissionType, value: PermissionValue) -> Result<(), PermissionError>;
    fn get_permission(&self, origin: &str, perm_type: &PermissionType) -> PermissionValue;
    fn get_site_permissions(&self, origin: &str) -> Result<Vec<SitePermission>, PermissionError>;
    fn list_all_permissions(&self) -> Result<Vec<SitePermission>, PermissionError>;
    fn revoke_permission(&mut self, origin: &str, perm_type: &PermissionType) -> Result<(), PermissionError>;
    fn reset_site_permissions(&mut self, origin: &str) -> Result<(), PermissionError>;
}

fn perm_type_to_str(pt: &PermissionType) -> &'static str {
    match pt {
        PermissionType::Camera => "camera",
        PermissionType::Microphone => "microphone",
        PermissionType::Geolocation => "geolocation",
        PermissionType::Notifications => "notifications",
        PermissionType::Clipboard => "clipboard",
    }
}

fn str_to_perm_type(s: &str) -> PermissionType {
    match s {
        "camera" => PermissionType::Camera,
        "microphone" => PermissionType::Microphone,
        "geolocation" => PermissionType::Geolocation,
        "notifications" => PermissionType::Notifications,
        "clipboard" => PermissionType::Clipboard,
        _ => PermissionType::Camera,
    }
}

fn perm_value_to_str(pv: &PermissionValue) -> &'static str {
    match pv {
        PermissionValue::Allow => "allow",
        PermissionValue::Deny => "deny",
        PermissionValue::Ask => "ask",
    }
}

fn str_to_perm_value(s: &str) -> PermissionValue {
    match s {
        "allow" => PermissionValue::Allow,
        "deny" => PermissionValue::Deny,
        _ => PermissionValue::Ask,
    }
}

/// Permission manager backed by SQLite.
pub struct PermissionManager {
    db: Arc<Database>,
}

impl PermissionManager {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    fn now_ts() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
    }
}

impl PermissionManagerTrait for PermissionManager {
    fn set_permission(&mut self, origin: &str, perm_type: PermissionType, value: PermissionValue) -> Result<(), PermissionError> {
        let conn = self.db.connection();
        let now = Self::now_ts();
        let type_str = perm_type_to_str(&perm_type);
        let value_str = perm_value_to_str(&value);

        // Try update first
        let updated = conn.execute(
            "UPDATE site_permissions SET value = ?1, updated_at = ?2 WHERE origin = ?3 AND permission_type = ?4",
            params![value_str, now, origin, type_str],
        ).map_err(|e| PermissionError::DatabaseError(e.to_string()))?;

        if updated == 0 {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO site_permissions (id, origin, permission_type, value, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, origin, type_str, value_str, now],
            ).map_err(|e| PermissionError::DatabaseError(e.to_string()))?;
        }

        Ok(())
    }

    fn get_permission(&self, origin: &str, perm_type: &PermissionType) -> PermissionValue {
        let conn = self.db.connection();
        let type_str = perm_type_to_str(perm_type);

        conn.query_row(
            "SELECT value FROM site_permissions WHERE origin = ?1 AND permission_type = ?2",
            params![origin, type_str],
            |row| {
                let val: String = row.get(0)?;
                Ok(str_to_perm_value(&val))
            },
        ).unwrap_or(PermissionValue::Ask)
    }

    fn get_site_permissions(&self, origin: &str) -> Result<Vec<SitePermission>, PermissionError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(
            "SELECT origin, permission_type, value, updated_at FROM site_permissions WHERE origin = ?1"
        ).map_err(|e| PermissionError::DatabaseError(e.to_string()))?;

        let perms = stmt.query_map(params![origin], |row| {
            let type_str: String = row.get(1)?;
            let value_str: String = row.get(2)?;
            Ok(SitePermission {
                origin: row.get(0)?,
                permission_type: str_to_perm_type(&type_str),
                value: str_to_perm_value(&value_str),
                updated_at: row.get(3)?,
            })
        }).map_err(|e| PermissionError::DatabaseError(e.to_string()))?;

        let mut result = Vec::new();
        for p in perms {
            result.push(p.map_err(|e| PermissionError::DatabaseError(e.to_string()))?);
        }
        Ok(result)
    }

    fn list_all_permissions(&self) -> Result<Vec<SitePermission>, PermissionError> {
        let conn = self.db.connection();
        let mut stmt = conn.prepare(
            "SELECT origin, permission_type, value, updated_at FROM site_permissions ORDER BY origin"
        ).map_err(|e| PermissionError::DatabaseError(e.to_string()))?;

        let perms = stmt.query_map([], |row| {
            let type_str: String = row.get(1)?;
            let value_str: String = row.get(2)?;
            Ok(SitePermission {
                origin: row.get(0)?,
                permission_type: str_to_perm_type(&type_str),
                value: str_to_perm_value(&value_str),
                updated_at: row.get(3)?,
            })
        }).map_err(|e| PermissionError::DatabaseError(e.to_string()))?;

        let mut result = Vec::new();
        for p in perms {
            result.push(p.map_err(|e| PermissionError::DatabaseError(e.to_string()))?);
        }
        Ok(result)
    }

    fn revoke_permission(&mut self, origin: &str, perm_type: &PermissionType) -> Result<(), PermissionError> {
        self.set_permission(origin, perm_type.clone(), PermissionValue::Ask)
    }

    fn reset_site_permissions(&mut self, origin: &str) -> Result<(), PermissionError> {
        self.db.connection().execute(
            "DELETE FROM site_permissions WHERE origin = ?1",
            params![origin],
        ).map_err(|e| PermissionError::DatabaseError(e.to_string()))?;
        Ok(())
    }
}
