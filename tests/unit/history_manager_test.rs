//! Unit tests for the HistoryManager public API.
//!
//! These tests exercise history recording, clearing, deletion, and private mode
//! through the `HistoryManagerTrait` interface, using an in-memory SQLite database.
//!
//! Requirements: 4.4 (delete single entry), 4.5 (clear all), 4.6 (private mode)

use gitbrowser::database::Database;
use gitbrowser::managers::history_manager::{HistoryManager, HistoryManagerTrait};

/// Helper: create a HistoryManager backed by a fresh in-memory database.
fn setup() -> (Database, ()) {
    let db = Database::open_in_memory().expect("Failed to open in-memory database");
    (db, ())
}

/// Visiting the same URL multiple times should increment visit_count.
///
/// Validates: Requirement 4.4
#[test]
fn test_visit_count_increments_on_repeated_visits() {
    let (db, _) = setup();
    let mut mgr = HistoryManager::new(db.connection());

    let url = "https://example.com";
    let title = "Example";

    // First visit — visit_count should be 1
    let id = mgr.record_visit(url, title).unwrap();
    let entries = mgr.list_history(None).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].visit_count, 1);

    // Second visit — same URL, visit_count should be 2
    let id2 = mgr.record_visit(url, title).unwrap();
    assert_eq!(id, id2, "Repeated visit should return the same entry ID");
    let entries = mgr.list_history(None).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].visit_count, 2);

    // Third visit
    mgr.record_visit(url, title).unwrap();
    let entries = mgr.list_history(None).unwrap();
    assert_eq!(entries[0].visit_count, 3);
}

/// clear_all should remove all history entries from the database.
///
/// Validates: Requirement 4.5
#[test]
fn test_clear_all_empties_history() {
    let (db, _) = setup();
    let mut mgr = HistoryManager::new(db.connection());

    mgr.record_visit("https://example.com", "Example").unwrap();
    mgr.record_visit("https://rust-lang.org", "Rust").unwrap();
    mgr.record_visit("https://python.org", "Python").unwrap();

    assert_eq!(mgr.list_history(None).unwrap().len(), 3);

    mgr.clear_all().unwrap();

    assert_eq!(mgr.list_history(None).unwrap().len(), 0);
}

/// When recording is disabled (private mode), record_visit should return an error.
///
/// Validates: Requirement 4.6
#[test]
fn test_recording_disabled_in_private_mode() {
    let (db, _) = setup();
    let mut mgr = HistoryManager::new(db.connection());

    // Recording is enabled by default
    assert!(mgr.is_recording_enabled());

    // Disable recording (private mode)
    mgr.set_recording_enabled(false);
    assert!(!mgr.is_recording_enabled());

    // record_visit should fail
    let result = mgr.record_visit("https://example.com", "Example");
    assert!(result.is_err(), "record_visit should fail when recording is disabled");

    // No entries should be in the database
    assert_eq!(mgr.list_history(None).unwrap().len(), 0);

    // Re-enable recording
    mgr.set_recording_enabled(true);
    assert!(mgr.is_recording_enabled());

    // Now recording should work again
    mgr.record_visit("https://example.com", "Example").unwrap();
    assert_eq!(mgr.list_history(None).unwrap().len(), 1);
}

/// delete_entry should remove a single history entry by ID.
///
/// Validates: Requirement 4.4
#[test]
fn test_delete_entry_removes_single_entry() {
    let (db, _) = setup();
    let mut mgr = HistoryManager::new(db.connection());

    let id1 = mgr.record_visit("https://example.com", "Example").unwrap();
    let _id2 = mgr.record_visit("https://rust-lang.org", "Rust").unwrap();

    assert_eq!(mgr.list_history(None).unwrap().len(), 2);

    mgr.delete_entry(&id1).unwrap();

    let remaining = mgr.list_history(None).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].url, "https://rust-lang.org");
}
