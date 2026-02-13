const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, session, Menu, nativeTheme, net, clipboard, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rustBridge = require('./rust-bridge');

const APP_VERSION = require('./package.json').version;

// SEC-06: Generate a unique token per context menu invocation to prevent spoofing via console.log
function generateCtxToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Disable Autofill CDP errors from DevTools
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication,AutofillEnableAccountWalletStorage');

// Fix GPU cache errors on Windows (cache locked by previous instance)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('gpu-disk-cache-size-kb', '0');

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
let currentSearchEngine = 'google'; // Track current search engine

// ─── Multi-window architecture ───
// Each browser window (normal or private) is a WindowContext.
// Global registry maps window IDs and webContents IDs to their context.
const TOOLBAR_HEIGHT = 48;
const SIDEBAR_WIDTH = 240;
const MAX_CLOSED_TABS = 20;

const windowRegistry = new Map(); // windowId -> WindowContext
const wcToWindow = new Map(); // webContents.id -> WindowContext (for IPC routing)
let primaryWindowCtx = null; // The first/main window context
let globalNextTabId = 1;

class WindowContext {
  constructor({ isPrivate = false, partition = null } = {}) {
    this.id = 'win-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    this.isPrivate = isPrivate;
    this.partition = partition || null;
    this.baseWindow = null;
    this.toolbarView = null;
    this.sidebarView = null; // null for private windows
    this.tabs = new Map();
    this.tabOrder = [];
    this.activeTabId = null;
    this.sidebarCollapsed = false;
    this.isHtmlFullscreen = false;
    this.closedTabsStack = [];
    this.closing = false;
  }
}

// Resolve which WindowContext owns a given webContents (toolbar, sidebar, or tab)
function getWindowCtx(sender) {
  if (!sender) return primaryWindowCtx;
  const wcId = sender.id;
  if (wcToWindow.has(wcId)) return wcToWindow.get(wcId);
  // Fallback: search all windows
  for (const ctx of windowRegistry.values()) {
    if (ctx.toolbarView && ctx.toolbarView.webContents.id === wcId) { wcToWindow.set(wcId, ctx); return ctx; }
    if (ctx.sidebarView && ctx.sidebarView.webContents.id === wcId) { wcToWindow.set(wcId, ctx); return ctx; }
    for (const [, tab] of ctx.tabs) {
      if (tab.view.webContents.id === wcId) { wcToWindow.set(wcId, ctx); return ctx; }
    }
  }
  return primaryWindowCtx;
}

// Convenience: get the "current" main window and its state (for backward compat in global handlers)
function getMainWindow() { return primaryWindowCtx ? primaryWindowCtx.baseWindow : null; }

// Legacy aliases — these point to the primary window context for code that hasn't been refactored
// They are getter-based so they always reflect the current primary context
Object.defineProperty(global, '__gbPrimaryCtx', { get: () => primaryWindowCtx });

const downloads = new Map();
let nextDownloadId = 1;

// ─── Picture-in-Picture state ───
let pipView = null; // WebContentsView for PiP overlay
let pipSourceTabId = null; // Which tab the PiP video came from
let pipBounds = { x: 0, y: 0, width: 320, height: 180 }; // Default PiP position (bottom-right, set in layoutViews)

// ─── Telegram Widget state ───
let telegramWin = null;   // BrowserWindow (child, transparent, rounded)
let telegramView = null;  // kept for compat — points to telegramWin
let telegramVisible = false;
let telegramBounds = { x: 0, y: 0, width: 380, height: 520 };

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

// Create a new browser window (normal or private)
function createBrowserWindow({ isPrivate = false, showImmediately = true } = {}) {
  const partition = isPrivate ? ('private-' + Date.now()) : null;
  const ctx = new WindowContext({ isPrivate, partition });

  ctx.baseWindow = new BaseWindow({
    width: isPrivate ? 1100 : 1280,
    height: isPrivate ? 700 : 800,
    title: isPrivate ? 'GitBrowser — Private' : 'GitBrowser',
    backgroundColor: isPrivate ? '#1a0a2e' : '#0a0e14',
    icon: resolvePath('resources', 'icons', 'app.ico'),
    minWidth: isPrivate ? 600 : 800,
    minHeight: isPrivate ? 400 : 600,
    frame: false,
    show: showImmediately,
  });

  // Sidebar (only for normal windows)
  if (!isPrivate) {
    ctx.sidebarView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    ctx.baseWindow.contentView.addChildView(ctx.sidebarView);
    ctx.sidebarView.webContents.loadFile(path.join(__dirname, 'ui', 'sidebar.html'));
    wcToWindow.set(ctx.sidebarView.webContents.id, ctx);

    ctx.sidebarView.webContents.on('context-menu', (e) => {
      e.preventDefault();
      // Custom context menu handled inside sidebar.html
    });
  }

  // Toolbar
  ctx.toolbarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  ctx.baseWindow.contentView.addChildView(ctx.toolbarView);
  ctx.toolbarView.webContents.loadFile(path.join(__dirname, 'ui', 'toolbar.html'));
  wcToWindow.set(ctx.toolbarView.webContents.id, ctx);

  // Custom glass context menu for toolbar via overlay view
  ctx.toolbarView.webContents.on('context-menu', (e, params) => {
    e.preventDefault();
    const sw = ctx.sidebarView ? (ctx.sidebarCollapsed ? 48 : SIDEBAR_WIDTH) : 0;
    showOverlayContextMenu(ctx, ctx.toolbarView.webContents, params, sw, 0);
  });

  // Register in global registry
  windowRegistry.set(ctx.id, ctx);

  // Layout
  layoutViews(ctx);
  ctx.baseWindow.on('resize', () => layoutViews(ctx));

  // Window close handler
  ctx.baseWindow.on('close', () => {
    ctx.closing = true;
    // Save session only for primary (non-private) window
    if (!isPrivate && ctx === primaryWindowCtx) {
      saveSession(ctx);
    }
    // Clean up all tabs
    for (const [, { view }] of ctx.tabs) {
      try { if (!view.webContents.isDestroyed()) { view.webContents.removeAllListeners(); view.webContents.close(); } } catch {}
    }
    ctx.tabs.clear();
    ctx.tabOrder = [];
    // Unregister webContents mappings
    if (ctx.toolbarView) wcToWindow.delete(ctx.toolbarView.webContents.id);
    if (ctx.sidebarView) wcToWindow.delete(ctx.sidebarView.webContents.id);
    // Remove from registry
    windowRegistry.delete(ctx.id);
    // If this was the primary window, promote another normal window or null out
    if (ctx === primaryWindowCtx) {
      primaryWindowCtx = null;
      for (const otherCtx of windowRegistry.values()) {
        if (!otherCtx.isPrivate) { primaryWindowCtx = otherCtx; break; }
      }
    }
    // Destroy telegram child window if closing primary
    if (!isPrivate && telegramWin && !telegramWin.isDestroyed()) {
      telegramWin.removeAllListeners('close');
      telegramWin.destroy();
      telegramWin = null;
    }
  });

  if (process.argv.includes('--dev') && !isPrivate) {
    ctx.toolbarView.webContents.openDevTools({ mode: 'detach' });
  }

  // Notify toolbar that this is a private window (for UI styling)
  if (isPrivate) {
    ctx.toolbarView.webContents.on('did-finish-load', () => {
      ctx.toolbarView.webContents.send('private-mode', { isPrivate: true });
    });
  }

  return ctx;
}

function createWindow() {
  const ctx = createBrowserWindow({ isPrivate: false, showImmediately: false });
  primaryWindowCtx = ctx;

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
          'Content-Security-Policy': ["default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.github.com https://*.githubusercontent.com; font-src 'self' data:;"],
        },
      });
    } else {
      callback({ responseHeaders: details.responseHeaders });
    }
  });

  setInterval(() => saveSession(primaryWindowCtx), 30000);
  // Clean up old completed downloads every hour
  setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours
    for (const [dlId, dl] of downloads) {
      if ((dl.state === 'completed' || dl.state === 'cancelled' || dl.state === 'interrupted') && dl.startTime < cutoff) {
        downloads.delete(dlId);
      }
    }
  }, 3600000);

  restoreSession(ctx).then(ok => { if (!ok) createTab(ctx, 'gb://newtab'); });
}

function layoutViews(ctx) {
  if (!ctx || !ctx.baseWindow || ctx.baseWindow.isDestroyed()) return;
  const { width: w, height: h } = ctx.baseWindow.getContentBounds();

  if (ctx.isHtmlFullscreen) {
    // Hide sidebar and toolbar, tab takes full window
    if (ctx.sidebarView) ctx.sidebarView.setBounds({ x: -SIDEBAR_WIDTH, y: 0, width: SIDEBAR_WIDTH, height: h });
    if (ctx.toolbarView) ctx.toolbarView.setBounds({ x: 0, y: -TOOLBAR_HEIGHT, width: w, height: TOOLBAR_HEIGHT });
    if (ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) {
      ctx.tabs.get(ctx.activeTabId).view.setBounds({ x: 0, y: 0, width: w, height: h });
    }
    return;
  }

  const sw = ctx.sidebarView ? (ctx.sidebarCollapsed ? 48 : SIDEBAR_WIDTH) : 0;
  if (ctx.sidebarView) ctx.sidebarView.setBounds({ x: 0, y: 0, width: sw, height: h });
  if (ctx.toolbarView) ctx.toolbarView.setBounds({ x: sw, y: 0, width: w - sw, height: TOOLBAR_HEIGHT });
  if (ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) {
    ctx.tabs.get(ctx.activeTabId).view.setBounds({ x: sw, y: TOOLBAR_HEIGHT, width: w - sw, height: h - TOOLBAR_HEIGHT });
  }
}

// ─── Tab management ───

// For internal pages (gb://...), switch to existing tab if already open
function openOrSwitchTab(ctx, url) {
  if (!ctx) ctx = primaryWindowCtx;
  if (!ctx) return;
  if (url && url.startsWith('gb://') && url !== 'gb://newtab') {
    for (const [id, tab] of ctx.tabs) {
      if (tab.url === url) {
        switchTab(ctx, id);
        return;
      }
    }
  }
  createTab(ctx, url);
}

function createTab(ctx, url, activate = true) {
  if (!ctx || ctx.closing) return null;
  const id = 'tab-' + (globalNextTabId++);
  const needsPreload = NEEDS_PRELOAD.has(url);
  const webPrefs = {
    contextIsolation: true,
    sandbox: !needsPreload,
    preload: needsPreload ? path.join(__dirname, 'preload.js') : undefined,
  };
  if (ctx.partition) webPrefs.partition = ctx.partition;

  const view = new WebContentsView({ webPreferences: webPrefs });
  // Prevent white flash on navigation/reload
  view.setBackgroundColor(currentTheme === 'Light' ? '#f5f5f5' : '#0a0e14');

  // Pre-set bounds before adding to view tree to prevent layout jump
  if (ctx.baseWindow && !ctx.baseWindow.isDestroyed()) {
    const { width: w, height: h } = ctx.baseWindow.getContentBounds();
    const sw = ctx.sidebarView ? (ctx.sidebarCollapsed ? 48 : SIDEBAR_WIDTH) : 0;
    view.setBounds({ x: sw, y: TOOLBAR_HEIGHT, width: w - sw, height: h - TOOLBAR_HEIGHT });
  }

  const tabData = { view, url: url || 'gb://newtab', title: getInternalTitle(url) || 'New Tab' };
  ctx.tabs.set(id, tabData);
  ctx.tabOrder.push(id);
  wcToWindow.set(view.webContents.id, ctx);

  view.webContents.setWindowOpenHandler(({ url: newUrl }) => {
    if (newUrl && (newUrl.startsWith('http://') || newUrl.startsWith('https://'))) {
      createTab(ctx, newUrl);
    }
    return { action: 'deny' };
  });

  view.webContents.on('page-title-updated', (_e, title) => {
    if (ctx.closing) return;
    if (title.startsWith('__gb_navigate:')) {
      navigateTab(ctx, id, normalizeUrl(title.substring('__gb_navigate:'.length)));
      return;
    }
    if (title.startsWith('__gb_newtab:')) {
      createTab(ctx, title.substring('__gb_newtab:'.length));
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
                sendToToolbar(ctx, 'toast', { message: cmL('passwords.save_prompt', 'Save password?'), action: 'save-password', data });
              }
            }).catch(() => {});
          }
        }).catch(() => {});
      } catch { /* ignore */ }
      return;
    }
    // SEC-04: Handle autofill request — decrypt password on demand and inject into page
    if (title.startsWith('__gb_autofill_req:')) {
      try {
        const { id: credId } = JSON.parse(title.substring('__gb_autofill_req:'.length));
        rustBridge.call('password.decrypt', { id: credId }).then(res => {
          if (res && res.password) {
            view.webContents.executeJavaScript(`
              (function() {
                var pw = document.querySelector('input[type="password"]');
                if (pw) { pw.value = ${JSON.stringify(res.password)}; pw.dispatchEvent(new Event('input', {bubbles:true})); }
              })();
            `).catch(() => {});
          }
        }).catch(() => {});
      } catch { /* ignore */ }
      return;
    }
    // Don't override internal page titles
    if (!isInternalUrl(tabData.url)) {
      tabData.title = title;
      // Record history when we have the real title (skip for private windows)
      const url = tabData.url;
      if (!ctx.isPrivate && url && (url.startsWith('http://') || url.startsWith('https://'))) {
        rustBridge.call('history.record', { url, title }).catch(() => {});
      }
    }
    sendTabsUpdate(ctx);
  });

  view.webContents.on('did-navigate', (_e, navUrl) => {
    tabData.url = navUrl;
    sendToToolbar(ctx, 'tab-url-updated', { id, url: navUrl });
    sendTabsUpdate(ctx);
  });
  view.webContents.on('did-navigate-in-page', (_e, navUrl) => {
    tabData.url = navUrl;
    sendToToolbar(ctx, 'tab-url-updated', { id, url: navUrl });
  });

  view.webContents.on('did-start-loading', () => {
    sendToToolbar(ctx, 'tab-loading', { id, loading: true });
    // Inject document_start content scripts early
    if (!isInternalUrl(tabData.url)) {
      injectContentScripts(view.webContents, tabData.url, 'document_start');
    }
  });
  view.webContents.on('did-stop-loading', () => sendToToolbar(ctx, 'tab-loading', { id, loading: false }));

  // Audio state tracking
  view.webContents.on('media-started-playing', () => sendTabsUpdate(ctx));
  view.webContents.on('media-paused', () => sendTabsUpdate(ctx));

  // Favicon
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    if (favicons && favicons.length > 0) {
      tabData.favicon = favicons[0];
      sendTabsUpdate(ctx);
    }
  });

  // Crash detection — show dialog to send report
  view.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    const errorInfo = `Tab: ${tabData.url}\nReason: ${details.reason}\nExit code: ${details.exitCode}`;
    showCrashReportDialog(ctx.baseWindow, errorInfo);
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
      if (key === '=' || key === '+') { e.preventDefault(); const wc2 = view.webContents; wc2.setZoomLevel(wc2.getZoomLevel() + 0.5); sendToToolbar(ctx, 'zoom-changed', { level: wc2.getZoomLevel() }); }
      else if (key === '-') { e.preventDefault(); const wc2 = view.webContents; wc2.setZoomLevel(wc2.getZoomLevel() - 0.5); sendToToolbar(ctx, 'zoom-changed', { level: wc2.getZoomLevel() }); }
      else if (key === '0') { e.preventDefault(); view.webContents.setZoomLevel(0); sendToToolbar(ctx, 'zoom-changed', { level: 0 }); }
      else if (key === 't') { e.preventDefault(); createTab(ctx, 'gb://newtab'); }
      else if (key === 'w') { e.preventDefault(); if (ctx.activeTabId) closeTab(ctx, ctx.activeTabId); }
      else if (key === 'l') { e.preventDefault(); if (ctx.toolbarView) ctx.toolbarView.webContents.executeJavaScript('document.getElementById("url").focus();document.getElementById("url").select();').catch(() => {}); }
      else if (key === 'f') { e.preventDefault(); if (ctx.toolbarView) ctx.toolbarView.webContents.executeJavaScript('toggleFindBar()').catch(() => {}); }
      else if (key === 'r') { e.preventDefault(); if (ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) ctx.tabs.get(ctx.activeTabId).view.webContents.reload(); }
      else if (key === 'd') { e.preventDefault(); addBookmarkCurrent(ctx); }
      else if (key === 'n') { e.preventDefault(); openNewWindow(); }
      else if (key === 'tab') { e.preventDefault(); cycleTab(ctx, 1); }
    }
    if (ctrl && shift) {
      if (key === 'tab') { e.preventDefault(); cycleTab(ctx, -1); }
      else if (key === 't') { e.preventDefault(); reopenClosedTab(ctx); }
      else if (key === 'n') { e.preventDefault(); openPrivateWindow(); }
    }
    if (!ctrl && !shift) {
      if (key === 'f5') { e.preventDefault(); if (ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) ctx.tabs.get(ctx.activeTabId).view.webContents.reload(); }
      else if (key === 'f11') { e.preventDefault(); if (ctx.baseWindow) ctx.baseWindow.setFullScreen(!ctx.baseWindow.isFullScreen()); }
    }
  });

  // HTML5 fullscreen (e.g. YouTube video player)
  view.webContents.on('enter-html-full-screen', () => {
    ctx.isHtmlFullscreen = true;
    layoutViews(ctx);
  });
  view.webContents.on('leave-html-full-screen', () => {
    ctx.isHtmlFullscreen = false;
    layoutViews(ctx);
  });

  loadUrlInView(view, url);
  if (activate) switchTab(ctx, id);
  sendTabsUpdate(ctx);
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

