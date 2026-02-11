// GitBrowser Shell JS — runs on internal pages (newtab, settings)
(function() {
  // Render tab bar from TABS_DATA
  function renderTabs() {
    var c = document.getElementById('tabs-container');
    if (!c || !TABS_DATA) return;
    c.innerHTML = '';
    var tabs = TABS_DATA.tabs || [];
    var activeId = TABS_DATA.activeId || '';
    tabs.forEach(function(tab) {
      var el = document.createElement('div');
      el.className = 'tab' + (tab.id === activeId ? ' active' : '') + (tab.pinned ? ' pinned' : '');
      var domain = '';
      try { if (tab.url && !tab.url.startsWith('about:')) domain = new URL(tab.url).hostname.replace('www.',''); } catch(e) {}
      var initial = domain ? domain[0].toUpperCase() : 'N';
      el.innerHTML =
        '<div class="tab-favicon">' + initial + '</div>' +
        '<span class="tab-title">' + escHtml(tab.title || 'New Tab') + '</span>' +
        '<button class="tab-close"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 1 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg></button>';
      (function(tabId) {
        el.addEventListener('click', function(e) {
          if (!e.target.closest('.tab-close')) ipcSend('switch_tab', { id: tabId });
        });
        el.querySelector('.tab-close').addEventListener('click', function(e) {
          e.stopPropagation();
          ipcSend('close_tab', { id: tabId });
        });
      })(tab.id);
      c.appendChild(el);
    });
  }

  function escHtml(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // URL bar navigation
  var urlInput = document.getElementById('url-input');
  if (urlInput) {
    urlInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var val = e.target.value.trim();
        if (val) ipcSend('navigate', { url: val });
      }
    });
    urlInput.addEventListener('focus', function() { this.select(); });
  }

  // New tab button
  var newTabBtn = document.getElementById('new-tab-btn');
  if (newTabBtn) newTabBtn.addEventListener('click', function() { ipcSend('new_tab', {}); });

  // Toolbar buttons
  var btnBookmark = document.getElementById('btn-bookmark');
  if (btnBookmark) btnBookmark.addEventListener('click', function() {
    var tab = (TABS_DATA.tabs || []).find(function(t) { return t.id === TABS_DATA.activeId; });
    if (tab && tab.url && !tab.url.startsWith('about:')) {
      ipcSend('add_bookmark', { url: tab.url, title: tab.title });
      showToast('Bookmark added');
    }
  });

  var btnSettings = document.getElementById('btn-settings');
  if (btnSettings) btnSettings.addEventListener('click', function() { ipcSend('open_settings', {}); });

  var btnBack = document.getElementById('btn-back');
  if (btnBack) btnBack.addEventListener('click', function() { history.back(); });
  var btnForward = document.getElementById('btn-forward');
  if (btnForward) btnForward.addEventListener('click', function() { history.forward(); });
  var btnReload = document.getElementById('btn-reload');
  if (btnReload) btnReload.addEventListener('click', function() { location.reload(); });

  // New tab page: search input and quick links
  var searchInput = document.querySelector('.newtab-search-input');
  if (searchInput) {
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        var val = e.target.value.trim();
        if (val) ipcSend('navigate', { url: val });
      }
    });
    setTimeout(function() { searchInput.focus(); }, 100);
  }

  document.querySelectorAll('.quick-link').forEach(function(link) {
    link.addEventListener('click', function() {
      ipcSend('navigate', { url: link.dataset.url });
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 't') { e.preventDefault(); ipcSend('new_tab', {}); }
    if (e.ctrlKey && e.key === 'w') { e.preventDefault(); if (TABS_DATA.activeId) ipcSend('close_tab', { id: TABS_DATA.activeId }); }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); if (urlInput) { urlInput.focus(); urlInput.select(); } }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); ipcSend('open_settings', {}); }
  });

  // Toast
  window.showToast = function(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);padding:8px 20px;background:#161b22;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-size:13px;z-index:9999;box-shadow:0 8px 24px rgba(1,4,9,0.4);';
    document.body.appendChild(t);
    setTimeout(function() { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(function() { t.remove(); }, 300); }, 2000);
  };

  // Settings page functions
  window.applySettingsData = function(data) {
    if (!data) return;
    var sv = function(id, v) { var e = document.getElementById(id); if (e) e.value = v; };
    var st = function(id, v) { var e = document.getElementById(id); if (e) { if (v) e.classList.add('on'); else e.classList.remove('on'); } };
    if (data.general) { sv('s-language', data.general.language); sv('s-startup', data.general.startup_behavior); sv('s-search', data.general.default_search_engine); }
    if (data.privacy) { st('s-trackers', data.privacy.tracker_blocking); st('s-ads', data.privacy.ad_blocking); st('s-https', data.privacy.https_enforcement); st('s-doh', data.privacy.dns_over_https); st('s-fingerprint', data.privacy.anti_fingerprinting); st('s-clearonexit', data.privacy.clear_data_on_exit); }
    if (data.appearance) { sv('s-theme', data.appearance.theme); sv('s-accent', data.appearance.accent_color); sv('s-fontsize', data.appearance.font_size); }
    if (data.performance) { sv('s-suspend', data.performance.tab_suspend_timeout_minutes); st('s-lazyimg', data.performance.lazy_load_images); }
  };

  window.setSetting = function(key, value) { ipcSend('set_setting', { key: key, value: value }); };

  // Render tabs and signal ready
  renderTabs();
  ipcSend('ui_ready', {});
})();
