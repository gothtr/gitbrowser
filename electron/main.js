const { app, BaseWindow, WebContentsView, ipcMain, session, Menu, nativeTheme, net, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const rustBridge = require('./rust-bridge');

let currentTheme = 'Dark'; // Track current theme

let mainWindow = null;
let toolbarView = null;
const tabs = new Map();
let tabOrder = [];
let activeTabId = null;
let nextTabId = 1;
const TOOLBAR_HEIGHT = 74;
const downloads = new Map();
let nextDownloadId = 1;
const closedTabsStack = []; // Stack for reopening closed tabs (Ctrl+Shift+T)
const MAX_CLOSED_TABS = 20;

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
    backgroundColor: '#0d1117',
    minWidth: 800, minHeight: 600,
  });

  toolbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.contentView.addChildView(toolbarView);
  toolbarView.webContents.loadFile(path.join(__dirname, 'ui', 'toolbar.html'));

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
  if (toolbarView) toolbarView.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_HEIGHT });
  if (activeTabId && tabs.has(activeTabId)) {
    tabs.get(activeTabId).view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: h - TOOLBAR_HEIGHT });
  }
}

// ─── Tab management ───

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
  view.webContents.on('context-menu', (_e, params) => {
    buildPageContextMenu(view.webContents, params);
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
    const url = t.view.webContents.getURL() || t.url;
    let title = t.title || 'New Tab';
    // Override titles for internal pages
    for (const [gbUrl, _] of Object.entries(INTERNAL_PAGES)) {
      const page = INTERNAL_PAGES[gbUrl];
      if (url.includes(page)) { title = getInternalTitle(gbUrl) || title; break; }
    }
    return { id, title, url, favicon: t.favicon || null };
  }).filter(Boolean);
  sendToToolbar('tabs-update', { tabs: data, activeId: activeTabId });
}

function sendToToolbar(channel, data) {
  if (toolbarView && !toolbarView.webContents.isDestroyed()) {
    toolbarView.webContents.send(channel, data);
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
      sendToToolbar('toast', { message: cmL('downloads.completed', 'Downloaded') + ': ' + dl.filename });
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
      try { fs.writeFileSync(path.join(__dirname, '..', 'session.json'), JSON.stringify(encrypted), 'utf8'); } catch {}
    }).catch(() => {
      // Fallback: save unencrypted if encryption fails
      try { fs.writeFileSync(path.join(__dirname, '..', 'session.json'), jsonStr, 'utf8'); } catch {}
    });
  } catch {}
}

