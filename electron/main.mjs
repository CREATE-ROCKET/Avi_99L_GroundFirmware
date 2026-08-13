import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseUsbLine } from '../shared/usb-line.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

let mainWindow = null;
let serialPort = null;
let serialBuffer = '';
let session = null;
let bufferedLines = [];
const MAX_BUFFERED_LINES = 100000; // 2 Hzで約14時間分。pretty-printはbufferへ入れない。
let serialportModule = null;
let logStatus = { healthy: true, lastFlushUtc: null, error: null };
let lastLogStatusNotifyAt = 0;

function isoForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function createSession() {
  const base = path.join(app.getPath('documents'), 'CREATE 99L Ground Station', 'logs');
  const directory = path.join(base, isoForPath());
  fs.mkdirSync(directory, { recursive: true });

  const rawFd = fs.openSync(path.join(directory, 'usb-lines.log'), 'a');
  const recordFd = fs.openSync(path.join(directory, 'records.jsonl'), 'a');
  const eventFd = fs.openSync(path.join(directory, 'ground-station.jsonl'), 'a');

  const createdAt = new Date();
  const metadata = {
    schema: 1,
    created_at_utc: createdAt.toISOString(),
    app_version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  fs.writeFileSync(path.join(directory, 'session.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  return { directory, rawFd, recordFd, eventFd, createdAt, portPath: null };
}

function notifyLogStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastLogStatusNotifyAt < 250) return;
  lastLogStatusNotifyAt = now;
  mainWindow?.webContents.send('ground:logStatus', logStatus);
}

function syncWrite(fd, text) {
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
    logStatus = { healthy: true, lastFlushUtc: new Date().toISOString(), error: null };
    notifyLogStatus(false);
    return true;
  } catch (error) {
    logStatus = {
      healthy: false,
      lastFlushUtc: logStatus.lastFlushUtc,
      error: error instanceof Error ? error.message : String(error),
    };
    notifyLogStatus(true);
    return false;
  }
}

function nowRecord() {
  return {
    host_time_utc: new Date().toISOString(),
    host_unix_ms: Date.now(),
    host_monotonic_ms: performance.now(),
  };
}

function logEvent(type, detail = {}) {
  if (!session) return;
  syncWrite(session.eventFd, `${JSON.stringify({ ...nowRecord(), type, ...detail })}\n`);
}

function appendRawLine(line, direction = 'rx') {
  if (!session) return;
  const stamp = nowRecord();
  syncWrite(session.rawFd, `${stamp.host_time_utc}\t${direction}\t${line}\n`);
  const parsed = direction === 'rx' ? parseUsbLine(line, new Date(stamp.host_time_utc)) : null;
  const record = {
    ...stamp,
    direction,
    port: session.portPath,
    raw_line: line,
    parsed,
  };
  syncWrite(session.recordFd, `${JSON.stringify(record)}\n`);

  // Renderer reload後の復元に必要なmachine recordとTXだけをRAMへ保持する。
  // 人間向けpretty-printはdiskには全保存するが、RAM historyを圧迫させない。
  if (direction === 'tx' || parsed?.kind === 'machine') {
    bufferedLines.push(record);
    if (bufferedLines.length > MAX_BUFFERED_LINES) {
      bufferedLines.splice(0, bufferedLines.length - MAX_BUFFERED_LINES);
    }
  }
  mainWindow?.webContents.send('ground:line', record);
}

async function loadSerialport() {
  if (serialportModule) return serialportModule;
  try {
    serialportModule = await import('serialport');
    return serialportModule;
  } catch (error) {
    throw new Error(`serialport package unavailable: ${error.message}`);
  }
}

async function listPorts() {
  const { SerialPort } = await loadSerialport();
  return SerialPort.list();
}

