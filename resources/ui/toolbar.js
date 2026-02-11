(function(){
if(document.getElementById('gb-toolbar'))return;

var CSS = '#gb-toolbar{position:fixed;top:0;left:0;right:0;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;font-size:13px;background:#161b22;color:#e6edf3;user-select:none;-webkit-user-select:none;display:flex;flex-direction:column;box-shadow:0 2px 8px rgba(0,0,0,0.4)}'
+'#gb-tabbar{display:flex;align-items:flex-end;height:36px;padding:0 8px;gap:2px;border-bottom:1px solid #21262d;background:#0d1117}'
+'#gb-tabs{display:flex;gap:2px;flex:1;overflow-x:auto;align-items:flex-end;height:100%;padding-top:4px;scrollbar-width:none}'
+'#gb-tabs::-webkit-scrollbar{display:none}'
+'.gb-tab{display:flex;align-items:center;gap:6px;padding:5px 12px;height:30px;background:transparent;color:#7d8590;border-radius:6px 6px 0 0;cursor:pointer;white-space:nowrap;border:1px solid transparent;border-bottom:none;transition:all .12s;max-width:200px;min-width:40px;font-size:12px;position:relative}'
+'.gb-tab:hover{background:#1c2128;color:#e6edf3}'
+'.gb-tab.active{background:#0d1117;color:#e6edf3;border-color:#30363d}'
+'.gb-tab.active::after{content:"";position:absolute;bottom:-1px;left:0;right:0;height:2px;background:#1f6feb;border-radius:2px 2px 0 0}'
+'.gb-tab-x{width:16px;height:16px;border:none;background:none;color:#484f58;cursor:pointer;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;opacity:0;transition:all .12s;flex-shrink:0}'
+'.gb-tab:hover .gb-tab-x{opacity:1}'
+'.gb-tab-x:hover{background:#da3633;color:#fff}'
+'#gb-newtab{width:30px;height:30px;border:none;background:none;color:#7d8590;cursor:pointer;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;transition:all .12s}'
+'#gb-newtab:hover{background:#1c2128;color:#e6edf3}'
+'#gb-addrbar{display:flex;align-items:center;gap:4px;padding:5px 10px;background:#161b22;border-bottom:1px solid #30363d}'
+'#gb-nav{display:flex;gap:2px}'
+'#gb-nav button{width:28px;height:28px;border:none;background:none;color:#7d8590;cursor:pointer;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:14px;transition:all .12s}'
+'#gb-nav button:hover{background:#1c2128;color:#e6edf3}'
+'#gb-nav button:active{transform:scale(0.9)}'
+'#gb-urlbox{flex:1;display:flex;align-items:center;gap:8px;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:0 10px;height:30px;transition:all .15s}'
+'#gb-urlbox:focus-within{border-color:#1f6feb;box-shadow:0 0 0 3px rgba(31,111,235,0.3)}'
+'#gb-url{flex:1;border:none;background:none;color:#e6edf3;font-family:inherit;font-size:13px;outline:none}'
+'#gb-url::placeholder{color:#484f58}'
+'#gb-tools{display:flex;gap:2px}'
+'#gb-tools button{width:28px;height:28px;border:none;background:none;color:#7d8590;cursor:pointer;border-radius:6px;display:flex;align-items:center;justify-content:center;transition:all .12s}'
+'#gb-tools button:hover{background:#1c2128;color:#e6edf3}'
+'#gb-tools button:active{transform:scale(0.9)}'
+'#gb-status{position:fixed;bottom:0;left:0;right:0;height:22px;background:#161b22;border-top:1px solid #30363d;display:flex;align-items:center;padding:0 10px;font-size:11px;color:#7d8590;z-index:2147483647}'
+'.gb-toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);padding:6px 16px;background:#161b22;border:1px solid #30363d;border-radius:8px;color:#e6edf3;font-size:12px;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,0.4)}';

var s = document.createElement('style');
s.textContent = CSS;
(document.head || document.documentElement).appendChild(s);

var tb = document.createElement('div');
tb.id = 'gb-toolbar';
tb.innerHTML = '<div id="gb-tabbar"><div id="gb-tabs"></div><button id="gb-newtab" title="New Tab (Ctrl+T)">+</button></div>'
+ '<div id="gb-addrbar"><div id="gb-nav">'
+ '<button id="gb-back" title="Back">\u25C0</button>'
+ '<button id="gb-fwd" title="Forward">\u25B6</button>'
+ '<button id="gb-reload" title="Reload">\u21BB</button>'
+ '</div><div id="gb-urlbox">'
+ '<svg width="14" height="14" viewBox="0 0 16 16" fill="#7d8590"><path d="M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10.5 6V4a2.5 2.5 0 1 0-5 0v2Z"/></svg>'
+ '<input id="gb-url" type="text" placeholder="Search or enter URL" spellcheck="false" autocomplete="off"/>'
+ '</div><div id="gb-tools">'
+ '<button id="gb-bmark" title="Bookmark">\u2606</button>'
+ '<button id="gb-settings" title="Settings">\u2699</button>'
+ '</div></div>';
document.documentElement.appendChild(tb);

var st = document.createElement('div');
st.id = 'gb-status';
st.innerHTML = '<span id="gb-status-text"></span>';
document.documentElement.appendChild(st);

// Push page content down below toolbar
document.body.style.marginTop = '72px';
document.body.style.marginBottom = '22px';

// IPC helper
var ipc = function(cmd, data) {
  if (window.ipc) window.ipc.postMessage(JSON.stringify(Object.assign({ cmd: cmd }, data || {})));
};
window.__gb_ipc = ipc;

// Button handlers
document.getElementById('gb-newtab').onclick = function() { ipc('new_tab', {}); };
document.getElementById('gb-back').onclick = function() { history.back(); };
document.getElementById('gb-fwd').onclick = function() { history.forward(); };
document.getElementById('gb-reload').onclick = function() { location.reload(); };
document.getElementById('gb-bmark').onclick = function() {
  ipc('add_bookmark', { url: location.href, title: document.title || location.href });
};
document.getElementById('gb-settings').onclick = function() { ipc('open_settings', {}); };

// URL input
var urlEl = document.getElementById('gb-url');
urlEl.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') ipc('navigate', { url: e.target.value });
});
urlEl.addEventListener('focus', function() { this.select(); });

