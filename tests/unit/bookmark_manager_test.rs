//! Unit tests for the BookmarkManager public API.
//!
//! These tests exercise bookmark and folder CRUD operations through the
//! `BookmarkManagerTrait` interface, using an in-memory SQLite database.
//!
//! Requirements: 3.3 (move bookmarks between folders), 3.5 (delete bookmarks)

use gitbrowser::database::Database;
use gitbrowser::managers::bookmark_manager::{BookmarkManager, BookmarkManagerTrait};

/// Helper: create a BookmarkManager backed by a fresh in-memory database.
fn setup() -> (Database, ()) {
    let db = Database::open_in_memory().expect("Failed to open in-memory database");
    (db, ())
}

/// Creating a folder and listing bookmarks inside it should work correctly.
///
/// Validates: Requirement 3.3
#[test]
fn test_create_folder_and_list_bookmarks_in_it() {
    let (db, _) = setup();
    let mut mgr = BookmarkManager::new(db.connection());

    let folder_id = mgr.create_folder("Work", None).unwrap();

    // Add bookmarks: one in the folder, one at root
    let bm_in_folder = mgr
        .add_bookmark("https://example.com", "Example", Some(&folder_id))
        .unwrap();
    let _bm_at_root = mgr
        .add_bookmark("https://rust-lang.org", "Rust", None)
        .unwrap();

    // Listing the folder should return only the bookmark inside it
    let folder_bookmarks = mgr.list_bookmarks(Some(&folder_id)).unwrap();
    assert_eq!(folder_bookmarks.len(), 1);
    assert_eq!(folder_bookmarks[0].id, bm_in_folder);

    // Listing root should return only the root bookmark
    let root_bookmarks = mgr.list_bookmarks(None).unwrap();
    assert_eq!(root_bookmarks.len(), 1);
    assert_eq!(root_bookmarks[0].url, "https://rust-lang.org");
}

/// Moving a bookmark from one folder to another should update its folder_id.
///
/// Validates: Requirement 3.3
#[test]
fn test_move_bookmark_between_folders() {
    let (db, _) = setup();
    let mut mgr = BookmarkManager::new(db.connection());

    let folder_a = mgr.create_folder("Folder A", None).unwrap();
    let folder_b = mgr.create_folder("Folder B", None).unwrap();

    let bm_id = mgr
        .add_bookmark("https://example.com", "Example", Some(&folder_a))
        .unwrap();

    // Verify it's in folder A
    assert_eq!(mgr.list_bookmarks(Some(&folder_a)).unwrap().len(), 1);
    assert_eq!(mgr.list_bookmarks(Some(&folder_b)).unwrap().len(), 0);

    // Move to folder B
    mgr.move_bookmark(&bm_id, Some(&folder_b)).unwrap();

    // Now folder A is empty, folder B has the bookmark
    assert_eq!(mgr.list_bookmarks(Some(&folder_a)).unwrap().len(), 0);
    let b_bookmarks = mgr.list_bookmarks(Some(&folder_b)).unwrap();
    assert_eq!(b_bookmarks.len(), 1);
    assert_eq!(b_bookmarks[0].id, bm_id);
}

/// Deleting a bookmark should remove it from the database.
///
/// Validates: Requirement 3.5
#[test]
fn test_delete_bookmark() {
    let (db, _) = setup();
    let mut mgr = BookmarkManager::new(db.connection());

    let bm_id = mgr
        .add_bookmark("https://example.com", "Example", None)
        .unwrap();

    assert_eq!(mgr.list_bookmarks(None).unwrap().len(), 1);

    mgr.remove_bookmark(&bm_id).unwrap();

    assert_eq!(mgr.list_bookmarks(None).unwrap().len(), 0);
}

/// Deleting a folder should move contained bookmarks to root (folder_id = NULL).
///
/// Validates: Requirement 3.3
#[test]
fn test_delete_folder_moves_bookmarks_to_root() {
    let (db, _) = setup();
    let mut mgr = BookmarkManager::new(db.connection());

    let folder_id = mgr.create_folder("Temp Folder", None).unwrap();
    let bm_id = mgr
        .add_bookmark("https://example.com", "Example", Some(&folder_id))
        .unwrap();

    // Folder has one bookmark, root has none
    assert_eq!(mgr.list_bookmarks(Some(&folder_id)).unwrap().len(), 1);
    assert_eq!(mgr.list_bookmarks(None).unwrap().len(), 0);

    // Delete the folder
    mgr.delete_folder(&folder_id).unwrap();

    // Bookmark should now be at root
    let root_bookmarks = mgr.list_bookmarks(None).unwrap();
    assert_eq!(root_bookmarks.len(), 1);
    assert_eq!(root_bookmarks[0].id, bm_id);
}

/// Searching bookmarks by partial title should return matching results.
///
/// Validates: Requirement 3.5
#[test]
fn test_search_bookmarks_by_partial_title() {
    let (db, _) = setup();
    let mut mgr = BookmarkManager::new(db.connection());

    mgr.add_bookmark("https://rust-lang.org", "Rust Programming Language", None)
        .unwrap();
    mgr.add_bookmark("https://python.org", "Python Programming", None)
        .unwrap();
    mgr.add_bookmark("https://example.com", "Example Site", None)
        .unwrap();

    // Search for "Programming" should match two bookmarks
    let results = mgr.search_bookmarks("Programming").unwrap();
    assert_eq!(results.len(), 2);

    // Search for "Rust" should match one
    let results = mgr.search_bookmarks("Rust").unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].url, "https://rust-lang.org");

    // Search for "nonexistent" should return empty
    let results = mgr.search_bookmarks("nonexistent").unwrap();
    assert!(results.is_empty());
}
