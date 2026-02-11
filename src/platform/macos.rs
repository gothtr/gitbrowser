// GitBrowser platform paths for macOS
// Config: ~/Library/Application Support/GitBrowser
// Data:   ~/Library/Application Support/GitBrowser
// Cache:  ~/Library/Caches/GitBrowser

use std::env;
use std::path::PathBuf;

/// Returns the home directory on macOS.
fn home_dir() -> PathBuf {
    PathBuf::from(env::var("HOME").unwrap_or_else(|_| String::from("/tmp")))
}

/// Returns the configuration directory for GitBrowser on macOS.
/// `~/Library/Application Support/GitBrowser`
pub fn get_config_dir() -> PathBuf {
    home_dir()
        .join("Library")
        .join("Application Support")
        .join("GitBrowser")
}

/// Returns the data directory for GitBrowser on macOS.
/// `~/Library/Application Support/GitBrowser`
pub fn get_data_dir() -> PathBuf {
    home_dir()
        .join("Library")
        .join("Application Support")
        .join("GitBrowser")
}

/// Returns the cache directory for GitBrowser on macOS.
/// `~/Library/Caches/GitBrowser`
pub fn get_cache_dir() -> PathBuf {
    home_dir().join("Library").join("Caches").join("GitBrowser")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_dir() {
        let config_dir = get_config_dir();
        let home = env::var("HOME").unwrap_or_else(|_| String::from("/tmp"));
        assert_eq!(
            config_dir,
            PathBuf::from(&home)
                .join("Library")
                .join("Application Support")
                .join("GitBrowser")
        );
    }

    #[test]
    fn test_data_dir_same_as_config() {
        let config_dir = get_config_dir();
        let data_dir = get_data_dir();
        assert_eq!(config_dir, data_dir);
    }

    #[test]
    fn test_cache_dir() {
        let cache_dir = get_cache_dir();
        let home = env::var("HOME").unwrap_or_else(|_| String::from("/tmp"));
        assert_eq!(
            cache_dir,
            PathBuf::from(&home)
                .join("Library")
                .join("Caches")
                .join("GitBrowser")
        );
    }

    #[test]
    fn test_cache_dir_differs_from_config() {
        let config_dir = get_config_dir();
        let cache_dir = get_cache_dir();
        assert_ne!(config_dir, cache_dir);
    }
}
