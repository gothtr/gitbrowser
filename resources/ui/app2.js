// === Settings Panel Renderer ===
function renderSettingsPanel() {
  return `
    <div class="settings-group">
      <div class="settings-group-title">General</div>
      <div class="setting-row">
        <div><div class="setting-label">Language</div></div>
        <select onchange="ipcSend('set_setting',{key:'general.language',value:this.value})">
          <option value="en">English</option><option value="ru">Русский</option>
        </select>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Homepage</div></div>
        <input type="text" value="about:newtab" style="width:200px"
          onchange="ipcSend('set_setting',{key:'general.homepage',value:this.value})" />
      </div>
      <div class="setting-row">
        <div><div class="setting-label">On Startup</div></div>
        <select onchange="ipcSend('set_setting',{key:'general.startup_behavior',value:this.value})">
          <option value="Restore">Restore previous session</option>
          <option value="NewTab">Open new tab</option>
          <option value="Homepage">Open homepage</option>
        </select>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">Privacy & Security</div>
      <div class="setting-row">
        <div><div class="setting-label">Block Trackers</div></div>
        <div class="toggle on" onclick="this.classList.toggle('on');ipcSend('set_setting',{key:'privacy.tracker_blocking',value:this.classList.contains('on')})"></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Block Ads</div></div>
        <div class="toggle on" onclick="this.classList.toggle('on');ipcSend('set_setting',{key:'privacy.ad_blocking',value:this.classList.contains('on')})"></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Force HTTPS</div></div>
        <div class="toggle on" onclick="this.classList.toggle('on');ipcSend('set_setting',{key:'privacy.https_enforcement',value:this.classList.contains('on')})"></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">DNS over HTTPS</div></div>
        <div class="toggle on" onclick="this.classList.toggle('on');ipcSend('set_setting',{key:'privacy.dns_over_https',value:this.classList.contains('on')})"></div>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Clear data on exit</div></div>
        <div class="toggle" onclick="this.classList.toggle('on');ipcSend('set_setting',{key:'privacy.clear_data_on_exit',value:this.classList.contains('on')})"></div>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">Appearance</div>
      <div class="setting-row">
        <div><div class="setting-label">Theme</div></div>
        <select onchange="ipcSend('set_setting',{key:'appearance.theme',value:this.value})">
          <option value="Dark">Dark</option><option value="Light">Light</option><option value="System">System</option>
        </select>
      </div>
      <div class="setting-row">
        <div><div class="setting-label">Accent Color</div></div>
        <input type="color" value="#2ea44f" onchange="ipcSend('set_setting',{key:'appearance.accent_color',value:this.value})" />
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">AI Assistant</div>
      <div class="setting-row">
        <div><div class="setting-label">Provider</div></div>
        <select onchange="ipcSend('set_setting',{key:'ai.active_provider',value:this.value})">
          <option value="">None</option><option value="OpenAI">OpenAI</option>
          <option value="Anthropic">Anthropic</option><option value="OpenRouter">OpenRouter</option>
          <option value="DeepSeek">DeepSeek</option>
        </select>
      </div>
    </div>
    <div class="settings-group">
      <div class="settings-group-title">Performance</div>
      <div class="setting-row">
        <div><div class="setting-label">Tab suspend timeout (min)</div></div>
        <input type="number" value="30" min="1" max="120" style="width:60px"
          onchange="ipcSend('set_setting',{key:'performance.tab_suspend_timeout_minutes',value:parseInt(this.value)})" />
      </div>
    </div>
    <div style="margin-top:20px">
      <button class="btn btn-danger" onclick="ipcSend('reset_settings',{})">Reset to Defaults</button>
    </div>
  `;
}

// === Bookmarks Panel Renderer ===
function renderBookmarksPanel(bookmarks) {
  if (!bookmarks || bookmarks.length === 0) {
    return '<p style="color:var(--text-secondary);text-align:center;padding:20px">No bookmarks yet</p>';
  }
  return bookmarks.map(b => `
    <div class="panel-item" onclick="ipcSend('navigate',{url:'${escHtml(b.url)}'})">
      <span>☆</span>
      <div class="panel-item-title">${escHtml(b.title)}</div>
      <button class="tab-close" onclick="event.stopPropagation();ipcSend('remove_bookmark',{id:'${b.id}'})">✕</button>
    </div>
  `).join('');
}

// === History Panel Renderer ===
function renderHistoryPanel(entries) {
  if (!entries || entries.length === 0) {
    return '<p style="color:var(--text-secondary);text-align:center;padding:20px">No history</p>';
  }
  return `
    <div style="margin-bottom:8px"><button class="btn btn-danger" onclick="ipcSend('clear_history',{})">Clear All</button></div>
  ` + entries.map(e => `
    <div class="panel-item" onclick="ipcSend('navigate',{url:'${escHtml(e.url)}'})">
      <div class="panel-item-title">${escHtml(e.title)}</div>
      <div class="panel-item-meta">${e.visit_count}x</div>
    </div>
  `).join('');
}

// === Downloads Panel Renderer ===
function renderDownloadsPanel(downloads) {
  if (!downloads || downloads.length === 0) {
    return '<p style="color:var(--text-secondary);text-align:center;padding:20px">No downloads</p>';
  }
  return downloads.map(d => `
    <div class="panel-item">
      <span>↓</span>
      <div>
        <div class="panel-item-title">${escHtml(d.filename)}</div>
        <div class="panel-item-meta">${d.status}</div>
      </div>
    </div>
  `).join('');
}

// === Utility ===
function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

// === Event Bindings ===
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('new-tab-btn').addEventListener('click', () => ipcSend('new_tab', {}));
  document.getElementById('btn-back').addEventListener('click', () => ipcSend('go_back', {}));
  document.getElementById('btn-forward').addEventListener('click', () => ipcSend('go_forward', {}));
  document.getElementById('btn-reload').addEventListener('click', () => ipcSend('reload', {}));
  document.getElementById('url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate(e.target.value);
  });
  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate(e.target.value);
  });
  document.getElementById('btn-bookmark').addEventListener('click', () => togglePanel('bookmarks'));
  document.getElementById('btn-downloads').addEventListener('click', () => togglePanel('downloads'));
  document.getElementById('btn-extensions').addEventListener('click', () => togglePanel('extensions'));
  document.getElementById('btn-ai').addEventListener('click', () => togglePanel('ai'));
  document.getElementById('btn-github').addEventListener('click', () => togglePanel('github'));
  document.getElementById('btn-settings').addEventListener('click', () => togglePanel('settings'));
  document.getElementById('panel-close').addEventListener('click', () => {
    document.getElementById('side-panel').classList.add('hidden');
    state.panelOpen = null;
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 't') { e.preventDefault(); ipcSend('new_tab', {}); }
    if (e.ctrlKey && e.key === 'w') { e.preventDefault(); ipcSend('close_tab', { id: state.activeTabId }); }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); document.getElementById('url-input').focus(); document.getElementById('url-input').select(); }
    if (e.ctrlKey && e.key === 'r') { e.preventDefault(); ipcSend('reload', {}); }
    if (e.ctrlKey && e.key === 'b') { e.preventDefault(); togglePanel('bookmarks'); }
    if (e.ctrlKey && e.key === 'h') { e.preventDefault(); togglePanel('history'); }
    if (e.ctrlKey && e.key === 'j') { e.preventDefault(); togglePanel('downloads'); }
  });

  // Notify Rust that UI is ready
  ipcSend('ui_ready', {});
});
