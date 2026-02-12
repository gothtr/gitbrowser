const { app, BaseWindow, WebContentsView, ipcMain, session, Menu, nativeTheme, net, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const rustBridge = require('./rust-bridge');

// Disable Autofill CDP errors from DevTools
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication,AutofillEnableAccountWalletStorage');

// Suppress EPIPE errors that occur when writing to destroyed webContents/sockets
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') return; // silently ignore
  // For non-EPIPE errors, log and show dialog
  console.error('Uncaught exception:', err);
  dialog.showErrorBox('Error', err?.message || String(err));
});
process.on('unhandledRejection', (reason) => {
  if (reason && reason.code === 'EPIPE') return;
  console.error('Unhandled rejection:', reason);
});

// Resolve paths that work both in dev and packaged app
// In packaged app, extraResources are at process.resourcesPath
function resolvePath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments);
  }
  return path.join(__dirname, '..', ...segments);
}

// User data path for writable files (session.json, database, etc.)
function userDataPath(...segments) {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), ...segments);
  }
  return path.join(__dirname, '..', ...segments);
}

let currentTheme = 'Dark'; // Track current theme

let mainWindow = null;
let toolbarView = null;
let sidebarView = null;
const tabs = new Map();
let tabOrder = [];
let activeTabId = null;
let nextTabId = 1;
const TOOLBAR_HEIGHT = 48;
const SIDEBAR_WIDTH = 240;
let sidebarCollapsed = false;
const downloads = new Map();
let nextDownloadId = 1;
const closedTabsStack = []; // Stack for reopening closed tabs (Ctrl+Shift+T)
const MAX_CLOSED_TABS = 20;
let isHtmlFullscreen = false; // Track HTML5 fullscreen (e.g. YouTube video)

// Internal pages that get preload (need IPC access)
const INTERNAL_PAGES = {
  'gb://newtab': 'newtab.html',
  'gb://settings': 'settings.html',
  'gb://bookmarks': 'bookmarks.html',
  'gb://history': 'history.html',
  'gb://downloads': 'downloads.html',
  'gb://ai': 'ai.html',
  'gb://github': 'github.html',
  'gb://passwords': 'passwords.html',
  'gb://extensions': 'extensions.html',
};

// Pages that need preload for IPC
const NEEDS_PRELOAD = new Set([
  'gb://newtab', 'gb://settings', 'gb://bookmarks', 'gb://history',
  'gb://downloads', 'gb://ai', 'gb://github', 'gb://passwords', 'gb://extensions',
]);

function createWindow() {
  mainWindow = new BaseWindow({
    width: 1280, height: 800,
    title: 'GitBrowser',
    backgroundColor: '#0a0e14',
    icon: resolvePath('resources', 'icons', 'app.ico'),
    minWidth: 800, minHeight: 600,
    frame: false,
  });

  // Sidebar view (left panel with tabs)
  sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.contentView.addChildView(sidebarView);
  sidebarView.webContents.loadFile(path.join(__dirname, 'ui', 'sidebar.html'));

  // Toolbar view (compact nav bar)
  toolbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.contentView.addChildView(toolbarView);
  toolbarView.webContents.loadFile(path.join(__dirname, 'ui', 'toolbar.html'));

  // Custom glass context menu for toolbar and sidebar via overlay view
  // (injected menus get clipped by view bounds, so we use a full-window overlay)
  toolbarView.webContents.on('context-menu', (e, params) => {
    e.preventDefault();
    const sw = sidebarCollapsed ? 48 : SIDEBAR_WIDTH;
    showOverlayContextMenu(toolbarView.webContents, params, sw, 0);
  });
  sidebarView.webContents.on('context-menu', (e) => {
    e.preventDefault();
    // Custom context menu handled inside sidebar.html
  });

  layoutViews();
  mainWindow.on('resize', layoutViews);

  restoreSession().then(ok => { if (!ok) createTab('gb://newtab'); });

  if (process.argv.includes('--dev')) {
    toolbarView.webContents.openDevTools({ mode: 'detach' });
  }
  Menu.setApplicationMenu(null);

  // Register will-download once on the default session (not per-tab!)
  session.defaultSession.on('will-download', (_e, item) => handleDownload(item));

  // CSP headers for internal pages
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url || '';
    if (url.startsWith('file://') || url.includes('/ui/')) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.github.com https://*.githubusercontent.com; font-src 'self' data:;"],
        },
      });
    } else {
      callback({ responseHeaders: details.responseHeaders });
    }
  });

  setInterval(saveSession, 30000);
  // Clean up old completed downloads every hour
  setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
    for (const [dlId, dl] of downloads) {
      if ((dl.state === 'completed' || dl.state === 'cancelled' || dl.state === 'interrupted') && dl.startTime < cutoff) {
        downloads.delete(dlId);
      }
    }
  }, 3600000);
  mainWindow.on('close', () => saveSession());
}

function layoutViews() {
  if (!mainWindow) return;
  const { width: w, height: h } = mainWindow.getContentBounds();

  if (isHtmlFullscreen) {
    // Hide sidebar and toolbar, tab takes full window
    if (sidebarView) sidebarView.setBounds({ x: -SIDEBAR_WIDTH, y: 0, width: SIDEBAR_WIDTH, height: h });
    if (toolbarView) toolbarView.setBounds({ x: 0, y: -TOOLBAR_HEIGHT, width: w, height: TOOLBAR_HEIGHT });
    if (activeTabId && tabs.has(activeTabId)) {
      tabs.get(activeTabId).view.setBounds({ x: 0, y: 0, width: w, height: h });
    }
    return;
  }

  const sw = sidebarCollapsed ? 48 : SIDEBAR_WIDTH;
  if (sidebarView) sidebarView.setBounds({ x: 0, y: 0, width: sw, height: h });
  if (toolbarView) toolbarView.setBounds({ x: sw, y: 0, width: w - sw, height: TOOLBAR_HEIGHT });
  if (activeTabId && tabs.has(activeTabId)) {
    tabs.get(activeTabId).view.setBounds({ x: sw, y: TOOLBAR_HEIGHT, width: w - sw, height: h - TOOLBAR_HEIGHT });
  }
}

// ─── Tab management ───

// For internal pages (gb://...), switch to existing tab if already open
function openOrSwitchTab(url) {
  if (url && url.startsWith('gb://') && url !== 'gb://newtab') {
    for (const [id, tab] of tabs) {
      if (tab.url === url) {
        switchTab(id);
        return;
      }
    }
  }
  createTab(url);
}

function createTab(url, activate = true) {
  const id = 'tab-' + (nextTabId++);
  const needsPreload = NEEDS_PRELOAD.has(url);
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: !needsPreload,
      preload: needsPreload ? path.join(__dirname, 'preload.js') : undefined,
    },
  });

  const tabData = { view, url: url || 'gb://newtab', title: getInternalTitle(url) || 'New Tab' };
  tabs.set(id, tabData);
  tabOrder.push(id);

  view.webContents.setWindowOpenHandler(({ url: newUrl }) => {
    if (newUrl && (newUrl.startsWith('http://') || newUrl.startsWith('https://'))) {
      createTab(newUrl);
    }
    return { action: 'deny' };
  });

  view.webContents.on('page-title-updated', (_e, title) => {
    if (title.startsWith('__gb_navigate:')) {
      navigateTab(id, normalizeUrl(title.substring('__gb_navigate:'.length)));
      return;
    }
    if (title.startsWith('__gb_newtab:')) {
      createTab(title.substring('__gb_newtab:'.length));
      return;
    }
    if (title.startsWith('__gb_save_password:')) {
      try {
        const data = JSON.parse(title.substring('__gb_save_password:'.length));
        // Check if already saved, then offer to save
        rustBridge.call('password.is_unlocked', {}).then(res => {
          if (res && res.unlocked) {
            rustBridge.call('password.list', { url: data.url }).then(existing => {
              const alreadySaved = Array.isArray(existing) && existing.some(c => c.username === data.username);
              if (!alreadySaved) {
                sendToToolbar('toast', { message: cmL('passwords.save_prompt', 'Save password?'), action: 'save-password', data });
              }
            }).catch(() => {});
          }
        }).catch(() => {});
      } catch { /* ignore */ }
      return;
    }
    // Don't override internal page titles
    if (!isInternalUrl(tabData.url)) {
      tabData.title = title;
      // Record history when we have the real title
      const url = tabData.url;
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        rustBridge.call('history.record', { url, title }).catch(() => {});
      }
    }
    sendTabsUpdate();
  });

  view.webContents.on('did-navigate', (_e, navUrl) => {
    tabData.url = navUrl;
    sendToToolbar('tab-url-updated', { id, url: navUrl });
    sendTabsUpdate();
  });
  view.webContents.on('did-navigate-in-page', (_e, navUrl) => {
    tabData.url = navUrl;
    sendToToolbar('tab-url-updated', { id, url: navUrl });
  });

  view.webContents.on('did-start-loading', () => {
    sendToToolbar('tab-loading', { id, loading: true });
    // Inject document_start content scripts early
    if (!isInternalUrl(tabData.url)) {
      injectContentScripts(view.webContents, tabData.url, 'document_start');
    }
  });
  view.webContents.on('did-stop-loading', () => sendToToolbar('tab-loading', { id, loading: false }));

  // Favicon
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    if (favicons && favicons.length > 0) {
      tabData.favicon = favicons[0];
      sendTabsUpdate();
    }
  });

  // Middle-click to open link in new tab
  view.webContents.on('did-finish-load', () => {
    if (!isInternalUrl(tabData.url)) {
      view.webContents.executeJavaScript(`
        document.addEventListener('auxclick', function(e) {
          if (e.button === 1) {
            const a = e.target.closest('a');
            if (a && a.href && (a.href.startsWith('http://') || a.href.startsWith('https://'))) {
              e.preventDefault();
              e.stopPropagation();
              document.title = '__gb_newtab:' + a.href;
            }
          }
        }, true);
      `).catch(() => {});

      // Password autofill: detect login forms and inject autofill UI
      injectPasswordAutofill(view.webContents, tabData.url);
      // Detect form submissions to offer saving passwords
      setupPasswordSaveDetection(view.webContents, tabData.url);
      // Inject extension content scripts matching this URL
      injectContentScripts(view.webContents, tabData.url, 'document_end');
      injectContentScripts(view.webContents, tabData.url, 'document_idle');
    }
  });
  
  // Custom context menu with AI actions
  view.webContents.on('context-menu', (e, params) => {
    e.preventDefault();
    buildPageContextMenu(view.webContents, params);
  });

  // Keyboard shortcuts inside tab views
  view.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const shift = input.shift;
    const key = input.key.toLowerCase();

    if (ctrl && !shift) {
      if (key === '=' || key === '+') { e.preventDefault(); ipcMain.emit('zoom-in', { sender: null }); }
      else if (key === '-') { e.preventDefault(); ipcMain.emit('zoom-out', { sender: null }); }
      else if (key === '0') { e.preventDefault(); ipcMain.emit('zoom-reset', { sender: null }); }
      else if (key === 't') { e.preventDefault(); createTab('gb://newtab'); }
      else if (key === 'w') { e.preventDefault(); if (activeTabId) closeTab(activeTabId); }
      else if (key === 'l') { e.preventDefault(); if (toolbarView) toolbarView.webContents.executeJavaScript('document.getElementById("url").focus();document.getElementById("url").select();').catch(() => {}); }
      else if (key === 'f') { e.preventDefault(); if (toolbarView) toolbarView.webContents.executeJavaScript('toggleFindBar()').catch(() => {}); }
      else if (key === 'r') { e.preventDefault(); if (activeTabId && tabs.has(activeTabId)) tabs.get(activeTabId).view.webContents.reload(); }
      else if (key === 'd') { e.preventDefault(); ipcMain.emit('add-bookmark-current', { sender: null }); }
      else if (key === 'tab') { e.preventDefault(); ipcMain.emit('next-tab', { sender: null }); }
    }
    if (ctrl && shift) {
      if (key === 'tab') { e.preventDefault(); ipcMain.emit('prev-tab', { sender: null }); }
      else if (key === 't') { e.preventDefault(); ipcMain.emit('reopen-closed-tab', { sender: null }); }
      else if (key === 'n') { e.preventDefault(); ipcMain.emit('open-private-window', { sender: null }); }
    }
    if (!ctrl && !shift) {
      if (key === 'f5') { e.preventDefault(); if (activeTabId && tabs.has(activeTabId)) tabs.get(activeTabId).view.webContents.reload(); }
      else if (key === 'f11') { e.preventDefault(); if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); }
    }
  });

  // HTML5 fullscreen (e.g. YouTube video player)
  view.webContents.on('enter-html-full-screen', () => {
    isHtmlFullscreen = true;
    layoutViews();
  });
  view.webContents.on('leave-html-full-screen', () => {
    isHtmlFullscreen = false;
    layoutViews();
  });

  loadUrlInView(view, url);
  if (activate) switchTab(id);
  sendTabsUpdate();
  return id;
}

function isInternalUrl(url) {
  return url && (url.startsWith('gb://') || url.includes('newtab.html') || url.includes('settings.html') || url.includes('bookmarks.html') || url.includes('history.html') || url.includes('downloads.html') || url.includes('ai.html') || url.includes('github.html') || url.includes('passwords.html') || url.includes('extensions.html'));
}

function getInternalTitle(url) {
  const keys = {
    'gb://newtab': ['tabs.new_tab', 'New Tab'],
    'gb://settings': ['settings.title', 'Settings'],
    'gb://bookmarks': ['bookmarks.title', 'Bookmarks'],
    'gb://history': ['history.title', 'History'],
    'gb://downloads': ['downloads.title', 'Downloads'],
    'gb://ai': ['ai.title', 'AI Assistant'],
    'gb://github': ['github.title', 'GitHub'],
    'gb://passwords': ['passwords.title', 'Passwords'],
    'gb://extensions': ['extensions.title', 'Extensions'],
  };
  const entry = keys[url];
  if (!entry) return null;
  return cmL(entry[0], entry[1]);
}

function loadUrlInView(view, url) {
  const page = INTERNAL_PAGES[url];
  if (page) {
    view.webContents.loadFile(path.join(__dirname, 'ui', page));
  } else if (url.startsWith('http://') || url.startsWith('https://')) {
    view.webContents.loadURL(url);
  } else {
    view.webContents.loadFile(path.join(__dirname, 'ui', 'newtab.html'));
  }
}

function switchTab(id) {
  if (!tabs.has(id)) return;
  if (activeTabId && tabs.has(activeTabId)) {
    mainWindow.contentView.removeChildView(tabs.get(activeTabId).view);
  }
  activeTabId = id;
  const { view, url } = tabs.get(id);
  mainWindow.contentView.addChildView(view);
  layoutViews();
  sendTabsUpdate();
  const realUrl = view.webContents.getURL() || url || '';
  sendToToolbar('tab-url-updated', { id, url: realUrl });
  // Update zoom indicator for the new tab
  sendToToolbar('zoom-changed', { level: view.webContents.getZoomLevel() });
  // Close find bar when switching tabs
  sendToToolbar('close-find', {});
}

function closeTab(id) {
  if (!tabs.has(id)) return;
  const { view, url, title } = tabs.get(id);
  // Save to closed tabs stack for Ctrl+Shift+T
  if (url && url !== 'gb://newtab') {
    closedTabsStack.push({ url, title });
    if (closedTabsStack.length > MAX_CLOSED_TABS) closedTabsStack.shift();
  }
  mainWindow.contentView.removeChildView(view);
  // Clean up all event listeners before closing
  view.webContents.removeAllListeners();
  view.webContents.close();
  tabs.delete(id);
  tabOrder = tabOrder.filter(tid => tid !== id);
  if (activeTabId === id) {
    activeTabId = null;
    if (tabOrder.length > 0) switchTab(tabOrder[tabOrder.length - 1]);
    else createTab('gb://newtab');
  }
  sendTabsUpdate();
}

function navigateTab(id, url) {
  if (!tabs.has(id)) return;
  const tabData = tabs.get(id);
  // If navigating to internal page that needs preload but current view doesn't have it,
  // create a new tab instead
  if (NEEDS_PRELOAD.has(url)) {
    closeTab(id);
    createTab(url);
    return;
  }
  tabData.url = url;
  tabData.title = getInternalTitle(url) || tabData.title;
  loadUrlInView(tabData.view, url);
  sendTabsUpdate();
}