function switchTab(ctx, id) {
  if (!ctx || !ctx.tabs.has(id)) return;
  const prevTabId = ctx.activeTabId;
  // Auto PiP: if leaving a tab with playing video, trigger PiP
  if (prevTabId && ctx.tabs.has(prevTabId) && prevTabId !== id) {
    const leavingView = ctx.tabs.get(prevTabId).view;
    if (!leavingView.webContents.isDestroyed()) {
      leavingView.webContents.executeJavaScript(`
        (function() {
          var v = document.querySelector('video');
          if (v && !v.paused && v.readyState >= 2 && !document.pictureInPictureElement) {
            try { v.requestPictureInPicture(); } catch(e) {}
          }
        })();
      `).catch(() => {});
    }
  }
  // If returning to the tab that has PiP, exit PiP
  if (prevTabId !== id && ctx.tabs.has(id)) {
    const returningView = ctx.tabs.get(id).view;
    if (!returningView.webContents.isDestroyed()) {
      returningView.webContents.executeJavaScript(`
        (function() {
          if (document.pictureInPictureElement) {
            try { document.exitPictureInPicture(); } catch(e) {}
          }
        })();
      `).catch(() => {});
    }
  }
  ctx.activeTabId = id;
  const { view, url } = ctx.tabs.get(id);
  // Set correct bounds BEFORE adding to prevent layout jump
  const { width: w, height: h } = ctx.baseWindow.getContentBounds();
  const sw = ctx.sidebarView ? (ctx.sidebarCollapsed ? 48 : SIDEBAR_WIDTH) : 0;
  view.setBounds({ x: sw, y: TOOLBAR_HEIGHT, width: w - sw, height: h - TOOLBAR_HEIGHT });
  ctx.baseWindow.contentView.addChildView(view);
  if (prevTabId && prevTabId !== id && ctx.tabs.has(prevTabId)) {
    ctx.baseWindow.contentView.removeChildView(ctx.tabs.get(prevTabId).view);
  }
  sendTabsUpdate(ctx);
  const realUrl = view.webContents.getURL() || url || '';
  sendToToolbar(ctx, 'tab-url-updated', { id, url: realUrl });
  sendToToolbar(ctx, 'zoom-changed', { level: view.webContents.getZoomLevel() });
  sendToToolbar(ctx, 'close-find', {});
}

function closeTab(ctx, id) {
  if (!ctx || !ctx.tabs.has(id)) return;
  const { view, url, title } = ctx.tabs.get(id);
  // Save to closed tabs stack for Ctrl+Shift+T
  if (url && url !== 'gb://newtab') {
    ctx.closedTabsStack.push({ url, title });
    if (ctx.closedTabsStack.length > MAX_CLOSED_TABS) ctx.closedTabsStack.shift();
  }
  ctx.baseWindow.contentView.removeChildView(view);
  // Clean up all event listeners before closing
  wcToWindow.delete(view.webContents.id);
  view.webContents.removeAllListeners();
  view.webContents.close();
  ctx.tabs.delete(id);
  ctx.tabOrder = ctx.tabOrder.filter(tid => tid !== id);
  if (ctx.activeTabId === id) {
    ctx.activeTabId = null;
    if (ctx.tabOrder.length > 0) switchTab(ctx, ctx.tabOrder[ctx.tabOrder.length - 1]);
    else {
      // If private window and no tabs left, close the window
      if (ctx.isPrivate) {
        ctx.baseWindow.close();
        return;
      }
      createTab(ctx, 'gb://newtab');
    }
  }
  sendTabsUpdate(ctx);
}

function navigateTab(ctx, id, url) {
  if (!ctx || !ctx.tabs.has(id)) return;
  const tabData = ctx.tabs.get(id);
  // If navigating to internal page that needs preload but current view doesn't have it,
  // create new tab first, then remove old — prevents flicker
  if (NEEDS_PRELOAD.has(url)) {
    createTab(ctx, url);
    // Silently remove old tab without switching
    const { view } = ctx.tabs.get(id);
    ctx.baseWindow.contentView.removeChildView(view);
    wcToWindow.delete(view.webContents.id);
    view.webContents.removeAllListeners();
    view.webContents.close();
    ctx.tabs.delete(id);
    ctx.tabOrder = ctx.tabOrder.filter(tid => tid !== id);
    sendTabsUpdate(ctx);
    return;
  }
  tabData.url = url;
  tabData.title = getInternalTitle(url) || tabData.title;
  loadUrlInView(tabData.view, url);
  sendTabsUpdate(ctx);
}

let _tabsUpdateTimers = new WeakMap();
function sendTabsUpdate(ctx) {
  if (!ctx || ctx.closing) return;
  // Debounce to prevent rapid-fire updates causing visual jitter
  if (_tabsUpdateTimers.has(ctx)) clearTimeout(_tabsUpdateTimers.get(ctx));
  _tabsUpdateTimers.set(ctx, setTimeout(() => {
    _tabsUpdateTimers.delete(ctx);
    if (ctx.closing) return;
    const data = ctx.tabOrder.map(id => {
    if (!ctx.tabs.has(id)) return null;
    const t = ctx.tabs.get(id);
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
    return { id, title, url, favicon: t.favicon || null, audible: t.view.webContents.isCurrentlyAudible(), muted: t.view.webContents.isAudioMuted() };
  }).filter(Boolean);
  sendToToolbar(ctx, 'tabs-update', { tabs: data, activeId: ctx.activeTabId });
  }, 16));
}

function sendToToolbar(ctx, channel, data) {
  if (!ctx) return;
  if (ctx.toolbarView && !ctx.toolbarView.webContents.isDestroyed()) {
    ctx.toolbarView.webContents.send(channel, data);
  }
  if (ctx.sidebarView && !ctx.sidebarView.webContents.isDestroyed()) {
    ctx.sidebarView.webContents.send(channel, data);
  }
}

// Helper functions for keyboard shortcuts
function cycleTab(ctx, direction) {
  if (!ctx || ctx.tabOrder.length < 2) return;
  const idx = ctx.tabOrder.indexOf(ctx.activeTabId);
  const next = (idx + direction + ctx.tabOrder.length) % ctx.tabOrder.length;
  switchTab(ctx, ctx.tabOrder[next]);
}

function reopenClosedTab(ctx) {
  if (!ctx || ctx.closedTabsStack.length === 0) return;
  const { url } = ctx.closedTabsStack.pop();
  createTab(ctx, url);
}

function addBookmarkCurrent(ctx) {
  if (!ctx || !ctx.activeTabId || !ctx.tabs.has(ctx.activeTabId)) return;
  const t = ctx.tabs.get(ctx.activeTabId);
  rustBridge.call('bookmark.add', { url: t.url, title: t.title }).catch(() => {});
}

function openPrivateWindow() {
  const ctx = createBrowserWindow({ isPrivate: true });
  createTab(ctx, 'gb://newtab');
}

function openNewWindow() {
  const ctx = createBrowserWindow({ isPrivate: false });
  createTab(ctx, 'gb://newtab');
}

// ─── Downloads ───

const downloadItems = new Map(); // dlId -> DownloadItem

// Broadcast download events to toolbar, sidebar, AND any open downloads tab
function broadcastDownload(channel, data) {
  const ctx = primaryWindowCtx;
  if (!ctx) return;
  sendToToolbar(ctx, channel, data);
  // Also send to any tab showing gb://downloads
  for (const [, tab] of ctx.tabs) {
    try {
      const url = tab.view.webContents.getURL();
      if (url && (url.includes('downloads.html') || tab.url === 'gb://downloads')) {
        if (!tab.view.webContents.isDestroyed()) {
          tab.view.webContents.send(channel, data);
        }
      }
    } catch {}
  }
}

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
  broadcastDownload('download-started', dl);

  let lastBytes = 0;
  let lastTime = Date.now();
  let progressTimer = null;

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

    // Throttle UI updates to ~4 times per second
    if (!progressTimer) {
      progressTimer = setTimeout(() => {
        progressTimer = null;
        broadcastDownload('download-progress', {
          id: dlId, receivedBytes: dl.receivedBytes, totalBytes: dl.totalBytes,
          state: dl.state, paused: dl.paused, speed: dl.speed, eta: dl.eta,
        });
      }, 250);
    }
  });
  item.once('done', (_e, state) => {
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    dl.state = state;
    dl.savePath = item.getSavePath();
    dl.receivedBytes = dl.totalBytes;
    dl.speed = 0;
    dl.eta = 0;
    downloadItems.delete(dlId);
    broadcastDownload('download-done', { id: dlId, state, savePath: dl.savePath, filename: dl.filename });
    if (state === 'completed') {
      sendToToolbar(primaryWindowCtx, 'toast', { message: cmL('downloads.completed', 'Downloaded') + ': ' + dl.filename, action: 'open-download', data: { savePath: dl.savePath } });
    }
  });
}

// ─── Session ───

function saveSession(ctx) {
  if (!ctx) ctx = primaryWindowCtx;
  if (!ctx || ctx.isPrivate) return;
  try {
    const data = ctx.tabOrder.map(id => {
      if (!ctx.tabs.has(id)) return null;
      const t = ctx.tabs.get(id);
      const url = t.view.webContents.getURL() || t.url;
      return { url, title: t.title };
    }).filter(Boolean);
    // Skip save if RPC is not ready (e.g. during shutdown)
    if (!rustBridge.ready) return;
    // Save to Rust RPC
    rustBridge.call('session.save', { tabs: data }).catch(() => {});
    // Save encrypted local backup
    const jsonStr = JSON.stringify(data);
    rustBridge.call('github.encrypt_sync', { data: jsonStr }).then(encrypted => {
      try { fs.writeFileSync(userDataPath('session.json'), JSON.stringify(encrypted), 'utf8'); } catch {}
    }).catch(() => {
      // SEC-02: Do NOT fallback to unencrypted save
    });
  } catch {}
}

async function restoreSession(ctx) {
  try {
    // Primary source: encrypted local backup
    try {
      const raw = fs.readFileSync(userDataPath('session.json'), 'utf8');
      const parsed = JSON.parse(raw);
      let tabs = null;
      if (parsed.ciphertext) {
        const decrypted = await rustBridge.call('github.decrypt_sync', parsed);
        tabs = JSON.parse(decrypted.data);
      } else if (Array.isArray(parsed)) {
        tabs = parsed;
      }
      if (Array.isArray(tabs) && tabs.length > 0) {
        // Deduplicate by url
        const seen = new Set();
        const unique = tabs.filter(t => {
          const url = t.url || 'gb://newtab';
          if (seen.has(url)) return false;
          seen.add(url);
          return true;
        });
        unique.forEach((t, i) => createTab(ctx, t.url || 'gb://newtab', i === unique.length - 1));
        return true;
      }
    } catch {}

    // Fallback: Rust RPC session file
    let result = await rustBridge.call('session.restore', {});
    if (Array.isArray(result) && result.length > 0) {
      const seen = new Set();
      const unique = result.filter(t => {
        const url = t.url || 'gb://newtab';
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });
      unique.forEach((t, i) => createTab(ctx, t.url || 'gb://newtab', i === unique.length - 1));
      return true;
    }
  } catch {}
  return false;
}

// ─── IPC handlers ───