// Keyboard shortcuts
document.addEventListener('keydown', function(e) {
  if (e.ctrlKey && e.key === 't') { e.preventDefault(); ipc('new_tab', {}); }
  if (e.ctrlKey && e.key === 'w') { e.preventDefault(); ipc('close_active_tab', {}); }
  if (e.ctrlKey && e.key === 'l') { e.preventDefault(); urlEl.focus(); urlEl.select(); }
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); ipc('open_settings', {}); }
});

// Tab update function — called from Rust
window.__gb_updateTabs = function(data) {
  var c = document.getElementById('gb-tabs');
  if (!c) return;
  c.innerHTML = '';
  var tabs = data.tabs || [];
  var aid = data.activeId || '';
  tabs.forEach(function(t) {
    var d = document.createElement('div');
    d.className = 'gb-tab' + (t.id === aid ? ' active' : '');
    var title = t.title || 'New Tab';
    if (title.length > 25) title = title.substring(0, 25) + '...';
    var span = document.createElement('span');
    span.textContent = title;
    d.appendChild(span);
    var xbtn = document.createElement('button');
    xbtn.className = 'gb-tab-x';
    xbtn.textContent = '\u00D7';
    d.appendChild(xbtn);
    (function(id) {
      d.addEventListener('click', function(e) {
        if (!e.target.closest('.gb-tab-x')) ipc('switch_tab', { id: id });
      });
      xbtn.addEventListener('click', function(e) {
        e.stopPropagation();
        ipc('close_tab', { id: id });
      });
    })(t.id);
    c.appendChild(d);
  });
  // Update URL bar
  var active = tabs.find(function(t) { return t.id === aid; });
  if (urlEl && active) {
    if (active.url && !active.url.startsWith('about:')) urlEl.value = active.url;
    else urlEl.value = '';
  }
  var stxt = document.getElementById('gb-status-text');
  if (stxt && active) stxt.textContent = (active.url && !active.url.startsWith('about:')) ? active.url : '';
};

// Toast
window.__gb_showToast = function(msg) {
  var t = document.createElement('div');
  t.className = 'gb-toast';
  t.textContent = msg;
  document.documentElement.appendChild(t);
  setTimeout(function() {
    t.style.opacity = '0';
    t.style.transition = 'opacity .3s';
    setTimeout(function() { t.remove(); }, 300);
  }, 2000);
};

// Signal ready
ipc('ui_ready', {});

// Track URL changes for the address bar (in-page navigation, redirects)
var __gb_lastUrl = location.href;
function __gb_checkUrl() {
  if (location.href !== __gb_lastUrl) {
    __gb_lastUrl = location.href;
    if (urlEl && !location.href.startsWith('about:')) urlEl.value = location.href;
    var stxt = document.getElementById('gb-status-text');
    if (stxt) stxt.textContent = location.href;
    // Notify Rust about URL change
    ipc('url_changed', { url: location.href, title: document.title || location.hostname });
  }
}
window.addEventListener('popstate', __gb_checkUrl);
window.addEventListener('hashchange', __gb_checkUrl);
// Also poll for SPA navigations (pushState doesn't fire events)
setInterval(__gb_checkUrl, 500);

// Update URL bar with current page URL on load
if (urlEl && location.href && location.protocol !== 'about:' && location.href !== 'about:blank') {
  urlEl.value = location.href;
}
})();
