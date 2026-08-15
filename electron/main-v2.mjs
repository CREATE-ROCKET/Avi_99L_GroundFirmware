import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GroundSerialService } from './ground-serial-service.mjs';
import { SessionWriter } from './session-writer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

let mainWindow = null;
let serialService = null;
let sessionWriter = null;
let quitting = false;
let lastSessionStatusAt = 0;

function runtimeFlags() {
  const devMode = isDev || process.env.CREATE_99L_DEV_MODE === '1';
  return {
    devMode,
    syntheticAutostart: devMode && process.env.CREATE_99L_SYNTHETIC === '1',
  };
}

function sendToRenderer(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

function createSessionWriter() {
  const baseDirectory = path.join(app.getPath('documents'), 'CREATE 99L Ground Station', 'logs');
  return new SessionWriter({
    baseDirectory,
    appVersion: app.getVersion(),
    onStatus: (status) => {
      const now = Date.now();
      if (!status.healthy || now - lastSessionStatusAt >= 250) {
        lastSessionStatusAt = now;
        sendToRenderer('ground:sessionStatus', status);
      }
    },
  });
}

function registerIpc() {
  ipcMain.handle('ground:listPorts', () => serialService.listPorts());
  ipcMain.handle('ground:connect', (_event, options) => {
    if (!options || typeof options !== 'object' || typeof options.path !== 'string') throw new Error('path is required');
    return serialService.connect(options.path);
  });
  ipcMain.handle('ground:disconnect', () => serialService.disconnect('user'));
  ipcMain.handle('ground:sendCommand', (_event, command) => serialService.sendCommand(command));
  ipcMain.handle('ground:getRuntimeFlags', () => runtimeFlags());
  ipcMain.handle('ground:getSession', () => ({ ...sessionWriter.snapshot(), connection: serialService.currentStatus() }));
  ipcMain.on('ground:recordLatency', (_event, metric) => {
    if (!metric || !Number.isFinite(metric.receivedAtMs) || !Number.isFinite(metric.storeLatencyMs)
        || !Number.isFinite(metric.paintLatencyMs) || metric.storeLatencyMs < 0 || metric.paintLatencyMs < 0
        || metric.storeLatencyMs > 60000 || metric.paintLatencyMs > 60000) return;
    sessionWriter.append('renderer_latency', metric);
  });
  ipcMain.on('ground:recordAppDecodeMismatch', (_event, mismatch) => {
    if (!mismatch || mismatch.error !== 'APP_DECODE_MISMATCH' || !Number.isInteger(mismatch.seq)
        || mismatch.seq < 0 || mismatch.seq > 0xFFFFFFFF || !Number.isInteger(mismatch.header)
        || mismatch.header < 0 || mismatch.header > 255) return;
    sessionWriter.append('app_decode_mismatch', mismatch, true);
  });
  ipcMain.handle('ground:chooseMap', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Offline map imageを選択',
      properties: ['openFile'],
      filters: [{ name: 'Map image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
  ipcMain.on('ground:rendererReady', () => {
    sessionWriter.appendConnectionEvent('renderer_ready');
    sendToRenderer('ground:connectionStatus', serialService.currentStatus());
    sendToRenderer('ground:sessionStatus', sessionWriter.status);
  });
  ipcMain.on('ground:rendererReload', () => sessionWriter.appendConnectionEvent('renderer_reload'));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1440,
    minHeight: 810,
    backgroundColor: '#f2f0ea',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-v2.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (isDev) await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else await mainWindow.loadFile(path.join(__dirname, '../dist/renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  sessionWriter = createSessionWriter();
  sessionWriter.start();
  serialService = new GroundSerialService({ sessionWriter });
  serialService.on('line', (record) => sendToRenderer('ground:serialLine', record));
  serialService.on('status', (status) => sendToRenderer('ground:connectionStatus', status));
  serialService.on('serial-error', (error) => sendToRenderer('ground:error', error));
  registerIpc();
  sessionWriter.appendConnectionEvent('application_started');
  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('before-quit', (event) => {
  if (quitting || !serialService) return;
  event.preventDefault();
  quitting = true;
  void serialService.disconnect('application').finally(() => {
    sessionWriter?.close();
    app.quit();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
