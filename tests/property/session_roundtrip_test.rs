//! Property-based tests for session save-restore round-trip.
//!
//! **Validates: Requirements 9.1, 9.3, 9.4**
//!
//! These tests verify that for any valid SessionData, saving then restoring
//! through the SessionManager (encrypt → SQLite → decrypt) produces an
//! equivalent SessionData.

use std::sync::Arc;

use gitbrowser::database::connection::Database;
use gitbrowser::managers::session_manager::{SessionManager, SessionManagerTrait};
use gitbrowser::types::session::{SessionData, SessionTab, WindowBounds};
use gitbrowser::types::tab::ScrollPosition;
use proptest::prelude::*;

// --- Arbitrary strategies for session types ---

fn arb_scroll_position() -> impl Strategy<Value = ScrollPosition> {
    (-1e6f64..1e6f64, -1e6f64..1e6f64)
        .prop_map(|(x, y)| ScrollPosition {
            // Round to avoid f64 precision loss during JSON serialization roundtrip
            x: (x * 1e6).round() / 1e6,
            y: (y * 1e6).round() / 1e6,
        })
}

fn arb_window_bounds() -> impl Strategy<Value = WindowBounds> {
    (
        -10000i32..10000i32,
        -10000i32..10000i32,
        100i32..5000i32,
        100i32..5000i32,
    )
        .prop_map(|(x, y, width, height)| WindowBounds {
            x,
            y,
            width,
            height,
        })
}

fn arb_session_tab() -> impl Strategy<Value = SessionTab> {
    (
        "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}",
        "https?://[a-z]{3,15}\\.[a-z]{2,5}/[a-z0-9/_-]{0,30}",
        "[A-Za-z0-9 ]{1,50}",
        any::<bool>(),
        arb_scroll_position(),
    )
        .prop_map(|(id, url, title, pinned, scroll_position)| SessionTab {
            id,
            url,
            title,
            pinned,
            scroll_position,
        })
}

fn arb_session_data() -> impl Strategy<Value = SessionData> {
    (
        proptest::collection::vec(arb_session_tab(), 1..=5),
        arb_window_bounds(),
        0i64..=i64::MAX,
    )
        .prop_flat_map(|(tabs, window_bounds, timestamp)| {
            let tab_ids: Vec<String> = tabs.iter().map(|t| t.id.clone()).collect();
            let active_tab_strategy = if tab_ids.is_empty() {
                Just(None).boxed()
            } else {
                proptest::option::of(proptest::sample::select(tab_ids)).boxed()
            };
            (Just(tabs), active_tab_strategy, Just(window_bounds), Just(timestamp))
        })
        .prop_map(|(tabs, active_tab_id, window_bounds, timestamp)| SessionData {
            tabs,
            active_tab_id,
            window_bounds,
            timestamp,
        })
}

// **Property 7: Session save-restore round-trip**
//
// *For any* valid SessionData, saving then restoring SHALL produce an
// equivalent SessionData.
//
// **Validates: Requirements 9.1, 9.3, 9.4**
proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    #[test]
    fn session_save_restore_roundtrip(session_data in arb_session_data()) {
        // Set up in-memory database + session manager
        let db = Database::open_in_memory().expect("Failed to open in-memory database");
        let db = Arc::new(db);
        let manager = SessionManager::new(db).expect("Failed to create SessionManager");

        // Save the session
        manager
            .save_session(&session_data)
            .expect("save_session should succeed for any valid SessionData");

        // Restore the session
        let restored = manager
            .restore_session()
            .expect("restore_session should succeed")
            .expect("restore_session should return Some after save");

        // All fields must match
        prop_assert_eq!(
            restored,
            session_data,
            "Restored SessionData must equal the original"
        );
    }
}
