use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::types::errors::TabError;
use crate::types::tab::{ScrollPosition, Tab};

/// Trait defining the tab management interface.
pub trait TabManagerTrait {
    fn create_tab(&mut self, url: Option<&str>, active: bool) -> String;
    fn close_tab(&mut self, tab_id: &str) -> Result<(), TabError>;
    fn switch_tab(&mut self, tab_id: &str) -> Result<(), TabError>;
    fn reorder_tab(&mut self, tab_id: &str, new_index: usize) -> Result<(), TabError>;
    fn pin_tab(&mut self, tab_id: &str) -> Result<(), TabError>;
    fn unpin_tab(&mut self, tab_id: &str) -> Result<(), TabError>;
    fn mute_tab(&mut self, tab_id: &str) -> Result<(), TabError>;
    fn duplicate_tab(&mut self, tab_id: &str) -> Result<String, TabError>;
    fn close_other_tabs(&mut self, tab_id: &str) -> Result<(), TabError>;
    fn close_tabs_to_right(&mut self, tab_id: &str) -> Result<(), TabError>;
    fn get_tab(&self, tab_id: &str) -> Option<&Tab>;
    fn get_all_tabs(&self) -> Vec<&Tab>;
    fn get_active_tab(&self) -> Option<&Tab>;
    fn suspend_tab(&mut self, tab_id: &str) -> Result<(), TabError>;
    fn resume_tab(&mut self, tab_id: &str) -> Result<(), TabError>;
    fn tab_count(&self) -> usize;
    fn get_tab_order(&self) -> &[String];
    fn update_tab_url(&mut self, tab_id: &str, url: &str) -> Result<(), TabError>;
    fn update_tab_title(&mut self, tab_id: &str, title: &str) -> Result<(), TabError>;
}

/// In-memory tab manager for the browser.
pub struct TabManager {
    tabs: Vec<Tab>,
    tab_order: Vec<String>,
    active_tab_id: Option<String>,
    suspended_tabs: HashSet<String>,
}

impl TabManager {
    pub fn new() -> Self {
        Self {
            tabs: Vec::new(),
            tab_order: Vec::new(),
            active_tab_id: None,
            suspended_tabs: HashSet::new(),
        }
    }

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }

    fn find_tab_index(&self, tab_id: &str) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == tab_id)
    }

    fn find_order_index(&self, tab_id: &str) -> Option<usize> {
        self.tab_order.iter().position(|id| id == tab_id)
    }

    /// Count of pinned tabs in the current order (they are always at the left).
    fn pinned_count(&self) -> usize {
        self.tab_order
            .iter()
            .filter(|id| self.tabs.iter().any(|t| &t.id == *id && t.pinned))
            .count()
    }
}

impl Default for TabManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TabManagerTrait for TabManager {
    /// Create a new tab, optionally with a URL and active state.
    /// Returns the new tab's ID.
    fn create_tab(&mut self, url: Option<&str>, active: bool) -> String {
        let id = Uuid::new_v4().to_string();
        let tab = Tab {
            id: id.clone(),
            url: url.unwrap_or("about:blank").to_string(),
            title: "New Tab".to_string(),
            favicon: None,
            pinned: false,
            muted: false,
            loading: false,
            crashed: false,
            scroll_position: ScrollPosition::default(),
            created_at: Self::now(),
        };
        self.tabs.push(tab);
        self.tab_order.push(id.clone());
        if active || self.active_tab_id.is_none() {
            self.active_tab_id = Some(id.clone());
        }
        id
    }

