// === Event Bindings ===
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('new-tab-btn').addEventListener('click', function() { ipcSend('new_tab', {}); });
  document.getElementById('btn-back').addEventListener('click', function() {
    var page = document.querySelector('.page.active iframe');
    if (page) { try { page.contentWindow.history.back(); } catch(e){} }
  });
  document.getElementById('btn-forward').addEventListener('click', function() {
    var page = document.querySelector('.page.active iframe');
    if (page) { try { page.contentWindow.history.forward(); } catch(e){} }
  });
  document.getElementById('btn-reload').addEventListener('click', function() {
    var page = document.querySelector('.page.active iframe');
    if (page) { try { page.contentWindow.location.reload(); } catch(e){} }
  });
  document.getElementById('url-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && state.activeTabId) navigateInTab(state.activeTabId, e.target.value);
  });
  document.getElementById('url-input').addEventListener('focus', function() { this.select(); });

  document.getElementById('btn-bookmark').addEventListener('click', function() {
    var tab = state.tabs.find(function(t){return t.id===state.activeTabId;});
    if (tab && tab.url && !tab.url.startsWith('about:')) {
      ipcSend('add_bookmark', { url: tab.url, title: tab.title });
      showToast('Bookmark added');
    }
  });
  document.getElementById('btn-history').addEventListener('click', function() {
    // Open history as a new tab (future: dedicated history page)
    showToast('History: Ctrl+H');
  });
  document.getElementById('btn-downloads').addEventListener('click', function() {
    showToast('Downloads: Ctrl+J');
  });
  document.getElementById('btn-settings').addEventListener('click', function() {
    // Open settings as a new tab
    ipcSend('navigate_new_tab', { url: 'about:settings' });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 't') { e.preventDefault(); ipcSend('new_tab', {}); }
    if (e.ctrlKey && e.key === 'w') { e.preventDefault(); if(state.activeTabId) ipcSend('close_tab', { id: state.activeTabId }); }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); var u=document.getElementById('url-input'); u.focus(); u.select(); }
    if (e.ctrlKey && e.key === 'r') { e.preventDefault(); var f=document.querySelector('.page.active iframe'); if(f) try{f.contentWindow.location.reload();}catch(ex){} }
    if (e.ctrlKey && e.key === ',') { e.preventDefault(); ipcSend('navigate_new_tab', { url: 'about:settings' }); }
  });

  ipcSend('ui_ready', {});
});

// === Toast notification ===
function showToast(msg) {
  var t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);padding:8px 20px;background:var(--bg-default);border:1px solid var(--border-default);border-radius:var(--radius-md);color:var(--fg-default);font-size:13px;z-index:9999;animation:toastIn 0.2s ease-out;box-shadow:var(--shadow-lg);';
  document.body.appendChild(t);
  setTimeout(function(){ t.style.opacity='0'; t.style.transition='opacity 0.3s'; setTimeout(function(){t.remove();},300); }, 2000);
}
