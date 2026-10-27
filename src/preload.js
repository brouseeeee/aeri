'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('glass', {
  onState: (callback) => subscribe('widget:state', callback),
  onVolume: (callback) => subscribe('widget:volume', callback),
  onSeek: (callback) => subscribe('widget:seek', callback),
  onVisibility: (callback) => subscribe('widget:visibility', callback),
  onArt: (callback) => subscribe('widget:art', callback),
  onLayout: (callback) => subscribe('widget:layout', callback),
  onDragging: (callback) => subscribe('widget:dragging', callback),
  hover: (value) => ipcRenderer.send('glass:hover', Boolean(value)),
  focus: () => ipcRenderer.send('glass:focus'),
  interaction: (value) => ipcRenderer.send('glass:interaction', Boolean(value)),
  setVolume: (value) => ipcRenderer.send('glass:volume', value),
  setMuted: (value) => ipcRenderer.send('glass:muted', Boolean(value)),
  seek: (value) => ipcRenderer.send('glass:seek', value),
  toggle: () => ipcRenderer.send('glass:toggle'),
  next: () => ipcRenderer.send('glass:next'),
  previous: () => ipcRenderer.send('glass:previous'),
  requestState: () => ipcRenderer.send('glass:requestState'),
});
