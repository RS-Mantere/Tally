/**
 * The only bridge between the renderer and Node.
 *
 * The renderer runs sandboxed with no Node access; everything it is allowed to
 * do is listed here explicitly.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tally', {
  // Data
  load: () => ipcRenderer.invoke('data:load'),
  save: (doc) => ipcRenderer.invoke('data:save', doc),
  flush: () => ipcRenderer.invoke('data:flush'),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  revealDataFolder: () => ipcRenderer.invoke('data:reveal'),

  // OS integration
  setLaunchOnStartup: (enabled, startMinimised) =>
    ipcRenderer.invoke('app:launch-on-startup', { enabled, startMinimised }),

  // Window controls (the frame is drawn by the renderer)
  minimise: () => ipcRenderer.invoke('win:minimise'),
  close: () => ipcRenderer.invoke('win:close'),
  setCompact: (enabled) => ipcRenderer.invoke('win:compact', enabled),
  onCompactChanged: (callback) => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on('win:compact-changed', listener);
    return () => ipcRenderer.removeListener('win:compact-changed', listener);
  },
  onBeforeHide: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:before-hide', listener);
    return () => ipcRenderer.removeListener('app:before-hide', listener);
  },

  appVersion: () => ipcRenderer.invoke('app:version'),
});
