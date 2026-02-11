// GitBrowser UI — Single JS file for all browser functionality
'use strict';

var state = {
  tabs: [],
  activeTabId: null,
  tabPages: {} // tabId -> { type, url, el }
};

// ============ IPC ============
function ipcSend(cmd, data) {
  if (window.ipc) window.ipc.postMessage(JSON.stringify(Object.assign({ cmd: cmd }, data || {})));
}

// Called from Rust via evaluate_script
function updateFromBackend(data) {
  state.tabs = data.tabs || [];
  state.activeTabId = data.activeId || null;
  renderTabBar();
  syncPages();
  updateUrlBar();
}

// ============ Tab Bar ============
function renderTabBar() {
  var c = document.getElementById('tabs-container');
  if (!c) return;
  c.innerHTML = '';
  state.tabs.forEach(function(tab) {
    var el = document.createElement('div');
    el.className = 'tab' + (tab.id === state.activeTabId ? ' active' : '') + (tab.pinned ? ' pinned' : '');
    el.dataset.id = tab.id;
    var domain = getDomain(tab.url);
    var initial = domain ? domain[0].toUpperCase() : 'N';
    if (tab.url === 'about:settings') initial = 'S';

    el.innerHTML =
      '<div class="tab-favicon">' + escHtml(initial) + '</div>' +
      '<span class="tab-title">' + escHtml(tab.title || 'New Tab') + '</span>' +
      '<button class="tab-close" title="Close tab">' +
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 1 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>' +
      '</button>';

    (function(tabId) {
      el.addEventListener('click', function(e) {
        if (!e.target.closest('.tab-close')) {
          ipcSend('switch_tab', { id: tabId });
        }
      });
      el.querySelector('.tab-close').addEventListener('click', function(e) {
        e.stopPropagation();
        ipcSend('close_tab', { id: tabId });
      });
    })(tab.id);

    c.appendChild(el);
  });
}

// ============ Page Management ============
function syncPages() {
  var container = document.getElementById('pages-container');
  if (!container) return;

  var activeTab = state.tabs.find(function(t) { return t.id === state.activeTabId; });
  var currentTabIds = new Set(state.tabs.map(function(t) { return t.id; }));

  // Remove pages for closed tabs
  Object.keys(state.tabPages).forEach(function(id) {
    if (!currentTabIds.has(id)) {
      if (state.tabPages[id].el && state.tabPages[id].el.parentNode) {
        state.tabPages[id].el.remove();
      }
      delete state.tabPages[id];
    }
  });

  // Ensure each tab has a page
  state.tabs.forEach(function(tab) {
    if (!state.tabPages[tab.id]) {
      createPageForTab(tab, container);
    } else {
      // Update URL if changed (e.g. after navigation)
      var page = state.tabPages[tab.id];
      if (page.url !== tab.url) {
        updatePageContent(tab);
      }
    }
  });

  // Show only active page
  container.querySelectorAll('.page').forEach(function(p) {
    p.classList.remove('active');
  });
  if (activeTab && state.tabPages[activeTab.id]) {
    state.tabPages[activeTab.id].el.classList.add('active');
  }
}

function createPageForTab(tab, container) {
  var pageEl = document.createElement('div');
  pageEl.className = 'page';
  pageEl.id = 'page-' + tab.id;

  var pageType = getPageType(tab.url);
  fillPageContent(pageEl, tab, pageType);

  container.appendChild(pageEl);
  state.tabPages[tab.id] = { type: pageType, url: tab.url, el: pageEl };
  bindPageEvents(pageEl, tab.id);
}

function updatePageContent(tab) {
  var page = state.tabPages[tab.id];
  if (!page) return;
  var newType = getPageType(tab.url);

  // Only rebuild if type or URL changed
  if (page.type !== newType || page.url !== tab.url) {
    page.el.innerHTML = '';
    fillPageContent(page.el, tab, newType);
    page.type = newType;
    page.url = tab.url;
    bindPageEvents(page.el, tab.id);
  }
}

