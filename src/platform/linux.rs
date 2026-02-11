// GitBrowser platform paths for Linux
// Config: ~/.config/gitbrowser
// Data:   ~/.local/share/gitbrowser
// Cache:  ~/.cache/gitbrowser

use std::env;
use std::path::PathBuf;

/// Returns the configuration directory for GitBrowser on Linux.
/// Uses `$XDG_CONFIG_HOME/gitbrowser` if set, otherwise `~/.config/gitbrowser`.
pub fn get_config_dir() -> PathBuf {
    if let Ok(xdg) = env::var("XDG_CONFIG_HOME") {
        PathBuf::from(xdg).join("gitbrowser")
    } else {
        let home = env::var("HOME").unwrap_or_else(|_| String::from("/tmp"));
        PathBuf::from(home).join(".config").join("gitbrowser")
    }
}

/// Returns the data directory for GitBrowser on Linux.
/// Uses `$XDG_DATA_HOME/gitbrowser` if set, otherwise `~/.local/share/gitbrowser`.
pub fn get_data_dir() -> PathBuf {
    if let Ok(xdg) = env::var("XDG_DATA_HOME") {
        PathBuf::from(xdg).join("gitbrowser")
    } else {
        let home = env::var("HOME").unwrap_or_else(|_| String::from("/tmp"));
        PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("gitbrowser")
    }
}

/// Returns the cache directory for GitBrowser on Linux.
/// Uses `$XDG_CACHE_HOME/gitbrowser` if set, otherwise `~/.cache/gitbrowser`.
pub fn get_cache_dir() -> PathBuf {
    if let Ok(xdg) = env::var("XDG_CACHE_HOME") {
        PathBuf::from(xdg).join("gitbrowser")
    } else {
        let home = env::var("HOME").unwrap_or_else(|_| String::from("/tmp"));
        PathBuf::from(home).join(".cache").join("gitbrowser")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_dir_default() {
        // Temporarily remove XDG_CONFIG_HOME to test default path
        let original = env::var("XDG_CONFIG_HOME").ok();
        env::remove_var("XDG_CONFIG_HOME");

        let config_dir = get_config_dir();
        let home = env::var("HOME").unwrap_or_else(|_| String::from("/tmp"));
        assert_eq!(
            config_dir,
            PathBuf::from(&home).join(".config").join("gitbrowser")
        );

        // Restore
        if let Some(val) = original {
            env::set_var("XDG_CONFIG_HOME", val);
        }
    }

    #[test]
    fn test_config_dir_with_xdg() {
        let original = env::var("XDG_CONFIG_HOME").ok();
        env::set_var("XDG_CONFIG_HOME", "/custom/config");

        let config_dir = get_config_dir();
        assert_eq!(config_dir, PathBuf::from("/custom/config/gitbrowser"));

        // Restore
        match original {
            Some(val) => env::set_var("XDG_CONFIG_HOME", val),
            None => env::remove_var("XDG_CONFIG_HOME"),
        }
    }

    #[test]
    fn test_data_dir_default() {
        let original = env::var("XDG_DATA_HOME").ok();
        env::remove_var("XDG_DATA_HOME");

        let data_dir = get_data_dir();
        let home = env::var("HOME").unwrap_or_else(|_| String::from("/tmp"));
        assert_eq!(
            data_dir,
            PathBuf::from(&home)
                .join(".local")
                .join("share")
                .join("gitbrowser")
        );

        if let Some(val) = original {
            env::set_var("XDG_DATA_HOME", val);
        }
    }

    #[test]
    fn test_cache_dir_default() {
        let original = env::var("XDG_CACHE_HOME").ok();
        env::remove_var("XDG_CACHE_HOME");

        let cache_dir = get_cache_dir();
        let home = env::var("HOME").unwrap_or_else(|_| String::from("/tmp"));
        assert_eq!(
            cache_dir,
            PathBuf::from(&home).join(".cache").join("gitbrowser")
        );

        if let Some(val) = original {
            env::set_var("XDG_CACHE_HOME", val);
        }
    }
}
