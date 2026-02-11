use gitbrowser::managers::tab_manager::{TabManager, TabManagerTrait};

#[test]
fn test_create_tab_returns_unique_ids() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, false);
    assert_ne!(id1, id2);
    assert_eq!(mgr.tab_count(), 2);
}

#[test]
fn test_create_tab_sets_active_when_first() {
    let mut mgr = TabManager::new();
    let id = mgr.create_tab(Some("https://example.com"), false);
    // First tab should become active even if active=false
    assert_eq!(mgr.get_active_tab().unwrap().id, id);
}

#[test]
fn test_create_tab_with_url() {
    let mut mgr = TabManager::new();
    let id = mgr.create_tab(Some("https://github.com"), true);
    let tab = mgr.get_tab(&id).unwrap();
    assert_eq!(tab.url, "https://github.com");
}

#[test]
fn test_create_tab_default_url() {
    let mut mgr = TabManager::new();
    let id = mgr.create_tab(None, true);
    let tab = mgr.get_tab(&id).unwrap();
    assert_eq!(tab.url, "about:blank");
}

#[test]
fn test_close_tab_switches_to_neighbor() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, true);
    let id3 = mgr.create_tab(None, false);

    // Active is id2, close it
    mgr.close_tab(&id2).unwrap();
    // Should switch to id3 (next neighbor in order)
    let active = mgr.get_active_tab().unwrap();
    assert!(active.id == id1 || active.id == id3);
    assert_eq!(mgr.tab_count(), 2);
}

#[test]
fn test_close_last_tab_creates_new_one() {
    let mut mgr = TabManager::new();
    let id = mgr.create_tab(None, true);
    mgr.close_tab(&id).unwrap();
    // Should have created a new empty tab
    assert_eq!(mgr.tab_count(), 1);
    let active = mgr.get_active_tab().unwrap();
    assert_eq!(active.url, "about:blank");
    assert_ne!(active.id, id);
}

#[test]
fn test_close_nonexistent_tab_returns_error() {
    let mut mgr = TabManager::new();
    mgr.create_tab(None, true);
    let result = mgr.close_tab("nonexistent");
    assert!(result.is_err());
}

#[test]
fn test_switch_tab() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, false);
    assert_eq!(mgr.get_active_tab().unwrap().id, id1);

    mgr.switch_tab(&id2).unwrap();
    assert_eq!(mgr.get_active_tab().unwrap().id, id2);
}

#[test]
fn test_switch_nonexistent_tab_returns_error() {
    let mut mgr = TabManager::new();
    mgr.create_tab(None, true);
    assert!(mgr.switch_tab("nonexistent").is_err());
}

#[test]
fn test_reorder_tab() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, false);
    let id3 = mgr.create_tab(None, false);

    // Order: [id1, id2, id3] -> move id3 to index 0
    mgr.reorder_tab(&id3, 0).unwrap();
    let order = mgr.get_tab_order();
    assert_eq!(order[0], id3);
    assert_eq!(order[1], id1);
    assert_eq!(order[2], id2);
}

#[test]
fn test_reorder_invalid_index() {
    let mut mgr = TabManager::new();
    let id = mgr.create_tab(None, true);
    assert!(mgr.reorder_tab(&id, 5).is_err());
}

#[test]
fn test_pin_tab_moves_to_left() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, false);
    let id3 = mgr.create_tab(None, false);

    // Pin id3 — should move to position 0 (first pinned)
    mgr.pin_tab(&id3).unwrap();
    let order = mgr.get_tab_order();
    assert_eq!(order[0], id3);
    assert!(mgr.get_tab(&id3).unwrap().pinned);

    // Pin id2 — should move to position 1 (after id3 which is pinned)
    mgr.pin_tab(&id2).unwrap();
    let order = mgr.get_tab_order();
    assert_eq!(order[0], id3);
    assert_eq!(order[1], id2);
    assert_eq!(order[2], id1);
}

#[test]
fn test_pinned_tabs_stay_left_after_reorder() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, false);
    let _id3 = mgr.create_tab(None, false);

    mgr.pin_tab(&id1).unwrap();
    // Pinned tab is at index 0
    let order = mgr.get_tab_order();
    assert_eq!(order[0], id1);

    // Reorder unpinned tab id2 to index 2
    mgr.reorder_tab(&id2, 2).unwrap();
    // Pinned tab should still be at the left
    let order = mgr.get_tab_order();
    assert_eq!(order[0], id1);
}