ipcMain.on('new-tab', (e) => { const ctx = getWindowCtx(e.sender); createTab(ctx, 'gb://newtab'); });
ipcMain.on('close-tab', (e, id) => { const ctx = getWindowCtx(e.sender); closeTab(ctx, id); });
ipcMain.on('switch-tab', (e, id) => { const ctx = getWindowCtx(e.sender); switchTab(ctx, id); });
ipcMain.on('next-tab', (e) => { const ctx = getWindowCtx(e.sender); cycleTab(ctx, 1); });
ipcMain.on('prev-tab', (e) => { const ctx = getWindowCtx(e.sender); cycleTab(ctx, -1); });
ipcMain.on('reopen-closed-tab', (e) => { const ctx = getWindowCtx(e.sender); reopenClosedTab(ctx); });
ipcMain.on('reorder-tab', (e, { fromId, toId }) => {
  const ctx = getWindowCtx(e.sender);
  if (!ctx) return;
  const fromIdx = ctx.tabOrder.indexOf(fromId);
  const toIdx = ctx.tabOrder.indexOf(toId);
  if (fromIdx >= 0 && toIdx >= 0) {
    ctx.tabOrder.splice(fromIdx, 1);
    ctx.tabOrder.splice(toIdx, 0, fromId);
    sendTabsUpdate(ctx);
  }
});
ipcMain.on('go-back', (e) => { const ctx = getWindowCtx(e.sender); if (ctx && ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) ctx.tabs.get(ctx.activeTabId).view.webContents.goBack(); });
ipcMain.on('go-forward', (e) => { const ctx = getWindowCtx(e.sender); if (ctx && ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) ctx.tabs.get(ctx.activeTabId).view.webContents.goForward(); });
ipcMain.on('reload', (e) => { const ctx = getWindowCtx(e.sender); if (ctx && ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) ctx.tabs.get(ctx.activeTabId).view.webContents.reload(); });
ipcMain.on('get-tabs', (e) => { const ctx = getWindowCtx(e.sender); sendTabsUpdate(ctx); });
ipcMain.on('toggle-mute', (e, id) => {
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.tabs.has(id)) {
    const wc = ctx.tabs.get(id).view.webContents;
    wc.setAudioMuted(!wc.isAudioMuted());
    sendTabsUpdate(ctx);
  }
});

// Zoom
ipcMain.on('zoom-in', (e) => {
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) {
    const wc = ctx.tabs.get(ctx.activeTabId).view.webContents;
    wc.setZoomLevel(wc.getZoomLevel() + 0.5);
    sendToToolbar(ctx, 'zoom-changed', { level: wc.getZoomLevel() });
  }
});
ipcMain.on('zoom-out', (e) => {
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) {
    const wc = ctx.tabs.get(ctx.activeTabId).view.webContents;
    wc.setZoomLevel(wc.getZoomLevel() - 0.5);
    sendToToolbar(ctx, 'zoom-changed', { level: wc.getZoomLevel() });
  }
});
ipcMain.on('zoom-reset', (e) => {
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) {
    ctx.tabs.get(ctx.activeTabId).view.webContents.setZoomLevel(0);
    sendToToolbar(ctx, 'zoom-changed', { level: 0 });
  }
});

// Fullscreen
ipcMain.on('toggle-fullscreen', (e) => {
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.baseWindow) ctx.baseWindow.setFullScreen(!ctx.baseWindow.isFullScreen());
});

// Window controls (frameless)
ipcMain.on('win-minimize', (e) => {
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.baseWindow) ctx.baseWindow.minimize();
});
ipcMain.on('win-maximize', (e) => {
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.baseWindow) {
    if (ctx.baseWindow.isMaximized()) ctx.baseWindow.unmaximize();
    else ctx.baseWindow.maximize();
  }
});
ipcMain.on('win-close', (e) => {
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.baseWindow) ctx.baseWindow.close();
});

// Sidebar toggle — instant bounds change, CSS handles visual smoothness inside sidebar
ipcMain.on('toggle-sidebar', (e) => {
  const ctx = getWindowCtx(e.sender);
  if (!ctx) return;
  ctx.sidebarCollapsed = !ctx.sidebarCollapsed;
  layoutViews(ctx);
  // Notify sidebar view about collapse state
  if (ctx.sidebarView && !ctx.sidebarView.webContents.isDestroyed()) {
    ctx.sidebarView.webContents.send('sidebar-collapsed', { collapsed: ctx.sidebarCollapsed });
  }
});

// Private mode — now uses the unified multi-window architecture
ipcMain.on('open-private-window', () => openPrivateWindow());

// Open new normal window
ipcMain.on('open-new-window', () => openNewWindow());

// Find in page
ipcMain.on('find-in-page', (e, text) => {
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) {
    if (text) ctx.tabs.get(ctx.activeTabId).view.webContents.findInPage(text);
    else ctx.tabs.get(ctx.activeTabId).view.webContents.stopFindInPage('clearSelection');
  }
});
ipcMain.on('stop-find', (e) => {
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) {
    ctx.tabs.get(ctx.activeTabId).view.webContents.stopFindInPage('clearSelection');
  }
});

// Reader mode
ipcMain.handle('reader-extract', async (e) => {
  const ctx = getWindowCtx(e.sender);
  if (!ctx || !ctx.activeTabId || !ctx.tabs.has(ctx.activeTabId)) return { error: 'No active tab' };
  const wc = ctx.tabs.get(ctx.activeTabId).view.webContents;
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
ipcMain.on('open-settings', (e) => { const ctx = getWindowCtx(e.sender); openOrSwitchTab(ctx, 'gb://settings'); });
ipcMain.on('open-bookmarks', (e) => { const ctx = getWindowCtx(e.sender); openOrSwitchTab(ctx, 'gb://bookmarks'); });
ipcMain.on('open-history', (e) => { const ctx = getWindowCtx(e.sender); openOrSwitchTab(ctx, 'gb://history'); });
ipcMain.on('open-downloads', (e) => { const ctx = getWindowCtx(e.sender); openOrSwitchTab(ctx, 'gb://downloads'); });
// Ensure downloads tab exists without switching to it
ipcMain.on('ensure-downloads-tab', (e) => {
  const ctx = getWindowCtx(e.sender);
  if (!ctx) return;
  // Check if already open
  for (const [, tab] of ctx.tabs) {
    if (tab.url === 'gb://downloads') return;
  }
  createTab(ctx, 'gb://downloads', false);
});
ipcMain.on('open-ai', (e) => { const ctx = getWindowCtx(e.sender); openOrSwitchTab(ctx, 'gb://ai'); });
ipcMain.on('open-github', (e) => { const ctx = getWindowCtx(e.sender); openOrSwitchTab(ctx, 'gb://github'); });

// Sidebar context menu (overlay in tab view when sidebar is collapsed)
ipcMain.on('sidebar-context-menu', (e, clientX, clientY) => {
  const ctx = getWindowCtx(e.sender);
  if (!ctx || !ctx.activeTabId || !ctx.tabs.has(ctx.activeTabId)) return;
  const tabView = ctx.tabs.get(ctx.activeTabId).view;
  const tabBounds = tabView.getBounds();
  const sw = ctx.sidebarCollapsed ? 48 : SIDEBAR_WIDTH;
  const sbToken = generateCtxToken();

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
      d.onclick=function(){closeMenu();console.log('__gb_sb_ctx:${sbToken}:'+JSON.stringify({action:it.action}));};
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
    const prefix = '__gb_sb_ctx:' + sbToken + ':';
    if (!message || !message.startsWith(prefix)) return;
    tabView.webContents.removeListener('console-message', sbCtxHandler);
    try {
      const { action } = JSON.parse(message.replace(prefix, ''));
      if (action === 'sb_new_tab') createTab(ctx, 'gb://newtab');
      else if (action === 'sb_bookmarks') openOrSwitchTab(ctx, 'gb://bookmarks');
      else if (action === 'sb_history') openOrSwitchTab(ctx, 'gb://history');
      else if (action === 'sb_downloads') openOrSwitchTab(ctx, 'gb://downloads');
      else if (action === 'sb_passwords') openOrSwitchTab(ctx, 'gb://passwords');
      else if (action === 'sb_extensions') openOrSwitchTab(ctx, 'gb://extensions');
      else if (action === 'sb_ai') openOrSwitchTab(ctx, 'gb://ai');
      else if (action === 'sb_github') openOrSwitchTab(ctx, 'gb://github');
      else if (action === 'sb_settings') openOrSwitchTab(ctx, 'gb://settings');
    } catch {}
  };
  tabView.webContents.on('console-message', sbCtxHandler);
  setTimeout(() => { try { tabView.webContents.removeListener('console-message', sbCtxHandler); } catch {} }, 10000);
});

// Sidebar quick nav context menus (glass style in tab view)
ipcMain.on('sidebar-quick-nav-menu', (e, navId, clientX, clientY) => {
  const ctx = getWindowCtx(e.sender);
  if (!ctx) return;
  const navToken = generateCtxToken();
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
  if (!ctx.activeTabId || !ctx.tabs.has(ctx.activeTabId)) {
    // Build native menu as fallback
    const nativeItems = items.map(it => ({
      label: it.label,
      click: () => handleNavAction(ctx, it.action, it.data),
    }));
    Menu.buildFromTemplate(nativeItems).popup();
    return;
  }

  const tabView = ctx.tabs.get(ctx.activeTabId).view;
  const tabBounds = tabView.getBounds();
  const sidebarBounds = ctx.sidebarView ? ctx.sidebarView.getBounds() : { x: 0, y: 0 };

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
        console.log('__gb_nav_ctx:${navToken}:'+JSON.stringify({action:this.dataset.action,data:this.dataset.data}));
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
    const prefix = '__gb_nav_ctx:' + navToken + ':';
    if (!message || !message.startsWith(prefix)) return;
    tabView.webContents.removeListener('console-message', navHandler);
    try {
      const { action, data } = JSON.parse(message.replace(prefix, ''));
      handleNavAction(ctx, action, data);
    } catch {}
  };
  tabView.webContents.on('console-message', navHandler);
  setTimeout(() => { try { tabView.webContents.removeListener('console-message', navHandler); } catch {} }, 10000);
});