function sendTabsUpdate() {
  const data = tabOrder.map(id => {
    if (!tabs.has(id)) return null;
    const t = tabs.get(id);
    const realUrl = t.view.webContents.getURL() || t.url;
    // Resolve back to gb:// URL for internal pages
    let url = realUrl;
    for (const [gbUrl, page] of Object.entries(INTERNAL_PAGES)) {
      if (realUrl.includes(page)) { url = gbUrl; break; }
    }
    let title = t.title || 'New Tab';
    // Override titles for internal pages
    if (url.startsWith('gb://')) {
      title = getInternalTitle(url) || title;
    }
    return { id, title, url, favicon: t.favicon || null };
  }).filter(Boolean);
  sendToToolbar('tabs-update', { tabs: data, activeId: activeTabId });
}

function sendToToolbar(channel, data) {
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send(channel, data);
  }
  if (sidebarView && !sidebarView.webContents.isDestroyed()) {
    sidebarView.webContents.send(channel, data);
  }
}

// ─── Downloads ───

const downloadItems = new Map(); // dlId -> DownloadItem

function handleDownload(item) {
  const dlId = 'dl-' + (nextDownloadId++);

  // Auto-save to system Downloads folder instead of prompting
  const downloadsDir = app.getPath('downloads');
  let filename = item.getFilename() || 'download';
  let savePath = path.join(downloadsDir, filename);

  // Avoid overwriting: append (1), (2), etc.
  let counter = 1;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  while (fs.existsSync(savePath)) {
    savePath = path.join(downloadsDir, `${base} (${counter})${ext}`);
    counter++;
  }
  item.setSavePath(savePath);

  const dl = {
    id: dlId, filename, url: item.getURL(),
    totalBytes: item.getTotalBytes(), receivedBytes: 0,
    state: 'progressing', savePath, startTime: Date.now(), paused: false,
    speed: 0, eta: 0,
  };
  downloads.set(dlId, dl);
  downloadItems.set(dlId, item);
  sendToToolbar('download-started', dl);

  let lastBytes = 0;
  let lastTime = Date.now();

  item.on('updated', (_e, state) => {
    dl.receivedBytes = item.getReceivedBytes();
    dl.totalBytes = item.getTotalBytes();
    dl.state = state;
    dl.paused = item.isPaused();

    // Calculate speed and ETA
    const now = Date.now();
    const elapsed = (now - lastTime) / 1000;
    if (elapsed > 0.5) {
      dl.speed = Math.round((dl.receivedBytes - lastBytes) / elapsed);
      if (dl.speed > 0 && dl.totalBytes > 0) {
        dl.eta = Math.round((dl.totalBytes - dl.receivedBytes) / dl.speed);
      }
      lastBytes = dl.receivedBytes;
      lastTime = now;
    }

    sendToToolbar('download-progress', {
      id: dlId, receivedBytes: dl.receivedBytes, totalBytes: dl.totalBytes,
      state, paused: dl.paused, speed: dl.speed, eta: dl.eta,
    });
  });
  item.once('done', (_e, state) => {
    dl.state = state;
    dl.savePath = item.getSavePath();
    dl.receivedBytes = dl.totalBytes;
    dl.speed = 0;
    dl.eta = 0;
    downloadItems.delete(dlId);
    sendToToolbar('download-done', { id: dlId, state, savePath: dl.savePath, filename: dl.filename });
    if (state === 'completed') {
      sendToToolbar('toast', { message: cmL('downloads.completed', 'Downloaded') + ': ' + dl.filename, action: 'open-download', data: { savePath: dl.savePath } });
    }
  });
}

// ─── Session ───

function saveSession() {
  try {
    const data = tabOrder.map(id => {
      if (!tabs.has(id)) return null;
      const t = tabs.get(id);
      const url = t.view.webContents.getURL() || t.url;
      return { url, title: t.title };
    }).filter(Boolean);
    // Save to Rust RPC
    rustBridge.call('session.save', { tabs: data }).catch(() => {});
    // Save encrypted local backup
    const jsonStr = JSON.stringify(data);
    rustBridge.call('github.encrypt_sync', { data: jsonStr }).then(encrypted => {
      try { fs.writeFileSync(userDataPath('session.json'), JSON.stringify(encrypted), 'utf8'); } catch {}
    }).catch(() => {
      // Fallback: save unencrypted if encryption fails
      try { fs.writeFileSync(userDataPath('session.json'), jsonStr, 'utf8'); } catch {}
    });
  } catch {}
}

async function restoreSession() {
  try {
    let result = await rustBridge.call('session.restore', {});
    // Fallback to local file
    if (!Array.isArray(result) || result.length === 0) {
      try {
        const raw = fs.readFileSync(userDataPath('session.json'), 'utf8');
        const parsed = JSON.parse(raw);
        // Check if encrypted (has ciphertext field) or plain array
        if (parsed.ciphertext) {
          const decrypted = await rustBridge.call('github.decrypt_sync', parsed);
          result = JSON.parse(decrypted.data);
        } else if (Array.isArray(parsed)) {
          result = parsed;
        }
      } catch {}
    }
    if (Array.isArray(result) && result.length > 0) {
      result.forEach((t, i) => createTab(t.url || 'gb://newtab', i === result.length - 1));
      return true;
    }
  } catch {}
  return false;
}

// ─── IPC handlers ───

ipcMain.on('new-tab', () => createTab('gb://newtab'));
ipcMain.on('close-tab', (_e, id) => closeTab(id));
ipcMain.on('switch-tab', (_e, id) => switchTab(id));
ipcMain.on('next-tab', () => {
  if (tabOrder.length < 2) return;
  const idx = tabOrder.indexOf(activeTabId);
  const next = (idx + 1) % tabOrder.length;
  switchTab(tabOrder[next]);
});
ipcMain.on('prev-tab', () => {
  if (tabOrder.length < 2) return;
  const idx = tabOrder.indexOf(activeTabId);
  const prev = (idx - 1 + tabOrder.length) % tabOrder.length;
  switchTab(tabOrder[prev]);
});
ipcMain.on('reopen-closed-tab', () => {
  if (closedTabsStack.length > 0) {
    const { url } = closedTabsStack.pop();
    createTab(url);
  }
});
ipcMain.on('reorder-tab', (_e, { fromId, toId }) => {
  const fromIdx = tabOrder.indexOf(fromId);
  const toIdx = tabOrder.indexOf(toId);
  if (fromIdx >= 0 && toIdx >= 0) {
    tabOrder.splice(fromIdx, 1);
    tabOrder.splice(toIdx, 0, fromId);
    sendTabsUpdate();
  }
});
ipcMain.on('go-back', () => { if (activeTabId && tabs.has(activeTabId)) tabs.get(activeTabId).view.webContents.goBack(); });
ipcMain.on('go-forward', () => { if (activeTabId && tabs.has(activeTabId)) tabs.get(activeTabId).view.webContents.goForward(); });
ipcMain.on('reload', () => { if (activeTabId && tabs.has(activeTabId)) tabs.get(activeTabId).view.webContents.reload(); });
ipcMain.on('get-tabs', () => sendTabsUpdate());

// Zoom
ipcMain.on('zoom-in', () => {
  if (activeTabId && tabs.has(activeTabId)) {
    const wc = tabs.get(activeTabId).view.webContents;
    wc.setZoomLevel(wc.getZoomLevel() + 0.5);
    sendToToolbar('zoom-changed', { level: wc.getZoomLevel() });
  }
});
ipcMain.on('zoom-out', () => {
  if (activeTabId && tabs.has(activeTabId)) {
    const wc = tabs.get(activeTabId).view.webContents;
    wc.setZoomLevel(wc.getZoomLevel() - 0.5);
    sendToToolbar('zoom-changed', { level: wc.getZoomLevel() });
  }
});
ipcMain.on('zoom-reset', () => {
  if (activeTabId && tabs.has(activeTabId)) {
    tabs.get(activeTabId).view.webContents.setZoomLevel(0);
    sendToToolbar('zoom-changed', { level: 0 });
  }
});

// Fullscreen
ipcMain.on('toggle-fullscreen', () => {
  if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// Window controls (frameless)
ipcMain.on('win-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.on('win-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});
ipcMain.on('win-close', () => {
  if (mainWindow) mainWindow.close();
});

// Sidebar toggle — instant bounds change, CSS handles visual smoothness inside sidebar
ipcMain.on('toggle-sidebar', () => {
  sidebarCollapsed = !sidebarCollapsed;
  layoutViews();
  // Notify sidebar view about collapse state
  if (sidebarView && !sidebarView.webContents.isDestroyed()) {
    sidebarView.webContents.send('sidebar-collapsed', { collapsed: sidebarCollapsed });
  }
});

// Private mode
ipcMain.on('open-private-window', () => {
  const privWin = new BaseWindow({
    width: 1100, height: 700, title: 'GitBrowser — Private',
    backgroundColor: '#1a0a2e', minWidth: 600, minHeight: 400,
    frame: false,
  });
  const privToolbar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  privWin.contentView.addChildView(privToolbar);
  privToolbar.webContents.loadFile(path.join(__dirname, 'ui', 'toolbar.html'));

  // Glass context menu for private toolbar
  privToolbar.webContents.on('context-menu', (e, params) => {
    e.preventDefault();
    buildPageContextMenu(privToolbar.webContents, params);
  });

  // Private window tab management
  const privTabs = new Map();
  let privTabOrder = [];
  let privActiveTabId = null;
  let privNextTabId = 1;
  let privHtmlFullscreen = false;
  // Ephemeral partition — no 'persist:' prefix means in-memory only, destroyed when all webContents using it are closed
  const privPartition = 'private-' + Date.now();
  let privClosing = false;

  function privCreateTab(url, activate = true) {
    if (privClosing || privWin.isDestroyed()) return null;
    const id = 'priv-tab-' + (privNextTabId++);
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        partition: privPartition,
      },
    });
    const tabData = { view, url: url || 'gb://newtab', title: 'New Tab' };
    privTabs.set(id, tabData);
    privTabOrder.push(id);

    view.webContents.on('page-title-updated', (_e, title) => {
      if (privClosing) return;
      if (title.startsWith('__gb_navigate:')) {
        const navUrl = normalizeUrl(title.substring('__gb_navigate:'.length));
        tabData.url = navUrl;
        if (navUrl.startsWith('http://') || navUrl.startsWith('https://')) view.webContents.loadURL(navUrl);
        else {
          const pg = INTERNAL_PAGES[navUrl];
          if (pg) view.webContents.loadFile(path.join(__dirname, 'ui', pg));
        }
        if (!privClosing && !privToolbar.webContents.isDestroyed()) privToolbar.webContents.send('tab-url-updated', { id, url: navUrl });
        privSendTabsUpdate();
        return;
      }
      if (title.startsWith('__gb_newtab:')) { privCreateTab(title.substring('__gb_newtab:'.length)); return; }
      tabData.title = title;
      privSendTabsUpdate();
    });
    view.webContents.on('did-navigate', (_e, navUrl) => {
      tabData.url = navUrl;
      if (!privClosing && !privToolbar.webContents.isDestroyed()) privToolbar.webContents.send('tab-url-updated', { id, url: navUrl });
      privSendTabsUpdate();
    });
    view.webContents.on('did-start-loading', () => { if (!privClosing && !privToolbar.webContents.isDestroyed()) privToolbar.webContents.send('tab-loading', { id, loading: true }); });
    view.webContents.on('did-stop-loading', () => { if (!privClosing && !privToolbar.webContents.isDestroyed()) privToolbar.webContents.send('tab-loading', { id, loading: false }); });
    view.webContents.on('page-favicon-updated', (_e, favicons) => {
      if (favicons && favicons.length > 0) { tabData.favicon = favicons[0]; privSendTabsUpdate(); }
    });
    view.webContents.setWindowOpenHandler(({ url: newUrl }) => {
      if (newUrl && (newUrl.startsWith('http://') || newUrl.startsWith('https://'))) privCreateTab(newUrl);
      return { action: 'deny' };
    });

    // HTML5 fullscreen
    view.webContents.on('enter-html-full-screen', () => { privHtmlFullscreen = true; layoutPriv(); });
    view.webContents.on('leave-html-full-screen', () => { privHtmlFullscreen = false; layoutPriv(); });

    // Glass context menu for private tabs
    view.webContents.on('context-menu', (e, params) => {
      e.preventDefault();
      buildPageContextMenu(view.webContents, params);
    });

    // Keyboard shortcuts for private tabs
    view.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const ctrl = input.control || input.meta;
      const shift = input.shift;
      const key = input.key.toLowerCase();
      if (ctrl && !shift) {
        if (key === '=' || key === '+') { e.preventDefault(); const wc2 = view.webContents; wc2.setZoomLevel(wc2.getZoomLevel() + 0.5); }
        else if (key === '-') { e.preventDefault(); const wc2 = view.webContents; wc2.setZoomLevel(wc2.getZoomLevel() - 0.5); }
        else if (key === '0') { e.preventDefault(); view.webContents.setZoomLevel(0); }
        else if (key === 't') { e.preventDefault(); privCreateTab('gb://newtab'); }
        else if (key === 'w') { e.preventDefault(); if (privActiveTabId) privCloseTab(privActiveTabId); }
        else if (key === 'r') { e.preventDefault(); view.webContents.reload(); }
      }
      if (!ctrl && !shift) {
        if (key === 'f5') { e.preventDefault(); view.webContents.reload(); }
        if (key === 'f11') { e.preventDefault(); if (privWin && !privWin.isDestroyed()) privWin.setFullScreen(!privWin.isFullScreen()); }
      }
    });

    const page = INTERNAL_PAGES[url];
    if (page) view.webContents.loadFile(path.join(__dirname, 'ui', page));
    else if (url && (url.startsWith('http://') || url.startsWith('https://'))) view.webContents.loadURL(url);
    else view.webContents.loadFile(path.join(__dirname, 'ui', 'newtab.html'));

    if (activate) privSwitchTab(id);
    privSendTabsUpdate();
    return id;
  }

  function privSwitchTab(id) {
    if (privClosing || !privTabs.has(id)) return;
    if (privActiveTabId && privTabs.has(privActiveTabId)) {
      privWin.contentView.removeChildView(privTabs.get(privActiveTabId).view);
    }
    privActiveTabId = id;
    const { view } = privTabs.get(id);
    privWin.contentView.addChildView(view);
    layoutPriv();
    privSendTabsUpdate();
  }

  function privCloseTab(id) {
    if (privClosing || !privTabs.has(id)) return;
    const { view } = privTabs.get(id);
    privWin.contentView.removeChildView(view);
    view.webContents.close();
    privTabs.delete(id);
    privTabOrder = privTabOrder.filter(t => t !== id);
    if (privActiveTabId === id) {
      if (privTabOrder.length > 0) privSwitchTab(privTabOrder[privTabOrder.length - 1]);
      else privWin.close();
    }
    privSendTabsUpdate();
  }

  function privSendTabsUpdate() {
    if (privClosing || privToolbar.webContents.isDestroyed()) return;
    const list = privTabOrder.map(tid => {
      if (!privTabs.has(tid)) return null;
      const t = privTabs.get(tid);
      return { id: tid, title: t.title, url: t.url, active: tid === privActiveTabId, favicon: t.favicon };
    }).filter(Boolean);
    privToolbar.webContents.send('tabs-update', list);
  }

  function layoutPriv() {
    if (privClosing || privWin.isDestroyed()) return;
    const { width: w, height: h } = privWin.getContentBounds();
    if (privHtmlFullscreen) {
      privToolbar.setBounds({ x: 0, y: -TOOLBAR_HEIGHT, width: w, height: TOOLBAR_HEIGHT });
      if (privActiveTabId && privTabs.has(privActiveTabId)) {
        privTabs.get(privActiveTabId).view.setBounds({ x: 0, y: 0, width: w, height: h });
      }
      return;
    }
    privToolbar.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_HEIGHT });
    if (privActiveTabId && privTabs.has(privActiveTabId)) {
      privTabs.get(privActiveTabId).view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: h - TOOLBAR_HEIGHT });
    }
  }

  // Handle IPC from private toolbar
  privToolbar.webContents.on('ipc-message', (_e, channel, ...args) => {
    if (privClosing) return;
    if (channel === 'new-tab') privCreateTab('gb://newtab');
    else if (channel === 'close-tab') privCloseTab(args[0]);
    else if (channel === 'switch-tab') privSwitchTab(args[0]);
    else if (channel === 'navigate') {
      if (privActiveTabId && privTabs.has(privActiveTabId)) {
        const url = normalizeUrl(args[0]);
        const tabData = privTabs.get(privActiveTabId);
        tabData.url = url;
        if (url.startsWith('http://') || url.startsWith('https://')) tabData.view.webContents.loadURL(url);
        else {
          const page = INTERNAL_PAGES[url];
          if (page) tabData.view.webContents.loadFile(path.join(__dirname, 'ui', page));
        }
      }
    }
    else if (channel === 'go-back') { if (privActiveTabId && privTabs.has(privActiveTabId)) privTabs.get(privActiveTabId).view.webContents.goBack(); }
    else if (channel === 'go-forward') { if (privActiveTabId && privTabs.has(privActiveTabId)) privTabs.get(privActiveTabId).view.webContents.goForward(); }
    else if (channel === 'reload') { if (privActiveTabId && privTabs.has(privActiveTabId)) privTabs.get(privActiveTabId).view.webContents.reload(); }
    else if (channel === 'win-minimize') privWin.minimize();
    else if (channel === 'win-maximize') { if (privWin.isMaximized()) privWin.unmaximize(); else privWin.maximize(); }
    else if (channel === 'win-close') privWin.close();
  });

  privCreateTab('gb://newtab');
  layoutPriv();
  privWin.on('resize', layoutPriv);
  privWin.on('close', () => {
    privClosing = true;
    // Clean up all private tabs
    for (const [, { view }] of privTabs) { try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {} }
    privTabs.clear();
    privTabOrder = [];
  });
});