function fillPageContent(el, tab, pageType) {
  if (pageType === 'newtab') {
    el.innerHTML = buildNewTabHTML();
  } else if (pageType === 'settings') {
    el.innerHTML = '<div class="settings-page" id="settings-' + tab.id + '"></div>';
    // Load settings content
    fetch('http://gitbrowser.localhost/settings.html')
      .then(function(r) { return r.text(); })
      .then(function(html) {
        var sp = document.getElementById('settings-' + tab.id);
        if (sp) {
          sp.innerHTML = html;
          bindSettingsEvents(sp);
          ipcSend('get_settings', {});
        }
      });
  } else {
    // Web page — use iframe
    el.innerHTML = '<div class="loading-bar"></div>' +
      '<iframe src="' + escAttr(tab.url) + '" ' +
      'sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" ' +
      'referrerpolicy="no-referrer" allow="autoplay; encrypted-media"></iframe>';
  }
}

function getPageType(url) {
  if (!url || url === 'about:newtab' || url === 'about:blank') return 'newtab';
  if (url === 'about:settings') return 'settings';
  return 'web';
}

// ============ New Tab Page ============
function buildNewTabHTML() {
  return '<div class="newtab-page">' +
    '<div class="newtab-logo">GitBrowser</div>' +
    '<div class="newtab-subtitle">Fast. Private. Open.</div>' +
    '<div class="newtab-search">' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--fg-subtle)"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 1 1-1.06 1.06l-3.04-3.04ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>' +
      '<input class="newtab-search-input" type="text" placeholder="Search the web or enter URL..." autofocus />' +
    '</div>' +
    '<div class="quick-links">' +
      buildQuickLink('https://github.com', 'G', 'GitHub') +
      buildQuickLink('https://google.com', 'g', 'Google') +
      buildQuickLink('https://youtube.com', 'Y', 'YouTube') +
      buildQuickLink('https://reddit.com', 'R', 'Reddit') +
      buildQuickLink('https://stackoverflow.com', 'S', 'Stack Overflow') +
      buildQuickLink('https://wikipedia.org', 'W', 'Wikipedia') +
    '</div>' +
  '</div>';
}

function buildQuickLink(url, icon, label) {
  return '<div class="quick-link" data-url="' + url + '">' +
    '<div class="quick-link-icon">' + icon + '</div>' + label + '</div>';
}

// ============ Settings ============
function bindSettingsEvents(container) {
  // Toggle switches
  container.querySelectorAll('.toggle').forEach(function(toggle) {
    toggle.addEventListener('click', function() {
      this.classList.toggle('on');
      var key = this.dataset.key;
      if (key) setSetting(key, this.classList.contains('on'));
    });
  });
}

function setSetting(key, value) {
  ipcSend('set_setting', { key: key, value: value });
}

function applySettingsData(data) {
  if (!data) return;
  var sv = function(id, v) { var e = document.getElementById(id); if (e) e.value = v; };
  var st = function(id, v) { var e = document.getElementById(id); if (e) { if (v) e.classList.add('on'); else e.classList.remove('on'); } };
  if (data.general) {
    sv('s-language', data.general.language);
    sv('s-startup', data.general.startup_behavior);
    sv('s-search', data.general.default_search_engine);
  }
  if (data.privacy) {
    st('s-trackers', data.privacy.tracker_blocking);
    st('s-ads', data.privacy.ad_blocking);
    st('s-https', data.privacy.https_enforcement);
    st('s-doh', data.privacy.dns_over_https);
    st('s-fingerprint', data.privacy.anti_fingerprinting);
    st('s-clearonexit', data.privacy.clear_data_on_exit);
  }
  if (data.appearance) {
    sv('s-theme', data.appearance.theme);
    sv('s-accent', data.appearance.accent_color);
    sv('s-fontsize', data.appearance.font_size);
  }
  if (data.performance) {
    sv('s-suspend', data.performance.tab_suspend_timeout_minutes);
    st('s-lazyimg', data.performance.lazy_load_images);
  }
}

// ============ URL Bar ============
function updateUrlBar() {
  var tab = state.tabs.find(function(t) { return t.id === state.activeTabId; });
  var input = document.getElementById('url-input');
  if (!tab || !input) return;

  if (tab.url === 'about:newtab' || tab.url === 'about:settings' || tab.url === 'about:blank') {
    input.value = '';
    input.placeholder = 'Search or enter URL';
  } else {
    input.value = tab.url;
  }

  // Security icon
  var icon = document.getElementById('security-icon');
  if (icon) {
    var path = icon.querySelector('path');
    if (tab.url && tab.url.startsWith('https://')) {
      path.setAttribute('fill', 'var(--success-fg)');
    } else if (tab.url && tab.url.startsWith('http://')) {
      path.setAttribute('fill', 'var(--attention-fg)');
    } else {
      path.setAttribute('fill', 'var(--fg-muted)');
    }
  }

  // Status bar
  var status = document.getElementById('status-text');
  if (status) {
    status.textContent = (tab.url && !tab.url.startsWith('about:')) ? tab.url : '';
  }
}