    /// Close a tab. If it's the active tab, switch to the nearest neighbor.
    /// If it's the last tab, create a new empty tab automatically.
    fn close_tab(&mut self, tab_id: &str) -> Result<(), TabError> {
        let tab_idx = self
            .find_tab_index(tab_id)
            .ok_or_else(|| TabError::NotFound(tab_id.to_string()))?;
        let order_idx = self
            .find_order_index(tab_id)
            .ok_or_else(|| TabError::NotFound(tab_id.to_string()))?;

        // Determine new active tab before removal if this is the active tab
        let need_switch = self.active_tab_id.as_deref() == Some(tab_id);

        // Remove from data structures
        self.tabs.remove(tab_idx);
        self.tab_order.remove(order_idx);
        self.suspended_tabs.remove(tab_id);

        // If that was the last tab, create a new empty one
        if self.tabs.is_empty() {
            let new_id = self.create_tab(None, true);
            self.active_tab_id = Some(new_id);
            return Ok(());
        }

        // Switch active tab to nearest neighbor
        if need_switch {
            let new_order_idx = if order_idx < self.tab_order.len() {
                order_idx
            } else {
                self.tab_order.len() - 1
            };
            self.active_tab_id = Some(self.tab_order[new_order_idx].clone());
        }

        Ok(())
    }

    /// Switch the active tab to the given tab_id.
    fn switch_tab(&mut self, tab_id: &str) -> Result<(), TabError> {
        if self.find_tab_index(tab_id).is_none() {
            return Err(TabError::NotFound(tab_id.to_string()));
        }
        self.active_tab_id = Some(tab_id.to_string());
        Ok(())
    }

    /// Move a tab to a new position in the tab order.
    fn reorder_tab(&mut self, tab_id: &str, new_index: usize) -> Result<(), TabError> {
        let order_idx = self
            .find_order_index(tab_id)
            .ok_or_else(|| TabError::NotFound(tab_id.to_string()))?;

        if new_index >= self.tab_order.len() {
            return Err(TabError::InvalidIndex(new_index));
        }

        let id = self.tab_order.remove(order_idx);
        self.tab_order.insert(new_index, id);
        Ok(())
    }

    /// Pin a tab, moving it to the left side of the tab bar (after other pinned tabs).
    fn pin_tab(&mut self, tab_id: &str) -> Result<(), TabError> {
        let tab_idx = self
            .find_tab_index(tab_id)
            .ok_or_else(|| TabError::NotFound(tab_id.to_string()))?;

        if self.tabs[tab_idx].pinned {
            return Ok(()); // Already pinned
        }

        // Count pinned tabs before we change state
        let pinned_before = self.pinned_count();
        self.tabs[tab_idx].pinned = true;

        // Move to the end of the pinned section in tab_order
        if let Some(order_idx) = self.find_order_index(tab_id) {
            let id = self.tab_order.remove(order_idx);
            // Insert at position = previous pinned count (i.e. right after existing pinned tabs)
            let insert_pos = pinned_before.min(self.tab_order.len());
            self.tab_order.insert(insert_pos, id);
        }

        Ok(())
    }

    /// Unpin a tab, moving it to just after the pinned section.
    fn unpin_tab(&mut self, tab_id: &str) -> Result<(), TabError> {
        let tab_idx = self
            .find_tab_index(tab_id)
            .ok_or_else(|| TabError::NotFound(tab_id.to_string()))?;

        if !self.tabs[tab_idx].pinned {
            return Ok(()); // Already unpinned
        }

        self.tabs[tab_idx].pinned = false;

        // Move to just after the pinned section
        if let Some(order_idx) = self.find_order_index(tab_id) {
            let pinned_count = self.pinned_count();
            let id = self.tab_order.remove(order_idx);
            let insert_pos = pinned_count.min(self.tab_order.len());
            self.tab_order.insert(insert_pos, id);
        }

        Ok(())
    }

    /// Toggle the muted state of a tab.
    fn mute_tab(&mut self, tab_id: &str) -> Result<(), TabError> {
        let tab_idx = self
            .find_tab_index(tab_id)
            .ok_or_else(|| TabError::NotFound(tab_id.to_string()))?;
        self.tabs[tab_idx].muted = !self.tabs[tab_idx].muted;
        Ok(())
    }

