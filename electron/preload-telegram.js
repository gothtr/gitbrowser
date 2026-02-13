// SEC-12: Minimal preload for Telegram widget — only exposes telegramToggle
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gitbrowser', {
  telegramToggle: () => ipcRenderer.send('telegram-toggle'),
});
