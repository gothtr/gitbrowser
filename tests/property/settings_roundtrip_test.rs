//! Property-based tests for BrowserSettings serialization round-trip.
//!
//! **Validates: Requirements 6.4**
//!
//! These tests verify that BrowserSettings can be serialized to JSON
//! and deserialized back without data loss for arbitrary valid inputs.

use gitbrowser::types::ai::AIProviderName;
use gitbrowser::types::settings::{
    AISettings, AppearanceSettings, BrowserSettings, GeneralSettings, PerformanceSettings,
    PrivacySettings, StartupBehavior, ThemeMode,
};
use proptest::prelude::*;
use std::collections::HashMap;

// --- Arbitrary strategies for all settings sub-types ---

fn arb_startup_behavior() -> impl Strategy<Value = StartupBehavior> {
    prop_oneof![
        Just(StartupBehavior::Restore),
        Just(StartupBehavior::NewTab),
        Just(StartupBehavior::Homepage),
    ]
}

fn arb_theme_mode() -> impl Strategy<Value = ThemeMode> {
    prop_oneof![
        Just(ThemeMode::Dark),
        Just(ThemeMode::Light),
        Just(ThemeMode::System),
    ]
}

fn arb_ai_provider_name() -> impl Strategy<Value = AIProviderName> {
    prop_oneof![
        Just(AIProviderName::OpenRouter),
        Just(AIProviderName::OpenAI),
        Just(AIProviderName::Anthropic),
        Just(AIProviderName::DeepSeek),
    ]
}

fn arb_general_settings() -> impl Strategy<Value = GeneralSettings> {
    (
        "[a-z]{2,5}",
        arb_startup_behavior(),
        "[a-zA-Z0-9:/._-]{1,50}",
        "[a-z]{3,10}",
    )
        .prop_map(
            |(language, startup_behavior, homepage, default_search_engine)| GeneralSettings {
                language,
                startup_behavior,
                homepage,
                default_search_engine,
            },
        )
}

fn arb_privacy_settings() -> impl Strategy<Value = PrivacySettings> {
    (
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
        "[a-zA-Z0-9:/._-]{5,60}",
        any::<bool>(),
        any::<bool>(),
        any::<bool>(),
    )
        .prop_map(
            |(
                tracker_blocking,
                ad_blocking,
                https_enforcement,
                dns_over_https,
                dns_provider,
                anti_fingerprinting,
                clear_data_on_exit,
                telemetry_consent,
            )| PrivacySettings {
                tracker_blocking,
                ad_blocking,
                https_enforcement,
                dns_over_https,
                dns_provider,
                anti_fingerprinting,
                clear_data_on_exit,
                telemetry_consent,
            },
        )
}

fn arb_appearance_settings() -> impl Strategy<Value = AppearanceSettings> {
    (arb_theme_mode(), "#[0-9a-f]{6}", 8u32..=72u32, proptest::bool::ANY, proptest::bool::ANY).prop_map(
        |(theme, accent_color, font_size, show_telegram, show_github)| AppearanceSettings {
            theme,
            accent_color,
            font_size,
            show_telegram,
            show_github,
        },
    )
}

fn arb_shortcuts() -> impl Strategy<Value = HashMap<String, String>> {
    proptest::collection::hash_map("[a-z_]{2,15}", "[A-Za-z+]{3,20}", 0..=10)
}

fn arb_ai_settings() -> impl Strategy<Value = AISettings> {
    (
        proptest::option::of(arb_ai_provider_name()),
        proptest::option::of("[a-zA-Z0-9._-]{3,30}"),
    )
        .prop_map(|(active_provider, active_model)| AISettings {
            active_provider,
            active_model,
        })
}

fn arb_performance_settings() -> impl Strategy<Value = PerformanceSettings> {
    (1u32..=120u32, any::<bool>()).prop_map(|(tab_suspend_timeout_minutes, lazy_load_images)| {
        PerformanceSettings {
            tab_suspend_timeout_minutes,
            lazy_load_images,
        }
    })
}

fn arb_browser_settings() -> impl Strategy<Value = BrowserSettings> {
    (
        arb_general_settings(),
        arb_privacy_settings(),
        arb_appearance_settings(),
        arb_shortcuts(),
        arb_ai_settings(),
        arb_performance_settings(),
    )
        .prop_map(
            |(general, privacy, appearance, shortcuts, ai, performance)| BrowserSettings {
                general,
                privacy,
                appearance,
                shortcuts,
                ai,
                performance,
            },
        )
}

// **Property 2: Settings serialization round-trip**
//
// *For any* valid `BrowserSettings` struct, serializing to JSON then
// deserializing SHALL produce an equivalent struct.
//
// **Validates: Requirements 6.4**
proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    #[test]
    fn settings_serialization_roundtrip(settings in arb_browser_settings()) {
        let json = serde_json::to_string(&settings)
            .expect("Serialization to JSON should succeed for any valid BrowserSettings");

        let deserialized: BrowserSettings = serde_json::from_str(&json)
            .expect("Deserialization from JSON should succeed for valid JSON");

        prop_assert_eq!(
            deserialized,
            settings,
            "Deserialized BrowserSettings must equal the original"
        );
    }
}
