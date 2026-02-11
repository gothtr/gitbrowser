//! Theme Engine — manages dark/light/system themes, accent colors, and CSS variables.

use std::collections::HashMap;

use crate::types::errors::ThemeError;
use crate::types::settings::ThemeMode;

/// Trait defining the theme engine interface.
pub trait ThemeEngineTrait {
    fn set_theme(&mut self, mode: ThemeMode);
    fn get_theme(&self) -> &ThemeMode;
    fn set_accent_color(&mut self, color: &str) -> Result<(), ThemeError>;
    fn get_accent_color(&self) -> &str;
    fn detect_system_theme(&self) -> ThemeMode;
    fn get_css_variables(&self) -> HashMap<String, String>;
}

/// GitHub-style dark theme colors.
struct DarkPalette;
impl DarkPalette {
    const BG_PRIMARY: &'static str = "#0d1117";
    const BG_SECONDARY: &'static str = "#161b22";
    const BG_TERTIARY: &'static str = "#21262d";
    const TEXT_PRIMARY: &'static str = "#c9d1d9";
    const TEXT_SECONDARY: &'static str = "#8b949e";
    const BORDER: &'static str = "#30363d";
    const LINK: &'static str = "#58a6ff";
    const HOVER_BG: &'static str = "#1f242b";
    const INPUT_BG: &'static str = "#0d1117";
    const SCROLLBAR: &'static str = "#484f58";
}

/// GitHub-style light theme colors.
struct LightPalette;
impl LightPalette {
    const BG_PRIMARY: &'static str = "#ffffff";
    const BG_SECONDARY: &'static str = "#f6f8fa";
    const BG_TERTIARY: &'static str = "#eaeef2";
    const TEXT_PRIMARY: &'static str = "#24292f";
    const TEXT_SECONDARY: &'static str = "#57606a";
    const BORDER: &'static str = "#d0d7de";
    const LINK: &'static str = "#0969da";
    const HOVER_BG: &'static str = "#f3f4f6";
    const INPUT_BG: &'static str = "#ffffff";
    const SCROLLBAR: &'static str = "#afb8c1";
}

