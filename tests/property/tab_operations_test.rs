//! Property-based tests for Tab Manager operations.
//!
//! **Validates: Requirements 1.1, 1.2**
//!
//! These tests verify the tab create-close invariant: for any sequence of
//! tab creations and closures, `tab_count()` tracks correctly, accounting
//! for the auto-create behavior when the last tab is closed.

use gitbrowser::managers::tab_manager::{TabManager, TabManagerTrait};
use proptest::prelude::*;

/// Operations that can be performed on the TabManager.
#[derive(Debug, Clone)]
enum TabOp {
    Create,
    Close(usize), // index into current tab_order to pick which tab to close
}

/// Strategy for generating a sequence of tab operations.
/// We bias toward more creates than closes to keep interesting state.
fn arb_tab_ops() -> impl Strategy<Value = Vec<TabOp>> {
    prop::collection::vec(
        prop_oneof![
            3 => Just(TabOp::Create),
            2 => (0..20usize).prop_map(TabOp::Close),
        ],
        1..60,
    )
}

// **Property 6: Tab create-close invariant**
//
// *For any* sequence of tab creations and closures, `tab_count()` SHALL equal
// the number of creates minus the number of successful closes, accounting for
// auto-created tabs when the last tab is closed (count never drops below 1
// after the first create).
//
// **Validates: Requirements 1.1, 1.2**
proptest! {
    #![proptest_config(ProptestConfig::with_cases(20))]

    #[test]
    fn tab_create_close_invariant(ops in arb_tab_ops()) {
        let mut manager = TabManager::new();
        let mut expected_count: usize = 0;

        for op in &ops {
            match op {
                TabOp::Create => {
                    manager.create_tab(None, true);
                    expected_count += 1;
                }
                TabOp::Close(idx) => {
                    let order = manager.get_tab_order().to_vec();
                    if order.is_empty() {
                        // Nothing to close, count stays the same
                        continue;
                    }
                    let pick = idx % order.len();
                    let tab_id = order[pick].clone();

                    let is_last = order.len() == 1;
                    let result = manager.close_tab(&tab_id);

                    if result.is_ok() {
                        if is_last {
                            // Closing the last tab: removes 1, auto-creates 1
                            // Net effect: expected_count stays the same
                        } else {
                            expected_count -= 1;
                        }
                    }
                }
            }

            // Invariant: tab_count matches our expected count at every step
            prop_assert_eq!(
                manager.tab_count(),
                expected_count,
                "After {:?}, expected {} tabs but got {}",
                op,
                expected_count,
                manager.tab_count()
            );
        }

        // Additional invariant: after at least one create, count >= 1
        if ops.iter().any(|op| matches!(op, TabOp::Create)) {
            prop_assert!(
                manager.tab_count() >= 1,
                "Tab count must be >= 1 after at least one create, got {}",
                manager.tab_count()
            );
        }
    }
}
