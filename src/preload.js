const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getState: (gameDir) => ipcRenderer.invoke('state:get', gameDir),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickGameDir: () => ipcRenderer.invoke('game:pick'),
  autoDetect: () => ipcRenderer.invoke('game:autodetect'),
  installLoader: (gameDir) => ipcRenderer.invoke('loader:install', gameDir),
  installTailscale: () => ipcRenderer.invoke('tailscale:install'),
  openFirewall: (port) => ipcRenderer.invoke('firewall:open', port),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s)),
  onGameStatus: (cb) => ipcRenderer.on('game:status', (_e, s) => cb(s)),
  openTailscale: () => ipcRenderer.invoke('tailscale:open'),
  openTailscaleKeys: () => ipcRenderer.invoke('tailscale:keys'),
  loginTailscale: (key) => ipcRenderer.invoke('tailscale:login', key),
  openModsFolder: () => ipcRenderer.invoke('mods:open'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  launch: (payload) => ipcRenderer.invoke('game:launch', payload),
});