/// Validates a hex color string (e.g. "#2ea44f" or "#fff").
fn is_valid_hex_color(color: &str) -> bool {
    if !color.starts_with('#') {
        return false;
    }
    let hex = &color[1..];
    matches!(hex.len(), 3 | 6)
        && hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// The theme engine implementation.
pub struct ThemeEngine {
    current_theme: ThemeMode,
    accent_color: String,
}

impl ThemeEngine {
    /// Creates a new ThemeEngine with the given initial mode and default accent color.
    pub fn new(mode: ThemeMode) -> Self {
        Self {
            current_theme: mode,
            accent_color: "#2ea44f".to_string(),
        }
    }

    /// Returns the effective theme, resolving `System` to a concrete mode.
    fn effective_theme(&self) -> ThemeMode {
        match &self.current_theme {
            ThemeMode::System => self.detect_system_theme(),
            other => other.clone(),
        }
    }

    /// Builds the CSS variable map for a given palette.
    fn build_variables(
        bg_primary: &str,
        bg_secondary: &str,
        bg_tertiary: &str,
        text_primary: &str,
        text_secondary: &str,
        border: &str,
        link: &str,
        hover_bg: &str,
        input_bg: &str,
        scrollbar: &str,
        accent: &str,
    ) -> HashMap<String, String> {
        let mut vars = HashMap::new();
        vars.insert("--bg-primary".into(), bg_primary.into());
        vars.insert("--bg-secondary".into(), bg_secondary.into());
        vars.insert("--bg-tertiary".into(), bg_tertiary.into());
        vars.insert("--text-primary".into(), text_primary.into());
        vars.insert("--text-secondary".into(), text_secondary.into());
        vars.insert("--border-color".into(), border.into());
        vars.insert("--link-color".into(), link.into());
        vars.insert("--hover-bg".into(), hover_bg.into());
        vars.insert("--input-bg".into(), input_bg.into());
        vars.insert("--scrollbar-color".into(), scrollbar.into());
        vars.insert("--accent-color".into(), accent.into());
        vars.insert("--font-family".into(), "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif".into());
        vars.insert("--transition-fast".into(), "100ms".into());
        vars.insert("--transition-normal".into(), "200ms".into());
        vars.insert("--transition-slow".into(), "300ms".into());
        vars
    }
}

impl ThemeEngineTrait for ThemeEngine {
    fn set_theme(&mut self, mode: ThemeMode) {
        self.current_theme = mode;
    }

    fn get_theme(&self) -> &ThemeMode {
        &self.current_theme
    }

    fn set_accent_color(&mut self, color: &str) -> Result<(), ThemeError> {
        if !is_valid_hex_color(color) {
            return Err(ThemeError::InvalidColor(color.to_string()));
        }
        self.accent_color = color.to_string();
        Ok(())
    }

    fn get_accent_color(&self) -> &str {
        &self.accent_color
    }

    fn detect_system_theme(&self) -> ThemeMode {
        // In a full GTK4 build this would query gtk::Settings for
        // "gtk-application-prefer-dark-theme". Without the GTK runtime
        // we fall back to checking the GTK_THEME environment variable.
        if let Ok(gtk_theme) = std::env::var("GTK_THEME") {
            let lower = gtk_theme.to_lowercase();
            if lower.contains("dark") {
                return ThemeMode::Dark;
            }
            return ThemeMode::Light;
        }
        // Default to dark (GitHub-style default).
        ThemeMode::Dark
    }

    fn get_css_variables(&self) -> HashMap<String, String> {
        let accent = &self.accent_color;
        match self.effective_theme() {
            ThemeMode::Dark => Self::build_variables(
                DarkPalette::BG_PRIMARY,
                DarkPalette::BG_SECONDARY,
                DarkPalette::BG_TERTIARY,
                DarkPalette::TEXT_PRIMARY,
                DarkPalette::TEXT_SECONDARY,
                DarkPalette::BORDER,
                DarkPalette::LINK,
                DarkPalette::HOVER_BG,
                DarkPalette::INPUT_BG,
                DarkPalette::SCROLLBAR,
                accent,
            ),
            ThemeMode::Light => Self::build_variables(
                LightPalette::BG_PRIMARY,
                LightPalette::BG_SECONDARY,
                LightPalette::BG_TERTIARY,
                LightPalette::TEXT_PRIMARY,
                LightPalette::TEXT_SECONDARY,
                LightPalette::BORDER,
                LightPalette::LINK,
                LightPalette::HOVER_BG,
                LightPalette::INPUT_BG,
                LightPalette::SCROLLBAR,
                accent,
            ),
            // System is already resolved by effective_theme()
            ThemeMode::System => unreachable!(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_theme_is_dark_accent() {
        let engine = ThemeEngine::new(ThemeMode::Dark);
        assert_eq!(engine.get_accent_color(), "#2ea44f");
    }

    #[test]
    fn test_set_and_get_theme() {
        let mut engine = ThemeEngine::new(ThemeMode::Dark);
        engine.set_theme(ThemeMode::Light);
        assert_eq!(*engine.get_theme(), ThemeMode::Light);
    }

    #[test]
    fn test_valid_accent_colors() {
        let mut engine = ThemeEngine::new(ThemeMode::Dark);
        assert!(engine.set_accent_color("#ff0000").is_ok());
        assert_eq!(engine.get_accent_color(), "#ff0000");
        assert!(engine.set_accent_color("#abc").is_ok());
        assert_eq!(engine.get_accent_color(), "#abc");
    }

    #[test]
    fn test_invalid_accent_colors() {
        let mut engine = ThemeEngine::new(ThemeMode::Dark);
        assert!(engine.set_accent_color("red").is_err());
        assert!(engine.set_accent_color("#gggggg").is_err());
        assert!(engine.set_accent_color("#12345").is_err());
        assert!(engine.set_accent_color("").is_err());
    }

    #[test]
    fn test_dark_css_variables() {
        let engine = ThemeEngine::new(ThemeMode::Dark);
        let vars = engine.get_css_variables();
        assert_eq!(vars.get("--bg-primary").unwrap(), "#0d1117");
        assert_eq!(vars.get("--text-primary").unwrap(), "#c9d1d9");
        assert_eq!(vars.get("--border-color").unwrap(), "#30363d");
        assert_eq!(vars.get("--accent-color").unwrap(), "#2ea44f");
    }

    #[test]
    fn test_light_css_variables() {
        let engine = ThemeEngine::new(ThemeMode::Light);
        let vars = engine.get_css_variables();
        assert_eq!(vars.get("--bg-primary").unwrap(), "#ffffff");
        assert_eq!(vars.get("--text-primary").unwrap(), "#24292f");
        assert_eq!(vars.get("--border-color").unwrap(), "#d0d7de");
    }

    #[test]
    fn test_css_variables_include_font_and_transitions() {
        let engine = ThemeEngine::new(ThemeMode::Dark);
        let vars = engine.get_css_variables();
        assert!(vars.get("--font-family").unwrap().contains("sans-serif"));
        assert_eq!(vars.get("--transition-fast").unwrap(), "100ms");
        assert_eq!(vars.get("--transition-slow").unwrap(), "300ms");
    }

    #[test]
    fn test_accent_color_reflected_in_css_variables() {
        let mut engine = ThemeEngine::new(ThemeMode::Dark);
        engine.set_accent_color("#ff5500").unwrap();
        let vars = engine.get_css_variables();
        assert_eq!(vars.get("--accent-color").unwrap(), "#ff5500");
    }

    #[test]
    fn test_system_theme_detection_fallback() {
        // Without GTK_THEME set, should default to Dark
        std::env::remove_var("GTK_THEME");
        let engine = ThemeEngine::new(ThemeMode::System);
        let vars = engine.get_css_variables();
        // Should resolve to dark palette
        assert_eq!(vars.get("--bg-primary").unwrap(), "#0d1117");
    }
}
