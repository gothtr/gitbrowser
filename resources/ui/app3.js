// === New Tab Page ===
function buildNewTabPage() {
  return '<div class="newtab-page">' +
    '<div class="newtab-logo">GitBrowser</div>' +
    '<div class="newtab-subtitle">Fast. Private. Open.</div>' +
    '<div class="newtab-search">' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 1 1-1.06 1.06l-3.04-3.04ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>' +
      '<input class="newtab-search-input" type="text" placeholder="Search the web or enter URL..." autofocus />' +
    '</div>' +
    '<div class="quick-links">' +
      '<div class="quick-link" data-url="https://github.com"><div class="quick-link-icon">G</div>GitHub</div>' +
      '<div class="quick-link" data-url="https://google.com"><div class="quick-link-icon">g</div>Google</div>' +
      '<div class="quick-link" data-url="https://youtube.com"><div class="quick-link-icon">Y</div>YouTube</div>' +
      '<div class="quick-link" data-url="https://reddit.com"><div class="quick-link-icon">R</div>Reddit</div>' +
    '</div>' +
  '</div>';
}

// === Settings Page ===
function buildSettingsPage() {
  return '<div class="settings-title">Settings</div>' +
    '<div class="settings-desc">Manage your browser preferences</div>' +
    '<div class="settings-section">' +
      '<div class="settings-section-header">General</div>' +
      '<div class="setting-row"><div class="setting-info"><div class="setting-label">Language</div><div class="setting-desc">Interface language</div></div>' +
        '<select id="s-language" onchange="setSetting(\'general.language\',this.value)"><option value="en">English</option><option value="ru">Russian</option></select></div>' +
      '<div class="setting-row"><div class="setting-info"><div class="setting-label">On Startup</div><div class="setting-desc">What to show when browser starts</div></div>' +
        '<select id="s-startup" onchange="setSetting(\'general.startup_behavior\',this.value)"><option value="Restore">Restore session</option><option value="NewTab">New tab</option><option value="Homepage">Homepage</option></select></div>' +
      '<div class="setting-row"><div class="setting-info"><div class="setting-label">Search Engine</div><div class="setting-desc">Default search provider</div></div>' +
        '<select id="s-search" onchange="setSetting(\'general.default_search_engine\',this.value)"><option value="google">Google</option><option value="duckduckgo">DuckDuckGo</option><option value="bing">Bing</option></select></div>' +
    '</div>' +
    '<div class="settings-section">' +
      '<div class="settings-section-header">Privacy and Security</div>' +
      stgl('s-trackers','Block Trackers','Prevent tracking scripts from loading','privacy.tracker_blocking',true) +
      stgl('s-ads','Block Ads','Remove advertisements from pages','privacy.ad_blocking',true) +
      stgl('s-https','Force HTTPS','Upgrade insecure connections automatically','privacy.https_enforcement',true) +
      stgl('s-doh','DNS over HTTPS','Encrypt DNS queries for privacy','privacy.dns_over_https',true) +
      stgl('s-fingerprint','Anti-Fingerprinting','Reduce browser fingerprint surface','privacy.anti_fingerprinting',true) +
      stgl('s-clearonexit','Clear Data on Exit','Remove browsing data when closing','privacy.clear_data_on_exit',false) +
    '</div>' +
    '<div class="settings-section">' +
      '<div class="settings-section-header">Appearance</div>' +
      '<div class="setting-row"><div class="setting-info"><div class="setting-label">Theme</div><div class="setting-desc">Color scheme</div></div>' +
        '<select id="s-theme" onchange="setSetting(\'appearance.theme\',this.value)"><option value="Dark">Dark</option><option value="Light">Light</option><option value="System">System</option></select></div>' +
      '<div class="setting-row"><div class="setting-info"><div class="setting-label">Accent Color</div></div>' +
        '<input type="color" id="s-accent" value="#2ea44f" onchange="setSetting(\'appearance.accent_color\',this.value)" /></div>' +
      '<div class="setting-row"><div class="setting-info"><div class="setting-label">Font Size</div></div>' +
        '<input type="number" id="s-fontsize" value="14" min="10" max="24" style="width:60px" onchange="setSetting(\'appearance.font_size\',parseInt(this.value))" /></div>' +
    '</div>' +
    '<div class="settings-section">' +
      '<div class="settings-section-header">AI Assistant</div>' +
      '<div class="setting-row"><div class="setting-info"><div class="setting-label">Provider</div><div class="setting-desc">AI service for page analysis</div></div>' +
        '<select id="s-ai" onchange="setSetting(\'ai.active_provider\',this.value)"><option value="">None</option><option value="OpenAI">OpenAI</option><option value="Anthropic">Anthropic</option><option value="OpenRouter">OpenRouter</option><option value="DeepSeek">DeepSeek</option></select></div>' +
    '</div>' +
    '<div class="settings-section">' +
      '<div class="settings-section-header">Performance</div>' +
      '<div class="setting-row"><div class="setting-info"><div class="setting-label">Tab Suspend Timeout</div><div class="setting-desc">Minutes before inactive tabs are suspended</div></div>' +
        '<input type="number" id="s-suspend" value="30" min="1" max="120" style="width:70px" onchange="setSetting(\'performance.tab_suspend_timeout_minutes\',parseInt(this.value))" /></div>' +
      stgl('s-lazyimg','Lazy Load Images','Defer loading off-screen images','performance.lazy_load_images',true) +
    '</div>' +
    '<div style="padding:16px 0"><button class="btn btn-danger" onclick="ipcSend(\'reset_settings\',{})">Reset All Settings to Defaults</button></div>';
}

function stgl(id, label, desc, key, on) {
  return '<div class="setting-row"><div class="setting-info"><div class="setting-label">' + label + '</div><div class="setting-desc">' + desc + '</div></div>' +
    '<div class="toggle' + (on ? ' on' : '') + '" id="' + id + '" onclick="this.classList.toggle(\'on\');setSetting(\'' + key + '\',this.classList.contains(\'on\'))"></div></div>';
}

function setSetting(key, value) { ipcSend('set_setting', { key: key, value: value }); }

function applySettingsData(data) {
  if (!data) return;
  var sv = function(id,v) { var e=document.getElementById(id); if(e) e.value=v; };
  var st = function(id,v) { var e=document.getElementById(id); if(e){if(v)e.classList.add('on');else e.classList.remove('on');} };
  if(data.general){sv('s-language',data.general.language);sv('s-startup',data.general.startup_behavior);sv('s-search',data.general.default_search_engine);}
  if(data.privacy){st('s-trackers',data.privacy.tracker_blocking);st('s-ads',data.privacy.ad_blocking);st('s-https',data.privacy.https_enforcement);st('s-doh',data.privacy.dns_over_https);st('s-fingerprint',data.privacy.anti_fingerprinting);st('s-clearonexit',data.privacy.clear_data_on_exit);}
  if(data.appearance){sv('s-theme',data.appearance.theme);sv('s-accent',data.appearance.accent_color);sv('s-fontsize',data.appearance.font_size);}
  if(data.performance){sv('s-suspend',data.performance.tab_suspend_timeout_minutes);st('s-lazyimg',data.performance.lazy_load_images);}
}
