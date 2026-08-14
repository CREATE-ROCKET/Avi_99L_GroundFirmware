const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('groundApi', {
  listPorts: () => ipcRenderer.invoke('ground:listPorts'),
  connect: (path) => ipcRenderer.invoke('ground:connect', { path }),
  disconnect: () => ipcRenderer.invoke('ground:disconnect'),
  sendCommand: (command) => ipcRenderer.invoke('ground:sendCommand', command),
  getSession: () => ipcRenderer.invoke('ground:getSession'),
  chooseMap: () => ipcRenderer.invoke('ground:chooseMap'),
  rendererReady: () => ipcRenderer.send('ground:rendererReady'),
  rendererReload: () => ipcRenderer.send('ground:rendererReload'),
  recordLatency: (metric) => ipcRenderer.send('ground:recordLatency', metric),
  recordAppDecodeMismatch: (mismatch) => ipcRenderer.send('ground:recordAppDecodeMismatch', mismatch),
  onSerialLine: (callback) => subscribe('ground:serialLine', callback),
  onSessionStatus: (callback) => subscribe('ground:sessionStatus', callback),
  onConnectionStatus: (callback) => subscribe('ground:connectionStatus', callback),
  onError: (callback) => subscribe('ground:error', callback),
});
