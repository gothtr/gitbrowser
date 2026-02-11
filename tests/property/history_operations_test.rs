//! Property-based tests for History Manager operations.
//!
//! **Validates: Requirements 4.1, 4.3**
//!
//! These tests verify that recording a visit and then searching by its title
//! always returns a result containing that entry, for arbitrary valid
//! URLs and titles.

use gitbrowser::database::Database;
use gitbrowser::managers::history_manager::{HistoryManager, HistoryManagerTrait};
use proptest::prelude::*;

/// Strategy for generating valid URL strings.
/// Produces URLs with http/https scheme, alphanumeric host, and optional path.
fn arb_url() -> impl Strategy<Value = String> {
    (
        prop_oneof![Just("https"), Just("http")],
        "[a-z][a-z0-9]{2,15}",
        prop_oneof![Just(".com"), Just(".org"), Just(".net"), Just(".io")],
        proptest::option::of("/[a-z0-9]{1,10}"),
    )
        .prop_map(|(scheme, host, tld, path)| {
            format!("{}://{}{}{}", scheme, host, tld, path.unwrap_or_default())
        })
}

/// Strategy for generating non-empty history titles.
/// Uses printable ASCII characters to avoid edge cases with SQL LIKE and encoding.
fn arb_title() -> impl Strategy<Value = String> {
    "[a-zA-Z][a-zA-Z0-9 ]{1,30}"
}

// **Property 5: History record-then-search**
//
// *For any* valid URL and title, recording a visit then searching by that
// title SHALL return a result containing that entry.
//
// **Validates: Requirements 4.1, 4.3**
proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    #[test]
    fn history_record_then_search_returns_result(
        url in arb_url(),
        title in arb_title(),
    ) {
        // Set up a fresh in-memory database for each test case
        let db = Database::open_in_memory()
            .expect("Failed to open in-memory database");
        let mut manager = HistoryManager::new(db.connection());

        // Record a visit with the generated URL and title
        let entry_id = manager
            .record_visit(&url, &title)
            .expect("record_visit should succeed for valid inputs");

        // Search by the full title
        let results = manager
            .search_history(&title)
            .expect("search_history should succeed");

        // The search results must contain the entry we just recorded
        let found = results.iter().any(|e| e.id == entry_id);
        prop_assert!(
            found,
            "Searching for title '{}' should find the history entry with id '{}', but got {} results: {:?}",
            title,
            entry_id,
            results.len(),
            results.iter().map(|e| (&e.id, &e.title)).collect::<Vec<_>>()
        );

        // Additionally verify the found entry has the correct URL and title
        let entry = results.iter().find(|e| e.id == entry_id).unwrap();
        prop_assert_eq!(
            &entry.url,
            &url,
            "Found history entry URL must match the original"
        );
        prop_assert_eq!(
            &entry.title,
            &title,
            "Found history entry title must match the original"
        );
    }
}