// Find in page
ipcMain.on('find-in-page', (_e, text) => {
  if (activeTabId && tabs.has(activeTabId)) {
    if (text) tabs.get(activeTabId).view.webContents.findInPage(text);
    else tabs.get(activeTabId).view.webContents.stopFindInPage('clearSelection');
  }
});
ipcMain.on('stop-find', () => {
  if (activeTabId && tabs.has(activeTabId)) {
    tabs.get(activeTabId).view.webContents.stopFindInPage('clearSelection');
  }
});

// Reader mode
ipcMain.handle('reader-extract', async () => {
  if (!activeTabId || !tabs.has(activeTabId)) return { error: 'No active tab' };
  const wc = tabs.get(activeTabId).view.webContents;
  try {
    const result = await wc.executeJavaScript(`
      (function() {
        // Try multiple selectors in priority order
        const selectors = [
          'article', '[role="article"]', '[itemprop="articleBody"]',
          '.post-content', '.article-content', '.entry-content', '.post-body',
          '.story-body', '.article-body', '.content-body',
          '[role="main"]', 'main', '#content', '.content',
          '#main-content', '.main-content',
        ];
        let article = null;
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.innerText.length > 200) { article = el; break; }
        }
        // Fallback: find the element with the most text content
        if (!article) {
          let best = null, bestLen = 0;
          document.querySelectorAll('div, section').forEach(el => {
            const len = el.innerText.length;
            const childDivs = el.querySelectorAll('div, section').length;
            // Prefer elements with lots of text but not too many nested divs
            if (len > bestLen && len > 500 && childDivs < 20) { best = el; bestLen = len; }
          });
          article = best || document.body;
        }
        const clone = article.cloneNode(true);
        // Remove non-content elements
        clone.querySelectorAll('script,style,nav,footer,aside,iframe,header,.ad,.ads,.advertisement,.sidebar,.nav,.menu,.social,.share,.comments,.related,.recommended,form,[role="navigation"],[role="banner"],[role="complementary"]').forEach(el => el.remove());
        const title = document.title;
        const text = clone.innerText;
        const html = clone.innerHTML;
        // Get site name for attribution
        const siteName = (document.querySelector('meta[property="og:site_name"]') || {}).content || location.hostname;
        return JSON.stringify({ title, text, html, siteName, url: location.href });
      })()
    `);
    return JSON.parse(result);
  } catch (err) {
    return { error: err.message };
  }
});

// Open internal pages as tabs
ipcMain.on('open-settings', () => openOrSwitchTab('gb://settings'));
ipcMain.on('open-bookmarks', () => openOrSwitchTab('gb://bookmarks'));
ipcMain.on('open-history', () => openOrSwitchTab('gb://history'));
ipcMain.on('open-downloads', () => openOrSwitchTab('gb://downloads'));
ipcMain.on('open-ai', () => openOrSwitchTab('gb://ai'));
ipcMain.on('open-github', () => openOrSwitchTab('gb://github'));

// Sidebar context menu (overlay in tab view when sidebar is collapsed)
ipcMain.on('sidebar-context-menu', (_e, clientX, clientY) => {
  if (!activeTabId || !tabs.has(activeTabId)) return;
  const tabView = tabs.get(activeTabId).view;
  const tabBounds = tabView.getBounds();
  const sw = sidebarCollapsed ? 48 : SIDEBAR_WIDTH;

  const items = [
    { label: cmL('tabs.new_tab', 'Новая вкладка'), action: 'sb_new_tab' },
    { type: 'separator' },
    { label: cmL('bookmarks.title', 'Закладки'), action: 'sb_bookmarks' },
    { label: cmL('history.title', 'История'), action: 'sb_history' },
    { label: cmL('downloads.title', 'Загрузки'), action: 'sb_downloads' },
    { label: cmL('passwords.title', 'Пароли'), action: 'sb_passwords' },
    { label: cmL('extensions.title', 'Расширения'), action: 'sb_extensions' },
    { type: 'separator' },
    { label: cmL('ai.title', 'AI-ассистент'), action: 'sb_ai' },
    { label: 'GitHub', action: 'sb_github' },
    { type: 'separator' },
    { label: cmL('settings.title', 'Настройки'), action: 'sb_settings' },
  ];

  const globalX = clientX;
  const globalY = clientY;
  const tabLocalX = globalX - tabBounds.x + sw;
  const tabLocalY = globalY - tabBounds.y;
  const menuData = JSON.stringify(items);

  tabView.webContents.executeJavaScript(`(function(){
    ${CLEAR_ALL_OVERLAYS_JS}
    var style=document.createElement('style');style.id='__gb-sb-ctx-style';
    style.textContent=\`
      #__gb-sb-ctx-ov{position:fixed;inset:0;z-index:2147483646;}
      #__gb-sb-ctx{position:fixed;z-index:2147483647;
        background:rgba(18,22,30,0.92);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);
        border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:4px;min-width:200px;
        box-shadow:0 8px 32px rgba(0,0,0,0.45),0 2px 6px rgba(0,0,0,0.25),inset 0 1px 0 rgba(255,255,255,0.06);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#e2e8f0;
        animation:__gbSbIn 0.12s cubic-bezier(0.16,1,0.3,1);user-select:none;-webkit-user-select:none;}
      @keyframes __gbSbIn{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}
      #__gb-sb-ctx .sbi{display:flex;align-items:center;padding:6px 10px;border-radius:6px;cursor:default;transition:background 0.08s;gap:16px;}
      #__gb-sb-ctx .sbi:hover{background:rgba(255,255,255,0.07);}
      #__gb-sb-ctx .sbi-sep{height:1px;background:rgba(255,255,255,0.06);margin:3px 6px;}
      html.light #__gb-sb-ctx{background:rgba(255,255,255,0.94);border-color:rgba(0,0,0,0.1);color:#1e293b;box-shadow:0 8px 32px rgba(0,0,0,0.1),0 2px 6px rgba(0,0,0,0.05);}
      html.light #__gb-sb-ctx .sbi:hover{background:rgba(0,0,0,0.05);}
      html.light #__gb-sb-ctx .sbi-sep{background:rgba(0,0,0,0.07);}
    \`;
    document.documentElement.appendChild(style);
    function closeMenu(){
      var a=document.getElementById('__gb-sb-ctx-ov');if(a)a.remove();
      var b=document.getElementById('__gb-sb-ctx');if(b)b.remove();
      var c=document.getElementById('__gb-sb-ctx-style');if(c)c.remove();
    }
    var ov=document.createElement('div');ov.id='__gb-sb-ctx-ov';
    ov.onclick=function(){closeMenu();};
    ov.oncontextmenu=function(e){e.preventDefault();closeMenu();};
    document.documentElement.appendChild(ov);
    var menu=document.createElement('div');menu.id='__gb-sb-ctx';
    var items=${menuData};
    items.forEach(function(it){
      if(it.type==='separator'){var s=document.createElement('div');s.className='sbi-sep';menu.appendChild(s);return;}
      var d=document.createElement('div');d.className='sbi';
      d.textContent=it.label;
      d.onclick=function(){closeMenu();console.log('__gb_sb_ctx:'+JSON.stringify({action:it.action}));};
      menu.appendChild(d);
    });
    document.documentElement.appendChild(menu);
    var mx=${tabLocalX},my=${tabLocalY};
    var r=menu.getBoundingClientRect();
    if(mx+r.width>window.innerWidth)mx=window.innerWidth-r.width-8;
    if(my+r.height>window.innerHeight)my=window.innerHeight-r.height-8;
    if(mx<4)mx=4;if(my<4)my=4;
    menu.style.left=mx+'px';menu.style.top=my+'px';
  })();`);

  const sbCtxHandler = (event) => {
    const message = event.message;
    if (!message || !message.startsWith('__gb_sb_ctx:')) return;
    tabView.webContents.removeListener('console-message', sbCtxHandler);
    try {
      const { action } = JSON.parse(message.replace('__gb_sb_ctx:', ''));
      if (action === 'sb_new_tab') createTab('gb://newtab');
      else if (action === 'sb_bookmarks') openOrSwitchTab('gb://bookmarks');
      else if (action === 'sb_history') openOrSwitchTab('gb://history');
      else if (action === 'sb_downloads') openOrSwitchTab('gb://downloads');
      else if (action === 'sb_passwords') openOrSwitchTab('gb://passwords');
      else if (action === 'sb_extensions') openOrSwitchTab('gb://extensions');
      else if (action === 'sb_ai') openOrSwitchTab('gb://ai');
      else if (action === 'sb_github') openOrSwitchTab('gb://github');
      else if (action === 'sb_settings') openOrSwitchTab('gb://settings');
    } catch {}
  };
  tabView.webContents.on('console-message', sbCtxHandler);
  setTimeout(() => { try { tabView.webContents.removeListener('console-message', sbCtxHandler); } catch {} }, 10000);
});

// Sidebar quick nav context menus (glass style in tab view)
ipcMain.on('sidebar-quick-nav-menu', (_e, navId, clientX, clientY) => {
  const menuActions = {
    bookmarks: [
      { label: cmL('bookmarks.add', 'Добавить закладку'), action: 'nav_bookmark_add' },
      { label: cmL('bookmarks.title', 'Закладки'), action: 'nav_open', data: 'gb://bookmarks' },
    ],
    history: [
      { label: cmL('history.title', 'История'), action: 'nav_open', data: 'gb://history' },
      { label: cmL('history.clear_all', 'Очистить всё'), action: 'nav_history_clear' },
    ],
    downloads: [
      { label: cmL('downloads.title', 'Загрузки'), action: 'nav_open', data: 'gb://downloads' },
    ],
    passwords: [
      { label: cmL('passwords.title', 'Пароли'), action: 'nav_open', data: 'gb://passwords' },
      { label: cmL('passwords.lock', 'Заблокировать'), action: 'nav_password_lock' },
    ],
    extensions: [
      { label: cmL('extensions.title', 'Расширения'), action: 'nav_open', data: 'gb://extensions' },
    ],
    ai: [
      { label: cmL('ai.title', 'AI-ассистент'), action: 'nav_open', data: 'gb://ai' },
    ],
    github: [
      { label: cmL('github.title', 'GitHub'), action: 'nav_open', data: 'gb://github' },
    ],
    settings: [
      { label: cmL('settings.title', 'Настройки'), action: 'nav_open', data: 'gb://settings' },
    ],
  };

  const items = menuActions[navId];
  if (!items) return;

  // If no active tab, fallback to native menu
  if (!activeTabId || !tabs.has(activeTabId)) {
    // Build native menu as fallback
    const nativeItems = items.map(it => ({
      label: it.label,
      click: () => handleNavAction(it.action, it.data),
    }));
    Menu.buildFromTemplate(nativeItems).popup();
    return;
  }

  const tabView = tabs.get(activeTabId).view;
  const tabBounds = tabView.getBounds();
  const sidebarBounds = sidebarView ? sidebarView.getBounds() : { x: 0, y: 0 };

  // Convert sidebar-local coords to tab-local coords
  const tabLocalX = (clientX || 0) + sidebarBounds.x - tabBounds.x;
  const tabLocalY = (clientY || 0) + sidebarBounds.y - tabBounds.y;

  const menuData = JSON.stringify(items);

  tabView.webContents.executeJavaScript(`(function(){
    ${CLEAR_ALL_OVERLAYS_JS}

    var style=document.createElement('style');style.id='__gb-ctx-style';
    style.textContent=\`
      #__gb-ctx-ov{position:fixed;inset:0;z-index:2147483646;}
      #__gb-ctx{position:fixed;z-index:2147483647;
        background:rgba(18,22,30,0.92);
        backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);
        border:1px solid rgba(255,255,255,0.08);border-radius:12px;
        padding:6px;min-width:200px;
        box-shadow:0 12px 48px rgba(0,0,0,0.5),0 2px 8px rgba(0,0,0,0.3),inset 0 1px 0 rgba(255,255,255,0.06);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#e2e8f0;
        animation:__gbCtxIn 0.15s cubic-bezier(0.16,1,0.3,1);
        user-select:none;-webkit-user-select:none;}
      @keyframes __gbCtxIn{from{opacity:0;transform:scale(0.96) translateY(-4px)}to{opacity:1;transform:scale(1) translateY(0)}}
      #__gb-ctx .ctx-item{display:flex;align-items:center;justify-content:space-between;
        padding:7px 12px;border-radius:8px;cursor:pointer;transition:background 0.1s,color 0.1s;gap:24px;}
      #__gb-ctx .ctx-item:hover{background:rgba(96,165,250,0.12);color:#fff;}
      #__gb-ctx .ctx-accel{font-size:11px;color:rgba(255,255,255,0.3);font-weight:500;}
      #__gb-ctx .ctx-sep{height:1px;background:rgba(255,255,255,0.06);margin:4px 8px;}
      @media (prefers-color-scheme:light){
        #__gb-ctx{background:rgba(255,255,255,0.92);border-color:rgba(0,0,0,0.08);color:#1e293b;
          box-shadow:0 12px 48px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06),inset 0 1px 0 rgba(255,255,255,0.8);}
        #__gb-ctx .ctx-item:hover{background:rgba(37,99,235,0.1);}
        #__gb-ctx .ctx-accel{color:rgba(0,0,0,0.3);}
        #__gb-ctx .ctx-sep{background:rgba(0,0,0,0.06);}
      }
      html.light #__gb-ctx{background:rgba(255,255,255,0.92);border-color:rgba(0,0,0,0.08);color:#1e293b;
        box-shadow:0 12px 48px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06),inset 0 1px 0 rgba(255,255,255,0.8);}
      html.light #__gb-ctx .ctx-item:hover{background:rgba(37,99,235,0.1);}
      html.light #__gb-ctx .ctx-accel{color:rgba(0,0,0,0.3);}
      html.light #__gb-ctx .ctx-sep{background:rgba(0,0,0,0.06);}
    \`;
    document.documentElement.appendChild(style);

    var ov=document.createElement('div');ov.id='__gb-ctx-ov';
    ov.onclick=function(){ov.remove();menu.remove();style.remove();};
    ov.oncontextmenu=function(e){e.preventDefault();ov.remove();menu.remove();style.remove();};
    document.documentElement.appendChild(ov);

    var menu=document.createElement('div');menu.id='__gb-ctx';
    var items=${menuData};
    items.forEach(function(it){
      var d=document.createElement('div');d.className='ctx-item';
      d.textContent=it.label;
      d.dataset.action=it.action||'';
      d.dataset.data=it.data||'';
      d.onclick=function(){
        ov.remove();menu.remove();style.remove();
        console.log('__gb_nav_ctx:'+JSON.stringify({action:this.dataset.action,data:this.dataset.data}));
      };
      menu.appendChild(d);
    });
    document.documentElement.appendChild(menu);

    var mx=${tabLocalX},my=${tabLocalY};
    var r=menu.getBoundingClientRect();
    if(mx+r.width>window.innerWidth)mx=window.innerWidth-r.width-8;
    if(my+r.height>window.innerHeight)my=window.innerHeight-r.height-8;
    if(mx<0)mx=4;if(my<0)my=4;
    menu.style.left=mx+'px';menu.style.top=my+'px';
  })();`);

  const navHandler = (event) => {
    const message = event.message;
    if (!message || !message.startsWith('__gb_nav_ctx:')) return;
    tabView.webContents.removeListener('console-message', navHandler);
    try {
      const { action, data } = JSON.parse(message.replace('__gb_nav_ctx:', ''));
      handleNavAction(action, data);
    } catch {}
  };
  tabView.webContents.on('console-message', navHandler);
  setTimeout(() => { try { tabView.webContents.removeListener('console-message', navHandler); } catch {} }, 10000);
});

