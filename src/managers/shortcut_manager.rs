//! Shortcut Manager for GitBrowser.
//!
//! Manages keyboard shortcut bindings with conflict detection
//! and platform-specific modifier key adaptation.

use std::collections::HashMap;

use crate::types::errors::ShortcutError;

/// Trait defining shortcut management operations.
pub trait ShortcutManagerTrait {
    fn register_shortcut(&mut self, action: &str, keys: &str) -> Result<(), ShortcutError>;
    fn unregister_shortcut(&mut self, action: &str) -> Result<(), ShortcutError>;
    fn get_shortcut(&self, action: &str) -> Option<&str>;
    fn list_shortcuts(&self) -> &HashMap<String, String>;
    fn reset_to_defaults(&mut self) -> Result<(), ShortcutError>;
    fn has_conflict(&self, keys: &str, exclude_action: Option<&str>) -> Option<String>;
    fn get_default_shortcuts(&self) -> HashMap<String, String>;
}

/// Shortcut manager with in-memory storage and platform adaptation.
pub struct ShortcutManager {
    shortcuts: HashMap<String, String>,
}

impl ShortcutManager {
    pub fn new() -> Self {
        let mut mgr = Self {
            shortcuts: HashMap::new(),
        };
        let defaults = mgr.get_default_shortcuts();
        mgr.shortcuts = defaults;
        mgr
    }

    /// Adapts modifier keys for the current platform.
    fn adapt_for_platform(keys: &str) -> String {
        if cfg!(target_os = "macos") {
            keys.replace("Ctrl+", "Cmd+")
        } else {
            keys.to_string()
        }
    }
}

impl Default for ShortcutManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ShortcutManagerTrait for ShortcutManager {
    fn register_shortcut(&mut self, action: &str, keys: &str) -> Result<(), ShortcutError> {
        if keys.is_empty() {
            return Err(ShortcutError::InvalidKeys("Keys cannot be empty".to_string()));
        }

        if let Some(conflicting_action) = self.has_conflict(keys, Some(action)) {
            return Err(ShortcutError::Conflict(format!(
                "'{}' is already bound to '{}'", keys, conflicting_action
            )));
        }

        let adapted = Self::adapt_for_platform(keys);
        self.shortcuts.insert(action.to_string(), adapted);
        Ok(())
    }

    fn unregister_shortcut(&mut self, action: &str) -> Result<(), ShortcutError> {
        self.shortcuts.remove(action)
            .map(|_| ())
            .ok_or_else(|| ShortcutError::NotFound(action.to_string()))
    }

    fn get_shortcut(&self, action: &str) -> Option<&str> {
        self.shortcuts.get(action).map(|s| s.as_str())
    }

    fn list_shortcuts(&self) -> &HashMap<String, String> {
        &self.shortcuts
    }

    fn reset_to_defaults(&mut self) -> Result<(), ShortcutError> {
        self.shortcuts = self.get_default_shortcuts();
        Ok(())
    }

    fn has_conflict(&self, keys: &str, exclude_action: Option<&str>) -> Option<String> {
        let adapted = Self::adapt_for_platform(keys);
        for (action, bound_keys) in &self.shortcuts {
            if bound_keys == &adapted {
                if let Some(exclude) = exclude_action {
                    if action == exclude {
                        continue;
                    }
                }
                return Some(action.clone());
            }
        }
        None
    }

    fn get_default_shortcuts(&self) -> HashMap<String, String> {
        let defaults = vec![
            ("new_tab", "Ctrl+T"),
            ("close_tab", "Ctrl+W"),
            ("reload", "Ctrl+R"),
            ("hard_reload", "Ctrl+Shift+R"),
            ("back", "Alt+Left"),
            ("forward", "Alt+Right"),
            ("address_bar", "Ctrl+L"),
            ("find", "Ctrl+F"),
            ("bookmarks", "Ctrl+B"),
            ("history", "Ctrl+H"),
            ("downloads", "Ctrl+J"),
            ("settings", "Ctrl+Comma"),
            ("private_mode", "Ctrl+Shift+N"),
            ("ai_assistant", "Ctrl+Shift+A"),
            ("dev_tools", "F12"),
            ("dev_tools_alt", "Ctrl+Shift+I"),
            ("view_source", "Ctrl+U"),
            ("print", "Ctrl+P"),
            ("save_page", "Ctrl+S"),
            ("fullscreen", "F11"),
            ("stop_loading", "Escape"),
            ("clear_data", "Ctrl+Shift+Delete"),
            ("reopen_tab", "Ctrl+Shift+T"),
            ("new_window", "Ctrl+N"),
            ("zoom_in", "Ctrl+Plus"),
            ("zoom_out", "Ctrl+Minus"),
            ("zoom_reset", "Ctrl+0"),
            ("next_tab", "Ctrl+Tab"),
            ("prev_tab", "Ctrl+Shift+Tab"),
            ("home", "Alt+Home"),
        ];

        defaults.into_iter()
            .map(|(a, k)| (a.to_string(), Self::adapt_for_platform(k)))
            .collect()
    }
}
