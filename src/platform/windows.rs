// GitBrowser platform paths for Windows
// Config: %APPDATA%/GitBrowser
// Data:   %APPDATA%/GitBrowser
// Cache:  %LOCALAPPDATA%/GitBrowser/cache

use std::env;
use std::path::PathBuf;

/// Returns the configuration directory for GitBrowser on Windows.
/// `%APPDATA%/GitBrowser`
pub fn get_config_dir() -> PathBuf {
    let appdata =
        env::var("APPDATA").unwrap_or_else(|_| String::from("C:\\Users\\Default\\AppData\\Roaming"));
    PathBuf::from(appdata).join("GitBrowser")
}

/// Returns the data directory for GitBrowser on Windows.
/// `%APPDATA%/GitBrowser`
pub fn get_data_dir() -> PathBuf {
    let appdata =
        env::var("APPDATA").unwrap_or_else(|_| String::from("C:\\Users\\Default\\AppData\\Roaming"));
    PathBuf::from(appdata).join("GitBrowser")
}

/// Returns the cache directory for GitBrowser on Windows.
/// `%LOCALAPPDATA%/GitBrowser/cache`
pub fn get_cache_dir() -> PathBuf {
    let local_appdata = env::var("LOCALAPPDATA")
        .unwrap_or_else(|_| String::from("C:\\Users\\Default\\AppData\\Local"));
    PathBuf::from(local_appdata)
        .join("GitBrowser")
        .join("cache")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_dir_with_appdata() {
        let config_dir = get_config_dir();
        // Config dir should always end with "GitBrowser"
        assert_eq!(config_dir.file_name().unwrap(), "GitBrowser");
        // Should be under APPDATA
        let appdata = env::var("APPDATA")
            .unwrap_or_else(|_| String::from("C:\\Users\\Default\\AppData\\Roaming"));
        assert!(config_dir.starts_with(&appdata));
    }

    #[test]
    fn test_data_dir_same_as_config() {
        let config_dir = get_config_dir();
        let data_dir = get_data_dir();
        assert_eq!(config_dir, data_dir);
    }

    #[test]
    fn test_cache_dir_with_localappdata() {
        let cache_dir = get_cache_dir();
        // Cache dir should end with "GitBrowser/cache"
        assert_eq!(cache_dir.file_name().unwrap(), "cache");
        assert_eq!(cache_dir.parent().unwrap().file_name().unwrap(), "GitBrowser");
    }

    #[test]
    fn test_cache_dir_differs_from_config() {
        let config_dir = get_config_dir();
        let cache_dir = get_cache_dir();
        assert_ne!(config_dir, cache_dir);
    }
}