function handleNavAction(action, data) {
  if (action === 'nav_open') openOrSwitchTab(data);
  else if (action === 'nav_bookmark_add') {
    if (activeTabId && tabs.has(activeTabId)) {
      const t = tabs.get(activeTabId);
      rustBridge.call('bookmark.add', { url: t.url, title: t.title }).catch(() => {});
    }
  }
  else if (action === 'nav_history_clear') rustBridge.call('history.clear', {}).catch(() => {});
  else if (action === 'nav_password_lock') rustBridge.call('password.lock', {}).catch(() => {});
}

// ─── Page context menu state (for IPC-based glass menu) ───
let _pageCtxWc = null;
let _pageCtxParams = null;
let _pageCtxConsoleHandler = null;

// ─── Toolbar "More" menu ───
let _prevMoreHandler = null;
let _prevMoreWc = null;
ipcMain.on('toolbar-more-menu', (_e, clientX, clientY) => {
  if (!activeTabId || !tabs.has(activeTabId)) return;
  // Clean up previous listener to prevent duplicate handling
  if (_prevMoreHandler && _prevMoreWc) {
    try { _prevMoreWc.removeListener('console-message', _prevMoreHandler); } catch {}
    _prevMoreHandler = null; _prevMoreWc = null;
  }

  const items = [
    { label: cmL('toolbar.new_tab', 'Новая вкладка'), accel: 'Ctrl+T', action: 'nav_open', data: 'gb://newtab', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/></svg>' },
    { label: cmL('toolbar.private_window', 'Приватное окно'), accel: 'Ctrl+Shift+N', action: 'more_private', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M.143 2.31a.75.75 0 0 1 1.047-.167l14.5 10.5a.75.75 0 1 1-.88 1.214l-2.248-1.628C11.346 13.19 9.792 13.75 8 13.75c-4.706 0-7.5-4.25-7.5-5.75 0-.85.99-2.57 2.727-3.88L.976 2.357a.75.75 0 0 1-.833-1.047ZM4.09 4.97C2.6 6.05 1.75 7.38 1.75 8c0 .718 1.842 4.25 6.25 4.25 1.34 0 2.498-.38 3.438-.96L9.978 10.2A2.75 2.75 0 0 1 6.3 6.536L4.09 4.97ZM8 2.25c.94 0 1.81.18 2.6.47a.75.75 0 0 1-.5 1.415A6.7 6.7 0 0 0 8 3.75c-.94 0-1.76.18-2.46.46l-.01-.01C6.24 3.68 7.08 2.25 8 2.25Zm4.39 3.07a.75.75 0 0 1 1.046.2c.844 1.18 1.314 2.33 1.314 2.98 0 .47-.26 1.15-.76 1.89a.75.75 0 0 1-1.24-.84c.38-.56.5-.96.5-1.05 0-.28-.32-1.12-1.06-2.13a.75.75 0 0 1 .2-1.05Z"/></svg>' },
    { type: 'separator' },
    { label: cmL('toolbar.find', 'Найти на странице'), accel: 'Ctrl+F', action: 'more_find', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 1 1-1.06 1.06l-3.04-3.04ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/></svg>' },
    { label: cmL('toolbar.zoom_in', 'Увеличить'), accel: 'Ctrl++', action: 'more_zoom_in', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/></svg>' },
    { label: cmL('toolbar.zoom_out', 'Уменьшить'), accel: 'Ctrl+-', action: 'more_zoom_out', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 7.75A.75.75 0 0 1 2.75 7h10a.75.75 0 0 1 0 1.5h-10A.75.75 0 0 1 2 7.75Z"/></svg>' },
    { label: cmL('toolbar.zoom_reset', 'Сбросить масштаб'), accel: 'Ctrl+0', action: 'more_zoom_reset', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 1.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11Z"/></svg>' },
    { type: 'separator' },
    { label: cmL('toolbar.fullscreen', 'Полный экран'), accel: 'F11', action: 'more_fullscreen', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 10a.75.75 0 0 1 .75.75v2.5c0 .138.112.25.25.25h2.5a.75.75 0 0 1 0 1.5h-2.5A1.75 1.75 0 0 1 1 13.25v-2.5a.75.75 0 0 1 .75-.75Zm12.5 0a.75.75 0 0 1 .75.75v2.5A1.75 1.75 0 0 1 13.25 15h-2.5a.75.75 0 0 1 0-1.5h2.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 .75-.75ZM2.75 1h2.5a.75.75 0 0 1 0 1.5h-2.5a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0v-2.5C1 1.784 1.784 1 2.75 1Zm10.5 0C14.216 1 15 1.784 15 2.75v2.5a.75.75 0 0 1-1.5 0v-2.5a.25.25 0 0 0-.25-.25h-2.5a.75.75 0 0 1 0-1.5h2.5Z"/></svg>' },
    { label: cmL('toolbar.reader_mode', 'Режим чтения'), action: 'more_reader', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25ZM1.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25ZM3.5 4.75a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1-.75-.75Zm.75 2.75a.75.75 0 0 0 0 1.5h7.5a.75.75 0 0 0 0-1.5h-7.5Zm0 3.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-4.5Z"/></svg>' },
    { type: 'separator' },
    { label: cmL('bookmarks.title', 'Закладки'), accel: 'Ctrl+B', action: 'nav_open', data: 'gb://bookmarks', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>' },
    { label: cmL('history.title', 'История'), accel: 'Ctrl+H', action: 'nav_open', data: 'gb://history', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 8a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0ZM8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm.5 4.75a.75.75 0 0 0-1.5 0v3.5a.75.75 0 0 0 .37.65l2.5 1.5a.75.75 0 1 0 .77-1.29L8.5 7.94Z"/></svg>' },
    { label: cmL('downloads.title', 'Загрузки'), action: 'nav_open', data: 'gb://downloads', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"/></svg>' },
    { label: cmL('passwords.title', 'Пароли'), action: 'nav_open', data: 'gb://passwords', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10.5 6V4a2.5 2.5 0 1 0-5 0v2Z"/></svg>' },
    { label: cmL('extensions.title', 'Расширения'), action: 'nav_open', data: 'gb://extensions', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 4.25a2.25 2.25 0 0 1 4.5 0 .75.75 0 0 0 .75.75h2.5c.14 0 .25.11.25.25v2.5a.75.75 0 0 0 .75.75 2.25 2.25 0 0 1 0 4.5.75.75 0 0 0-.75.75v2.5a.25.25 0 0 1-.25.25h-2.5a.75.75 0 0 1-.75-.75 2.25 2.25 0 0 0-4.5 0 .75.75 0 0 1-.75.75H2.25a.25.25 0 0 1-.25-.25v-2.5a.75.75 0 0 0-.75-.75 2.25 2.25 0 0 1 0-4.5.75.75 0 0 0 .75-.75v-2.5c0-.14.11-.25.25-.25h2.5a.75.75 0 0 0 .75-.75z"/></svg>' },
    { type: 'separator' },
    { label: cmL('settings.title', 'Настройки'), accel: 'Ctrl+,', action: 'nav_open', data: 'gb://settings', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.1-.303c.652-.18 1.34.03 1.73.545a8.042 8.042 0 0 1 1.088 1.89c.238.572.1 1.252-.337 1.71l-.812.804a.395.395 0 0 0-.112.29c.013.26.013.52 0 .78a.394.394 0 0 0 .112.29l.812.804c.436.458.575 1.138.337 1.71a8.04 8.04 0 0 1-1.088 1.89c-.39.515-1.078.725-1.73.545l-1.1-.303a.352.352 0 0 0-.3.071 5.834 5.834 0 0 1-.667.386.35.35 0 0 0-.212.224l-.289 1.106c-.169.646-.715 1.196-1.458 1.26a8.28 8.28 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106a.35.35 0 0 0-.212-.224 5.738 5.738 0 0 1-.668-.386.352.352 0 0 0-.299-.071l-1.1.303c-.652.18-1.34-.03-1.73-.545a8.042 8.042 0 0 1-1.088-1.89c-.238-.572-.1-1.252.337-1.71l.812-.804a.395.395 0 0 0 .112-.29 6.046 6.046 0 0 1 0-.78.394.394 0 0 0-.112-.29l-.812-.804c-.436-.458-.575-1.138-.337-1.71a8.04 8.04 0 0 1 1.088-1.89c.39-.515 1.078-.725 1.73-.545l1.1.303a.352.352 0 0 0 .3-.071c.214-.143.437-.272.667-.386a.35.35 0 0 0 .212-.224l.289-1.106C6.01.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.046-.219.29-.411.6-.573.925-.014.028-.042.112.017.182l.812.803c.407.404.63.953.63 1.52s-.223 1.116-.63 1.52l-.812.803c-.059.07-.031.154-.017.182.162.325.354.634.573.925.02.03.086.077.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.16.107.327.204.5.29.449.222.851.628.998 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.03.175-.016.195-.046.219-.29.411-.6.573-.925.014-.028.042-.112-.017-.182l-.812-.803a2.15 2.15 0 0 1-.63-1.52c0-.567.223-1.116.63-1.52l.812-.803c.059-.07.031-.154.017-.182a6.588 6.588 0 0 0-.573-.925c-.02-.03-.086-.077-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.5-.29c-.449-.222-.851-.628-.998-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/></svg>' },
  ];

  const tabView = tabs.get(activeTabId).view;
  const tabBounds = tabView.getBounds();
  const toolbarBounds = toolbarView ? toolbarView.getBounds() : { x: 0, y: 0 };

  const tabLocalX = (clientX || 0) + toolbarBounds.x - tabBounds.x;
  const tabLocalY = (clientY || 0) + toolbarBounds.y - tabBounds.y;

  const menuData = JSON.stringify(items);

  tabView.webContents.executeJavaScript(`(function(){
    ${CLEAR_ALL_OVERLAYS_JS}

    var style=document.createElement('style');style.id='__gb-ctx-style';
    style.textContent=\`
      #__gb-ctx-ov{position:fixed;inset:0;z-index:2147483646;}
      #__gb-ctx{position:fixed;z-index:2147483647;
        background:rgba(18,22,30,0.92);
        backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);
        border:1px solid rgba(255,255,255,0.08);border-radius:12px;
        padding:6px;min-width:240px;max-height:80vh;overflow-y:auto;
        box-shadow:0 12px 48px rgba(0,0,0,0.5),0 2px 8px rgba(0,0,0,0.3),inset 0 1px 0 rgba(255,255,255,0.06);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#e2e8f0;
        animation:__gbCtxIn 0.15s cubic-bezier(0.16,1,0.3,1);
        user-select:none;-webkit-user-select:none;
        scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.06) transparent;}
      #__gb-ctx::-webkit-scrollbar{width:4px;}
      #__gb-ctx::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.06);border-radius:2px;}
      @keyframes __gbCtxIn{from{opacity:0;transform:scale(0.96) translateY(-4px)}to{opacity:1;transform:scale(1) translateY(0)}}
      #__gb-ctx .ctx-item{display:flex;align-items:center;
        padding:7px 12px;border-radius:8px;cursor:pointer;transition:background 0.1s,color 0.1s;gap:10px;}
      #__gb-ctx .ctx-item:hover{background:rgba(96,165,250,0.12);color:#fff;}
      #__gb-ctx .ctx-icon{width:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0;opacity:0.5;}
      #__gb-ctx .ctx-item:hover .ctx-icon{opacity:1;}
      #__gb-ctx .ctx-label{flex:1;}
      #__gb-ctx .ctx-accel{font-size:11px;color:rgba(255,255,255,0.3);font-weight:500;margin-left:auto;}
      #__gb-ctx .ctx-item:hover .ctx-accel{color:rgba(255,255,255,0.5);}
      #__gb-ctx .ctx-sep{height:1px;background:rgba(255,255,255,0.06);margin:4px 8px;}
      @media (prefers-color-scheme:light){
        #__gb-ctx{background:rgba(255,255,255,0.92);border-color:rgba(0,0,0,0.08);color:#1e293b;
          box-shadow:0 12px 48px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06),inset 0 1px 0 rgba(255,255,255,0.8);}
        #__gb-ctx .ctx-item:hover{background:rgba(37,99,235,0.1);}
        #__gb-ctx .ctx-accel{color:rgba(0,0,0,0.3);}
        #__gb-ctx .ctx-item:hover .ctx-accel{color:rgba(0,0,0,0.5);}
        #__gb-ctx .ctx-sep{background:rgba(0,0,0,0.06);}
      }
      html.light #__gb-ctx{background:rgba(255,255,255,0.92);border-color:rgba(0,0,0,0.08);color:#1e293b;
        box-shadow:0 12px 48px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06),inset 0 1px 0 rgba(255,255,255,0.8);}
      html.light #__gb-ctx .ctx-item:hover{background:rgba(37,99,235,0.1);}
      html.light #__gb-ctx .ctx-accel{color:rgba(0,0,0,0.3);}
      html.light #__gb-ctx .ctx-item:hover .ctx-accel{color:rgba(0,0,0,0.5);}
      html.light #__gb-ctx .ctx-sep{background:rgba(0,0,0,0.06);}
    \`;
    document.documentElement.appendChild(style);

    var ov=document.createElement('div');ov.id='__gb-ctx-ov';
    ov.onclick=function(){ov.remove();menu.remove();style.remove();};
    ov.oncontextmenu=function(e){e.preventDefault();ov.remove();menu.remove();style.remove();};
    document.documentElement.appendChild(ov);

    var menu=document.createElement('div');menu.id='__gb-ctx';
    var items=${menuData};
    items.forEach(function(it){
      if(it.type==='separator'){var s=document.createElement('div');s.className='ctx-sep';menu.appendChild(s);return;}
      var d=document.createElement('div');d.className='ctx-item';
      d.innerHTML=(it.icon?'<span class="ctx-icon">'+it.icon+'</span>':'')+'<span class="ctx-label">'+it.label+'</span>'+(it.accel?'<span class="ctx-accel">'+it.accel+'</span>':'');
      d.dataset.action=it.action||'';
      d.dataset.data=it.data||'';
      d.onclick=function(){
        ov.remove();menu.remove();style.remove();
        console.log('__gb_more_ctx:'+JSON.stringify({action:this.dataset.action,data:this.dataset.data}));
      };
      menu.appendChild(d);
    });
    document.documentElement.appendChild(menu);

    var mx=${tabLocalX},my=${tabLocalY};
    var r=menu.getBoundingClientRect();
    if(mx+r.width>window.innerWidth)mx=window.innerWidth-r.width-8;
    if(my+r.height>window.innerHeight)my=window.innerHeight-r.height-8;
    if(mx<0)mx=4;if(my<0)my=4;
    menu.style.left=mx+'px';menu.style.top=my+'px';
  })();`);

  const moreHandler = (event) => {
    const message = event.message;
    if (!message || !message.startsWith('__gb_more_ctx:')) return;
    tabView.webContents.removeListener('console-message', moreHandler);
    try {
      const { action, data } = JSON.parse(message.replace('__gb_more_ctx:', ''));
      if (action === 'nav_open') openOrSwitchTab(data);
      else if (action === 'more_private') { ipcMain.emit('open-private-window', { sender: null }); }
      else if (action === 'more_find') { if (toolbarView) toolbarView.webContents.executeJavaScript('toggleFindBar()').catch(() => {}); }
      else if (action === 'more_zoom_in') { if (activeTabId && tabs.has(activeTabId)) { const wc = tabs.get(activeTabId).view.webContents; wc.setZoomLevel(wc.getZoomLevel() + 1); sendToToolbar('zoom-changed', { level: wc.getZoomLevel() }); } }
      else if (action === 'more_zoom_out') { if (activeTabId && tabs.has(activeTabId)) { const wc = tabs.get(activeTabId).view.webContents; wc.setZoomLevel(wc.getZoomLevel() - 1); sendToToolbar('zoom-changed', { level: wc.getZoomLevel() }); } }
      else if (action === 'more_zoom_reset') { if (activeTabId && tabs.has(activeTabId)) { const wc = tabs.get(activeTabId).view.webContents; wc.setZoomLevel(0); sendToToolbar('zoom-changed', { level: 0 }); } }
      else if (action === 'more_fullscreen') { if (mainWindow) { mainWindow.isFullScreen() ? mainWindow.setFullScreen(false) : mainWindow.setFullScreen(true); } }
      else if (action === 'more_reader') {
        // Reader mode — trigger via existing IPC
        sendToToolbar('toast', { message: 'Режим чтения (в разработке)' });
      }
    } catch {}
  };
  _prevMoreHandler = moreHandler;
  _prevMoreWc = tabView.webContents;
  tabView.webContents.on('console-message', moreHandler);
  setTimeout(() => { try { tabView.webContents.removeListener('console-message', moreHandler); } catch {} if (_prevMoreHandler === moreHandler) { _prevMoreHandler = null; _prevMoreWc = null; } }, 10000);
});

ipcMain.on('navigate', (_e, input) => {
  if (!activeTabId) return;
  navigateTab(activeTabId, normalizeUrl(input));
});

// Bookmark
ipcMain.on('add-bookmark', async (_e, data) => {
  try {
    // If title is empty, get it from the active tab
    let title = data.title;
    if (!title && activeTabId && tabs.has(activeTabId)) {
      title = tabs.get(activeTabId).title || '';
    }
    await rustBridge.call('bookmark.add', { url: data.url, title });
    sendToToolbar('toast', { message: cmL('bookmarks.added_toast', 'Bookmark added') });
  } catch { sendToToolbar('toast', { message: cmL('bookmarks.failed_toast', 'Failed to add bookmark') }); }
});

ipcMain.handle('bookmark-list', async () => {
  try { return await rustBridge.call('bookmark.list', {}); } catch { return []; }
});
ipcMain.handle('bookmark-search', async (_e, query) => {
  try { return await rustBridge.call('bookmark.search', { query }); } catch { return []; }
});
ipcMain.on('bookmark-delete', async (_e, id) => {
  try { await rustBridge.call('bookmark.delete', { id }); sendToToolbar('toast', { message: cmL('bookmarks.removed_toast', 'Bookmark removed') }); } catch {}
});

// History
ipcMain.handle('history-recent', async () => {
  try { return await rustBridge.call('history.recent', {}); } catch { return []; }
});
ipcMain.handle('history-search', async (_e, query) => {
  try { return await rustBridge.call('history.search', { query }); } catch { return []; }
});
ipcMain.on('history-clear', async () => {
  try { await rustBridge.call('history.clear', {}); sendToToolbar('toast', { message: cmL('history.cleared', 'History cleared') }); } catch {}
});
ipcMain.on('history-delete', async (_e, id) => {
  try { await rustBridge.call('history.delete', { id }); } catch {}
});

// Settings
ipcMain.handle('settings-get', async () => {
  try { return await rustBridge.call('settings.get', {}); } catch { return {}; }
});

// Locale — load entire locale file for UI
ipcMain.handle('get-locale-data', async () => {
  try {
    const settings = await rustBridge.call('settings.get', {});
    const lang = (settings && settings.general && settings.general.language) || 'en';
    const localePath = resolvePath('locales', lang + '.json');
    const data = fs.readFileSync(localePath, 'utf8');
    return { locale: lang, data: JSON.parse(data) };
  } catch {
    try {
      const fallback = resolvePath('locales', 'en.json');
      const data = fs.readFileSync(fallback, 'utf8');
      return { locale: 'en', data: JSON.parse(data) };
    } catch { return { locale: 'en', data: {} }; }
  }
});
ipcMain.handle('settings-set', async (_e, { key, value }) => {
  try {
    const result = await rustBridge.call('settings.set', { key, value });
    // Broadcast theme change to all views
    if (key === 'appearance.theme') {
      broadcastTheme(value);
    }
    // Reload locale for context menu when language changes
    if (key === 'general.language') {
      loadContextMenuLocale();
    }
    return result;
  } catch { return { error: true }; }
});

// Downloads
ipcMain.handle('downloads-list', () => Array.from(downloads.values()));
ipcMain.on('download-pause', (_e, id) => { const item = downloadItems.get(id); if (item) item.pause(); });
ipcMain.on('download-resume', (_e, id) => { const item = downloadItems.get(id); if (item && item.canResume()) item.resume(); });
ipcMain.on('download-cancel', (_e, id) => { const item = downloadItems.get(id); if (item) item.cancel(); });
ipcMain.on('download-open-file', (_e, filepath) => { const { shell } = require('electron'); shell.openPath(filepath); });
ipcMain.on('download-show-folder', (_e, filepath) => { const { shell } = require('electron'); shell.showItemInFolder(filepath); });

// Navigation from internal pages
ipcMain.on('open-url', (_e, url) => {
  if (activeTabId) navigateTab(activeTabId, url);
  else createTab(url);
});
ipcMain.on('open-url-new-tab', (_e, url) => createTab(url));

// ─── AI Assistant (main process to bypass CORS) ───

// ─── Page context menu (right-click) with AI actions ───

// Cached locale for context menu
let cachedLocale = null;
async function loadContextMenuLocale() {
  try {
    const settings = await rustBridge.call('settings.get', {});
    const lang = (settings && settings.general && settings.general.language) || 'en';
    const localePath = resolvePath('locales', lang + '.json');
    const data = fs.readFileSync(localePath, 'utf8');
    cachedLocale = JSON.parse(data);
  } catch {
    try {
      const fallback = resolvePath('locales', 'en.json');
      const data = fs.readFileSync(fallback, 'utf8');
      cachedLocale = JSON.parse(data);
    } catch {}
  }
}

function cmL(key, fallback) {
  if (!cachedLocale) return fallback;
  const parts = key.split('.');
  let v = cachedLocale;
  for (const p of parts) { v = v && v[p]; if (!v) break; }
  return v || fallback;
}

// ─── Overlay context menu for toolbar/sidebar ───
// JS snippet to remove all injected overlay menus from a page (call before injecting new one)
const CLEAR_ALL_OVERLAYS_JS = `
  ['__gb-sb-ctx','__gb-sb-ctx-style','__gb-sb-ctx-ov',
   '__gb-ctx','__gb-ctx-style','__gb-ctx-ov',
   '__gb-page-ctx','__gb-page-ctx-style','__gb-page-ctx-ov','__gb-page-ctx-sub']
  .forEach(function(id){var e=document.getElementById(id);if(e)e.remove();});
`;

// Shows a custom glass context menu in the active tab view (which is large enough)
// by converting coordinates from the source view to the tab view coordinate space.
function showOverlayContextMenu(sourceWc, params, viewOffsetX, viewOffsetY) {
  // We need an active tab to host the menu
  if (!activeTabId || !tabs.has(activeTabId)) {
    // Fallback to native menu if no tab is open
    buildNativeContextMenu(sourceWc, params);
    return;
  }

  const tabView = tabs.get(activeTabId).view;
  const tabBounds = tabView.getBounds();

  const hasSelection = params.selectionText && params.selectionText.trim().length > 0;
  const selText = (params.selectionText || '').trim();
  const isEditable = params.isEditable;

  const items = [];
  if (hasSelection) {
    items.push({ label: cmL('context_menu.copy', 'Копировать'), accel: 'Ctrl+C', action: 'copy' });
  }
  if (isEditable) {
    items.push({ label: cmL('context_menu.cut', 'Вырезать'), accel: 'Ctrl+X', action: 'cut', disabled: !hasSelection });
    items.push({ label: cmL('context_menu.paste', 'Вставить'), accel: 'Ctrl+V', action: 'paste' });
  }
  items.push({ label: cmL('context_menu.select_all', 'Выделить всё'), accel: 'Ctrl+A', action: 'selectAll' });

  if (process.argv.includes('--dev')) {
    items.push({ type: 'separator' });
    items.push({ label: cmL('context_menu.inspect', 'Инспектировать элемент'), action: 'inspect' });
  }

  // Convert coordinates: source view local -> window global -> tab view local
  const globalX = params.x + viewOffsetX;
  const globalY = params.y + viewOffsetY;
  const tabLocalX = globalX - tabBounds.x;
  const tabLocalY = globalY - tabBounds.y;

  const menuData = JSON.stringify(items);

  // Inject the glass context menu into the active tab view
  tabView.webContents.executeJavaScript(`(function(){
    ${CLEAR_ALL_OVERLAYS_JS}

    var style=document.createElement('style');style.id='__gb-ctx-style';
    style.textContent=\`
      #__gb-ctx-ov{position:fixed;inset:0;z-index:2147483646;}
      #__gb-ctx{position:fixed;z-index:2147483647;
        background:rgba(18,22,30,0.92);
        backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);
        border:1px solid rgba(255,255,255,0.08);border-radius:12px;
        padding:6px;min-width:200px;
        box-shadow:0 12px 48px rgba(0,0,0,0.5),0 2px 8px rgba(0,0,0,0.3),inset 0 1px 0 rgba(255,255,255,0.06);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#e2e8f0;
        animation:__gbCtxIn 0.15s cubic-bezier(0.16,1,0.3,1);
        user-select:none;-webkit-user-select:none;}
      @keyframes __gbCtxIn{from{opacity:0;transform:scale(0.96) translateY(-4px)}to{opacity:1;transform:scale(1) translateY(0)}}
      #__gb-ctx .ctx-item{display:flex;align-items:center;justify-content:space-between;
        padding:7px 12px;border-radius:8px;cursor:pointer;transition:background 0.1s,color 0.1s;gap:24px;}
      #__gb-ctx .ctx-item:hover{background:rgba(96,165,250,0.12);color:#fff;}
      #__gb-ctx .ctx-item.disabled{opacity:0.4;pointer-events:none;}
      #__gb-ctx .ctx-accel{font-size:11px;color:rgba(255,255,255,0.3);font-weight:500;}
      #__gb-ctx .ctx-item:hover .ctx-accel{color:rgba(255,255,255,0.5);}
      #__gb-ctx .ctx-sep{height:1px;background:rgba(255,255,255,0.06);margin:4px 8px;}
      @media (prefers-color-scheme:light){
        #__gb-ctx{background:rgba(255,255,255,0.92);border-color:rgba(0,0,0,0.08);color:#1e293b;
          box-shadow:0 12px 48px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06),inset 0 1px 0 rgba(255,255,255,0.8);}
        #__gb-ctx .ctx-item:hover{background:rgba(37,99,235,0.1);}
        #__gb-ctx .ctx-accel{color:rgba(0,0,0,0.3);}
        #__gb-ctx .ctx-item:hover .ctx-accel{color:rgba(0,0,0,0.5);}
        #__gb-ctx .ctx-sep{background:rgba(0,0,0,0.06);}
      }
      html.light #__gb-ctx{background:rgba(255,255,255,0.92);border-color:rgba(0,0,0,0.08);color:#1e293b;
        box-shadow:0 12px 48px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06),inset 0 1px 0 rgba(255,255,255,0.8);}
      html.light #__gb-ctx .ctx-item:hover{background:rgba(37,99,235,0.1);}
      html.light #__gb-ctx .ctx-accel{color:rgba(0,0,0,0.3);}
      html.light #__gb-ctx .ctx-item:hover .ctx-accel{color:rgba(0,0,0,0.5);}
      html.light #__gb-ctx .ctx-sep{background:rgba(0,0,0,0.06);}
    \`;
    document.documentElement.appendChild(style);

    var ov=document.createElement('div');ov.id='__gb-ctx-ov';
    ov.onclick=function(){ov.remove();menu.remove();style.remove();};
    ov.oncontextmenu=function(e){e.preventDefault();ov.remove();menu.remove();style.remove();};
    document.documentElement.appendChild(ov);

    var menu=document.createElement('div');menu.id='__gb-ctx';
    var items=${menuData};
    items.forEach(function(it){
      if(it.type==='separator'){var s=document.createElement('div');s.className='ctx-sep';menu.appendChild(s);return;}
      var d=document.createElement('div');d.className='ctx-item'+(it.disabled?' disabled':'');
      d.innerHTML=it.label+(it.accel?'<span class="ctx-accel">'+it.accel+'</span>':'');
      d.dataset.action=it.action||'';
      d.dataset.data=it.data||'';
      d.onclick=function(){
        ov.remove();menu.remove();style.remove();
        console.log('__gb_ctx_overlay:'+JSON.stringify({action:this.dataset.action,data:this.dataset.data}));
      };
      menu.appendChild(d);
    });
    document.documentElement.appendChild(menu);

    var mx=${tabLocalX},my=${tabLocalY};
    var r=menu.getBoundingClientRect();
    if(mx+r.width>window.innerWidth)mx=window.innerWidth-r.width-8;
    if(my+r.height>window.innerHeight)my=window.innerHeight-r.height-8;
    if(mx<4)mx=4;if(my<4)my=4;
    menu.style.left=mx+'px';menu.style.top=my+'px';
  })();`);

  // Listen for overlay menu actions
  const overlayHandler = (event) => {
    const message = event.message;
    if (!message || !message.startsWith('__gb_ctx_overlay:')) return;
    tabView.webContents.removeListener('console-message', overlayHandler);
    try {
      const { action } = JSON.parse(message.replace('__gb_ctx_overlay:', ''));
      if (action === 'copy') sourceWc.copy();
      else if (action === 'cut') sourceWc.cut();
      else if (action === 'paste') sourceWc.paste();
      else if (action === 'selectAll') sourceWc.selectAll();
      else if (action === 'inspect') sourceWc.inspectElement(params.x, params.y);
    } catch {}
  };
  tabView.webContents.on('console-message', overlayHandler);
  setTimeout(() => { try { tabView.webContents.removeListener('console-message', overlayHandler); } catch {} }, 10000);
}

// Native Electron Menu for toolbar/sidebar (not clipped by view bounds)
function buildNativeContextMenu(wc, params) {
  const hasSelection = params.selectionText && params.selectionText.trim().length > 0;
  const isEditable = params.isEditable;
  const template = [];

  if (hasSelection) {
    template.push({ label: cmL('context_menu.copy', 'Копировать'), accelerator: 'CmdOrCtrl+C', role: 'copy' });
  }
  if (isEditable) {
    template.push({ label: cmL('context_menu.cut', 'Вырезать'), accelerator: 'CmdOrCtrl+X', role: 'cut', enabled: hasSelection });
    template.push({ label: cmL('context_menu.paste', 'Вставить'), accelerator: 'CmdOrCtrl+V', role: 'paste' });
  }
  template.push({ label: cmL('context_menu.select_all', 'Выделить всё'), accelerator: 'CmdOrCtrl+A', role: 'selectAll' });

  if (process.argv.includes('--dev')) {
    template.push({ type: 'separator' });
    template.push({ label: cmL('context_menu.inspect', 'Инспектировать элемент'), click: () => wc.inspectElement(params.x, params.y) });
  }

  if (template.length > 0) {
    const menu = Menu.buildFromTemplate(template);
    menu.popup();
  }
}

function buildPageContextMenu(wc, params) {
  // Store context for IPC handler
  _pageCtxWc = wc;
  _pageCtxParams = params;
  // Clean up previous console handler
  if (_pageCtxConsoleHandler && wc && !wc.isDestroyed()) {
    try { wc.removeListener('console-message', _pageCtxConsoleHandler); } catch {}
  }

  const hasSelection = params.selectionText && params.selectionText.trim().length > 0;
  const selText = (params.selectionText || '').trim();
  const isEditable = params.isEditable;

  const items = [];

  if (hasSelection) {
    items.push({ label: cmL('context_menu.copy', 'Копировать'), accel: 'Ctrl+C', action: 'copy' });
  }
  if (isEditable) {
    items.push({ label: cmL('context_menu.cut', 'Вырезать'), accel: 'Ctrl+X', action: 'cut', disabled: !hasSelection });
    items.push({ label: cmL('context_menu.paste', 'Вставить'), accel: 'Ctrl+V', action: 'paste' });
  }
  items.push({ label: cmL('context_menu.select_all', 'Выделить всё'), accel: 'Ctrl+A', action: 'selectAll' });

  if (params.linkURL) {
    items.push({ type: 'separator' });
    items.push({ label: cmL('context_menu.open_link_new_tab', 'Открыть ссылку в новой вкладке'), action: 'openLink', data: params.linkURL });
    items.push({ label: cmL('context_menu.copy_link', 'Копировать ссылку'), action: 'copyLink', data: params.linkURL });
  }

  if (params.mediaType === 'image' && params.srcURL) {
    items.push({ type: 'separator' });
    items.push({ label: cmL('context_menu.save_image', 'Сохранить изображение...'), action: 'saveImage', data: params.srcURL });
    items.push({ label: cmL('context_menu.copy_image_url', 'Копировать URL изображения'), action: 'copyImageUrl', data: params.srcURL });
    items.push({ label: cmL('context_menu.open_image_new_tab', 'Открыть изображение в новой вкладке'), action: 'openImageTab', data: params.srcURL });
  }

  // AI submenu items
  let aiSub = [];
  if (hasSelection && selText.length >= 2) {
    aiSub = [
      { label: cmL('context_menu.fix_errors', 'Исправить ошибки'), action: 'ai', data: JSON.stringify({ type: 'fix', text: selText }) },
      { label: cmL('context_menu.rephrase', 'Перефразировать'), action: 'ai', data: JSON.stringify({ type: 'rephrase', text: selText }) },
      { type: 'separator' },
      { label: cmL('context_menu.translate_en', 'Перевести на English'), action: 'ai', data: JSON.stringify({ type: 'translate_en', text: selText }) },
      { label: cmL('context_menu.translate_ru', 'Перевести на Русский'), action: 'ai', data: JSON.stringify({ type: 'translate_ru', text: selText }) },
      { type: 'separator' },
      { label: cmL('context_menu.summarize', 'Резюмировать'), action: 'ai', data: JSON.stringify({ type: 'summarize', text: selText }) },
      { label: cmL('context_menu.explain', 'Объяснить'), action: 'ai', data: JSON.stringify({ type: 'explain', text: selText }) },
    ];
  }

  if (process.argv.includes('--dev')) {
    items.push({ type: 'separator' });
    items.push({ label: cmL('context_menu.inspect', 'Инспектировать элемент'), action: 'inspect' });
  }

  const menuData = JSON.stringify(items);
  const aiSubData = JSON.stringify(aiSub);
  const aiLabel = JSON.stringify(cmL('context_menu.ai', 'AI'));
  const mx = params.x;
  const my = params.y;

  // Inject glass-style context menu directly into the page
  if (wc.isDestroyed()) return;
  wc.executeJavaScript(`(function(){
    ${CLEAR_ALL_OVERLAYS_JS}

    var style=document.createElement('style');style.id='__gb-page-ctx-style';
    style.textContent=\`
      #__gb-page-ctx-ov{position:fixed;inset:0;z-index:2147483646;}
      .__gbp{position:fixed;z-index:2147483647;
        background:rgba(18,22,30,0.92);
        backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);
        border:1px solid rgba(255,255,255,0.08);border-radius:10px;
        padding:4px;min-width:200px;
        box-shadow:0 8px 32px rgba(0,0,0,0.45),0 2px 6px rgba(0,0,0,0.25),inset 0 1px 0 rgba(255,255,255,0.06);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#e2e8f0;
        animation:__gbPCtxIn 0.12s cubic-bezier(0.16,1,0.3,1);
        user-select:none;-webkit-user-select:none;}
      @keyframes __gbPCtxIn{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}
      .__gbp .pci{display:flex;align-items:center;justify-content:space-between;
        padding:6px 10px;border-radius:6px;cursor:default;transition:background 0.08s;gap:16px;}
      .__gbp .pci:hover{background:rgba(255,255,255,0.07);}
      .__gbp .pci.disabled{opacity:0.35;pointer-events:none;}
      .__gbp .pci-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .__gbp .pci-accel{font-size:11px;color:rgba(255,255,255,0.25);font-weight:500;flex-shrink:0;}
      .__gbp .pci:hover .pci-accel{color:rgba(255,255,255,0.4);}
      .__gbp .pci-arrow{font-size:10px;color:rgba(255,255,255,0.3);margin-left:4px;}
      .__gbp .pci-sep{height:1px;background:rgba(255,255,255,0.06);margin:3px 6px;}
      #__gb-page-ctx-sub{animation:__gbPCtxIn 0.1s cubic-bezier(0.16,1,0.3,1);}
      @media (prefers-color-scheme:light){
        .__gbp{background:rgba(255,255,255,0.94);border-color:rgba(0,0,0,0.1);color:#1e293b;
          box-shadow:0 8px 32px rgba(0,0,0,0.1),0 2px 6px rgba(0,0,0,0.05),inset 0 1px 0 rgba(255,255,255,0.8);}
        .__gbp .pci:hover{background:rgba(0,0,0,0.05);}
        .__gbp .pci-accel{color:rgba(0,0,0,0.25);}
        .__gbp .pci:hover .pci-accel{color:rgba(0,0,0,0.4);}
        .__gbp .pci-arrow{color:rgba(0,0,0,0.3);}
        .__gbp .pci-sep{background:rgba(0,0,0,0.07);}
      }
      html.light .__gbp{background:rgba(255,255,255,0.94);border-color:rgba(0,0,0,0.1);color:#1e293b;
        box-shadow:0 8px 32px rgba(0,0,0,0.1),0 2px 6px rgba(0,0,0,0.05),inset 0 1px 0 rgba(255,255,255,0.8);}
      html.light .__gbp .pci:hover{background:rgba(0,0,0,0.05);}
      html.light .__gbp .pci-accel{color:rgba(0,0,0,0.25);}
      html.light .__gbp .pci:hover .pci-accel{color:rgba(0,0,0,0.4);}
      html.light .__gbp .pci-arrow{color:rgba(0,0,0,0.3);}
      html.light .__gbp .pci-sep{background:rgba(0,0,0,0.07);}
    \`;
    document.documentElement.appendChild(style);

    function closeMenu(){
      var ov2=document.getElementById('__gb-page-ctx-ov');if(ov2)ov2.remove();
      var m2=document.getElementById('__gb-page-ctx');if(m2)m2.remove();
      var s2=document.getElementById('__gb-page-ctx-style');if(s2)s2.remove();
      var sb=document.getElementById('__gb-page-ctx-sub');if(sb)sb.remove();
    }

    var _prevFocus=document.activeElement;
    var _prevSelStart=null,_prevSelEnd=null;
    if(_prevFocus&&(_prevFocus.tagName==='INPUT'||_prevFocus.tagName==='TEXTAREA')){
      _prevSelStart=_prevFocus.selectionStart;_prevSelEnd=_prevFocus.selectionEnd;
    }

    var hasIpc=!!(window.gitbrowser&&window.gitbrowser.ctxAction);
    function doAction(act,dat){
      closeMenu();
      if(_prevFocus&&_prevFocus.focus){
        _prevFocus.focus();
        if(_prevSelStart!==null&&(_prevFocus.tagName==='INPUT'||_prevFocus.tagName==='TEXTAREA')){
          try{_prevFocus.setSelectionRange(_prevSelStart,_prevSelEnd);}catch(e){}
        }
      }
      // Small delay to let focus restore before IPC triggers clipboard ops
      setTimeout(function(){
        if(hasIpc){window.gitbrowser.ctxAction(act,dat);}
        else{console.log('__gb_page_ctx:'+JSON.stringify({action:act,data:dat}));}
      },50);
    }

    var ov=document.createElement('div');ov.id='__gb-page-ctx-ov';
    ov.onclick=function(){closeMenu();};
    ov.oncontextmenu=function(e){e.preventDefault();closeMenu();};
    document.documentElement.appendChild(ov);

    var menu=document.createElement('div');menu.id='__gb-page-ctx';
    menu.className='__gbp';
    var items=${menuData};
    var aiSub=${aiSubData};
    var aiLabel=${aiLabel};

    items.forEach(function(it){
      if(it.type==='separator'){var s=document.createElement('div');s.className='pci-sep';menu.appendChild(s);return;}
      var d=document.createElement('div');d.className='pci'+(it.disabled?' disabled':'');
      d.innerHTML='<span class="pci-label">'+it.label+'</span>'+(it.accel?'<span class="pci-accel">'+it.accel+'</span>':'');
      d.onclick=function(){doAction(it.action||'',it.data||'');};
      menu.appendChild(d);
    });

    if(aiSub.length>0){
      var sep=document.createElement('div');sep.className='pci-sep';menu.appendChild(sep);
      var aiRow=document.createElement('div');aiRow.className='pci';
      aiRow.innerHTML='<span class="pci-label">'+aiLabel+'</span><span class="pci-arrow">&#9656;</span>';
      var subTimer=null;
      function showAiSub(){
        clearTimeout(subTimer);
        var oldSub=document.getElementById('__gb-page-ctx-sub');if(oldSub)oldSub.remove();
        var sub=document.createElement('div');sub.id='__gb-page-ctx-sub';sub.className='__gbp';
        aiSub.forEach(function(si){
          if(si.type==='separator'){var ss=document.createElement('div');ss.className='pci-sep';sub.appendChild(ss);return;}
          var sd=document.createElement('div');sd.className='pci';
          sd.innerHTML='<span class="pci-label">'+si.label+'</span>';
          sd.onclick=function(){doAction(si.action||'',si.data||'');};
          sub.appendChild(sd);
        });
        document.documentElement.appendChild(sub);
        var mr=menu.getBoundingClientRect();var sr=sub.getBoundingClientRect();
        var sx=mr.right+4,sy=aiRow.getBoundingClientRect().top;
        if(sx+sr.width>window.innerWidth)sx=mr.left-sr.width-4;
        if(sy+sr.height>window.innerHeight)sy=window.innerHeight-sr.height-8;
        if(sy<4)sy=4;
        sub.style.left=sx+'px';sub.style.top=sy+'px';
        sub.onmouseenter=function(){clearTimeout(subTimer);};
        sub.onmouseleave=function(){subTimer=setTimeout(function(){sub.remove();},200);};
      }
      aiRow.onmouseenter=function(){showAiSub();};
      aiRow.onmouseleave=function(){subTimer=setTimeout(function(){var s=document.getElementById('__gb-page-ctx-sub');if(s)s.remove();},200);};
      aiRow.onclick=function(){showAiSub();};
      menu.appendChild(aiRow);
    }

    document.documentElement.appendChild(menu);

    var mx=${mx},my=${my};
    var r=menu.getBoundingClientRect();
    if(mx+r.width>window.innerWidth)mx=window.innerWidth-r.width-8;
    if(my+r.height>window.innerHeight)my=window.innerHeight-r.height-8;
    if(mx<4)mx=4;if(my<4)my=4;
    menu.style.left=mx+'px';menu.style.top=my+'px';
  })();void 0;`).catch(() => {});

  // Console.log fallback listener for external pages without preload
  const consoleHandler = (event) => {
    const message = event.message;
    if (!message || !message.startsWith('__gb_page_ctx:')) return;
    try { wc.removeListener('console-message', consoleHandler); } catch {}
    _pageCtxConsoleHandler = null;
    try {
      const { action, data } = JSON.parse(message.replace('__gb_page_ctx:', ''));
      if (action === 'copy') wc.copy();
      else if (action === 'cut') wc.cut();
      else if (action === 'paste') wc.paste();
      else if (action === 'selectAll') wc.selectAll();
      else if (action === 'openLink' && data) createTab(data);
      else if (action === 'copyLink' && data) clipboard.writeText(data);
      else if (action === 'saveImage' && data) wc.downloadURL(data);
      else if (action === 'copyImageUrl' && data) clipboard.writeText(data);
      else if (action === 'openImageTab' && data) createTab(data);
      else if (action === 'inspect') wc.inspectElement(params.x, params.y);
      else if (action === 'ai' && data) {
        try {
          const aiData = JSON.parse(data);
          runAiAction(wc, aiData.type, aiData.text);
        } catch {}
      }
    } catch {}
  };
  _pageCtxConsoleHandler = consoleHandler;
  if (!wc.isDestroyed()) wc.on('console-message', consoleHandler);
  setTimeout(() => { try { if (!wc.isDestroyed()) wc.removeListener('console-message', consoleHandler); } catch {} if (_pageCtxConsoleHandler === consoleHandler) _pageCtxConsoleHandler = null; }, 10000);
}

// Run AI action and show result in an injected popup
async function runAiAction(wc, action, text) {
  // Show loading popup, pass original text for later replacement
  injectAiPopup(wc, null, true, text);

  try {
    const config = await getAiConfig();
    if (!config || !config.apiKey) {
      injectAiPopup(wc, { error: cmL('ai.error_no_key', 'No AI API key configured. Set it up in AI Assistant.') }, false, text);
      return;
    }

    const prompts = {
      fix: 'Fix all grammar, spelling, and punctuation errors in the following text. Return ONLY the corrected text, nothing else:\n\n',
      rephrase: 'Rephrase the following text to sound more natural and clear. Return ONLY the rephrased text, nothing else:\n\n',
      translate_en: 'Translate the following text to English. Return ONLY the translation, nothing else:\n\n',
      translate_ru: 'Translate the following text to Russian. Return ONLY the translation, nothing else:\n\n',
      summarize: 'Summarize the following text in 2-3 sentences. Return ONLY the summary:\n\n',
      explain: 'Explain the following text in simple terms. Be concise:\n\n',
    };
    const message = (prompts[action] || '') + text.substring(0, 4000);
    const { provider, apiKey, model } = config;

    const endpoints = {
      openai: 'https://api.openai.com/v1/chat/completions',
      anthropic: 'https://api.anthropic.com/v1/messages',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
      deepseek: 'https://api.deepseek.com/v1/chat/completions',
    };
    const url = endpoints[provider];
    if (!url) { injectAiPopup(wc, { error: 'Unknown provider' }, false, text); return; }

    const msgs = [{ role: 'user', content: message }];
    let resultText;

    if (provider === 'anthropic') {
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model || 'claude-sonnet-4-20250514', max_tokens: 2048, messages: msgs }),
      });
      if (!res.ok) throw new Error((await res.text()).substring(0, 200));
      const data = await res.json();
      resultText = data.content?.[0]?.text || 'No response';
    } else {
      const defaultModels = { openai: 'gpt-4o-mini', deepseek: 'deepseek-chat', openrouter: 'openai/gpt-4o-mini' };
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model: model || defaultModels[provider] || 'gpt-4o-mini', messages: msgs, max_tokens: 2048 }),
      });
      if (!res.ok) throw new Error((await res.text()).substring(0, 200));
      const data = await res.json();
      resultText = data.choices?.[0]?.message?.content || 'No response';
    }

    injectAiPopup(wc, { text: resultText }, false, text);
  } catch (err) {
    injectAiPopup(wc, { error: err.message || 'AI request failed' }, false, text);
  }
}

// Inject a floating result popup into the page
function injectAiPopup(wc, result, loading, originalText) {
  if (wc.isDestroyed()) return;
  const origEsc = JSON.stringify(originalText || '');
  const js = `(function(){
    var p=document.getElementById('__gb-ai-pop');
    if(!p){
      p=document.createElement('div');p.id='__gb-ai-pop';
      var s=document.createElement('style');
      s.textContent='#__gb-ai-pop{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#161b22;border:1px solid #30363d;border-radius:14px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.6);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:500px;min-width:280px;max-height:70vh;display:flex;flex-direction:column;color:#e6edf3}#__gb-ai-pop .hd{display:flex;align-items:center;margin-bottom:10px;font-size:13px;font-weight:600;color:#7d8590}#__gb-ai-pop .hd span{flex:1}#__gb-ai-pop .hd button{background:none;border:none;color:#7d8590;cursor:pointer;font-size:18px;line-height:1;padding:0 4px}#__gb-ai-pop .hd button:hover{color:#e6edf3}#__gb-ai-pop .bd{font-size:14px;line-height:1.6;overflow-y:auto;white-space:pre-wrap;word-break:break-word;flex:1;max-height:50vh}#__gb-ai-pop .ld{color:#7d8590;font-size:13px;display:flex;align-items:center;gap:8px}#__gb-ai-pop .ld::before{content:"";width:14px;height:14px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:__gbsp .6s linear infinite}@keyframes __gbsp{to{transform:rotate(360deg)}}#__gb-ai-pop .er{color:#f85149}#__gb-ai-pop .ft{display:flex;gap:8px;margin-top:12px;justify-content:flex-end}#__gb-ai-pop .ft button{padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit;border:1px solid #30363d;background:#21262d;color:#e6edf3}#__gb-ai-pop .ft button:hover{border-color:#58a6ff;background:#30363d}#__gb-ai-pop .ft button.pr{background:#1f6feb;border-color:#1f6feb;color:#fff}#__gb-ai-pop .ft button.pr:hover{background:#388bfd}';
      document.documentElement.appendChild(s);
      document.documentElement.appendChild(p);
    }
    window.__gbOrigText=${origEsc};
    ${loading ? `p.innerHTML='<div class="hd"><span>AI</span><button id="__gbxl">x</button></div><div class="bd"><div class="ld">${cmL('ai.thinking', 'Thinking...')}</div></div>';p.style.display='flex';var xl=document.getElementById('__gbxl');if(xl)xl.onclick=function(){p.style.display='none';};`
    : result ? `var r=${JSON.stringify(result)};
      var h='<div class="hd"><span>AI Result</span><button id="__gbxp">x</button></div>';
      if(r.error){h+='<div class="bd er">'+r.error.replace(/</g,"&lt;")+'</div>';}
      else{h+='<div class="bd">'+r.text.replace(/</g,"&lt;")+'</div>';h+='<div class="ft"><button class="pr" id="__gbcp">${cmL('ai.copy', 'Copy')}</button><button id="__gbrp">${cmL('ai.replace', 'Replace')}</button></div>';}
      p.innerHTML=h;p.style.display='flex';
      var xb=document.getElementById('__gbxp');if(xb)xb.onclick=function(){p.style.display='none';};
      var cb=document.getElementById('__gbcp');if(cb)cb.onclick=function(){navigator.clipboard.writeText(r.text).then(function(){cb.textContent='Copied!';setTimeout(function(){cb.textContent='${cmL('ai.copy', 'Copy')}';},1200);});};
      var rb=document.getElementById('__gbrp');if(rb)rb.onclick=function(){
        var orig=window.__gbOrigText;
        var newText=r.text;
        var done=false;
        // 1. Try contenteditable / input / textarea first (most common editable context)
        try{
          var ae=document.activeElement;
          if(ae&&(ae.tagName==='TEXTAREA'||(ae.tagName==='INPUT'&&ae.type==='text'))){
            var v=ae.value;
            var idx=v.indexOf(orig);
            if(idx>=0){
              ae.focus();
              ae.setSelectionRange(idx,idx+orig.length);
              document.execCommand('insertText',false,newText);
              done=true;
            }
          }
          if(!done&&ae&&ae.isContentEditable){
            var tw=document.createTreeWalker(ae,NodeFilter.SHOW_TEXT,null,false);
            var nd,buf='',nodes=[];
            while(nd=tw.nextNode()){nodes.push({node:nd,start:buf.length});buf+=nd.textContent;}
            var fi=buf.indexOf(orig);
            if(fi>=0){
              ae.focus();
              var startInfo=null,endInfo=null,fe=fi+orig.length;
              for(var ni=0;ni<nodes.length;ni++){
                var ns=nodes[ni].start,ne=ns+nodes[ni].node.textContent.length;
                if(!startInfo&&fi>=ns&&fi<ne)startInfo={node:nodes[ni].node,offset:fi-ns};
                if(!endInfo&&fe>ns&&fe<=ne)endInfo={node:nodes[ni].node,offset:fe-ns};
              }
              if(startInfo&&endInfo){
                var rng=document.createRange();
                rng.setStart(startInfo.node,startInfo.offset);
                rng.setEnd(endInfo.node,endInfo.offset);
                var sel=window.getSelection();sel.removeAllRanges();sel.addRange(rng);
                document.execCommand('insertText',false,newText);
                done=true;
              }
            }
          }
        }catch(e){}
        // 2. Try window.find for non-editable content (read-only pages)
        if(!done&&orig&&window.find){
          try{
            p.style.visibility='hidden';
            if(window.find(orig,false,false,false,false,false,false)){
              var sel=window.getSelection();
              if(sel&&!sel.isCollapsed){
                var rng=sel.getRangeAt(0);
                var parent=rng.commonAncestorContainer;
                var editable=false;
                var check=parent;
                while(check){
                  if(check.isContentEditable||check.tagName==='TEXTAREA'||check.tagName==='INPUT'){editable=true;break;}
                  check=check.parentElement;
                }
                if(editable){
                  document.execCommand('insertText',false,newText);
                  done=true;
                }else{
                  rng.deleteContents();
                  rng.insertNode(document.createTextNode(newText));
                  sel.removeAllRanges();
                  done=true;
                }
              }
            }
            p.style.visibility='visible';
          }catch(e){p.style.visibility='visible';}
        }
        // 3. TreeWalker fallback on entire document body
        if(!done&&orig){
          try{
            var tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);
            var nd;
            while(nd=tw.nextNode()){
              var idx=nd.textContent.indexOf(orig);
              if(idx>=0){
                var before=nd.textContent.substring(0,idx);
                var after=nd.textContent.substring(idx+orig.length);
                nd.textContent=before+newText+after;
                done=true;break;
              }
            }
          }catch(e){}
        }
        if(!done){rb.textContent='${cmL('ai.not_found', 'Not found')}';rb.disabled=true;}
        else{p.style.display='none';}
      };`
    : `p.style.display='none';`}
  })();void 0;`;
  wc.executeJavaScript(js).catch(() => {});
}

// Get AI provider config — prefer secure secret storage, fallback to toolbar localStorage
let cachedAiConfig = null;
async function getAiConfig() {
  // Try reading from secure secret storage first
  try {
    const providerResult = await rustBridge.call('secret.get', { key: 'ai_provider' });
    const provider = (providerResult && providerResult.value) || 'openai';
    const keyResult = await rustBridge.call('secret.get', { key: 'ai_key_' + provider });
    const modelResult = await rustBridge.call('secret.get', { key: 'ai_model_' + provider });
    if (keyResult && keyResult.value) {
      cachedAiConfig = { provider, apiKey: keyResult.value, model: (modelResult && modelResult.value) || '' };
      return cachedAiConfig;
    }
  } catch { /* secret store not available, fallback */ }

  // Fallback: read from toolbar localStorage (for backward compatibility)
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    try {
      const result = await toolbarView.webContents.executeJavaScript(`
        JSON.stringify({
          provider: localStorage.getItem('ai_provider') || 'openai',
          apiKey: localStorage.getItem('ai_key_' + (localStorage.getItem('ai_provider') || 'openai')) || '',
          model: localStorage.getItem('ai_model_' + (localStorage.getItem('ai_provider') || 'openai')) || ''
        })
      `);
      const config = JSON.parse(result);
      if (config.apiKey) { cachedAiConfig = config; return config; }
    } catch {}
  }
  return cachedAiConfig;
}

const aiChatHistories = new Map(); // sessionId -> messages[]

ipcMain.handle('ai-chat', async (_e, { provider, apiKey, message, sessionId, model }) => {
  if (!sessionId) sessionId = 'default';
  if (!aiChatHistories.has(sessionId)) aiChatHistories.set(sessionId, []);
  const history = aiChatHistories.get(sessionId);
  history.push({ role: 'user', content: message });

  const endpoints = {
    openai: 'https://api.openai.com/v1/chat/completions',
    anthropic: 'https://api.anthropic.com/v1/messages',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions',
    deepseek: 'https://api.deepseek.com/v1/chat/completions',
  };
  const url = endpoints[provider];
  if (!url) return { error: 'Unknown provider' };

  try {
    let assistantText;
    if (provider === 'anthropic') {
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: model || 'claude-sonnet-4-20250514', max_tokens: 2048, messages: history }),
      });
      if (!res.ok) { const e = await res.text(); return { error: e }; }
      const data = await res.json();
      assistantText = data.content?.[0]?.text || 'No response';
    } else {
      const defaultModels = { openai: 'gpt-4o-mini', deepseek: 'deepseek-chat', openrouter: 'openai/gpt-4o-mini' };
      const res = await net.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({ model: model || defaultModels[provider] || 'gpt-4o-mini', messages: history, max_tokens: 2048 }),
      });
      if (!res.ok) { const e = await res.text(); return { error: e }; }
      const data = await res.json();
      assistantText = data.choices?.[0]?.message?.content || 'No response';
    }
    history.push({ role: 'assistant', content: assistantText });
    return { text: assistantText };
  } catch (err) {
    return { error: err.message || 'Network error' };
  }
});

