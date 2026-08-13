const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('groundApi', {
  listPorts: () => ipcRenderer.invoke('ground:listPorts'),
  connect: (options) => ipcRenderer.invoke('ground:connect', options),
  disconnect: () => ipcRenderer.invoke('ground:disconnect'),
  sendLine: (line) => ipcRenderer.invoke('ground:sendLine', line),
  getSession: () => ipcRenderer.invoke('ground:getSession'),
  chooseMap: () => ipcRenderer.invoke('ground:chooseMap'),
  rendererReady: () => ipcRenderer.send('ground:rendererReady'),
  rendererReload: () => ipcRenderer.send('ground:rendererReload'),
  recordDecoded: (record) => ipcRenderer.send('ground:decoded', record),
  onLine: (callback) => {
    const handler = (_event, record) => callback(record);
    ipcRenderer.on('ground:line', handler);
    return () => ipcRenderer.removeListener('ground:line', handler);
  },
  onLogStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('ground:logStatus', handler);
    return () => ipcRenderer.removeListener('ground:logStatus', handler);
  },
  onConnection: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('ground:connection', handler);
    return () => ipcRenderer.removeListener('ground:connection', handler);
  },
});