function handleNavAction(ctx, action, data) {
  if (action === 'nav_open') openOrSwitchTab(ctx, data);
  else if (action === 'nav_bookmark_add') {
    if (ctx && ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) {
      const t = ctx.tabs.get(ctx.activeTabId);
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
ipcMain.on('toolbar-more-menu', (e, clientX, clientY) => {
  const ctx = getWindowCtx(e.sender);
  if (!ctx || !ctx.activeTabId || !ctx.tabs.has(ctx.activeTabId)) return;
  const moreToken = generateCtxToken();
  // Clean up previous listener to prevent duplicate handling
  if (_prevMoreHandler && _prevMoreWc) {
    try { _prevMoreWc.removeListener('console-message', _prevMoreHandler); } catch {}
    _prevMoreHandler = null; _prevMoreWc = null;
  }

  const items = [
    { label: cmL('toolbar.new_tab', 'Новая вкладка'), accel: 'Ctrl+T', action: 'nav_open', data: 'gb://newtab', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/></svg>' },
    { label: cmL('toolbar.new_window', 'Новое окно'), accel: 'Ctrl+N', action: 'more_new_window', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1.5a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm12.5 11.5H1.75A1.75 1.75 0 0 1 0 11.25v-9.5C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13ZM3 15a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 15Z"/></svg>' },
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

  const tabView = ctx.tabs.get(ctx.activeTabId).view;
  const tabBounds = tabView.getBounds();
  const toolbarBounds = ctx.toolbarView ? ctx.toolbarView.getBounds() : { x: 0, y: 0 };

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
        console.log('__gb_more_ctx:${moreToken}:'+JSON.stringify({action:this.dataset.action,data:this.dataset.data}));
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
    const prefix = '__gb_more_ctx:' + moreToken + ':';
    if (!message || !message.startsWith(prefix)) return;
    tabView.webContents.removeListener('console-message', moreHandler);
    try {
      const { action, data } = JSON.parse(message.replace(prefix, ''));
      if (action === 'nav_open') openOrSwitchTab(ctx, data);
      else if (action === 'more_new_window') { openNewWindow(); }
      else if (action === 'more_private') { openPrivateWindow(); }
      else if (action === 'more_find') { if (ctx.toolbarView) ctx.toolbarView.webContents.executeJavaScript('toggleFindBar()').catch(() => {}); }
      else if (action === 'more_zoom_in') { if (ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) { const wc = ctx.tabs.get(ctx.activeTabId).view.webContents; wc.setZoomLevel(wc.getZoomLevel() + 1); sendToToolbar(ctx, 'zoom-changed', { level: wc.getZoomLevel() }); } }
      else if (action === 'more_zoom_out') { if (ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) { const wc = ctx.tabs.get(ctx.activeTabId).view.webContents; wc.setZoomLevel(wc.getZoomLevel() - 1); sendToToolbar(ctx, 'zoom-changed', { level: wc.getZoomLevel() }); } }
      else if (action === 'more_zoom_reset') { if (ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) { const wc = ctx.tabs.get(ctx.activeTabId).view.webContents; wc.setZoomLevel(0); sendToToolbar(ctx, 'zoom-changed', { level: 0 }); } }
      else if (action === 'more_fullscreen') { if (ctx.baseWindow) { ctx.baseWindow.isFullScreen() ? ctx.baseWindow.setFullScreen(false) : ctx.baseWindow.setFullScreen(true); } }
      else if (action === 'more_reader') {
        // Reader mode — trigger via existing IPC
        sendToToolbar(ctx, 'toast', { message: 'Режим чтения (в разработке)' });
      }
    } catch {}
  };
  _prevMoreHandler = moreHandler;
  _prevMoreWc = tabView.webContents;
  tabView.webContents.on('console-message', moreHandler);
  setTimeout(() => { try { tabView.webContents.removeListener('console-message', moreHandler); } catch {} if (_prevMoreHandler === moreHandler) { _prevMoreHandler = null; _prevMoreWc = null; } }, 10000);
});

// ─── Toolbar GitHub quick menu ───
let _prevGhHandler = null;
let _prevGhWc = null;

function handleGhAction(action, data) {
  const ctx = primaryWindowCtx;
  if (action === 'gh_open' && data) createTab(ctx, data);
  else if (action === 'gh_dashboard') createTab(ctx, 'gb://github');
  else if (action === 'gh_login') createTab(ctx, 'gb://github');
  else if (action === 'gh_logout') {
    githubToken = null;
    ghNotifCount = 0;
    clearGhTokenLocal();
    if (ghNotifInterval) { clearInterval(ghNotifInterval); ghNotifInterval = null; }
    rustBridge.call('github.logout', {}).catch(() => {});
    rustBridge.call('secret.delete', { key: 'github_token' }).catch(() => {});
    sendToToolbar(primaryWindowCtx, 'gh-notif-count', { count: 0 });
  }
}

ipcMain.on('toolbar-github-menu', async (e, clientX, clientY) => {
  const ctx = getWindowCtx(e.sender);
  if (!ctx || !ctx.activeTabId || !ctx.tabs.has(ctx.activeTabId)) return;
  const ghToken = generateCtxToken();
  if (_prevGhHandler && _prevGhWc) {
    try { _prevGhWc.removeListener('console-message', _prevGhHandler); } catch {}
    _prevGhHandler = null; _prevGhWc = null;
  }

  // Try to restore token if not loaded yet
  if (!githubToken) {
    try { const r = await rustBridge.call('github.get_token', {}); if (r && r.token) githubToken = r.token; } catch {}
  }
  if (!githubToken) {
    const local = loadGhTokenLocal();
    if (local) githubToken = local;
  }
  if (!githubToken) {
    try { const sec = await rustBridge.call('secret.get', { key: 'github_token' }); if (sec && sec.value) { githubToken = sec.value; saveGhTokenLocal(sec.value); } } catch {}
  }

  let ghUser = null;
  if (githubToken) {
    try {
      const res = await net.fetch('https://api.github.com/user', {
        headers: { 'Authorization': 'Bearer ' + githubToken, 'Accept': 'application/vnd.github+json' },
      });
      if (res.ok) ghUser = await res.json();
      else if (res.status === 401) { githubToken = null; clearGhTokenLocal(); }
    } catch {}
  }

  const items = [];
  if (ghUser) {
    items.push({ type: 'header', login: ghUser.login, name: ghUser.name || ghUser.login, avatar: ghUser.avatar_url || '' });
    items.push({ label: 'Profile', action: 'gh_open', data: 'https://github.com/' + ghUser.login, icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>' });
    items.push({ label: 'Repositories', action: 'gh_open', data: 'https://github.com/' + ghUser.login + '?tab=repositories', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8Z"/></svg>' });
    items.push({ label: 'Notifications', action: 'gh_open', data: 'https://github.com/notifications', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 16a2 2 0 0 0 1.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 0 0 8 16ZM3 5a5 5 0 0 1 10 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.519 1.519 0 0 1 13.482 13H2.518a1.516 1.516 0 0 1-1.263-2.36l1.703-2.554A.255.255 0 0 0 3 7.947Z"/></svg>', badge: ghNotifCount || 0 });
    items.push({ label: 'Pull Requests', action: 'gh_open', data: 'https://github.com/pulls', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z"/></svg>' });
    items.push({ label: 'Gists', action: 'gh_open', data: 'https://gist.github.com/' + ghUser.login, icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1.5a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25ZM9.22 4.22a.749.749 0 0 1 1.06 0l3.25 3.25a.749.749 0 0 1 0 1.06l-3.25 3.25a.749.749 0 1 1-1.06-1.06L11.94 8 9.22 5.28a.749.749 0 0 1 0-1.06ZM6.78 4.22a.749.749 0 0 1 0 1.06L4.06 8l2.72 2.72a.749.749 0 1 1-1.06 1.06L2.47 8.53a.749.749 0 0 1 0-1.06l3.25-3.25a.749.749 0 0 1 1.06 0Z"/></svg>' });
    items.push({ type: 'separator' });
    items.push({ label: 'New Repository', action: 'gh_open', data: 'https://github.com/new', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/></svg>' });
    items.push({ label: 'New Gist', action: 'gh_open', data: 'https://gist.github.com', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/></svg>' });
    items.push({ type: 'separator' });
    items.push({ label: 'Full Dashboard', action: 'gh_dashboard', icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6.122.392a1.75 1.75 0 0 1 1.756 0l5.25 3.045c.54.313.872.89.872 1.514V7.25a.75.75 0 0 1-1.5 0V5.677L7.75 8.432v6.384a1 1 0 0 1-1.502.865L.872 12.563A1.75 1.75 0 0 1 0 11.049V4.951c0-.624.332-1.2.872-1.514Z"/></svg>' });
    items.push({ type: 'separator' });
    items.push({ label: 'Sign out', action: 'gh_logout', danger: true, icon: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.75C2 1.784 2.784 1 3.75 1h2.5a.75.75 0 0 1 0 1.5h-2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h2.5a.75.75 0 0 1 0 1.5h-2.5A1.75 1.75 0 0 1 2 13.25Zm10.44 4.5-1.97-1.97a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.97-1.97H6.75a.75.75 0 0 1 0-1.5Z"/></svg>' });
  } else {
    items.push({ type: 'login' });
  }

  const tabView = ctx.tabs.get(ctx.activeTabId).view;
  const tabBounds = tabView.getBounds();
  const toolbarBounds = ctx.toolbarView ? ctx.toolbarView.getBounds() : { x: 0, y: 0 };
  const tabLocalX = (clientX || 0) + toolbarBounds.x - tabBounds.x;
  const tabLocalY = (clientY || 0) + toolbarBounds.y - tabBounds.y;
  const menuData = JSON.stringify(items);

  tabView.webContents.executeJavaScript(`(function(){
    ${CLEAR_ALL_OVERLAYS_JS}
    var style=document.createElement('style');style.id='__gb-ctx-style';
    style.textContent=\`
      #__gb-ctx-ov{position:fixed;inset:0;z-index:2147483646;}
      #__gb-ctx{position:fixed;z-index:2147483647;
        background:rgba(18,22,30,0.95);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);
        border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:0;min-width:260px;max-width:300px;
        box-shadow:0 16px 48px rgba(0,0,0,0.5),0 4px 12px rgba(0,0,0,0.3),inset 0 1px 0 rgba(255,255,255,0.06);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#e2e8f0;
        animation:__gbCtxIn 0.15s cubic-bezier(0.16,1,0.3,1);overflow:hidden;}
      @keyframes __gbCtxIn{from{opacity:0;transform:translateY(-6px) scale(0.97)}to{opacity:1;transform:translateY(0) scale(1)}}
      #__gb-ctx .ghm-hd{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.06);}
      #__gb-ctx .ghm-av{width:32px;height:32px;border-radius:50%;flex-shrink:0;}
      #__gb-ctx .ghm-name{font-size:13px;font-weight:600;}
      #__gb-ctx .ghm-login{font-size:11px;color:rgba(255,255,255,0.4);}
      #__gb-ctx .ghm-i{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer;transition:background 0.08s;color:#e2e8f0;}
      #__gb-ctx .ghm-i:hover{background:rgba(255,255,255,0.07);}
      #__gb-ctx .ghm-i svg{opacity:0.5;flex-shrink:0;}
      #__gb-ctx .ghm-i:hover svg{opacity:1;}
      #__gb-ctx .ghm-i.danger{color:#f85149;}
      #__gb-ctx .ghm-badge{margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#1f6feb;color:#fff;font-size:10px;font-weight:700;line-height:18px;text-align:center;}
      #__gb-ctx .ghm-sep{height:1px;background:rgba(255,255,255,0.06);margin:2px 8px;}
      #__gb-ctx .ghm-lp{padding:24px 16px;text-align:center;color:rgba(255,255,255,0.4);}
      #__gb-ctx .ghm-lp svg{opacity:0.2;margin-bottom:8px;}
      #__gb-ctx .ghm-lb{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:8px 16px;border-radius:8px;background:#1f6feb;color:#fff;border:none;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;}
      #__gb-ctx .ghm-lb:hover{filter:brightness(1.1);}
      @media(prefers-color-scheme:light){
        #__gb-ctx{background:rgba(255,255,255,0.97);border-color:rgba(0,0,0,0.1);color:#1f2328;box-shadow:0 16px 48px rgba(0,0,0,0.1);}
        #__gb-ctx .ghm-hd{border-color:rgba(0,0,0,0.06);}
        #__gb-ctx .ghm-login{color:rgba(0,0,0,0.4);}
        #__gb-ctx .ghm-i{color:#1f2328;}
        #__gb-ctx .ghm-i:hover{background:rgba(0,0,0,0.05);}
        #__gb-ctx .ghm-sep{background:rgba(0,0,0,0.06);}
        #__gb-ctx .ghm-lp{color:rgba(0,0,0,0.4);}
      }
      html.light #__gb-ctx{background:rgba(255,255,255,0.97);border-color:rgba(0,0,0,0.1);color:#1f2328;box-shadow:0 16px 48px rgba(0,0,0,0.1);}
      html.light #__gb-ctx .ghm-hd{border-color:rgba(0,0,0,0.06);}
      html.light #__gb-ctx .ghm-login{color:rgba(0,0,0,0.4);}
      html.light #__gb-ctx .ghm-i{color:#1f2328;}
      html.light #__gb-ctx .ghm-i:hover{background:rgba(0,0,0,0.05);}
      html.light #__gb-ctx .ghm-sep{background:rgba(0,0,0,0.06);}
      html.light #__gb-ctx .ghm-lp{color:rgba(0,0,0,0.4);}
    \`;
    document.documentElement.appendChild(style);
    function closeMenu(){var o=document.getElementById('__gb-ctx-ov');if(o)o.remove();var m=document.getElementById('__gb-ctx');if(m)m.remove();var s=document.getElementById('__gb-ctx-style');if(s)s.remove();}
    var hasIpc=!!(window.gitbrowser&&window.gitbrowser.ctxAction);
    function doAction(act,dat){closeMenu();setTimeout(function(){if(hasIpc)window.gitbrowser.ctxAction(act,dat);else console.log('__gb_gh_ctx:${ghToken}:'+JSON.stringify({action:act,data:dat}));},50);}
    var ov=document.createElement('div');ov.id='__gb-ctx-ov';ov.onclick=closeMenu;ov.oncontextmenu=function(e){e.preventDefault();closeMenu();};
    document.documentElement.appendChild(ov);
    var menu=document.createElement('div');menu.id='__gb-ctx';
    var items=${menuData};
    var html='';
    items.forEach(function(it){
      if(it.type==='header'){html+='<div class="ghm-hd"><img class="ghm-av" src="'+it.avatar+'" onerror="this.style.display=\\'none\\'"/><div><div class="ghm-name">'+it.name+'</div><div class="ghm-login">@'+it.login+'</div></div></div>';return;}
      if(it.type==='login'){html+='<div class="ghm-lp"><svg width="32" height="32" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"/></svg><div>Sign in for quick access</div><button class="ghm-lb" data-act="gh_login">Sign in with GitHub</button></div>';return;}
      if(it.type==='separator'){html+='<div class="ghm-sep"></div>';return;}
      var badge=it.badge>0?'<span class="ghm-badge">'+it.badge+'</span>':'';
      var cls='ghm-i'+(it.danger?' danger':'');
      html+='<div class="'+cls+'" data-action="'+(it.action||'')+'" data-data="'+(it.data||'').replace(/"/g,'&quot;')+'">'+(it.icon||'')+' '+it.label+badge+'</div>';
    });
    menu.innerHTML=html;
    var hd=menu.querySelector('.ghm-hd');
    if(hd){var body=document.createElement('div');body.style.padding='6px';while(menu.firstChild!==hd&&menu.firstChild)body.appendChild(menu.firstChild);while(hd.nextSibling)body.appendChild(hd.nextSibling);menu.appendChild(body);}
    else{var body2=document.createElement('div');body2.style.padding='6px';while(menu.firstChild)body2.appendChild(menu.firstChild);menu.appendChild(body2);}
    document.documentElement.appendChild(menu);
    var mx=${tabLocalX},my=${tabLocalY};
    var r=menu.getBoundingClientRect();
    if(mx+r.width>window.innerWidth)mx=window.innerWidth-r.width-8;
    if(my+r.height>window.innerHeight)my=window.innerHeight-r.height-8;
    if(mx<4)mx=4;if(my<4)my=4;
    menu.style.left=mx+'px';menu.style.top=my+'px';
    menu.querySelectorAll('.ghm-i').forEach(function(el){el.onclick=function(){doAction(el.dataset.action,el.dataset.data);};});
    var loginBtn=menu.querySelector('[data-act="gh_login"]');
    if(loginBtn)loginBtn.onclick=function(){doAction('gh_login','');};
  })();void 0;`).catch(() => {});

  const ghHandler = (event) => {
    const message = event.message;
    const prefix = '__gb_gh_ctx:' + ghToken + ':';
    if (!message || !message.startsWith(prefix)) return;
    tabView.webContents.removeListener('console-message', ghHandler);
    _prevGhHandler = null; _prevGhWc = null;
    try {
      const { action, data } = JSON.parse(message.replace(prefix, ''));
      handleGhAction(action, data);
    } catch {}
  };
  _prevGhHandler = ghHandler;
  _prevGhWc = tabView.webContents;
  tabView.webContents.on('console-message', ghHandler);
  setTimeout(() => { try { tabView.webContents.removeListener('console-message', ghHandler); } catch {} if (_prevGhHandler === ghHandler) { _prevGhHandler = null; _prevGhWc = null; } }, 10000);
});

ipcMain.on('navigate', (e, input) => {
  const ctx = getWindowCtx(e.sender);
  if (!ctx || !ctx.activeTabId) return;
  const url = normalizeUrl(input);
  // SEC-05: Block dangerous URL schemes
  if (isBlockedUrl(url)) return;
  navigateTab(ctx, ctx.activeTabId, url);
});

// Bookmark
ipcMain.on('add-bookmark', async (e, data) => {
  const ctx = getWindowCtx(e.sender);
  try {
    // If title is empty, get it from the active tab
    let title = data.title;
    if (!title && ctx && ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)) {
      title = ctx.tabs.get(ctx.activeTabId).title || '';
    }
    await rustBridge.call('bookmark.add', { url: data.url, title });
    sendToToolbar(ctx, 'toast', { message: cmL('bookmarks.added_toast', 'Bookmark added') });
  } catch { sendToToolbar(ctx, 'toast', { message: cmL('bookmarks.failed_toast', 'Failed to add bookmark') }); }
});

ipcMain.handle('bookmark-list', async () => {
  try { return await rustBridge.call('bookmark.list', {}); } catch { return []; }
});
ipcMain.handle('bookmark-search', async (_e, query) => {
  try { return await rustBridge.call('bookmark.search', { query }); } catch { return []; }
});
ipcMain.on('bookmark-delete', async (_e, id) => {
  try { await rustBridge.call('bookmark.delete', { id }); sendToToolbar(primaryWindowCtx, 'toast', { message: cmL('bookmarks.removed_toast', 'Bookmark removed') }); } catch {}
});

// History
ipcMain.handle('history-recent', async () => {
  try { return await rustBridge.call('history.recent', {}); } catch { return []; }
});
ipcMain.handle('history-search', async (_e, query) => {
  try { return await rustBridge.call('history.search', { query }); } catch { return []; }
});
ipcMain.on('history-clear', async (e) => {
  const ctx = getWindowCtx(e.sender);
  try { await rustBridge.call('history.clear', {}); sendToToolbar(ctx, 'toast', { message: cmL('history.cleared', 'History cleared') }); } catch {}
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
  // Broadcast visibility changes immediately (before Rust call, so UI updates even if backend fails)
  if (key === 'appearance.show_telegram') {
    sendToToolbar(primaryWindowCtx, 'telegram-btn-visible', { visible: !!value });
    if (!value && telegramVisible) hideTelegram();
  }
  if (key === 'appearance.show_github') {
    sendToToolbar(primaryWindowCtx, 'gh-btn-visible', { visible: !!value });
  }
  try {
    const result = await rustBridge.call('settings.set', { key, value });
    // Broadcast theme change to all views
    if (key === 'appearance.theme') {
      broadcastTheme(value);
    }
    // Broadcast font size change to all views
    if (key === 'appearance.font_size') {
      const size = parseInt(value) || 14;
      for (const ctx of windowRegistry.values()) {
        for (const [, tabData] of ctx.tabs) {
          if (!tabData.view.webContents.isDestroyed()) {
            tabData.view.webContents.setZoomFactor(size / 14);
          }
        }
      }
    }
    // Broadcast accent color change to all views
    if (key === 'appearance.accent_color') {
      const color = value || '#3b82f6';
      const css = `:root{--accent-fg:${color};--accent-emphasis:${color};--accent-glow:${color}55}`;
      for (const ctx of windowRegistry.values()) {
        sendToToolbar(ctx, 'accent-changed', { color, css });
        for (const [, tabData] of ctx.tabs) {
          if (!tabData.view.webContents.isDestroyed() && isInternalUrl(tabData.url)) {
            tabData.view.webContents.insertCSS(css).catch(() => {});
          }
        }
      }
    }
    // Cache search engine
    if (key === 'general.default_search_engine') {
      currentSearchEngine = value || 'google';
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
ipcMain.on('open-url', (e, url) => {
  // SEC-05: Block dangerous URL schemes
  if (isBlockedUrl(url)) return;
  const ctx = getWindowCtx(e.sender);
  if (ctx && ctx.activeTabId) navigateTab(ctx, ctx.activeTabId, url);
  else if (ctx) createTab(ctx, url);
});
ipcMain.on('open-url-new-tab', (e, url) => {
  if (isBlockedUrl(url)) return;
  const ctx = getWindowCtx(e.sender);
  createTab(ctx, url);
});

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
   '__gb-page-ctx','__gb-page-ctx-style','__gb-page-ctx-ov','__gb-page-ctx-sub','__gb-page-ctx-tr-sub',
   '__gb-translate-pop','__gb-translate-pop-style']
  .forEach(function(id){var e=document.getElementById(id);if(e)e.remove();});
`;

// Shows a custom glass context menu in the active tab view (which is large enough)
// by converting coordinates from the source view to the tab view coordinate space.
function showOverlayContextMenu(ctx, sourceWc, params, viewOffsetX, viewOffsetY) {
  // We need an active tab to host the menu
  if (!ctx || !ctx.activeTabId || !ctx.tabs.has(ctx.activeTabId)) {
    // Fallback to native menu if no tab is open
    buildNativeContextMenu(sourceWc, params);
    return;
  }

  const overlayToken = generateCtxToken();
  const tabView = ctx.tabs.get(ctx.activeTabId).view;
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
        console.log('__gb_ctx_overlay:${overlayToken}:'+JSON.stringify({action:this.dataset.action,data:this.dataset.data}));
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
    const prefix = '__gb_ctx_overlay:' + overlayToken + ':';
    if (!message || !message.startsWith(prefix)) return;
    tabView.webContents.removeListener('console-message', overlayHandler);
    try {
      const { action } = JSON.parse(message.replace(prefix, ''));
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
  const pageToken = generateCtxToken();
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

  // AI submenu items (without translate — moved to dedicated translator)
  let aiSub = [];
  if (hasSelection && selText.length >= 2) {
    aiSub = [
      { label: cmL('context_menu.fix_errors', 'Исправить ошибки'), action: 'ai', data: JSON.stringify({ type: 'fix', text: selText }) },
      { label: cmL('context_menu.rephrase', 'Перефразировать'), action: 'ai', data: JSON.stringify({ type: 'rephrase', text: selText }) },
      { type: 'separator' },
      { label: cmL('context_menu.summarize', 'Резюмировать'), action: 'ai', data: JSON.stringify({ type: 'summarize', text: selText }) },
      { label: cmL('context_menu.explain', 'Объяснить'), action: 'ai', data: JSON.stringify({ type: 'explain', text: selText }) },
    ];
  }

  // Translate submenu languages
  const translateLangs = [
    { code: 'en', label: 'English' }, { code: 'ru', label: 'Русский' },
    { code: 'de', label: 'Deutsch' }, { code: 'fr', label: 'Français' },
    { code: 'es', label: 'Español' }, { code: 'it', label: 'Italiano' },
    { code: 'pt', label: 'Português' }, { code: 'zh', label: '中文' },
    { code: 'ja', label: '日本語' }, { code: 'ko', label: '한국어' },
    { code: 'ar', label: 'العربية' }, { code: 'hi', label: 'हिन्दी' },
    { code: 'tr', label: 'Türkçe' }, { code: 'pl', label: 'Polski' },
    { code: 'uk', label: 'Українська' }, { code: 'nl', label: 'Nederlands' },
  ];
  let translateSub = [];
  if (hasSelection && selText.length >= 1) {
    translateSub = translateLangs.map(l => ({
      label: l.label, action: 'translate', data: JSON.stringify({ lang: l.code, text: selText }),
    }));
  }

  if (process.argv.includes('--dev')) {
    items.push({ type: 'separator' });
    items.push({ label: cmL('context_menu.inspect', 'Инспектировать элемент'), action: 'inspect' });
  }

  const menuData = JSON.stringify(items);
  const aiSubData = JSON.stringify(aiSub);
  const aiLabel = JSON.stringify(cmL('context_menu.ai', 'AI'));
  const translateSubData = JSON.stringify(translateSub);
  const translateLabel = JSON.stringify(cmL('context_menu.translate', 'Перевести'));
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
      var tr=document.getElementById('__gb-page-ctx-tr-sub');if(tr)tr.remove();
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
        else{console.log('__gb_page_ctx:${pageToken}:'+JSON.stringify({action:act,data:dat}));}
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
    var translateSub=${translateSubData};
    var translateLabel=${translateLabel};

    items.forEach(function(it){
      if(it.type==='separator'){var s=document.createElement('div');s.className='pci-sep';menu.appendChild(s);return;}
      var d=document.createElement('div');d.className='pci'+(it.disabled?' disabled':'');
      d.innerHTML='<span class="pci-label">'+it.label+'</span>'+(it.accel?'<span class="pci-accel">'+it.accel+'</span>':'');
      d.onclick=function(){doAction(it.action||'',it.data||'');};
      menu.appendChild(d);
    });

    // ─── Translate submenu ───
    function showSubAt(parentRow, subItems, subId){
      var subTimer2=null;
      function show(){
        clearTimeout(subTimer2);
        var old=document.getElementById(subId);if(old)old.remove();
        var sub=document.createElement('div');sub.id=subId;sub.className='__gbp';
        sub.style.maxHeight='320px';sub.style.overflowY='auto';
        subItems.forEach(function(si){
          if(si.type==='separator'){var ss=document.createElement('div');ss.className='pci-sep';sub.appendChild(ss);return;}
          var sd=document.createElement('div');sd.className='pci';
          sd.innerHTML='<span class="pci-label">'+si.label+'</span>';
          sd.onclick=function(){doAction(si.action||'',si.data||'');};
          sub.appendChild(sd);
        });
        document.documentElement.appendChild(sub);
        var mr=menu.getBoundingClientRect();var sr=sub.getBoundingClientRect();
        var sx=mr.right+4,sy=parentRow.getBoundingClientRect().top;
        if(sx+sr.width>window.innerWidth)sx=mr.left-sr.width-4;
        if(sy+sr.height>window.innerHeight)sy=window.innerHeight-sr.height-8;
        if(sy<4)sy=4;
        sub.style.left=sx+'px';sub.style.top=sy+'px';
        sub.onmouseenter=function(){clearTimeout(subTimer2);};
        sub.onmouseleave=function(){subTimer2=setTimeout(function(){sub.remove();},200);};
      }
      parentRow.onmouseenter=function(){
        // Close other submenus
        var ids=['__gb-page-ctx-sub','__gb-page-ctx-tr-sub'];
        ids.forEach(function(i){if(i!==subId){var e=document.getElementById(i);if(e)e.remove();}});
        show();
      };
      parentRow.onmouseleave=function(){subTimer2=setTimeout(function(){var s=document.getElementById(subId);if(s)s.remove();},200);};
      parentRow.onclick=function(){show();};
    }

    if(translateSub.length>0){
      var tsep=document.createElement('div');tsep.className='pci-sep';menu.appendChild(tsep);
      var trRow=document.createElement('div');trRow.className='pci';
      trRow.innerHTML='<span class="pci-label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px;opacity:0.7"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>'+translateLabel+'</span><span class="pci-arrow">&#9656;</span>';
      showSubAt(trRow, translateSub, '__gb-page-ctx-tr-sub');
      menu.appendChild(trRow);
    }

    // ─── AI submenu ───
    if(aiSub.length>0){
      var sep=document.createElement('div');sep.className='pci-sep';menu.appendChild(sep);
      var aiRow=document.createElement('div');aiRow.className='pci';
      aiRow.innerHTML='<span class="pci-label">'+aiLabel+'</span><span class="pci-arrow">&#9656;</span>';
      showSubAt(aiRow, aiSub, '__gb-page-ctx-sub');
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
    const prefix = '__gb_page_ctx:' + pageToken + ':';
    if (!message || !message.startsWith(prefix)) return;
    try { wc.removeListener('console-message', consoleHandler); } catch {}
    _pageCtxConsoleHandler = null;
    try {
      const { action, data } = JSON.parse(message.replace(prefix, ''));
      if (action === 'copy') wc.copy();
      else if (action === 'cut') wc.cut();
      else if (action === 'paste') wc.paste();
      else if (action === 'selectAll') wc.selectAll();
      else if (action === 'openLink' && data) { const _ctx = getWindowCtx(wc); createTab(_ctx, data); }
      else if (action === 'copyLink' && data) clipboard.writeText(data);
      else if (action === 'saveImage' && data) wc.downloadURL(data);
      else if (action === 'copyImageUrl' && data) clipboard.writeText(data);
      else if (action === 'openImageTab' && data) { const _ctx = getWindowCtx(wc); createTab(_ctx, data); }
      else if (action === 'inspect') wc.inspectElement(params.x, params.y);
      else if (action === 'ai' && data) {
        try {
          const aiData = JSON.parse(data);
          runAiAction(wc, aiData.type, aiData.text);
        } catch {}
      }
      else if (action === 'translate' && data) {
        try {
          const trData = JSON.parse(data);
          runGoogleTranslate(wc, trData.text, trData.lang);
        } catch {}
      }
    } catch {}
  };
  _pageCtxConsoleHandler = consoleHandler;
  if (!wc.isDestroyed()) wc.on('console-message', consoleHandler);
  setTimeout(() => { try { if (!wc.isDestroyed()) wc.removeListener('console-message', consoleHandler); } catch {} if (_pageCtxConsoleHandler === consoleHandler) _pageCtxConsoleHandler = null; }, 10000);
}

// ─── Google Translate (free API, no key required) ───

const TRANSLATE_LANG_NAMES = {
  af:'Afrikaans',am:'Amharic',ar:'العربية',az:'Azərbaycan',be:'Беларуская',bg:'Български',bn:'বাংলা',
  bs:'Bosanski',ca:'Català',ceb:'Cebuano',co:'Corsu',cs:'Čeština',cy:'Cymraeg',da:'Dansk',
  de:'Deutsch',el:'Ελληνικά',en:'English',eo:'Esperanto',es:'Español',et:'Eesti',eu:'Euskara',
  fa:'فارسی',fi:'Suomi',fr:'Français',fy:'Frysk',ga:'Gaeilge',gd:'Gàidhlig',gl:'Galego',
  gu:'ગુજરાતી',ha:'Hausa',haw:'ʻŌlelo Hawaiʻi',he:'עברית',hi:'हिन्दी',hmn:'Hmong',hr:'Hrvatski',
  ht:'Kreyòl ayisyen',hu:'Magyar',hy:'Հայերեն',id:'Bahasa Indonesia',ig:'Igbo',is:'Íslenska',
  it:'Italiano',ja:'日本語',jw:'Jawa',ka:'ქართული',kk:'Қазақ',km:'ខ្មែរ',kn:'ಕನ್ನಡ',
  ko:'한국어',ku:'Kurdî',ky:'Кыргызча',la:'Latina',lb:'Lëtzebuergesch',lo:'ລາວ',lt:'Lietuvių',
  lv:'Latviešu',mg:'Malagasy',mi:'Māori',mk:'Македонски',ml:'മലയാളം',mn:'Монгол',mr:'मराठी',
  ms:'Bahasa Melayu',mt:'Malti',my:'မြန်မာ',ne:'नेपाली',nl:'Nederlands',no:'Norsk',ny:'Chichewa',
  or:'ଓଡ଼ିଆ',pa:'ਪੰਜਾਬੀ',pl:'Polski',ps:'پښتو',pt:'Português',ro:'Română',ru:'Русский',
  rw:'Kinyarwanda',sd:'سنڌي',si:'සිංහල',sk:'Slovenčina',sl:'Slovenščina',sm:'Samoan',sn:'Shona',
  so:'Soomaali',sq:'Shqip',sr:'Српски',st:'Sesotho',su:'Basa Sunda',sv:'Svenska',sw:'Kiswahili',
  ta:'தமிழ்',te:'తెలుగు',tg:'Тоҷикӣ',th:'ไทย',tk:'Türkmen',tl:'Filipino',tr:'Türkçe',
  tt:'Татар',ug:'ئۇيغۇرچە',uk:'Українська',ur:'اردو',uz:'Oʻzbek',vi:'Tiếng Việt',
  xh:'isiXhosa',yi:'ייִדיש',yo:'Yorùbá',zh:'中文','zh-TW':'中文(繁體)',zu:'isiZulu',
};

async function googleTranslateText(text, targetLang, sourceLang = 'auto') {
  const encoded = encodeURIComponent(text.substring(0, 5000));
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&dt=bd&dj=1&q=${encoded}`;
  const resp = await net.fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!resp.ok) throw new Error('Google Translate HTTP ' + resp.status);
  const data = await resp.json();
  // Extract translated text from sentences
  let translated = '';
  if (data.sentences) {
    for (const s of data.sentences) {
      if (s.trans) translated += s.trans;
    }
  }
  const detectedLang = data.src || sourceLang;
  // Extract dictionary/alternative translations if available
  let alternatives = [];
  if (data.dict) {
    for (const d of data.dict) {
      if (d.terms && d.pos) {
        alternatives.push({ pos: d.pos, terms: d.terms.slice(0, 4) });
      }
    }
  }
  return { translated, detectedLang, alternatives };
}

async function runGoogleTranslate(wc, text, targetLang) {
  if (wc.isDestroyed()) return;
  injectTranslatePopup(wc, { loading: true, targetLang, originalText: text });
  try {
    const result = await googleTranslateText(text, targetLang);
    injectTranslatePopup(wc, {
      loading: false, targetLang, originalText: text,
      translated: result.translated,
      detectedLang: result.detectedLang,
      alternatives: result.alternatives,
    });
  } catch (err) {
    injectTranslatePopup(wc, {
      loading: false, targetLang, originalText: text,
      error: err.message || 'Translation failed',
    });
  }
}

function injectTranslatePopup(wc, opts) {
  if (wc.isDestroyed()) return;
  const langNames = JSON.stringify(TRANSLATE_LANG_NAMES);
  const data = JSON.stringify(opts);
  const copyLabel = cmL('ai.copy', 'Copy');
  const replaceLabel = cmL('ai.replace', 'Replace');
  const closeLabel = cmL('common.close', 'Close');
  const retranslateLabel = cmL('context_menu.translate', 'Перевести');

  const js = `(function(){
    var LANGS=${langNames};
    var opts=${data};
    var copyL=${JSON.stringify(copyLabel)};
    var replL=${JSON.stringify(replaceLabel)};
    var retranL=${JSON.stringify(retranslateLabel)};

    // Save selection info BEFORE we touch the DOM (only on first/loading call)
    if(opts.loading && !window.__gbTrSel){
      var _s=window.getSelection();
      var _ae=document.activeElement;
      var info={type:'none'};
      if(_ae&&(_ae.tagName==='TEXTAREA'||(_ae.tagName==='INPUT'&&_ae.type==='text'))){
        info={type:'input',el:_ae,start:_ae.selectionStart,end:_ae.selectionEnd};
      } else if(_ae&&_ae.isContentEditable){
        if(_s&&_s.rangeCount>0){try{info={type:'editable',el:_ae,range:_s.getRangeAt(0).cloneRange()};}catch(e){}}
      } else if(_s&&_s.rangeCount>0&&!_s.isCollapsed){
        try{info={type:'range',range:_s.getRangeAt(0).cloneRange()};}catch(e){}
      }
      window.__gbTrSel=info;
    }

    // Remove old popup
    var old=document.getElementById('__gb-translate-pop');if(old)old.remove();
    var oldS=document.getElementById('__gb-translate-pop-style');if(oldS)oldS.remove();

    var style=document.createElement('style');style.id='__gb-translate-pop-style';
    style.textContent=\`
      #__gb-translate-pop{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;
        background:rgba(22,27,34,0.97);border:1px solid rgba(255,255,255,0.08);border-radius:14px;
        padding:0;box-shadow:0 16px 48px rgba(0,0,0,.6),0 4px 12px rgba(0,0,0,.3);
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        max-width:520px;min-width:320px;max-height:80vh;display:flex;flex-direction:column;color:#e6edf3;
        animation:__gbTrIn 0.2s cubic-bezier(0.16,1,0.3,1);overflow:hidden;}
      @keyframes __gbTrIn{from{opacity:0;transform:translate(-50%,-50%) scale(0.95)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
      #__gb-translate-pop .tr-hd{display:flex;align-items:center;padding:14px 16px 10px;gap:8px;border-bottom:1px solid rgba(255,255,255,0.06);}
      #__gb-translate-pop .tr-hd svg{flex-shrink:0;opacity:0.6;}
      #__gb-translate-pop .tr-hd-title{flex:1;font-size:13px;font-weight:600;color:#7d8590;}
      #__gb-translate-pop .tr-hd-close{background:none;border:none;color:#7d8590;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:4px;}
      #__gb-translate-pop .tr-hd-close:hover{color:#e6edf3;background:rgba(255,255,255,0.06);}
      #__gb-translate-pop .tr-langs{display:flex;align-items:center;padding:10px 16px;gap:8px;font-size:12px;color:#7d8590;}
      #__gb-translate-pop .tr-lang-badge{padding:3px 8px;border-radius:6px;background:rgba(255,255,255,0.06);font-size:11px;font-weight:500;}
      #__gb-translate-pop .tr-arrow{opacity:0.4;}
      #__gb-translate-pop .tr-lang-sel{padding:3px 8px;border-radius:6px;background:rgba(88,166,255,0.12);color:#58a6ff;
        border:1px solid rgba(88,166,255,0.2);font-size:11px;font-weight:500;cursor:pointer;font-family:inherit;appearance:none;-webkit-appearance:none;}
      #__gb-translate-pop .tr-lang-sel:hover{background:rgba(88,166,255,0.2);}
      #__gb-translate-pop .tr-body{padding:12px 16px;overflow-y:auto;flex:1;max-height:50vh;}
      #__gb-translate-pop .tr-text{font-size:15px;line-height:1.65;white-space:pre-wrap;word-break:break-word;}
      #__gb-translate-pop .tr-alt{margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.06);}
      #__gb-translate-pop .tr-alt-pos{font-size:11px;color:#58a6ff;font-weight:600;text-transform:lowercase;margin-bottom:4px;}
      #__gb-translate-pop .tr-alt-terms{font-size:12px;color:#7d8590;line-height:1.5;}
      #__gb-translate-pop .tr-ld{color:#7d8590;font-size:13px;display:flex;align-items:center;gap:8px;padding:20px 16px;}
      #__gb-translate-pop .tr-ld::before{content:"";width:14px;height:14px;border:2px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:__gbTrSp .6s linear infinite;}
      @keyframes __gbTrSp{to{transform:rotate(360deg)}}
      #__gb-translate-pop .tr-err{color:#f85149;padding:16px;font-size:13px;}
      #__gb-translate-pop .tr-ft{display:flex;gap:8px;padding:10px 16px 14px;border-top:1px solid rgba(255,255,255,0.06);justify-content:flex-end;align-items:center;}
      #__gb-translate-pop .tr-ft .tr-powered{flex:1;font-size:10px;color:rgba(255,255,255,0.2);}
      #__gb-translate-pop .tr-btn{padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
        border:1px solid #30363d;background:#21262d;color:#e6edf3;transition:all 0.15s;}
      #__gb-translate-pop .tr-btn:hover{border-color:#58a6ff;background:#30363d;}
      #__gb-translate-pop .tr-btn.pr{background:#1f6feb;border-color:#1f6feb;color:#fff;}
      #__gb-translate-pop .tr-btn.pr:hover{background:#388bfd;}
      html.light #__gb-translate-pop{background:rgba(255,255,255,0.97);border-color:rgba(0,0,0,0.1);color:#1f2328;
        box-shadow:0 16px 48px rgba(0,0,0,.12),0 4px 12px rgba(0,0,0,.06);}
      html.light #__gb-translate-pop .tr-hd{border-color:rgba(0,0,0,0.06);}
      html.light #__gb-translate-pop .tr-hd-title{color:#656d76;}
      html.light #__gb-translate-pop .tr-hd-close{color:#656d76;}
      html.light #__gb-translate-pop .tr-hd-close:hover{color:#1f2328;background:rgba(0,0,0,0.06);}
      html.light #__gb-translate-pop .tr-langs{color:#656d76;}
      html.light #__gb-translate-pop .tr-lang-badge{background:rgba(0,0,0,0.05);}
      html.light #__gb-translate-pop .tr-lang-sel{background:rgba(9,105,218,0.08);color:#0969da;border-color:rgba(9,105,218,0.2);}
      html.light #__gb-translate-pop .tr-lang-sel:hover{background:rgba(9,105,218,0.15);}
      html.light #__gb-translate-pop .tr-text{color:#1f2328;}
      html.light #__gb-translate-pop .tr-alt{border-color:rgba(0,0,0,0.06);}
      html.light #__gb-translate-pop .tr-alt-pos{color:#0969da;}
      html.light #__gb-translate-pop .tr-alt-terms{color:#656d76;}
      html.light #__gb-translate-pop .tr-ld{color:#656d76;}
      html.light #__gb-translate-pop .tr-ld::before{border-color:rgba(0,0,0,0.1);border-top-color:#0969da;}
      html.light #__gb-translate-pop .tr-err{color:#cf222e;}
      html.light #__gb-translate-pop .tr-ft{border-color:rgba(0,0,0,0.06);}
      html.light #__gb-translate-pop .tr-ft .tr-powered{color:rgba(0,0,0,0.2);}
      html.light #__gb-translate-pop .tr-btn{border-color:rgba(0,0,0,0.15);background:rgba(0,0,0,0.03);color:#1f2328;}
      html.light #__gb-translate-pop .tr-btn:hover{border-color:#0969da;background:rgba(0,0,0,0.06);}
      html.light #__gb-translate-pop .tr-btn.pr{background:#0969da;border-color:#0969da;color:#fff;}
      html.light #__gb-translate-pop .tr-btn.pr:hover{background:#0860ca;}
    \`;
    document.documentElement.appendChild(style);

    var pop=document.createElement('div');pop.id='__gb-translate-pop';

    if(opts.loading){
      pop.innerHTML='<div class="tr-hd"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg><span class="tr-hd-title">Google Translate</span><button class="tr-hd-close" id="__gbTrX">&times;</button></div><div class="tr-body"><div class="tr-ld">Translating...</div></div>';
      document.documentElement.appendChild(pop);
      document.getElementById('__gbTrX').onclick=function(){pop.remove();style.remove();};
      return;
    }

    if(opts.error){
      pop.innerHTML='<div class="tr-hd"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg><span class="tr-hd-title">Google Translate</span><button class="tr-hd-close" id="__gbTrX">&times;</button></div><div class="tr-body"><div class="tr-err">'+opts.error.replace(/</g,'&lt;')+'</div></div>';
      document.documentElement.appendChild(pop);
      document.getElementById('__gbTrX').onclick=function(){pop.remove();style.remove();};
      return;
    }

    // Success — build full popup
    var srcName=LANGS[opts.detectedLang]||opts.detectedLang||'auto';
    var tgtName=LANGS[opts.targetLang]||opts.targetLang;

    // Language selector options
    var langOpts='';
    var popularLangs=['en','ru','de','fr','es','it','pt','zh','ja','ko','ar','hi','tr','pl','uk','nl','sv','cs','ro','hu','th','vi','id','el','he','da','fi','no','bg','hr','sk','sl','sr','lt','lv','et','ka','az','be','kk','uz','tg','ky','mn','ms','tl','sw','am','bn','ta','te','ml','kn','gu','mr','pa','ur','fa','ps','sd','ne','si','my','km','lo','ka'];
    popularLangs.forEach(function(c){
      var n=LANGS[c]||c;
      langOpts+='<option value="'+c+'"'+(c===opts.targetLang?' selected':'')+'>'+n+'</option>';
    });

    var altHtml='';
    if(opts.alternatives&&opts.alternatives.length>0){
      altHtml='<div class="tr-alt">';
      opts.alternatives.forEach(function(a){
        altHtml+='<div class="tr-alt-pos">'+a.pos+'</div>';
        altHtml+='<div class="tr-alt-terms">'+a.terms.join(', ')+'</div>';
      });
      altHtml+='</div>';
    }

    pop.innerHTML=
      '<div class="tr-hd"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg><span class="tr-hd-title">Google Translate</span><button class="tr-hd-close" id="__gbTrX">&times;</button></div>'+
      '<div class="tr-langs"><span class="tr-lang-badge">'+srcName+'</span><span class="tr-arrow">&rarr;</span><select class="tr-lang-sel" id="__gbTrLang">'+langOpts+'</select></div>'+
      '<div class="tr-body"><div class="tr-text" id="__gbTrText">'+opts.translated.replace(/</g,'&lt;')+'</div>'+altHtml+'</div>'+
      '<div class="tr-ft"><span class="tr-powered">Google Translate</span><button class="tr-btn" id="__gbTrCopy">'+copyL+'</button><button class="tr-btn pr" id="__gbTrReplace">'+replL+'</button></div>';

    document.documentElement.appendChild(pop);

    document.getElementById('__gbTrX').onclick=function(){window.__gbTrSel=null;pop.remove();style.remove();};

    // Copy button
    document.getElementById('__gbTrCopy').onclick=function(){
      var btn=this;
      navigator.clipboard.writeText(opts.translated).then(function(){
        btn.textContent='✓ Copied';
        setTimeout(function(){btn.textContent=copyL;},1500);
      }).catch(function(){});
    };

    // Replace button — replace selected text on page using saved selection
    document.getElementById('__gbTrReplace').onclick=function(){
      var newText=opts.translated;
      var orig=opts.originalText;
      var done=false;
      var sel=window.__gbTrSel||{type:'none'};

      try{
        // Case 1: input/textarea — find original text and replace
        if(sel.type==='input'&&sel.el&&document.contains(sel.el)){
          var el=sel.el;
          var v=el.value;
          var idx=v.indexOf(orig);
          if(idx>=0){
            el.focus();
            el.setSelectionRange(idx,idx+orig.length);
            document.execCommand('insertText',false,newText);
            done=true;
          }
        }
        // Case 2: contentEditable — restore saved range and insert
        if(!done&&sel.type==='editable'&&sel.el&&document.contains(sel.el)&&sel.range){
          try{
            sel.el.focus();
            var s2=window.getSelection();s2.removeAllRanges();s2.addRange(sel.range);
            document.execCommand('insertText',false,newText);
            done=true;
          }catch(e){}
        }
        // Case 3: regular page selection — restore saved range and replace node content
        if(!done&&sel.type==='range'&&sel.range){
          try{
            pop.style.visibility='hidden';
            var rng=sel.range;
            var s3=window.getSelection();s3.removeAllRanges();s3.addRange(rng);
            rng.deleteContents();
            rng.insertNode(document.createTextNode(newText));
            s3.removeAllRanges();
            done=true;
            pop.style.visibility='visible';
          }catch(e){pop.style.visibility='visible';}
        }
      }catch(e){}

      // Fallback: walk the DOM and find the original text
      if(!done){
        try{
          pop.style.visibility='hidden';
          if(window.find&&window.find(orig,false,false,false,false,false,false)){
            var fs=window.getSelection();
            if(fs&&!fs.isCollapsed){
              var fr=fs.getRangeAt(0);fr.deleteContents();fr.insertNode(document.createTextNode(newText));
              fs.removeAllRanges();done=true;
            }
          }
          pop.style.visibility='visible';
        }catch(e){pop.style.visibility='visible';}
      }
      if(!done){
        try{
          var tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);var nd;
          while(nd=tw.nextNode()){var idx=nd.textContent.indexOf(orig);if(idx>=0){nd.textContent=nd.textContent.substring(0,idx)+newText+nd.textContent.substring(idx+orig.length);done=true;break;}}
        }catch(e){}
      }

      window.__gbTrSel=null;
      if(done){pop.remove();style.remove();}
      else{this.textContent='Not found';this.disabled=true;}
    };

    // Language selector — re-translate on change
    document.getElementById('__gbTrLang').onchange=function(){
      var newLang=this.value;
      pop.remove();style.remove();
      // Trigger re-translation via IPC or console
      if(window.gitbrowser&&window.gitbrowser.ctxAction){
        window.gitbrowser.ctxAction('translate',JSON.stringify({lang:newLang,text:opts.originalText}));
      }else{
        console.log('__gb_page_ctx:'+JSON.stringify({action:'translate',data:JSON.stringify({lang:newLang,text:opts.originalText})}));
      }
    };
  })();void 0;`;
  wc.executeJavaScript(js).catch(() => {});
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
  const _tv = primaryWindowCtx ? primaryWindowCtx.toolbarView : null;
  if (_tv && !_tv.webContents.isDestroyed()) {
    try {
      const result = await _tv.webContents.executeJavaScript(`
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

ipcMain.handle('password-decrypt', async (_e, { id }) => {
  try { return await rustBridge.call('password.decrypt', { id }); }
  catch (err) { return { error: err.message || String(err) }; }
});

ipcMain.on('open-passwords', (e) => { const ctx = getWindowCtx(e.sender); openOrSwitchTab(ctx, 'gb://passwords'); });

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

// ─── Telegram Widget ───
// Uses a child BrowserWindow with transparent background for real rounded corners.
// The window is cached (hidden, not destroyed) so Telegram loads only once.
// Titlebar is injected as a fixed overlay on top of Telegram content.

function showTelegram() {
  const mainWindow = getMainWindow();
  if (!mainWindow) return;

  if (!telegramWin) {
    // Position bottom-right of main window
    const mainBounds = mainWindow.getBounds();
    const contentBounds = mainWindow.getContentBounds();
    telegramBounds.x = mainBounds.x + contentBounds.width - telegramBounds.width - 20;
    telegramBounds.y = mainBounds.y + contentBounds.height - telegramBounds.height - 20;

    // Dedicated session for Telegram
    const telegramSes = session.fromPartition('persist:telegram');
    telegramSes.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    telegramWin = new BrowserWindow({
      parent: mainWindow,
      x: telegramBounds.x,
      y: telegramBounds.y,
      width: telegramBounds.width,
      height: telegramBounds.height,
      minWidth: 280,
      minHeight: 350,
      maxWidth: 800,
      maxHeight: 900,
      frame: false,
      transparent: false,
      roundedCorners: true,
      thickFrame: true,
      resizable: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#0d1117',
      webPreferences: {
        contextIsolation: true,
        sandbox: false,
        partition: 'persist:telegram',
        preload: path.join(__dirname, 'preload.js'),
      },
    });

    // Load Telegram directly
    telegramWin.loadURL('https://web.telegram.org/k/');

    // Inject titlebar overlay once page loads
    const injectTitlebar = () => {
      if (telegramWin.isDestroyed()) return;
      telegramWin.webContents.insertCSS(`
        #__gb-tg-bar{position:fixed;top:0;left:0;right:0;height:32px;z-index:999999;
          background:rgba(18,22,30,0.95);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
          display:flex;align-items:center;justify-content:space-between;padding:0 8px;
          -webkit-app-region:drag;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
          border-bottom:1px solid rgba(255,255,255,0.06);user-select:none;-webkit-user-select:none;}
        #__gb-tg-bar *{-webkit-app-region:no-drag}
        #__gb-tg-bar .lbl{font-size:11px;color:#7c8494;font-weight:600;display:flex;align-items:center;gap:6px;-webkit-app-region:drag}
        #__gb-tg-bar .lbl svg{width:14px;height:14px;fill:#60a5fa}
        #__gb-tg-bar .cbtn{width:24px;height:24px;border:none;background:none;color:#4a5168;cursor:pointer;
          border-radius:6px;display:flex;align-items:center;justify-content:center;transition:all 0.15s}
        #__gb-tg-bar .cbtn:hover{background:rgba(220,38,38,0.15);color:#f87171}
        body{padding-top:32px !important}
      `).catch(() => {});
      telegramWin.webContents.executeJavaScript(`
        (function(){
          if(document.getElementById('__gb-tg-bar'))return;
          var bar=document.createElement('div');bar.id='__gb-tg-bar';
          bar.innerHTML='<span class="lbl"><svg viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>Telegram</span><button class="cbtn" title="Close"><svg width="8" height="8" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.5" fill="none"><line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/></svg></button>';
          bar.querySelector('.cbtn').onclick=function(){if(window.gitbrowser)window.gitbrowser.telegramToggle();};
          document.body.prepend(bar);
        })();
      `).catch(() => {});
    };

    telegramWin.webContents.on('did-finish-load', injectTitlebar);
    telegramWin.webContents.on('dom-ready', injectTitlebar);

    telegramWin.webContents.setWindowOpenHandler(({ url }) => {
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) createTab(primaryWindowCtx, url);
      return { action: 'deny' };
    });

    telegramWin.on('close', (e) => {
      e.preventDefault();
      hideTelegram();
    });

    telegramWin.on('moved', () => {
      if (telegramWin && !telegramWin.isDestroyed()) {
        const b = telegramWin.getBounds();
        telegramBounds.x = b.x;
        telegramBounds.y = b.y;
      }
    });

    telegramWin.on('resized', () => {
      if (telegramWin && !telegramWin.isDestroyed()) {
        const b = telegramWin.getBounds();
        telegramBounds.width = b.width;
        telegramBounds.height = b.height;
      }
    });

    telegramView = telegramWin; // compat reference
  }

  telegramWin.setBounds({
    x: telegramBounds.x,
    y: telegramBounds.y,
    width: telegramBounds.width,
    height: telegramBounds.height,
  });
  telegramWin.show();
  telegramVisible = true;
  sendToToolbar(primaryWindowCtx, 'telegram-state', { visible: true });
}

function hideTelegram() {
  if (telegramWin && !telegramWin.isDestroyed()) {
    telegramWin.hide();
  }
  telegramVisible = false;
  sendToToolbar(primaryWindowCtx, 'telegram-state', { visible: false });
}

ipcMain.on('telegram-toggle', () => {
  if (telegramVisible) hideTelegram();
  else showTelegram();
});

ipcMain.on('telegram-btn-set-visible', (_e, visible) => {
  sendToToolbar(primaryWindowCtx, 'telegram-btn-visible', { visible: !!visible });
  if (!visible && telegramVisible) hideTelegram();
});

ipcMain.on('telegram-drag', (_e, { dx, dy }) => {
  // Drag handled natively by -webkit-app-region: drag
});

ipcMain.on('telegram-resize-delta', (_e, { dx, dy }) => {
  // Resize handled natively by BrowserWindow
});

// ─── GitHub Telemetry (anonymous, consent-based → Issues) ───
const TELEMETRY_REPO = 'gothtr/gitbrowser';

ipcMain.handle('telemetry-send', async (_e, { event, data }) => {
  try {
    // Check consent
    const settings = await rustBridge.call('settings.get', {});
    if (!settings || !settings.privacy || !settings.privacy.telemetry_consent) {
      return { ok: false, reason: 'no_consent' };
    }
    // Check if user is authenticated with GitHub
    const tokenRes = await rustBridge.call('github.get_token', {});
    const token = tokenRes && tokenRes.token;
    if (!token) return { ok: false, reason: 'not_authenticated' };

    // Build anonymous telemetry payload
    const payload = {
      event,
      version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      locale: (settings.general && settings.general.language) || 'en',
      timestamp: new Date().toISOString(),
      data: data || {},
    };

    // Format as readable text
    const body = [
      `**Event:** ${payload.event}`,
      `**Version:** ${payload.version}`,
      `**Platform:** ${payload.platform} (${payload.arch})`,
      `**Locale:** ${payload.locale}`,
      `**Time:** ${payload.timestamp}`,
      payload.data && Object.keys(payload.data).length > 0
        ? `\n**Details:**\n${Object.entries(payload.data).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n');

    // Create Issue in public repo with "telemetry" label
    const resp = await net.fetch(
      `https://api.github.com/repos/${TELEMETRY_REPO}/issues`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'GitBrowser',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: `[Telemetry] ${event}`,
          body,
          labels: ['telemetry'],
        }),
      }
    );
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      return { ok: false, reason: 'api_error', status: resp.status, detail: errBody };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// ─── Bug Report (user-submitted → GitHub Issue) ───
ipcMain.handle('bug-report-send', async (_e, { description }) => {
  try {
    const tokenRes = await rustBridge.call('github.get_token', {});
    const token = tokenRes && tokenRes.token;
    if (!token) return { ok: false, reason: 'not_authenticated' };

    const settings = await rustBridge.call('settings.get', {});
    const locale = (settings && settings.general && settings.general.language) || 'en';

    const body = [
      `**Description:**\n${description}`,
      '',
      `**Version:** ${APP_VERSION}`,
      `**Platform:** ${process.platform} (${process.arch})`,
      `**Locale:** ${locale}`,
      `**Time:** ${new Date().toISOString()}`,
    ].join('\n');

    const resp = await net.fetch(
      `https://api.github.com/repos/${TELEMETRY_REPO}/issues`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'GitBrowser',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: `[Bug Report] ${description.slice(0, 80)}`,
          body,
          labels: ['bug'],
        }),
      }
    );
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      return { ok: false, reason: 'api_error', status: resp.status, detail: errBody };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
});

// ─── Crash/Error Dialog ───
function showCrashReportDialog(win, errorInfo) {
  if (!win || win.isDestroyed()) return;
  const { dialog } = require('electron');
  dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Something went wrong',
    message: 'It looks like something crashed. Would you like to send an error report to help us fix it?',
    detail: errorInfo || '',
    buttons: ['Send Report', 'Dismiss'],
    defaultId: 0,
    cancelId: 1,
  }).then(async ({ response }) => {
    if (response === 0) {
      try {
        const tokenRes = await rustBridge.call('github.get_token', {});
        const token = tokenRes && tokenRes.token;
        if (!token) return;

        const body = [
          `**Auto-detected crash/error**`,
          '',
          '```',
          errorInfo || 'No details available',
          '```',
          '',
          `**Version:** ${APP_VERSION}`,
          `**Platform:** ${process.platform} (${process.arch})`,
          `**Time:** ${new Date().toISOString()}`,
        ].join('\n');

        await net.fetch(
          `https://api.github.com/repos/${TELEMETRY_REPO}/issues`,
          {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'GitBrowser',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              title: `[Crash] ${(errorInfo || 'Unknown error').slice(0, 80)}`,
              body,
              labels: ['bug', 'crash'],
            }),
          }
        );
      } catch {}
    }
  });
}

// Extensions
ipcMain.handle('extension-list', async () => {
  try {
    // Get Chrome extensions loaded in session
    const chromeExts = session.defaultSession.getAllExtensions().map(ext => ({
      id: ext.id, name: ext.name, version: ext.version, path: ext.path, type: 'chrome',
    }));
    // Get Rust-managed extensions
    let rustExts = [];
    try { rustExts = await rustBridge.call('extension.list', {}); } catch {}
    return [...chromeExts, ...(Array.isArray(rustExts) ? rustExts : [])];
  } catch (err) { return []; }
});
ipcMain.handle('extension-install', async (_e, { path: extPath }) => {
  try {
    // Try loading as Chrome extension first
    const ext = await session.defaultSession.loadExtension(extPath, { allowFileAccess: true });
    // Save extension path for auto-load on next startup
    try {
      let saved = [];
      try { saved = JSON.parse(fs.readFileSync(userDataPath('chrome_extensions.json'), 'utf-8')); } catch {}
      if (!saved.includes(extPath)) { saved.push(extPath); fs.writeFileSync(userDataPath('chrome_extensions.json'), JSON.stringify(saved)); }
    } catch {}
    return { ok: true, id: ext.id, name: ext.name, version: ext.version };
  } catch (chromeErr) {
    // Fallback to Rust extension system
    try { return await rustBridge.call('extension.install', { path: extPath }); }
    catch (err) { return { error: err.message }; }
  }
});
ipcMain.handle('extension-uninstall', async (_e, { id }) => {
  try {
    // Try removing Chrome extension first
    const chromeExts = session.defaultSession.getAllExtensions();
    const found = chromeExts.find(e => e.id === id);
    if (found) {
      await session.defaultSession.removeExtension(id);
      // Remove from saved paths
      try {
        let saved = [];
        try { saved = JSON.parse(fs.readFileSync(userDataPath('chrome_extensions.json'), 'utf-8')); } catch {}
        saved = saved.filter(p => p !== found.path);
        fs.writeFileSync(userDataPath('chrome_extensions.json'), JSON.stringify(saved));
      } catch {}
      return { ok: true };
    }
    return await rustBridge.call('extension.uninstall', { id });
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('extension-enable', async (_e, { id }) => {
  try { return await rustBridge.call('extension.enable', { id }); }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('extension-disable', async (_e, { id }) => {
  try { return await rustBridge.call('extension.disable', { id }); }
  catch (err) { return { error: err.message }; }
});
ipcMain.on('open-extensions', (e) => { const ctx = getWindowCtx(e.sender); openOrSwitchTab(ctx, 'gb://extensions'); });

// Extension file picker dialog (replaces prompt())
ipcMain.handle('extension-select-path', async () => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    title: 'Select Extension Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { path: result.filePaths[0] };
});

// ─── GitHub Device Flow OAuth ───
// XOR-obfuscated GitHub OAuth Client ID (same approach as CryptoBot token)
const _GH_OBF_CID = 'GCFlZDs+NB0gHCACBDUfOm4PEWU=';
const _GH_CID_KEY = 0x57;
function _ghClientId() { return _deobfToken(_GH_OBF_CID, _GH_CID_KEY); }

let githubToken = null;

// Secure token file path (fallback when Rust backend unavailable)
const ghTokenFile = path.join(app.getPath('userData'), '.gh_token');

function saveGhTokenLocal(token) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(token);
      fs.writeFileSync(ghTokenFile, encrypted);
    }
  } catch {}
}

function loadGhTokenLocal() {
  try {
    if (fs.existsSync(ghTokenFile) && safeStorage.isEncryptionAvailable()) {
      const encrypted = fs.readFileSync(ghTokenFile);
      return safeStorage.decryptString(encrypted);
    }
  } catch {}
  return null;
}

function clearGhTokenLocal() {
  try { if (fs.existsSync(ghTokenFile)) fs.unlinkSync(ghTokenFile); } catch {}
}

// Try to restore token on startup
(async () => {
  try {
    const res = await rustBridge.call('github.get_token', {});
    if (res && res.token) {
      githubToken = res.token;
      startGhNotifPolling();
      return;
    }
  } catch {}
  // Fallback: load from local encrypted file
  const local = loadGhTokenLocal();
  if (local) {
    githubToken = local;
    startGhNotifPolling();
    return;
  }
  // Fallback: load from secret storage (saved by github.html)
  try {
    const sec = await rustBridge.call('secret.get', { key: 'github_token' });
    if (sec && sec.value) {
      githubToken = sec.value;
      saveGhTokenLocal(sec.value);
      startGhNotifPolling();
    }
  } catch {}
})();

ipcMain.handle('github-device-login', async (_e, _data) => {
  try {
    const cid = _ghClientId();
    const codeRes = await net.fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: cid, scope: 'repo read:user notifications gist' }),
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
let ghNotifCount = 0;

async function pollGhNotifications() {
  if (!githubToken) return;
  try {
    const res = await net.fetch('https://api.github.com/notifications?per_page=50', {
      headers: { 'Authorization': 'Bearer ' + githubToken, 'Accept': 'application/vnd.github+json' },
    });
    if (res.ok) {
      const data = await res.json();
      ghNotifCount = Array.isArray(data) ? data.length : 0;
      sendToToolbar(primaryWindowCtx, 'gh-notif-count', { count: ghNotifCount });
    }
  } catch { /* ignore */ }
}

function startGhNotifPolling() {
  if (ghNotifInterval) clearInterval(ghNotifInterval);
  pollGhNotifications();
  ghNotifInterval = setInterval(pollGhNotifications, 60000);
}

ipcMain.handle('github-device-poll', async (_e, { deviceCode }) => {
  try {
    const cid = _ghClientId();
    const res = await net.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ client_id: cid, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const data = await res.json();
    if (data.access_token) {
      githubToken = data.access_token;
      // Save token locally (encrypted via OS keychain)
      saveGhTokenLocal(data.access_token);
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
      // Also store in secret storage for github.html sync
      rustBridge.call('secret.store', { key: 'github_token', value: data.access_token }).catch(() => {});
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
    const t = token || githubToken;
    if (!t) return { error: 'not_authenticated' };
    const opts = {
      method: method || 'GET',
      headers: { 'Authorization': 'Bearer ' + t, 'Accept': 'application/vnd.github+json' },
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
    const t = token || githubToken;
    if (!t) return { error: 'not_authenticated' };
    // Get bookmarks from Rust
    const bookmarks = await rustBridge.call('bookmark.list', {});
    const data = JSON.stringify(bookmarks);
    // Encrypt via Rust
    const encrypted = await rustBridge.call('github.encrypt_sync', { data });
    const content = JSON.stringify(encrypted);
    // Check if sync gist already exists
    const gistsRes = await net.fetch('https://api.github.com/gists', {
      headers: { 'Authorization': 'Bearer ' + t, 'Accept': 'application/vnd.github+json' },
    });
    const gists = await gistsRes.json();
    const syncGist = Array.isArray(gists) ? gists.find(g => g.description === 'GitBrowser Bookmark Sync') : null;
    const gistPayload = {
      description: 'GitBrowser Bookmark Sync',
      public: false,
      files: { 'bookmarks.enc.json': { content } },
    };
    if (syncGist) {
      await net.fetch('https://api.github.com/gists/' + syncGist.id, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + t, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(gistPayload),
      });
    } else {
      await net.fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + t, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(gistPayload),
      });
    }
    return { ok: true };
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('github-sync-bookmarks-download', async (_e, { token }) => {
  try {
    const t = token || githubToken;
    if (!t) return { error: 'not_authenticated' };
    const gistsRes = await net.fetch('https://api.github.com/gists', {
      headers: { 'Authorization': 'Bearer ' + t, 'Accept': 'application/vnd.github+json' },
    });
    const gists = await gistsRes.json();
    const syncGist = Array.isArray(gists) ? gists.find(g => g.description === 'GitBrowser Bookmark Sync') : null;
    if (!syncGist) return { error: 'no_sync_gist' };
    const gistRes = await net.fetch('https://api.github.com/gists/' + syncGist.id, {
      headers: { 'Authorization': 'Bearer ' + t, 'Accept': 'application/vnd.github+json' },
    });
    const gist = await gistRes.json();
    const file = gist.files && gist.files['bookmarks.enc.json'];
    if (!file || !file.content) return { error: 'no_bookmark_file' };
    const encrypted = JSON.parse(file.content);
    const decrypted = await rustBridge.call('github.decrypt_sync', encrypted);
    const bookmarks = JSON.parse(decrypted.data);
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
    ghNotifCount = 0;
    clearGhTokenLocal();
    if (ghNotifInterval) { clearInterval(ghNotifInterval); ghNotifInterval = null; }
    sendToToolbar(primaryWindowCtx, 'gh-notif-count', { count: 0 });
    await rustBridge.call('github.logout', {});
    rustBridge.call('secret.delete', { key: 'github_token' }).catch(() => {});
    return { ok: true };
  } catch (err) { return { error: err.message }; }
});

// ─── Auto-update via GitHub Releases ───
const CURRENT_VERSION = require('./package.json').version;
const UPDATE_REPO = 'gothtr/gitbrowser';

ipcMain.handle('check-for-update', async () => {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) return { error: 'HTTP ' + res.status };
    const release = await res.json();
    const latestTag = (release.tag_name || '').replace(/^v/, '');
    if (!latestTag) return { upToDate: true, version: CURRENT_VERSION };
    if (compareVersions(latestTag, CURRENT_VERSION) > 0) {
      // Find .exe installer asset
      const asset = (release.assets || []).find(a => a.name && a.name.endsWith('.exe'));
      return {
        updateAvailable: true,
        currentVersion: CURRENT_VERSION,
        latestVersion: latestTag,
        downloadUrl: asset ? asset.browser_download_url : null,
        releaseNotes: release.body || '',
        releaseName: release.name || latestTag,
      };
    }
    return { upToDate: true, version: CURRENT_VERSION };
  } catch (err) {
    return { error: err.message };
  }
});

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

ipcMain.handle('download-and-install-update', async (_e, { downloadUrl }) => {
  try {
    if (!downloadUrl) return { error: 'No download URL' };
    const tmpDir = path.join(app.getPath('temp'), 'gitbrowser-update');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const fileName = path.basename(new URL(downloadUrl).pathname);
    const filePath = path.join(tmpDir, fileName);

    // Download the installer
    const res = await net.fetch(downloadUrl);
    if (!res.ok) return { error: 'Download failed: HTTP ' + res.status };
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    // Launch installer silently and quit
    const { spawn: spawnProc } = require('child_process');
    spawnProc(filePath, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.quit(), 1500);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ─── Page context menu actions (IPC from injected glass menu) ───
ipcMain.on('ctx-menu-action', (e, action, data) => {
  // GitHub menu actions don't need _pageCtxWc
  if (action && action.startsWith('gh_')) {
    handleGhAction(action, data);
    return;
  }
  const wc = _pageCtxWc;
  const params = _pageCtxParams;
  if (!wc || wc.isDestroyed()) return;
  const _ctx = getWindowCtx(e.sender) || getWindowCtx(wc);
  try {
    if (action === 'copy') wc.copy();
    else if (action === 'cut') wc.cut();
    else if (action === 'paste') wc.paste();
    else if (action === 'selectAll') wc.selectAll();
    else if (action === 'openLink' && data) createTab(_ctx, data);
    else if (action === 'copyLink' && data) clipboard.writeText(data);
    else if (action === 'saveImage' && data) wc.downloadURL(data);
    else if (action === 'copyImageUrl' && data) clipboard.writeText(data);
    else if (action === 'openImageTab' && data) createTab(_ctx, data);
    else if (action === 'inspect' && params) wc.inspectElement(params.x, params.y);
    else if (action === 'ai' && data) {
      try {
        const aiData = JSON.parse(data);
        runAiAction(wc, aiData.type, aiData.text);
      } catch {}
    }
    else if (action === 'translate' && data) {
      try {
        const trData = JSON.parse(data);
        runGoogleTranslate(wc, trData.text, trData.lang);
      } catch {}
    }
  } catch {}
});

// Tab context menu
ipcMain.on('tab-context-menu', (e, id, clientX, clientY) => {
  const ctx = getWindowCtx(e.sender);
  if (!ctx || !ctx.activeTabId || !ctx.tabs.has(ctx.activeTabId)) return;
  const tabCtxToken = generateCtxToken();
  const tabView = ctx.tabs.get(ctx.activeTabId).view;
  const tabBounds = tabView.getBounds();

  const sw = ctx.sidebarView ? (ctx.sidebarCollapsed ? 48 : SIDEBAR_WIDTH) : 0;
  const sidebarBounds = ctx.sidebarView ? ctx.sidebarView.getBounds() : { x: 0, y: 0 };

  const isMuted = ctx.tabs.has(id) && ctx.tabs.get(id).view.webContents.isAudioMuted();
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
    { label: cmL('tabs.reopen_closed', 'Восстановить вкладку'), action: 'reopen', disabled: ctx.closedTabsStack.length === 0 },
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
      d.onclick=function(){closeMenu();console.log('__gb_tab_ctx:${tabCtxToken}:'+JSON.stringify({action:it.action}));};
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
    const prefix = '__gb_tab_ctx:' + tabCtxToken + ':';
    if (!message || !message.startsWith(prefix)) return;
    tabView.webContents.removeListener('console-message', tabCtxHandler);
    try {
      const { action } = JSON.parse(message.replace(prefix, ''));
      if (action === 'new_tab') createTab(ctx, 'gb://newtab');
      else if (action === 'reload') { if (ctx.tabs.has(id)) ctx.tabs.get(id).view.webContents.reload(); }
      else if (action === 'duplicate') { if (ctx.tabs.has(id)) createTab(ctx, ctx.tabs.get(id).url); }
      else if (action === 'mute') { if (ctx.tabs.has(id)) { const wc2 = ctx.tabs.get(id).view.webContents; wc2.setAudioMuted(!wc2.isAudioMuted()); sendTabsUpdate(ctx); } }
      else if (action === 'close') closeTab(ctx, id);
      else if (action === 'close_others') { ctx.tabOrder.filter(tid => tid !== id).forEach(tid => closeTab(ctx, tid)); }
      else if (action === 'close_right') { const idx = ctx.tabOrder.indexOf(id); if (idx >= 0) ctx.tabOrder.slice(idx + 1).forEach(tid => closeTab(ctx, tid)); }
      else if (action === 'reopen') { reopenClosedTab(ctx); }
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
    // SEC-04: Only send usernames to the page, decrypt passwords on demand via IPC
    const credsJson = JSON.stringify(creds.map(c => ({ id: c.id, username: c.username })));
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
                // Signal main process to decrypt and fill via title hack
                document.title = '__gb_autofill_req:' + JSON.stringify({ id: c.id });
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
  const q = encodeURIComponent(trimmed);
  const engines = {
    google: 'https://www.google.com/search?q=' + q,
    duckduckgo: 'https://duckduckgo.com/?q=' + q,
    bing: 'https://www.bing.com/search?q=' + q,
    yandex: 'https://yandex.com/search/?text=' + q,
  };
  return engines[currentSearchEngine] || engines.google;
}

// SEC-05: Block dangerous URL schemes (file://, javascript:, data:, vbscript:, etc.)
function isBlockedUrl(url) {
  if (!url || typeof url !== 'string') return true;
  const lower = url.trim().toLowerCase();
  if (lower.startsWith('javascript:')) return true;
  if (lower.startsWith('file://')) return true;
  if (lower.startsWith('data:')) return true;
  if (lower.startsWith('vbscript:')) return true;
  if (lower.startsWith('blob:')) return true;
  return false;
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
  // Send to all windows
  for (const ctx of windowRegistry.values()) {
    sendToToolbar(ctx, 'theme-changed', { theme: resolved });
    for (const [, tabData] of ctx.tabs) {
      if (!tabData.view.webContents.isDestroyed()) {
        tabData.view.webContents.send('theme-changed', { theme: resolved });
      }
    }
  }
}

async function loadInitialTheme() {
  try {
    const settings = await rustBridge.call('settings.get', {});
    if (settings && settings.appearance && settings.appearance.theme) {
      currentTheme = settings.appearance.theme;
    }
    if (settings && settings.general && settings.general.default_search_engine) {
      currentSearchEngine = settings.general.default_search_engine;
    }
    // Apply font size to existing tabs
    if (settings && settings.appearance && settings.appearance.font_size) {
      const size = parseInt(settings.appearance.font_size) || 14;
      if (size !== 14) {
        for (const ctx of windowRegistry.values()) {
          for (const [, tabData] of ctx.tabs) {
            if (!tabData.view.webContents.isDestroyed()) {
              tabData.view.webContents.setZoomFactor(size / 14);
            }
          }
        }
      }
    }
  } catch {}
  broadcastTheme(currentTheme);
}

// ─── Splash screen ───
let splashWindow = null;

function showSplash() {
  splashWindow = new BrowserWindow({
    width: 320,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    center: true,
    icon: resolvePath('resources', 'icons', 'app.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'ui', 'splash.html'));
  splashWindow.on('closed', () => { splashWindow = null; });
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

app.whenReady().then(async () => {
  // Show splash immediately — before any heavy init
  showSplash();

  // Start rust bridge (non-blocking)
  rustBridge.start();

  // Don't block on locale — load it in background, use English fallback for now
  loadContextMenuLocale().catch(() => {});

  // Create main window immediately (hidden)
  createWindow();

  // Close splash once ALL views are ready (toolbar + sidebar + first tab)
  const mainWin = getMainWindow();
  if (mainWin && primaryWindowCtx) {
    const ctx = primaryWindowCtx;
    const viewsToWait = [];

    if (ctx.toolbarView) viewsToWait.push(ctx.toolbarView.webContents);
    if (ctx.sidebarView) viewsToWait.push(ctx.sidebarView.webContents);

    function checkAllReady() {
      // Also wait for at least one tab to exist and finish loading
      const activeTab = ctx.activeTabId && ctx.tabs.has(ctx.activeTabId)
        ? ctx.tabs.get(ctx.activeTabId).view.webContents : null;

      const allViewsLoaded = viewsToWait.every(wc => !wc.isLoading());
      const tabReady = activeTab && !activeTab.isLoading();

      if (allViewsLoaded && tabReady) {
        // Small extra delay to let paint finish
        setTimeout(() => {
          if (mainWin && !mainWin.isDestroyed()) mainWin.show();
          closeSplash();
        }, 100);
        return true;
      }
      return false;
    }

    // Poll every 200ms — covers all race conditions
    const readyInterval = setInterval(() => {
      if (checkAllReady()) clearInterval(readyInterval);
    }, 200);

    // Fallback — never stay on splash longer than 6s
    setTimeout(() => {
      clearInterval(readyInterval);
      if (mainWin && !mainWin.isDestroyed() && !mainWin.isVisible()) {
        mainWin.show();
        closeSplash();
      }
    }, 6000);
  } else if (mainWin) {
    setTimeout(() => { mainWin.show(); closeSplash(); }, 2000);
  }

  // Load theme after window is ready
  setTimeout(() => { loadInitialTheme(); }, 500);

  // Load saved Chrome extensions (deferred — don't block startup)
  setTimeout(async () => {
    try {
      const extPaths = JSON.parse(fs.readFileSync(userDataPath('chrome_extensions.json'), 'utf-8'));
      if (Array.isArray(extPaths)) {
        for (const p of extPaths) {
          try { await session.defaultSession.loadExtension(p, { allowFileAccess: true }); }
          catch { /* extension folder may have been removed */ }
        }
      }
    } catch { /* no saved extensions */ }
  }, 1000);

  // Listen for OS theme changes (for System mode)
  nativeTheme.on('updated', () => {
    if (currentTheme === 'System') {
      broadcastTheme('System');
    }
  });
});

app.on('window-all-closed', () => {
  // Save session for primary window if it still exists
  if (primaryWindowCtx) saveSession(primaryWindowCtx);
  rustBridge.stop();
  app.quit();
});
