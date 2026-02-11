// GitBrowser platform abstraction
// Provides platform-specific paths and utilities for Windows, macOS, and Linux.
//
// Uses `cfg(target_os)` for conditional compilation to select the correct
// platform-specific implementation at compile time.

use std::path::PathBuf;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

/// Returns the platform-specific configuration directory for GitBrowser.
///
/// - **Linux**: `~/.config/gitbrowser` (or `$XDG_CONFIG_HOME/gitbrowser`)
/// - **macOS**: `~/Library/Application Support/GitBrowser`
/// - **Windows**: `%APPDATA%/GitBrowser`
pub fn get_config_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        linux::get_config_dir()
    }
    #[cfg(target_os = "macos")]
    {
        macos::get_config_dir()
    }
    #[cfg(target_os = "windows")]
    {
        windows::get_config_dir()
    }
}

/// Returns the platform-specific data directory for GitBrowser.
///
/// - **Linux**: `~/.local/share/gitbrowser` (or `$XDG_DATA_HOME/gitbrowser`)
/// - **macOS**: `~/Library/Application Support/GitBrowser`
/// - **Windows**: `%APPDATA%/GitBrowser`
pub fn get_data_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        linux::get_data_dir()
    }
    #[cfg(target_os = "macos")]
    {
        macos::get_data_dir()
    }
    #[cfg(target_os = "windows")]
    {
        windows::get_data_dir()
    }
}

/// Returns the platform-specific cache directory for GitBrowser.
///
/// - **Linux**: `~/.cache/gitbrowser` (or `$XDG_CACHE_HOME/gitbrowser`)
/// - **macOS**: `~/Library/Caches/GitBrowser`
/// - **Windows**: `%LOCALAPPDATA%/GitBrowser/cache`
pub fn get_cache_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        linux::get_cache_dir()
    }
    #[cfg(target_os = "macos")]
    {
        macos::get_cache_dir()
    }
    #[cfg(target_os = "windows")]
    {
        windows::get_cache_dir()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_dir_returns_path() {
        let config_dir = get_config_dir();
        assert!(!config_dir.as_os_str().is_empty());
        // The path should end with the app name
        let path_str = config_dir.to_string_lossy().to_lowercase();
        assert!(
            path_str.contains("gitbrowser"),
            "Config dir should contain 'gitbrowser': {}",
            path_str
        );
    }

    #[test]
    fn test_data_dir_returns_path() {
        let data_dir = get_data_dir();
        assert!(!data_dir.as_os_str().is_empty());
        let path_str = data_dir.to_string_lossy().to_lowercase();
        assert!(
            path_str.contains("gitbrowser"),
            "Data dir should contain 'gitbrowser': {}",
            path_str
        );
    }

    #[test]
    fn test_cache_dir_returns_path() {
        let cache_dir = get_cache_dir();
        assert!(!cache_dir.as_os_str().is_empty());
        let path_str = cache_dir.to_string_lossy().to_lowercase();
        assert!(
            path_str.contains("gitbrowser"),
            "Cache dir should contain 'gitbrowser': {}",
            path_str
        );
    }

    #[test]
    fn test_config_and_data_dirs_are_distinct_on_linux() {
        // On Linux, config and data dirs should be different
        // On macOS and Windows, they may be the same
        let config_dir = get_config_dir();
        let data_dir = get_data_dir();

        #[cfg(target_os = "linux")]
        assert_ne!(
            config_dir, data_dir,
            "On Linux, config and data dirs should differ"
        );

        // On macOS and Windows, they can be the same — just verify they're valid
        let _ = (config_dir, data_dir);
    }

    #[test]
    fn test_cache_dir_differs_from_config() {
        let config_dir = get_config_dir();
        let cache_dir = get_cache_dir();
        assert_ne!(
            config_dir, cache_dir,
            "Cache dir should differ from config dir"
        );
    }
}