ipcMain.on('ai-clear-history', (_e, sessionId) => {
  aiChatHistories.delete(sessionId || 'default');
});

// ─── Password Manager ───

ipcMain.handle('password-unlock', async (_e, { masterPassword }) => {
  try { return await rustBridge.call('password.unlock', { master_password: masterPassword }); }
  catch (err) { return { error: err.message || String(err) }; }
});

ipcMain.handle('password-lock', async () => {
  try { return await rustBridge.call('password.lock', {}); }
  catch (err) { return { error: err.message || String(err) }; }
});

ipcMain.handle('password-is-unlocked', async () => {
  try { return await rustBridge.call('password.is_unlocked', {}); }
  catch (err) { return { error: err.message || String(err) }; }
});

ipcMain.handle('password-list', async (_e, { url }) => {
  try { return await rustBridge.call('password.list', { url: url || '' }); }
  catch (err) { return { error: err.message || String(err) }; }
});

ipcMain.handle('password-save', async (_e, { url, username, password }) => {
  try { return await rustBridge.call('password.save', { url, username, password }); }
  catch (err) { return { error: err.message || String(err) }; }
});

ipcMain.handle('password-update', async (_e, { id, username, password }) => {
  try { return await rustBridge.call('password.update', { id, username, password }); }
  catch (err) { return { error: err.message || String(err) }; }
});

