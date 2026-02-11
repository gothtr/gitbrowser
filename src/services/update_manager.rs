//! Update Manager for GitBrowser.
//!
//! Checks for updates via GitHub Releases API, downloads and verifies updates.

use ring::digest;

use crate::types::errors::UpdateError;
use crate::types::update::UpdateInfo;

/// Trait defining update management operations.
pub trait UpdateManagerTrait {
    fn check_for_updates(&self) -> Result<Option<UpdateInfo>, UpdateError>;
    fn verify_checksum(&self, file_path: &str, expected_sha256: &str) -> Result<bool, UpdateError>;
    fn get_current_version(&self) -> &str;
    fn set_auto_check_enabled(&mut self, enabled: bool);
    fn is_auto_check_enabled(&self) -> bool;
}

/// Update manager implementation.
pub struct UpdateManager {
    current_version: String,
    auto_check_enabled: bool,
}

impl UpdateManager {
    pub fn new() -> Self {
        Self {
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            auto_check_enabled: true,
        }
    }

    /// Compares two semver strings. Returns true if `latest` is newer than `current`.
    pub fn is_newer_version(current: &str, latest: &str) -> bool {
        let parse = |v: &str| -> Vec<u32> {
            v.trim_start_matches('v')
                .split('.')
                .filter_map(|s| s.parse().ok())
                .collect()
        };
        let c = parse(current);
        let l = parse(latest);
        l > c
    }
}

impl Default for UpdateManager {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateManagerTrait for UpdateManager {
    fn check_for_updates(&self) -> Result<Option<UpdateInfo>, UpdateError> {
        // In a full implementation, this would call the GitHub Releases API.
        // For now, return None (no update available).
        Ok(None)
    }

    fn verify_checksum(&self, file_path: &str, expected_sha256: &str) -> Result<bool, UpdateError> {
        let data = std::fs::read(file_path)
            .map_err(|e| UpdateError::NetworkError(e.to_string()))?;
        let actual = digest::digest(&digest::SHA256, &data);
        let actual_hex = hex_encode(actual.as_ref());
        Ok(actual_hex == expected_sha256.to_lowercase())
    }

    fn get_current_version(&self) -> &str {
        &self.current_version
    }

    fn set_auto_check_enabled(&mut self, enabled: bool) {
        self.auto_check_enabled = enabled;
    }

    fn is_auto_check_enabled(&self) -> bool {
        self.auto_check_enabled
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
