use serde::{Deserialize, Serialize};

/// Types of device permissions a site can request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PermissionType {
    Camera,
    Microphone,
    Geolocation,
    Notifications,
    Clipboard,
}

/// The value/decision for a site permission.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum PermissionValue {
    Allow,
    Deny,
    Ask,
}

/// A stored permission decision for a specific site and permission type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SitePermission {
    pub origin: String,
    pub permission_type: PermissionType,
    pub value: PermissionValue,
    pub updated_at: i64,
}