    /// Duplicate a tab, creating a new tab with the same URL.
    /// Returns the new tab's ID.
    fn duplicate_tab(&mut self, tab_id: &str) -> Result<String, TabError> {
        let tab_idx = self
            .find_tab_index(tab_id)
            .ok_or_else(|| TabError::NotFound(tab_id.to_string()))?;

        let source = &self.tabs[tab_idx];
        let new_id = Uuid::new_v4().to_string();
        let new_tab = Tab {
            id: new_id.clone(),
            url: source.url.clone(),
            title: source.title.clone(),
            favicon: source.favicon.clone(),
            pinned: false,
            muted: false,
            loading: false,
            crashed: false,
            scroll_position: source.scroll_position.clone(),
            created_at: Self::now(),
        };

        // Insert the duplicate right after the source in tab_order
        let order_idx = self.find_order_index(tab_id).unwrap();
        self.tabs.push(new_tab);
        self.tab_order.insert(order_idx + 1, new_id.clone());

        Ok(new_id)
    }

    /// Close all tabs except the specified one.
    fn close_other_tabs(&mut self, tab_id: &str) -> Result<(), TabError> {
        if self.find_tab_index(tab_id).is_none() {
            return Err(TabError::NotFound(tab_id.to_string()));
        }

        self.tabs.retain(|t| t.id == tab_id);
        self.tab_order.retain(|id| id == tab_id);
        self.suspended_tabs.retain(|id| id == tab_id);
        self.active_tab_id = Some(tab_id.to_string());
        Ok(())
    }

    /// Close all tabs to the right of the specified tab in the tab order.
    fn close_tabs_to_right(&mut self, tab_id: &str) -> Result<(), TabError> {
        let order_idx = self
            .find_order_index(tab_id)
            .ok_or_else(|| TabError::NotFound(tab_id.to_string()))?;

        // Collect IDs of tabs to the right
        let to_remove: Vec<String> = self.tab_order[order_idx + 1..].to_vec();

        for id in &to_remove {
            self.tabs.retain(|t| t.id != *id);
            self.suspended_tabs.remove(id);
        }
        self.tab_order.truncate(order_idx + 1);

        // If active tab was removed, switch to the specified tab
        if let Some(ref active) = self.active_tab_id {
            if to_remove.contains(active) {
                self.active_tab_id = Some(tab_id.to_string());
            }
        }

        Ok(())
    }

    fn get_tab(&self, tab_id: &str) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == tab_id)
    }

    fn get_all_tabs(&self) -> Vec<&Tab> {
        // Return tabs in tab_order sequence
        self.tab_order
            .iter()
            .filter_map(|id| self.tabs.iter().find(|t| t.id == *id))
            .collect()
    }

    fn get_active_tab(&self) -> Option<&Tab> {
        self.active_tab_id
            .as_ref()
            .and_then(|id| self.tabs.iter().find(|t| t.id == *id))
    }

    /// Mark a tab as suspended for performance management.
    fn suspend_tab(&mut self, tab_id: &str) -> Result<(), TabError> {
        if self.find_tab_index(tab_id).is_none() {
            return Err(TabError::NotFound(tab_id.to_string()));
        }
        self.suspended_tabs.insert(tab_id.to_string());
        Ok(())
    }

    /// Resume a previously suspended tab.
    fn resume_tab(&mut self, tab_id: &str) -> Result<(), TabError> {
        if self.find_tab_index(tab_id).is_none() {
            return Err(TabError::NotFound(tab_id.to_string()));
        }
        self.suspended_tabs.remove(tab_id);
        Ok(())
    }

    fn tab_count(&self) -> usize {
        self.tabs.len()
    }

    fn get_tab_order(&self) -> &[String] {
        &self.tab_order
    }

    fn update_tab_url(&mut self, tab_id: &str, url: &str) -> Result<(), TabError> {
        let tab = self.tabs.iter_mut().find(|t| t.id == tab_id)
            .ok_or(TabError::NotFound(tab_id.to_string()))?;
        tab.url = url.to_string();
        tab.title = url.to_string();
        Ok(())
    }

    fn update_tab_title(&mut self, tab_id: &str, title: &str) -> Result<(), TabError> {
        let tab = self.tabs.iter_mut().find(|t| t.id == tab_id)
            .ok_or(TabError::NotFound(tab_id.to_string()))?;
        tab.title = title.to_string();
        Ok(())
    }
}
