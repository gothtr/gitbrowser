const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  getInfo: () => ipcRenderer.invoke('get-info'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  install: (data) => ipcRenderer.invoke('install', data),
  createShortcuts: () => ipcRenderer.invoke('create-shortcuts'),
  launchApp: () => ipcRenderer.invoke('launch-app'),
  close: () => ipcRenderer.invoke('close-installer'),
  getIconPath: () => ipcRenderer.invoke('get-icon-path'),
});