ipcMain.handle('password-delete', async (_e, { id }) => {
  try { return await rustBridge.call('password.delete', { id }); }
  catch (err) { return { error: err.message || String(err) }; }
});

ipcMain.handle('password-generate', async (_e, opts) => {
  try { return await rustBridge.call('password.generate', opts || {}); }
  catch (err) { return { error: err.message || String(err) }; }
});

ipcMain.on('open-passwords', () => openOrSwitchTab('gb://passwords'));

// ─── CryptoBot Donate ───
// XOR-obfuscated token (deobfuscated only in main process, never sent to renderer)
const _OBF_TOKEN = 'YmRnb2VmbRYWJmY7IzU4EhAWFhUkJDFkDRQyHSRhZjUmbwUlEi00AgA1';
const _OBF_KEY = 0x57;
function _deobfToken(b64, key) {
  try {
    const buf = Buffer.from(b64, 'base64');
    return Array.from(buf).map(b => b ^ key).map(b => String.fromCharCode(b)).join('');
  } catch { return ''; }
}

ipcMain.handle('donate-create-invoice', async (_e, { amount }) => {
  try {
    const token = _deobfToken(_OBF_TOKEN, _OBF_KEY);
    if (!token) return { error: 'Token not configured' };
    const resp = await net.fetch('https://pay.crypt.bot/api/createInvoice', {
      method: 'POST',
      headers: {
        'Crypto-Pay-API-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        currency_type: 'fiat',
        fiat: 'USD',
        accepted_assets: 'USDT,TON,BTC,ETH',
        amount: String(amount),
        description: 'GitBrowser Donation',
        paid_btn_name: 'callback',
        paid_btn_url: 'https://github.com/gothtr/gitbrowser',
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { error: 'API error: ' + (resp.status || '') + ' ' + text.slice(0, 200) };
    }
    const text = await resp.text();
    if (!text) return { error: 'Empty response from API' };
    let data;
    try { data = JSON.parse(text); } catch { return { error: 'Invalid response from API' }; }
    if (data && data.ok && data.result) {
      return { bot_invoice_url: data.result.bot_invoice_url || data.result.mini_app_invoice_url };
    }
    return { error: (data && data.error && data.error.message) || 'Failed to create invoice' };
  } catch (err) {
    return { error: err.message || 'Network error' };
  }
});

// ─── Clear data handlers ───
ipcMain.handle('clear-cache', async () => {
  try {
    await session.defaultSession.clearCache();
    return { ok: true };
  } catch { return { error: 'Failed' }; }
});

ipcMain.handle('clear-cookies', async () => {
  try {
    await session.defaultSession.clearStorageData({ storages: ['cookies'] });
    return { ok: true };
  } catch { return { error: 'Failed' }; }
});

// Extensions
ipcMain.handle('extension-list', async () => {
  try { return await rustBridge.call('extension.list', {}); }
  catch (err) { return []; }
});
ipcMain.handle('extension-install', async (_e, { path: extPath }) => {
  try { return await rustBridge.call('extension.install', { path: extPath }); }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('extension-uninstall', async (_e, { id }) => {
  try { return await rustBridge.call('extension.uninstall', { id }); }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('extension-enable', async (_e, { id }) => {
  try { return await rustBridge.call('extension.enable', { id }); }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('extension-disable', async (_e, { id }) => {
  try { return await rustBridge.call('extension.disable', { id }); }
  catch (err) { return { error: err.message }; }
});
ipcMain.on('open-extensions', () => openOrSwitchTab('gb://extensions'));

// Extension file picker dialog (replaces prompt())
ipcMain.handle('extension-select-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Extension Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { path: result.filePaths[0] };
});

// ─── GitHub Device Flow OAuth ───

let githubToken = null;

// Try to restore token from Rust backend on startup
(async () => {
  try {
    const res = await rustBridge.call('github.get_token', {});
    if (res && res.token) githubToken = res.token;
  } catch { /* no stored token */ }
})();

ipcMain.handle('github-device-login', async (_e, { clientId }) => {
  try {
    const codeRes = await net.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: clientId, scope: 'repo read:user notifications' }),
    });
    const codeData = await codeRes.json();
    if (!codeRes.ok || codeData.error) {
      return { error: codeData.error_description || codeData.error || ('HTTP ' + codeRes.status) };
    }
    return {
      userCode: codeData.user_code,
      verificationUri: codeData.verification_uri,
      deviceCode: codeData.device_code,
      interval: codeData.interval || 5,
      expiresIn: codeData.expires_in || 900,
    };
  } catch (err) {
    return { error: err.message || 'Network error' };
  }
});

// ─── GitHub notification badge polling ───
let ghNotifInterval = null;

async function pollGhNotifications() {
  if (!githubToken) return;
  try {
    const res = await net.fetch('https://api.github.com/notifications?per_page=50', {
      headers: { 'Authorization': 'Bearer ' + githubToken, 'Accept': 'application/vnd.github+json' },
    });
    if (res.ok) {
      const data = await res.json();
      const count = Array.isArray(data) ? data.length : 0;
      sendToToolbar('gh-notif-count', { count });
    }
  } catch { /* ignore */ }
}

function startGhNotifPolling() {
  if (ghNotifInterval) clearInterval(ghNotifInterval);
  pollGhNotifications();
  ghNotifInterval = setInterval(pollGhNotifications, 60000);
}

ipcMain.handle('github-device-poll', async (_e, { clientId, deviceCode }) => {
  try {
    const res = await net.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const data = await res.json();
    if (data.access_token) {
      githubToken = data.access_token;
      // Fetch real user profile to get login and avatar
      let login = 'user', avatarUrl = null;
      try {
        const userRes = await net.fetch('https://api.github.com/user', {
          headers: { 'Authorization': 'Bearer ' + data.access_token, 'Accept': 'application/vnd.github+json' },
        });
        if (userRes.ok) {
          const userData = await userRes.json();
          login = userData.login || 'user';
          avatarUrl = userData.avatar_url || null;
        }
      } catch { /* use defaults */ }
      // Store token securely in Rust backend
      rustBridge.call('github.store_token', { token: data.access_token, login, avatar_url: avatarUrl }).catch(() => {});
      startGhNotifPolling();
      return { status: 'ok', token: data.access_token };
    }
    if (data.error === 'authorization_pending') return { status: 'pending' };
    if (data.error === 'slow_down') return { status: 'slow_down' };
    if (data.error === 'expired_token') return { status: 'expired' };
    return { status: 'error', error: data.error_description || data.error };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
});

ipcMain.handle('github-api', async (_e, { endpoint, token, method, body }) => {
  try {
    const opts = {
      method: method || 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await net.fetch('https://api.github.com' + endpoint, opts);
    if (!res.ok) return { error: res.status + ' ' + res.statusText };
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
});

// Secure secret storage (API keys, etc.)
ipcMain.handle('secret-store', async (_e, { key, value }) => {
  try { return await rustBridge.call('secret.store', { key, value }); }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('secret-get', async (_e, { key }) => {
  try { return await rustBridge.call('secret.get', { key }); }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('secret-delete', async (_e, { key }) => {
  try { return await rustBridge.call('secret.delete', { key }); }
  catch (err) { return { error: err.message }; }
});

// GitHub bookmark sync via Gists
ipcMain.handle('github-sync-bookmarks-upload', async (_e, { token }) => {
  try {
    // Get bookmarks from Rust
    const bookmarks = await rustBridge.call('bookmark.list', {});
    const data = JSON.stringify(bookmarks);
    // Encrypt via Rust
    const encrypted = await rustBridge.call('github.encrypt_sync', { data });
    const content = JSON.stringify(encrypted);
    // Check if sync gist already exists
    const gistsRes = await net.fetch('https://api.github.com/gists', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
    });
    const gists = await gistsRes.json();
    const syncGist = Array.isArray(gists) ? gists.find(g => g.description === 'GitBrowser Bookmark Sync') : null;
    const gistPayload = {
      description: 'GitBrowser Bookmark Sync',
      public: false,
      files: { 'bookmarks.enc.json': { content } },
    };
    if (syncGist) {
      // Update existing gist
      await net.fetch('https://api.github.com/gists/' + syncGist.id, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(gistPayload),
      });
    } else {
      // Create new gist
      await net.fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(gistPayload),
      });
    }
    return { ok: true };
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('github-sync-bookmarks-download', async (_e, { token }) => {
  try {
    const gistsRes = await net.fetch('https://api.github.com/gists', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
    });
    const gists = await gistsRes.json();
    const syncGist = Array.isArray(gists) ? gists.find(g => g.description === 'GitBrowser Bookmark Sync') : null;
    if (!syncGist) return { error: 'no_sync_gist' };
    // Fetch full gist
    const gistRes = await net.fetch('https://api.github.com/gists/' + syncGist.id, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
    });
    const gist = await gistRes.json();
    const file = gist.files && gist.files['bookmarks.enc.json'];
    if (!file || !file.content) return { error: 'no_bookmark_file' };
    const encrypted = JSON.parse(file.content);
    // Decrypt via Rust
    const decrypted = await rustBridge.call('github.decrypt_sync', encrypted);
    const bookmarks = JSON.parse(decrypted.data);
    // Import bookmarks (add missing ones)
    let imported = 0;
    for (const bm of bookmarks) {
      try {
        await rustBridge.call('bookmark.add', { url: bm.url, title: bm.title, folder_id: bm.folder_id || null });
        imported++;
      } catch { /* duplicate or error, skip */ }
    }
    return { ok: true, imported };
  } catch (err) { return { error: err.message }; }
});

// GitHub logout (clear Rust backend token)
ipcMain.handle('github-logout', async () => {
  try {
    githubToken = null;
    if (ghNotifInterval) { clearInterval(ghNotifInterval); ghNotifInterval = null; }
    await rustBridge.call('github.logout', {});
    return { ok: true };
  } catch (err) { return { error: err.message }; }
});

// ─── Page context menu actions (IPC from injected glass menu) ───
ipcMain.on('ctx-menu-action', (_e, action, data) => {
  const wc = _pageCtxWc;
  const params = _pageCtxParams;
  if (!wc || wc.isDestroyed()) return;
  try {
    if (action === 'copy') wc.copy();
    else if (action === 'cut') wc.cut();
    else if (action === 'paste') wc.paste();
    else if (action === 'selectAll') wc.selectAll();
    else if (action === 'openLink' && data) createTab(data);
    else if (action === 'copyLink' && data) clipboard.writeText(data);
    else if (action === 'saveImage' && data) wc.downloadURL(data);
    else if (action === 'copyImageUrl' && data) clipboard.writeText(data);
    else if (action === 'openImageTab' && data) createTab(data);
    else if (action === 'inspect' && params) wc.inspectElement(params.x, params.y);
    else if (action === 'ai' && data) {
      try {
        const aiData = JSON.parse(data);
        runAiAction(wc, aiData.type, aiData.text);
      } catch {}
    }
  } catch {}
});

// Tab context menu
ipcMain.on('tab-context-menu', (_e, id, clientX, clientY) => {
  if (!activeTabId || !tabs.has(activeTabId)) return;
  const tabView = tabs.get(activeTabId).view;
  const tabBounds = tabView.getBounds();

  const sw = sidebarCollapsed ? 48 : SIDEBAR_WIDTH;
  const sidebarBounds = sidebarView ? sidebarView.getBounds() : { x: 0, y: 0 };

  const isMuted = tabs.has(id) && tabs.get(id).view.webContents.isAudioMuted();
  const muteLabel = isMuted ? cmL('tabs.unmute', 'Включить звук') : cmL('tabs.mute', 'Выключить звук');

  const items = [
    { label: cmL('tabs.new_tab', 'Новая вкладка'), action: 'new_tab' },
    { type: 'separator' },
    { label: cmL('tabs.reload', 'Перезагрузить'), action: 'reload' },
    { label: cmL('tabs.duplicate', 'Дублировать'), action: 'duplicate' },
    { type: 'separator' },
    { label: muteLabel, action: 'mute' },
    { type: 'separator' },
    { label: cmL('tabs.close_tab', 'Закрыть вкладку'), action: 'close' },
    { label: cmL('tabs.close_others', 'Закрыть другие'), action: 'close_others' },
    { label: cmL('tabs.close_right', 'Закрыть вкладки снизу'), action: 'close_right' },
    { type: 'separator' },
    { label: cmL('tabs.reopen_closed', 'Восстановить вкладку'), action: 'reopen', disabled: closedTabsStack.length === 0 },
  ];

  const menuData = JSON.stringify(items);
  // Position: convert sidebar coords to tab view coords
  const globalX = (clientX || 0) + sidebarBounds.x;
  const globalY = (clientY || 0) + sidebarBounds.y;
  const tabLocalX = globalX - tabBounds.x;
  const tabLocalY = globalY - tabBounds.y;

  tabView.webContents.executeJavaScript(`(function(){
    ${CLEAR_ALL_OVERLAYS_JS}
    var style=document.createElement('style');style.id='__gb-ctx-style';
    style.textContent=\`
      #__gb-ctx-ov{position:fixed;inset:0;z-index:2147483646;}
      #__gb-ctx{position:fixed;z-index:2147483647;
        background:rgba(18,22,30,0.92);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);
        border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:4px;min-width:200px;
        box-shadow:0 8px 32px rgba(0,0,0,0.45),0 2px 6px rgba(0,0,0,0.25),inset 0 1px 0 rgba(255,255,255,0.06);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#e2e8f0;
        animation:__gbTcIn 0.12s cubic-bezier(0.16,1,0.3,1);user-select:none;-webkit-user-select:none;}
      @keyframes __gbTcIn{from{opacity:0;transform:scale(0.97)}to{opacity:1;transform:scale(1)}}
      #__gb-ctx .tci{display:flex;align-items:center;padding:6px 10px;border-radius:6px;cursor:default;transition:background 0.08s;}
      #__gb-ctx .tci:hover{background:rgba(255,255,255,0.07);}
      #__gb-ctx .tci.disabled{opacity:0.35;pointer-events:none;}
      #__gb-ctx .tci-sep{height:1px;background:rgba(255,255,255,0.06);margin:3px 6px;}
      html.light #__gb-ctx{background:rgba(255,255,255,0.94);border-color:rgba(0,0,0,0.1);color:#1e293b;box-shadow:0 8px 32px rgba(0,0,0,0.1),0 2px 6px rgba(0,0,0,0.05);}
      html.light #__gb-ctx .tci:hover{background:rgba(0,0,0,0.05);}
      html.light #__gb-ctx .tci-sep{background:rgba(0,0,0,0.07);}
    \`;
    document.documentElement.appendChild(style);
    function closeMenu(){
      var a=document.getElementById('__gb-ctx-ov');if(a)a.remove();
      var b=document.getElementById('__gb-ctx');if(b)b.remove();
      var c=document.getElementById('__gb-ctx-style');if(c)c.remove();
    }
    var ov=document.createElement('div');ov.id='__gb-ctx-ov';
    ov.onclick=function(){closeMenu();};
    ov.oncontextmenu=function(e){e.preventDefault();closeMenu();};
    document.documentElement.appendChild(ov);
    var menu=document.createElement('div');menu.id='__gb-ctx';
    var items=${menuData};
    items.forEach(function(it){
      if(it.type==='separator'){var s=document.createElement('div');s.className='tci-sep';menu.appendChild(s);return;}
      var d=document.createElement('div');d.className='tci'+(it.disabled?' disabled':'');
      d.textContent=it.label;
      d.onclick=function(){closeMenu();console.log('__gb_tab_ctx:'+JSON.stringify({action:it.action}));};
      menu.appendChild(d);
    });
    document.documentElement.appendChild(menu);
    var mx=${tabLocalX},my=${tabLocalY};
    var r=menu.getBoundingClientRect();
    if(mx+r.width>window.innerWidth)mx=window.innerWidth-r.width-8;
    if(my+r.height>window.innerHeight)my=window.innerHeight-r.height-8;
    if(mx<4)mx=4;if(my<4)my=4;
    menu.style.left=mx+'px';menu.style.top=my+'px';
  })();`);

  const tabCtxHandler = (event) => {
    const message = event.message;
    if (!message || !message.startsWith('__gb_tab_ctx:')) return;
    tabView.webContents.removeListener('console-message', tabCtxHandler);
    try {
      const { action } = JSON.parse(message.replace('__gb_tab_ctx:', ''));
      if (action === 'new_tab') createTab('gb://newtab');
      else if (action === 'reload') { if (tabs.has(id)) tabs.get(id).view.webContents.reload(); }
      else if (action === 'duplicate') { if (tabs.has(id)) createTab(tabs.get(id).url); }
      else if (action === 'mute') { if (tabs.has(id)) { const wc2 = tabs.get(id).view.webContents; wc2.setAudioMuted(!wc2.isAudioMuted()); } }
      else if (action === 'close') closeTab(id);
      else if (action === 'close_others') { tabOrder.filter(tid => tid !== id).forEach(tid => closeTab(tid)); }
      else if (action === 'close_right') { const idx = tabOrder.indexOf(id); if (idx >= 0) tabOrder.slice(idx + 1).forEach(tid => closeTab(tid)); }
      else if (action === 'reopen') { if (closedTabsStack.length > 0) { const { url } = closedTabsStack.pop(); createTab(url); } }
    } catch {}
  };
  tabView.webContents.on('console-message', tabCtxHandler);
  setTimeout(() => { try { tabView.webContents.removeListener('console-message', tabCtxHandler); } catch {} }, 10000);
});

// ─── Helpers ───

// Password autofill injection for external pages
async function injectPasswordAutofill(wc, pageUrl) {
  try {
    // Check if password manager is unlocked and has credentials for this URL
    const unlocked = await rustBridge.call('password.is_unlocked', {});
    if (!unlocked || !unlocked.unlocked) return;
    const creds = await rustBridge.call('password.list', { url: pageUrl });
    if (!Array.isArray(creds) || creds.length === 0) return;
    // Inject autofill script
    const credsJson = JSON.stringify(creds.map(c => ({ username: c.username, password: c.password })));
    wc.executeJavaScript(`
      (function() {
        if (window.__gbAutofillInjected) return;
        window.__gbAutofillInjected = true;
        const creds = ${credsJson};
        const pwFields = document.querySelectorAll('input[type="password"]');
        if (pwFields.length === 0) return;
        pwFields.forEach(pwField => {
          const form = pwField.closest('form') || pwField.parentElement;
          const userField = form ? form.querySelector('input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], input[name*="email"], input[autocomplete="username"]') : null;
          // Create autofill button
          const btn = document.createElement('div');
          btn.style.cssText = 'position:absolute;width:20px;height:20px;cursor:pointer;z-index:999999;display:flex;align-items:center;justify-content:center;border-radius:4px;background:#1f6feb;color:#fff;font-size:11px;font-weight:700;';
          btn.textContent = '🔑';
          btn.title = 'GitBrowser Autofill';
          const rect = pwField.getBoundingClientRect();
          btn.style.top = (window.scrollY + rect.top + (rect.height - 20) / 2) + 'px';
          btn.style.left = (window.scrollX + rect.right - 24) + 'px';
          document.body.appendChild(btn);
          // Dropdown
          btn.onclick = (e) => {
            e.stopPropagation();
            let dd = document.getElementById('__gb_autofill_dd');
            if (dd) { dd.remove(); return; }
            dd = document.createElement('div');
            dd.id = '__gb_autofill_dd';
            dd.style.cssText = 'position:absolute;z-index:1000000;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:4px;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,0.4);';
            dd.style.top = (window.scrollY + rect.bottom + 4) + 'px';
            dd.style.left = (window.scrollX + rect.left) + 'px';
            creds.forEach(c => {
              const item = document.createElement('div');
              item.style.cssText = 'padding:8px 12px;cursor:pointer;border-radius:4px;color:#e6edf3;font-size:13px;font-family:system-ui;';
              item.textContent = c.username;
              item.onmouseenter = () => item.style.background = '#1c2128';
              item.onmouseleave = () => item.style.background = 'transparent';
              item.onclick = () => {
                if (userField) { userField.value = c.username; userField.dispatchEvent(new Event('input', {bubbles:true})); }
                pwField.value = c.password; pwField.dispatchEvent(new Event('input', {bubbles:true}));
                dd.remove();
              };
              dd.appendChild(item);
            });
            document.body.appendChild(dd);
            document.addEventListener('click', () => { if (dd.parentNode) dd.remove(); }, { once: true });
          };
        });
      })();
    `).catch(() => {});
  } catch { /* password manager not available */ }
}

// Detect form submissions to offer saving passwords
function setupPasswordSaveDetection(wc, pageUrl) {
  wc.executeJavaScript(`
    (function() {
      if (window.__gbSaveDetected) return;
      window.__gbSaveDetected = true;
      document.addEventListener('submit', function(e) {
        const form = e.target;
        const pw = form.querySelector('input[type="password"]');
        if (!pw || !pw.value) return;
        const user = form.querySelector('input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], input[name*="email"]');
        const data = JSON.stringify({ url: location.href, username: user ? user.value : '', password: pw.value });
        document.title = '__gb_save_password:' + data;
      }, true);
    })();
  `).catch(() => {});
}

async function injectContentScripts(wc, pageUrl, runAt) {
  try {
    const scripts = await rustBridge.call('extension.content_scripts', { url: pageUrl });
    if (!Array.isArray(scripts) || scripts.length === 0) return;
    const targetRunAt = runAt || 'document_idle';
    for (const script of scripts) {
      if (script.run_at !== targetRunAt) continue;
      // Inject CSS
      if (script.css && script.css.length > 0) {
        for (const cssCode of script.css) {
          wc.insertCSS(cssCode).catch(() => {});
        }
      }
      // Inject JS
      if (script.js && script.js.length > 0) {
        for (const jsCode of script.js) {
          wc.executeJavaScript(`(function() { ${jsCode} })();`).catch(() => {});
        }
      }
    }
  } catch {}
}

function normalizeUrl(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return 'gb://newtab';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.startsWith('gb://')) return trimmed;
  if (trimmed.includes('.') && !trimmed.includes(' ')) return 'https://' + trimmed;
  return 'https://www.google.com/search?q=' + encodeURIComponent(trimmed);
}

// ─── App lifecycle ───

// ─── Theme management ───

function resolveTheme(theme) {
  if (theme === 'System') return nativeTheme.shouldUseDarkColors ? 'Dark' : 'Light';
  return theme || 'Dark';
}

function broadcastTheme(theme) {
  currentTheme = theme;
  const resolved = resolveTheme(theme);
  // Send to toolbar and sidebar
  sendToToolbar('theme-changed', { theme: resolved });
  // Send to all tab views
  for (const [, tabData] of tabs) {
    if (!tabData.view.webContents.isDestroyed()) {
      tabData.view.webContents.send('theme-changed', { theme: resolved });
    }
  }
}

async function loadInitialTheme() {
  try {
    const settings = await rustBridge.call('settings.get', {});
    if (settings && settings.appearance && settings.appearance.theme) {
      currentTheme = settings.appearance.theme;
    }
  } catch {}
  broadcastTheme(currentTheme);
}

app.whenReady().then(async () => {
  rustBridge.start();
  // Load locale before creating window so context menu and titles are localized from the start
  await loadContextMenuLocale();
  createWindow();
  // Load theme after window is ready
  setTimeout(() => { loadInitialTheme(); }, 500);

  // Listen for OS theme changes (for System mode)
  nativeTheme.on('updated', () => {
    if (currentTheme === 'System') {
      broadcastTheme('System');
    }
  });
});

app.on('window-all-closed', () => {
  saveSession();
  rustBridge.stop();
  app.quit();
});