function navigateFromInput(input) {
  var val = input.trim();
  if (!val) return;
  ipcSend('navigate', { url: val });
}

// ============ Page Events ============
function bindPageEvents(pageEl, tabId) {
  // New tab search
  var searchInput = pageEl.querySelector('.newtab-search-input');
  if (searchInput) {
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var val = e.target.value.trim();
        if (val) ipcSend('navigate', { url: val });
      }
    });
    // Focus search input when tab becomes active
    setTimeout(function() { searchInput.focus(); }, 50);
  }

  // Quick links
  pageEl.querySelectorAll('.quick-link').forEach(function(link) {
    link.addEventListener('click', function() {
      ipcSend('navigate', { url: link.dataset.url });
    });
  });
}

// ============ Utilities ============
function getDomain(url) {
  if (!url || url.startsWith('about:')) return '';
  try { return new URL(url).hostname.replace('www.', ''); }
  catch(e) { return ''; }
}

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

function escAttr(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showToast(msg) {
  var t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.3s';
    setTimeout(function() { t.remove(); }, 300);
  }, 2000);
}

// ============ Event Bindings ============
document.addEventListener('DOMContentLoaded', function() {
  // New tab
  document.getElementById('new-tab-btn').addEventListener('click', function() {
    ipcSend('new_tab', {});
  });

  // Navigation buttons
  document.getElementById('btn-back').addEventListener('click', function() {
    var page = state.tabPages[state.activeTabId];
    if (page && page.type === 'web') {
      var iframe = page.el.querySelector('iframe');
      if (iframe) { try { iframe.contentWindow.history.back(); } catch(e) {} }
    }
  });
  document.getElementById('btn-forward').addEventListener('click', function() {
    var page = state.tabPages[state.activeTabId];
    if (page && page.type === 'web') {
      var iframe = page.el.querySelector('iframe');
      if (iframe) { try { iframe.contentWindow.history.forward(); } catch(e) {} }
    }
  });
  document.getElementById('btn-reload').addEventListener('click', function() {
    var page = state.tabPages[state.activeTabId];
    if (page && page.type === 'web') {
      var iframe = page.el.querySelector('iframe');
      if (iframe) { try { iframe.contentWindow.location.reload(); } catch(e) {} }
    }
  });

  // URL input
  var urlInput = document.getElementById('url-input');
  urlInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') navigateFromInput(e.target.value);
  });
  urlInput.addEventListener('focus', function() { this.select(); });

  // Bookmark
  document.getElementById('btn-bookmark').addEventListener('click', function() {
    var tab = state.tabs.find(function(t) { return t.id === state.activeTabId; });
    if (tab && tab.url && !tab.url.startsWith('about:')) {
      ipcSend('add_bookmark', { url: tab.url, title: tab.title });
    }
  });

  // Settings
  document.getElementById('btn-settings').addEventListener('click', function() {
    ipcSend('navigate_new_tab', { url: 'about:settings' });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 't') { e.preventDefault(); ipcSend('new_tab', {}); }
    if (e.ctrlKey && e.key === 'w') { e.preventDefault(); if (state.activeTabId) ipcSend('close_tab', { id: state.activeTabId }); }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); urlInput.focus(); urlInput.select(); }
    if (e.ctrlKey && e.key === 'r') {
      e.preventDefault();
      var page = state.tabPages[state.activeTabId];
      if (page && page.type === 'web') {
        var iframe = page.el.querySelector('iframe');
        if (iframe) try { iframe.contentWindow.location.reload(); } catch(ex) {}
      }
    }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); ipcSend('navigate_new_tab', { url: 'about:settings' }); }
    // Tab switching with Ctrl+1-9
    if (e.ctrlKey && e.key >= '1' && e.key <= '9') {
      e.preventDefault();
      var idx = parseInt(e.key) - 1;
      if (idx < state.tabs.length) {
        ipcSend('switch_tab', { id: state.tabs[idx].id });
      }
    }
  });

  // Signal ready
  ipcSend('ui_ready', {});
});