#[test]
fn test_unpin_tab() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, false);

    mgr.pin_tab(&id2).unwrap();
    assert!(mgr.get_tab(&id2).unwrap().pinned);
    // After pinning: order is [id2, id1]
    assert_eq!(mgr.get_tab_order()[0], id2);

    mgr.unpin_tab(&id2).unwrap();
    assert!(!mgr.get_tab(&id2).unwrap().pinned);
    // After unpinning with 0 remaining pinned tabs, id2 goes to position 0
    let order = mgr.get_tab_order();
    assert_eq!(order[0], id2);
    assert_eq!(order[1], id1);
}

#[test]
fn test_mute_tab_toggles() {
    let mut mgr = TabManager::new();
    let id = mgr.create_tab(None, true);
    assert!(!mgr.get_tab(&id).unwrap().muted);

    mgr.mute_tab(&id).unwrap();
    assert!(mgr.get_tab(&id).unwrap().muted);

    mgr.mute_tab(&id).unwrap();
    assert!(!mgr.get_tab(&id).unwrap().muted);
}

#[test]
fn test_duplicate_tab_preserves_url() {
    let mut mgr = TabManager::new();
    let id = mgr.create_tab(Some("https://github.com"), true);
    let dup_id = mgr.duplicate_tab(&id).unwrap();

    let dup = mgr.get_tab(&dup_id).unwrap();
    assert_eq!(dup.url, "https://github.com");
    assert_ne!(dup.id, id);
    assert!(!dup.pinned); // Duplicate should not be pinned
    assert_eq!(mgr.tab_count(), 2);
}

#[test]
fn test_duplicate_tab_inserted_after_source() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, false);
    let dup_id = mgr.duplicate_tab(&id1).unwrap();

    let order = mgr.get_tab_order();
    assert_eq!(order[0], id1);
    assert_eq!(order[1], dup_id);
    assert_eq!(order[2], id2);
}

#[test]
fn test_close_other_tabs() {
    let mut mgr = TabManager::new();
    let _id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, false);
    let _id3 = mgr.create_tab(None, false);

    mgr.close_other_tabs(&id2).unwrap();
    assert_eq!(mgr.tab_count(), 1);
    assert_eq!(mgr.get_active_tab().unwrap().id, id2);
}

#[test]
fn test_close_tabs_to_right() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, false);
    let _id3 = mgr.create_tab(None, false);

    mgr.close_tabs_to_right(&id1).unwrap();
    assert_eq!(mgr.tab_count(), 1);
    assert_eq!(mgr.get_tab_order(), &[id1.clone()]);

    // Active should be id1 since id2 and id3 were removed
    // (id1 was already active)
    let _ = id2;
}

#[test]
fn test_suspend_and_resume_tab() {
    let mut mgr = TabManager::new();
    let id = mgr.create_tab(None, true);

    mgr.suspend_tab(&id).unwrap();
    // Suspend again should be fine
    mgr.suspend_tab(&id).unwrap();

    mgr.resume_tab(&id).unwrap();
    // Resume again should be fine
    mgr.resume_tab(&id).unwrap();
}

#[test]
fn test_suspend_nonexistent_tab() {
    let mut mgr = TabManager::new();
    assert!(mgr.suspend_tab("nonexistent").is_err());
    assert!(mgr.resume_tab("nonexistent").is_err());
}

#[test]
fn test_get_all_tabs_returns_ordered() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(Some("https://a.com"), true);
    let id2 = mgr.create_tab(Some("https://b.com"), false);
    let id3 = mgr.create_tab(Some("https://c.com"), false);

    let all = mgr.get_all_tabs();
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].id, id1);
    assert_eq!(all[1].id, id2);
    assert_eq!(all[2].id, id3);
}

#[test]
fn test_tab_count() {
    let mut mgr = TabManager::new();
    assert_eq!(mgr.tab_count(), 0);
    mgr.create_tab(None, true);
    assert_eq!(mgr.tab_count(), 1);
    mgr.create_tab(None, false);
    assert_eq!(mgr.tab_count(), 2);
}

#[test]
fn test_close_active_tab_at_end_switches_to_previous() {
    let mut mgr = TabManager::new();
    let id1 = mgr.create_tab(None, true);
    let id2 = mgr.create_tab(None, false);
    let id3 = mgr.create_tab(None, true); // active

    mgr.close_tab(&id3).unwrap();
    // id3 was at the end, should switch to id2 (previous neighbor)
    assert_eq!(mgr.get_active_tab().unwrap().id, id2);
    let _ = id1;
}