async function disconnectPort(reason = 'user') {
  if (!serialPort) return;
  const port = serialPort;
  serialPort = null;
  await new Promise((resolve) => {
    if (!port.isOpen) return resolve();
    port.close(() => resolve());
  });
  logEvent('serial_disconnected', { reason, path: session?.portPath });
  if (session) session.portPath = null;
  mainWindow?.webContents.send('ground:connection', { connected: false, reason });
}

async function connectPort({ path: portPath, baudRate = 115200 }) {
  if (!portPath || typeof portPath !== 'string') throw new Error('port path is required');
  await disconnectPort('switch');
  const { SerialPort } = await loadSerialport();

  const port = new SerialPort({
    path: portPath,
    baudRate,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    autoOpen: false,
  });

  await new Promise((resolve, reject) => {
    port.open((error) => error ? reject(error) : resolve());
  });

  serialPort = port;
  serialBuffer = '';
  session.portPath = portPath;
  logEvent('serial_connected', { path: portPath, baudRate });
  mainWindow?.webContents.send('ground:connection', { connected: true, path: portPath, baudRate });

  port.on('data', (chunk) => {
    serialBuffer += chunk.toString('utf8');
    while (true) {
      const newline = serialBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = serialBuffer.slice(0, newline).replace(/\r$/, '');
      serialBuffer = serialBuffer.slice(newline + 1);
      if (line.length > 0) appendRawLine(line, 'rx');
    }
    if (serialBuffer.length > 65536) {
      logEvent('serial_line_overflow', { bytes: serialBuffer.length });
      serialBuffer = '';
    }
  });

  port.on('error', (error) => {
    logEvent('serial_error', { message: error.message });
    mainWindow?.webContents.send('ground:connection', { connected: false, reason: error.message });
  });

  port.on('close', () => {
    const closedPath = session?.portPath;
    serialPort = null;
    if (session) session.portPath = null;
    logEvent('serial_closed', { path: closedPath });
    mainWindow?.webContents.send('ground:connection', { connected: false, reason: 'closed' });
  });

  return { connected: true, path: portPath, baudRate };
}

async function sendLine(line) {
  if (!serialPort?.isOpen) throw new Error('serial port is not connected');
  const normalized = String(line ?? '').trim();
  if (!normalized) throw new Error('empty command');
  await new Promise((resolve, reject) => {
    serialPort.write(`${normalized}\n`, 'utf8', (error) => {
      if (error) return reject(error);
      serialPort.drain((drainError) => drainError ? reject(drainError) : resolve());
    });
  });
  appendRawLine(normalized, 'tx');
  return { ok: true };
}

function registerIpc() {
  ipcMain.handle('ground:listPorts', () => listPorts());
  ipcMain.handle('ground:connect', (_event, options) => connectPort(options));
  ipcMain.handle('ground:disconnect', () => disconnectPort('user'));
  ipcMain.handle('ground:sendLine', (_event, line) => sendLine(line));
  ipcMain.handle('ground:getSession', () => ({
    directory: session?.directory ?? null,
    createdAt: session?.createdAt?.toISOString() ?? null,
    portPath: session?.portPath ?? null,
    bufferedLines,
    logStatus,
  }));
  ipcMain.handle('ground:chooseMap', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Offline map imageを選択',
      properties: ['openFile'],
      filters: [{ name: 'Map image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
  ipcMain.on('ground:rendererReady', () => logEvent('renderer_ready'));
  ipcMain.on('ground:rendererReload', () => logEvent('renderer_reload'));
  ipcMain.on('ground:decoded', (_event, record) => {
    if (!session) return;
    syncWrite(session.recordFd, `${JSON.stringify({ ...nowRecord(), direction: 'decoded', record })}\n`);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 1440,
    minHeight: 810,
    backgroundColor: '#efede7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../dist/renderer/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  session = createSession();
  registerIpc();
  logEvent('application_started');
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('before-quit', () => {
  logEvent('application_stopping');
  try { if (session) [session.rawFd, session.recordFd, session.eventFd].forEach((fd) => fs.closeSync(fd)); } catch {}
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
