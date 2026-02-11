//! Property-based tests for Bookmark Manager operations.
//!
//! **Validates: Requirements 3.1, 3.6**
//!
//! These tests verify that adding a bookmark and then searching by its title
//! always returns a result containing that bookmark, for arbitrary valid
//! URLs and titles.

use gitbrowser::database::Database;
use gitbrowser::managers::bookmark_manager::{BookmarkManager, BookmarkManagerTrait};
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

/// Strategy for generating non-empty bookmark titles.
/// Uses printable ASCII characters to avoid edge cases with SQL LIKE and encoding.
fn arb_title() -> impl Strategy<Value = String> {
    "[a-zA-Z][a-zA-Z0-9 ]{1,30}"
}

// **Property 4: Bookmark add-then-search**
//
// *For any* valid URL and title, adding a bookmark then searching by that
// title SHALL return a result containing that bookmark.
//
// **Validates: Requirements 3.1, 3.6**
proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    #[test]
    fn bookmark_add_then_search_returns_result(
        url in arb_url(),
        title in arb_title(),
    ) {
        // Set up a fresh in-memory database for each test case
        let db = Database::open_in_memory()
            .expect("Failed to open in-memory database");
        let mut manager = BookmarkManager::new(db.connection());

        // Add a bookmark with the generated URL and title
        let bookmark_id = manager
            .add_bookmark(&url, &title, None)
            .expect("add_bookmark should succeed for valid inputs");

        // Search by the full title
        let results = manager
            .search_bookmarks(&title)
            .expect("search_bookmarks should succeed");

        // The search results must contain the bookmark we just added
        let found = results.iter().any(|b| b.id == bookmark_id);
        prop_assert!(
            found,
            "Searching for title '{}' should find the bookmark with id '{}', but got {} results: {:?}",
            title,
            bookmark_id,
            results.len(),
            results.iter().map(|b| (&b.id, &b.title)).collect::<Vec<_>>()
        );

        // Additionally verify the found bookmark has the correct URL and title
        let bookmark = results.iter().find(|b| b.id == bookmark_id).unwrap();
        prop_assert_eq!(
            &bookmark.url,
            &url,
            "Found bookmark URL must match the original"
        );
        prop_assert_eq!(
            &bookmark.title,
            &title,
            "Found bookmark title must match the original"
        );
    }
}
