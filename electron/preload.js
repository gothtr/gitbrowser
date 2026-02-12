const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitbrowser', {
  // Tab actions
  newTab: () => ipcRenderer.send('new-tab'),
  closeTab: (id) => ipcRenderer.send('close-tab', id),
  switchTab: (id) => ipcRenderer.send('switch-tab', id),
  reorderTab: (fromId, toId) => ipcRenderer.send('reorder-tab', { fromId, toId }),
  navigate: (url) => ipcRenderer.send('navigate', url),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  reload: () => ipcRenderer.send('reload'),
  reopenClosedTab: () => ipcRenderer.send('reopen-closed-tab'),
  getTabs: () => ipcRenderer.send('get-tabs'),
  tabContextMenu: (id) => ipcRenderer.send('tab-context-menu', id),

  // Ctrl+Tab / Ctrl+Shift+Tab navigation
  nextTab: () => ipcRenderer.send('next-tab'),
  prevTab: () => ipcRenderer.send('prev-tab'),

  // Zoom
  zoomIn: () => ipcRenderer.send('zoom-in'),
  zoomOut: () => ipcRenderer.send('zoom-out'),
  zoomReset: () => ipcRenderer.send('zoom-reset'),
  onZoomChanged: (cb) => ipcRenderer.on('zoom-changed', (_e, d) => cb(d)),

  // Fullscreen
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),

  // Sidebar
  toggleSidebar: () => ipcRenderer.send('toggle-sidebar'),

  // Private mode
  openPrivateWindow: () => ipcRenderer.send('open-private-window'),

  // Find in page
  findInPage: (text) => ipcRenderer.send('find-in-page', text),
  stopFind: () => ipcRenderer.send('stop-find'),

  // Reader mode
  readerExtract: () => ipcRenderer.invoke('reader-extract'),

  // Open internal pages as tabs
  openSettings: () => ipcRenderer.send('open-settings'),
  openBookmarks: () => ipcRenderer.send('open-bookmarks'),
  openHistory: () => ipcRenderer.send('open-history'),
  openDownloads: () => ipcRenderer.send('open-downloads'),
  openAI: () => ipcRenderer.send('open-ai'),
  openGitHub: () => ipcRenderer.send('open-github'),

  // Bookmarks
  addBookmark: (data) => ipcRenderer.send('add-bookmark', data),
  getBookmarks: () => ipcRenderer.invoke('bookmark-list'),
  searchBookmarks: (q) => ipcRenderer.invoke('bookmark-search', q),
  deleteBookmark: (id) => ipcRenderer.send('bookmark-delete', id),

  // History
  getHistory: () => ipcRenderer.invoke('history-recent'),
  searchHistory: (q) => ipcRenderer.invoke('history-search', q),
  clearHistory: () => ipcRenderer.send('history-clear'),
  deleteHistoryEntry: (id) => ipcRenderer.send('history-delete', id),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings-set', { key, value }),
  getLocaleData: () => ipcRenderer.invoke('get-locale-data'),

  // Downloads
  getDownloads: () => ipcRenderer.invoke('downloads-list'),
  pauseDownload: (id) => ipcRenderer.send('download-pause', id),
  resumeDownload: (id) => ipcRenderer.send('download-resume', id),
  cancelDownload: (id) => ipcRenderer.send('download-cancel', id),
  openDownloadFile: (filepath) => ipcRenderer.send('download-open-file', filepath),
  showDownloadInFolder: (filepath) => ipcRenderer.send('download-show-folder', filepath),

  // AI Assistant
  aiChat: (data) => ipcRenderer.invoke('ai-chat', data),
  aiClearHistory: (sessionId) => ipcRenderer.send('ai-clear-history', sessionId),

  // Password Manager
  passwordUnlock: (data) => ipcRenderer.invoke('password-unlock', data),
  passwordLock: () => ipcRenderer.invoke('password-lock'),
  passwordIsUnlocked: () => ipcRenderer.invoke('password-is-unlocked'),
  passwordList: (data) => ipcRenderer.invoke('password-list', data || {}),
  passwordSave: (data) => ipcRenderer.invoke('password-save', data),
  passwordUpdate: (data) => ipcRenderer.invoke('password-update', data),
  passwordDelete: (data) => ipcRenderer.invoke('password-delete', data),
  passwordGenerate: (data) => ipcRenderer.invoke('password-generate', data || {}),
  openPasswords: () => ipcRenderer.send('open-passwords'),

  // GitHub
  githubDeviceLogin: (data) => ipcRenderer.invoke('github-device-login', data),
  githubDevicePoll: (data) => ipcRenderer.invoke('github-device-poll', data),
  githubApi: (data) => ipcRenderer.invoke('github-api', data),
  githubLogout: () => ipcRenderer.invoke('github-logout'),
  githubSyncBookmarksUpload: (data) => ipcRenderer.invoke('github-sync-bookmarks-upload', data),
  githubSyncBookmarksDownload: (data) => ipcRenderer.invoke('github-sync-bookmarks-download', data),

  // Secure secret storage
  secretStore: (key, value) => ipcRenderer.invoke('secret-store', { key, value }),
  secretGet: (key) => ipcRenderer.invoke('secret-get', { key }),
  secretDelete: (key) => ipcRenderer.invoke('secret-delete', { key }),

  // Extensions
  extensionList: () => ipcRenderer.invoke('extension-list'),
  extensionInstall: (extPath) => ipcRenderer.invoke('extension-install', { path: extPath }),
  extensionUninstall: (id) => ipcRenderer.invoke('extension-uninstall', { id }),
  extensionEnable: (id) => ipcRenderer.invoke('extension-enable', { id }),
  extensionDisable: (id) => ipcRenderer.invoke('extension-disable', { id }),
  openExtensions: () => ipcRenderer.send('open-extensions'),

  // Navigation from internal pages
  openUrl: (url) => ipcRenderer.send('open-url', url),
  openUrlNewTab: (url) => ipcRenderer.send('open-url-new-tab', url),

  // Events from main
  onTabsUpdate: (cb) => ipcRenderer.on('tabs-update', (_e, d) => cb(d)),
  onTabUrlUpdated: (cb) => ipcRenderer.on('tab-url-updated', (_e, d) => cb(d)),
  onTabTitleUpdated: (cb) => ipcRenderer.on('tab-title-updated', (_e, d) => cb(d)),
  onTabLoading: (cb) => ipcRenderer.on('tab-loading', (_e, d) => cb(d)),
  onToast: (cb) => ipcRenderer.on('toast', (_e, d) => cb(d)),
  onDownloadStarted: (cb) => ipcRenderer.on('download-started', (_e, d) => cb(d)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_e, d) => cb(d)),
  onDownloadDone: (cb) => ipcRenderer.on('download-done', (_e, d) => cb(d)),
  onThemeChanged: (cb) => ipcRenderer.on('theme-changed', (_e, d) => cb(d)),
  onCloseFind: (cb) => ipcRenderer.on('close-find', (_e, d) => cb(d)),
  onGhNotifCount: (cb) => ipcRenderer.on('gh-notif-count', (_e, d) => cb(d)),
});