async function restoreSession() {
  try {
    let result = await rustBridge.call('session.restore', {});
    // Fallback to local file
    if (!Array.isArray(result) || result.length === 0) {
      try {
        const raw = fs.readFileSync(path.join(__dirname, '..', 'session.json'), 'utf8');
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

// Private mode
ipcMain.on('open-private-window', () => {
  const privWin = new BaseWindow({
    width: 1100, height: 700, title: 'GitBrowser — Private',
    backgroundColor: '#1a0a2e', minWidth: 600, minHeight: 400,
  });
  const privToolbar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  privWin.contentView.addChildView(privToolbar);
  privToolbar.webContents.loadFile(path.join(__dirname, 'ui', 'toolbar.html'));

  // Private window tab management
  const privTabs = new Map();
  let privTabOrder = [];
  let privActiveTabId = null;
  let privNextTabId = 1;

  function privCreateTab(url, activate = true) {
    const id = 'priv-tab-' + (privNextTabId++);
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, partition: 'private' },
    });
    const tabData = { view, url: url || 'gb://newtab', title: 'New Tab' };
    privTabs.set(id, tabData);
    privTabOrder.push(id);

    view.webContents.on('page-title-updated', (_e, title) => {
      if (title.startsWith('__gb_navigate:')) {
        const navUrl = normalizeUrl(title.substring('__gb_navigate:'.length));
        tabData.url = navUrl;
        if (navUrl.startsWith('http://') || navUrl.startsWith('https://')) view.webContents.loadURL(navUrl);
        return;
      }
      if (title.startsWith('__gb_newtab:')) { privCreateTab(title.substring('__gb_newtab:'.length)); return; }
      tabData.title = title;
      privSendTabsUpdate();
    });
    view.webContents.on('did-navigate', (_e, navUrl) => {
      tabData.url = navUrl;
      privToolbar.webContents.send('tab-url-updated', { id, url: navUrl });
      privSendTabsUpdate();
    });
    view.webContents.on('did-start-loading', () => privToolbar.webContents.send('tab-loading', { id, loading: true }));
    view.webContents.on('did-stop-loading', () => privToolbar.webContents.send('tab-loading', { id, loading: false }));
    view.webContents.on('page-favicon-updated', (_e, favicons) => {
      if (favicons && favicons.length > 0) { tabData.favicon = favicons[0]; privSendTabsUpdate(); }
    });
    view.webContents.setWindowOpenHandler(({ url: newUrl }) => {
      if (newUrl && (newUrl.startsWith('http://') || newUrl.startsWith('https://'))) privCreateTab(newUrl);
      return { action: 'deny' };
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
    if (!privTabs.has(id)) return;
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
    if (!privTabs.has(id)) return;
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
    const list = privTabOrder.map(tid => {
      if (!privTabs.has(tid)) return null;
      const t = privTabs.get(tid);
      return { id: tid, title: t.title, url: t.url, active: tid === privActiveTabId, favicon: t.favicon };
    }).filter(Boolean);
    privToolbar.webContents.send('tabs-update', list);
  }

  function layoutPriv() {
    const { width: w, height: h } = privWin.getContentBounds();
    privToolbar.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_HEIGHT });
    if (privActiveTabId && privTabs.has(privActiveTabId)) {
      privTabs.get(privActiveTabId).view.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: h - TOOLBAR_HEIGHT });
    }
  }

  // Handle IPC from private toolbar
  privToolbar.webContents.on('ipc-message', (_e, channel, ...args) => {
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
  });

  privCreateTab('gb://newtab');
  layoutPriv();
  privWin.on('resize', layoutPriv);
  privWin.on('close', () => {
    // Clean up all private tabs
    for (const [, { view }] of privTabs) { try { view.webContents.close(); } catch {} }
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
ipcMain.on('open-settings', () => createTab('gb://settings'));
ipcMain.on('open-bookmarks', () => createTab('gb://bookmarks'));
ipcMain.on('open-history', () => createTab('gb://history'));
ipcMain.on('open-downloads', () => createTab('gb://downloads'));
ipcMain.on('open-ai', () => createTab('gb://ai'));
ipcMain.on('open-github', () => createTab('gb://github'));

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
    const localePath = path.join(__dirname, '..', 'locales', lang + '.json');
    const data = fs.readFileSync(localePath, 'utf8');
    return { locale: lang, data: JSON.parse(data) };
  } catch {
    try {
      const fallback = path.join(__dirname, '..', 'locales', 'en.json');
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
    const localePath = path.join(__dirname, '..', 'locales', lang + '.json');
    const data = fs.readFileSync(localePath, 'utf8');
    cachedLocale = JSON.parse(data);
  } catch {
    try {
      const fallback = path.join(__dirname, '..', 'locales', 'en.json');
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

function buildPageContextMenu(wc, params) {
  const hasSelection = params.selectionText && params.selectionText.trim().length > 0;
  const selText = (params.selectionText || '').trim();
  const isEditable = params.isEditable;

  const template = [];

  // Standard items
  if (hasSelection) {
    template.push({ label: cmL('context_menu.copy', 'Copy'), accelerator: 'CmdOrCtrl+C', click: () => wc.copy() });
  }
  if (isEditable) {
    template.push({ label: cmL('context_menu.cut', 'Cut'), accelerator: 'CmdOrCtrl+X', enabled: hasSelection, click: () => wc.cut() });
    template.push({ label: cmL('context_menu.paste', 'Paste'), accelerator: 'CmdOrCtrl+V', click: () => wc.paste() });
  }
  template.push({ label: cmL('context_menu.select_all', 'Select All'), accelerator: 'CmdOrCtrl+A', click: () => wc.selectAll() });

  // Link actions
  if (params.linkURL) {
    template.push({ type: 'separator' });
    template.push({ label: cmL('context_menu.open_link_new_tab', 'Open Link in New Tab'), click: () => createTab(params.linkURL) });
    template.push({ label: cmL('context_menu.copy_link', 'Copy Link'), click: () => { clipboard.writeText(params.linkURL); } });
  }

  // Image actions — save image from web
  if (params.mediaType === 'image' && params.srcURL) {
    template.push({ type: 'separator' });
    template.push({ label: cmL('context_menu.save_image', 'Save Image As...'), click: () => {
      wc.downloadURL(params.srcURL);
    }});
    template.push({ label: cmL('context_menu.copy_image_url', 'Copy Image URL'), click: () => {
      clipboard.writeText(params.srcURL);
    }});
    template.push({ label: cmL('context_menu.open_image_new_tab', 'Open Image in New Tab'), click: () => {
      createTab(params.srcURL);
    }});
  }

  // AI submenu (only when text is selected)
  if (hasSelection && selText.length >= 2) {
    template.push({ type: 'separator' });
    template.push({
      label: cmL('context_menu.ai', 'AI'),
      submenu: [
        { label: cmL('context_menu.fix_errors', 'Fix Errors'), click: () => runAiAction(wc, 'fix', selText) },
        { label: cmL('context_menu.rephrase', 'Rephrase'), click: () => runAiAction(wc, 'rephrase', selText) },
        { type: 'separator' },
        { label: cmL('context_menu.translate_en', 'Translate to English'), click: () => runAiAction(wc, 'translate_en', selText) },
        { label: cmL('context_menu.translate_ru', 'Translate to Russian'), click: () => runAiAction(wc, 'translate_ru', selText) },
        { type: 'separator' },
        { label: cmL('context_menu.summarize', 'Summarize'), click: () => runAiAction(wc, 'summarize', selText) },
        { label: cmL('context_menu.explain', 'Explain'), click: () => runAiAction(wc, 'explain', selText) },
      ],
    });
  }

  // Inspect element (dev mode)
  if (process.argv.includes('--dev')) {
    template.push({ type: 'separator' });
    template.push({ label: cmL('context_menu.inspect', 'Inspect Element'), click: () => wc.inspectElement(params.x, params.y) });
  }

  const menu = Menu.buildFromTemplate(template);
  menu.popup();
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

// Get AI provider config from toolbar localStorage
let cachedAiConfig = null;
async function getAiConfig() {
  // Read from toolbar (always loaded, shares localStorage with internal pages)
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

ipcMain.on('open-passwords', () => createTab('gb://passwords'));

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
ipcMain.on('open-extensions', () => createTab('gb://extensions'));

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
      // Store token securely in Rust backend
      rustBridge.call('github.store_token', { token: data.access_token, login: 'user', avatar_url: null }).catch(() => {});
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

// Tab context menu
ipcMain.on('tab-context-menu', (_e, id) => {
  const menu = Menu.buildFromTemplate([
    { label: cmL('tabs.new_tab', 'New Tab'), click: () => createTab('gb://newtab') },
    { type: 'separator' },
    { label: cmL('tabs.reload', 'Reload'), click: () => { if (tabs.has(id)) tabs.get(id).view.webContents.reload(); } },
    { label: cmL('tabs.duplicate', 'Duplicate'), click: () => { if (tabs.has(id)) createTab(tabs.get(id).url); } },
    { type: 'separator' },
    { label: cmL('tabs.mute', 'Mute Tab'), click: () => {
      if (tabs.has(id)) {
        const wc = tabs.get(id).view.webContents;
        wc.setAudioMuted(!wc.isAudioMuted());
      }
    }},
    { type: 'separator' },
    { label: cmL('tabs.close_tab', 'Close Tab'), click: () => closeTab(id) },
    { label: cmL('tabs.close_others', 'Close Other Tabs'), click: () => { tabOrder.filter(tid => tid !== id).forEach(tid => closeTab(tid)); } },
    { label: cmL('tabs.close_right', 'Close Tabs to the Right'), click: () => {
      const idx = tabOrder.indexOf(id);
      if (idx >= 0) tabOrder.slice(idx + 1).forEach(tid => closeTab(tid));
    }},
    { type: 'separator' },
    { label: cmL('tabs.reopen_closed', 'Reopen Closed Tab'), accelerator: 'CmdOrCtrl+Shift+T', enabled: closedTabsStack.length > 0, click: () => {
      if (closedTabsStack.length > 0) { const { url } = closedTabsStack.pop(); createTab(url); }
    }},
  ]);
  menu.popup();
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
  // Send to toolbar
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
