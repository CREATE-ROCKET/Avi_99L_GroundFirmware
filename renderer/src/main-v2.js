import './style-v2.css';
import { TelemetryStore } from './store-v2.js';
import { SyntheticSource } from './synthetic.js';
import { RocketViewV2, LocalMapViewV2 } from './visuals-v2.js';
import { SharedTrackChart } from './chart-v2.js';
import { AlertSound } from './sound.js';
import { createScreenRenderer } from './screens-v2.js';
import { createForceStartUi } from './force-start-ui.js';
import { buildCommand, isActionAvailable } from '../../shared/command-catalog.js';

const fallbackDevMode = Boolean(import.meta.env.DEV) || import.meta.env.VITE_CREATE_99L_DEV_MODE === '1';
const fallbackSynthetic = fallbackDevMode && import.meta.env.VITE_CREATE_99L_SYNTHETIC === '1';
const runtimeFlags = window.groundApi?.getRuntimeFlags
  ? await window.groundApi.getRuntimeFlags()
  : { devMode: fallbackDevMode, syntheticAutostart: fallbackSynthetic };
const DEV_MODE = Boolean(runtimeFlags.devMode);
const SYNTHETIC_AUTOSTART = DEV_MODE && Boolean(runtimeFlags.syntheticAutostart);

const app = document.querySelector('#app');
app.innerHTML = `
<div class="app-shell" id="app-shell">
  <header class="topbar" id="topbar"></header>
  <div class="connectbar">
    <select id="port-select" aria-label="Serial port"><option value="">SELECT USB PORT</option></select>
    <button id="refresh-ports" class="button ghost">REFRESH</button>
    <button id="connect-port" class="button dark">CONNECT</button>
    <span id="connection-label">DISCONNECTED</span>
    <span class="connect-spacer"></span>
    <button id="open-data" class="button ghost">DATA</button>
    ${DEV_MODE ? '<button id="open-dev" class="button ghost">DEV</button>' : ''}
  </div>
  <nav id="context-tabs" class="context-tabs"></nav>
  <main id="view-root" class="view-root"></main>
  <aside id="data-drawer" class="drawer"><div id="data-drawer-inner"></div></aside>
  <aside id="dev-drawer" class="drawer drawer-dev"><div id="dev-drawer-inner"></div></aside>
  <div class="parking" aria-hidden="true"><div id="rocket-parking"></div><div id="map-parking"></div><span id="model-global-status"></span></div>
  <div class="liftoff-banner" id="liftoff-banner"><span>LIFTOFF DETECTED</span><strong id="liftoff-source">SOURCE / UNKNOWN</strong></div>
  <div class="toast" id="toast"></div>
  <input id="map-file" type="file" accept="image/png,image/jpeg,image/webp" hidden />
</div>`;

const store = new TelemetryStore();
const synthetic = new SyntheticSource(store);
const alertSound = new AlertSound();
const shell = document.querySelector('#app-shell');
const topbar = document.querySelector('#topbar');
const viewRoot = document.querySelector('#view-root');
const tabsRoot = document.querySelector('#context-tabs');
const dataDrawer = document.querySelector('#data-drawer');
const dataDrawerInner = document.querySelector('#data-drawer-inner');
const devDrawer = document.querySelector('#dev-drawer');
const devDrawerInner = document.querySelector('#dev-drawer-inner');
const toast = document.querySelector('#toast');
const rocketParking = document.querySelector('#rocket-parking');
const mapParking = document.querySelector('#map-parking');
const rocketView = new RocketViewV2(rocketParking, store, { statusElement: document.querySelector('#model-global-status') });
const mapView = new LocalMapViewV2(mapParking, store);

let commandTab = 'overview';
let dataTab = 'current';
let dataOpen = false;
let devOpen = false;
let connected = false;
let loggerStatus = { healthy: true, lastFlushUtc: null, error: null };
let syntheticRunning = false;
let predictiveMode = true;
let charts = [];
let renderQueued = false;
let spaceTimer = null;
let spaceFired = false;
let lastHandledTimeRequestId = null;

const PARACHUTE_ABSOLUTE_TELEMETRY_MAX_AGE_MS = 1500;
const PARACHUTE_COMMAND_TERMINAL_TIMEOUT_MS = 12000;

const screens = createScreenRenderer({ store, devMode: DEV_MODE, loggerStatus: () => loggerStatus });
const forceStartUi = createForceStartUi({ store, onForce: () => dispatchAction('forceStartSequence') });

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}
function disposeCharts() { for (const chart of charts) chart.dispose(); charts = []; }
function effectiveCommandState() {
  return store.communicationMode === 'MissionLinkFallback' ? (store.lastKnownMissionState ?? store.state) : store.state;
}
function activeInput() {
  const node = document.activeElement;
  return node && ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName);
}
function normalizeParachuteDegrees(value) {
  return ((value % 360) + 360) % 360;
}
function shortestParachuteRelativeMove(currentDegrees, targetDegrees) {
  if (!Number.isFinite(currentDegrees) || !Number.isFinite(targetDegrees)) throw new TypeError('parachute angle must be finite');
  if (targetDegrees < 0 || targetDegrees >= 360) throw new RangeError('parachute absolute target must be 0 <= angle < 360 deg');
  let delta = targetDegrees - normalizeParachuteDegrees(currentDegrees);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  if (Math.abs(Math.abs(delta) - 180) < 1e-9) throw new RangeError('parachute absolute target is exactly 180 deg away');
  let rounded = Math.round(delta * 10) / 10;
  if (Math.abs(rounded) >= 180) rounded = Math.sign(rounded) * 179.9;
  return rounded;
}
function finalCommandResult(entry) {
  return [...(entry?.results ?? [])].reverse().find((result) => result.phase !== 0) ?? null;
}
function waitForCommandTerminal(entry, timeoutMs = PARACHUTE_COMMAND_TERMINAL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const finish = (result) => {
      if (result?.phase === 1 && result.reason === 0) resolve(result);
      else reject(new Error(`terminal phase=${result?.phase ?? 'missing'} reason=${result?.reason ?? 'missing'} detail=${result?.detail ?? 'missing'}`));
    };
    const existing = finalCommandResult(entry);
    if (existing) { finish(existing); return; }
    const cleanup = () => {
      clearTimeout(timer);
      store.removeEventListener('command-result', onResult);
    };
    const onResult = (event) => {
      const detail = event.detail ?? {};
      if (detail.entry !== entry && detail.entry?.localId !== entry?.localId) return;
      if (detail.ackTimeout) {
        cleanup();
        reject(new Error('command ACK timeout'));
        return;
      }
      if (!detail.result || detail.result.phase === 0) return;
      cleanup();
      finish(detail.result);
    };
    const timer = setTimeout(() => {
      store.removeEventListener('command-result', onResult);
      reject(new Error('command terminal timeout'));
    }, timeoutMs);
    store.addEventListener('command-result', onResult);
  });
}
function currentParachuteAbsoluteAngle() {
  const item = store.getLatestValue('paraAngle');
  if (!item || !['VALID', 'TEMPORARY_SCALE'].includes(item.status) || !Number.isFinite(item.value)) {
    throw new Error(`CURRENT POSITION is ${item?.status ?? 'unavailable'}`);
  }
  if (!Number.isFinite(item.hostMs) || Date.now() - item.hostMs > PARACHUTE_ABSOLUTE_TELEMETRY_MAX_AGE_MS) {
    throw new Error('CURRENT POSITION telemetry is stale');
  }
  return normalizeParachuteDegrees(item.value);
}
async function setParachuteEndpointAbsolute(endpoint) {
  const actionName = endpoint === 'open' ? 'setParaOpen' : endpoint === 'close' ? 'setParaClose' : null;
  if (!actionName) return;
  if (!isActionAvailable(actionName, effectiveCommandState(), store.communicationMode)) {
    showToast(`COMMAND DISABLED / ${actionName}`);
    return;
  }
  try {
    const input = document.querySelector(`#para-${endpoint}-absolute`);
    const target = Number(input?.value);
    if (!Number.isFinite(target) || target < 0 || target >= 360) throw new RangeError('absolute angle must be 0 <= angle < 360 deg');
    const current = currentParachuteAbsoluteAngle();
    const delta = shortestParachuteRelativeMove(current, target);
    if (Math.abs(delta) >= 0.05) {
      const move = await sendCommand(buildCommand('paraMoveRelative', { angle: delta }), { throwOnError: true });
      await waitForCommandTerminal(move);
    }
    const save = await sendCommand(buildCommand(actionName), { throwOnError: true });
    await waitForCommandTerminal(save);
    store.addEvent(`PARA ${endpoint.toUpperCase()} ABS SET / target=${target.toFixed(1)}deg start=${current.toFixed(1)}deg delta=${delta.toFixed(1)}deg`, 'ok');
    showToast(`PARA ${endpoint.toUpperCase()} SET / ${target.toFixed(1)}° ABS`);
  } catch (error) {
    store.addEvent(`PARA ${endpoint.toUpperCase()} ABS SET FAILED / ${error.message}`, 'error');
    showToast(`PARA ${endpoint.toUpperCase()} ERROR / ${error.message}`);
  }
}
function renderTopbar() {
  topbar.innerHTML = screens.topbar();
  forceStartUi.decorateTopbar(topbar);
}

function createFlightChart(host, frozen = false) {
  if (!host) return;
  const markers = [
    { t: 8, label: 'CONTROL 8 s', color: '#2c879a' },
    { t: 10, label: '10 s', color: '#9a9891' },
    { t: 17, label: 'TIME FALLBACK 17 s', color: '#c73c32' },
  ];
  if (frozen && store.flightHistory.length) markers.push({ t: store.flightHistory.at(-1).t, label: 'MISSION LINK LOST', color: '#c73c32', width: 2 });
  charts.push(new SharedTrackChart(host, {
    title: frozen ? 'Mission graph / frozen' : 'Flight dynamics',
    subtitle: frozen ? 'Last received Mission samples' : 'Raw samples / shared 0–20 s axis',
    fixedX: [0, 20], xLabel: 'T+ s', getData: () => store.flightHistory, markers,
    tracks: [
      { weight: 1.35, lanes: [{ label: 'Attitude / fin [deg]', maxGap: 1.0, fallbackRange: [-30, 90], includeZero: true, series: [
        { key: 'roll', label: 'ROLL', unit: '°', color: '#11110f', width: 2.1 },
        { key: 'tilt', label: 'TILT', unit: '°', color: '#f05a28' },
        { key: 'finAngle', label: 'FIN', unit: '°', color: '#c58b23' },
      ] }] },
      { weight: 1, lanes: [{ label: 'Angular response [deg/s]', maxGap: 1.0, fallbackRange: [-80, 80], includeZero: true, series: [
        { key: 'rollRate', label: 'ROLL RATE', unit: '°/s', color: '#2c879a' },
        { key: 'finRate', label: 'FIN RATE', unit: '°/s', color: '#6c4e90' },
      ] }] },
      { weight: 1, lanes: [
        { label: 'Requested torque', maxGap: 1.0, fallbackRange: [-1, 1], includeZero: true, series: [{ key: 'requestedTorque', label: 'TORQUE', unit: 'N·m', color: '#c73c32' }] },
        { label: 'Airspeed', maxGap: 1.0, range: [0, 200], series: [{ key: 'airspeed', label: 'AIRSPEED', unit: 'm/s', color: '#2d8a59' }] },
      ] },
      { weight: 1, lanes: [
        { label: 'Absolute height', maxGap: 1.0, fallbackRange: [0, 1500], includeZero: true, series: [{ key: 'height', label: 'HEIGHT', unit: 'm', color: '#3f6f90' }] },
        { label: 'Static pressure', maxGap: 1.0, fallbackRange: [800, 1020], series: [{ key: 'pressure', label: 'PRESS', unit: 'hPa', color: '#68794d' }] },
      ] },
    ],
  }));
}

function createSystemChart(host, compact = false) {
  if (!host) return;
  charts.push(new SharedTrackChart(host, {
    title: compact ? 'Power history' : 'System history',
    subtitle: 'From application startup / no fabricated samples',
    xLabel: 'RUN s', getData: () => store.allRunSystemHistory,
    tracks: compact ? [
      { weight: 1, lanes: [{ label: 'Power [V]', range: [0, 12], maxGap: 2, series: [
        { key: 'logicVoltage', label: 'LOGIC', unit: 'V', color: '#11110f' },
        { key: 'motorVoltage', label: 'MOTOR', unit: 'V', color: '#f05a28' },
      ] }] },
    ] : [
      { weight: 1.2, lanes: [{ label: 'Power [V]', range: [0, 12], maxGap: 2, series: [
        { key: 'logicVoltage', label: 'LOGIC', unit: 'V', color: '#11110f' },
        { key: 'motorVoltage', label: 'MOTOR', unit: 'V', color: '#f05a28' },
      ] }] },
      { weight: .8, lanes: [
        { label: 'RSSI', range: [-130, -30], maxGap: 12, series: [{ key: 'rssi', label: 'RSSI', unit: 'dBm', color: '#2c879a' }] },
        { label: 'Environment', maxGap: 2, fallbackRange: [0, 1050], series: [
          { key: 'pressure', label: 'PRESS', unit: 'hPa', color: '#2d8a59' },
          { key: 'temperature', label: 'TEMP', unit: '°C', color: '#c58b23' },
        ] },
      ] },
    ],
  }));
}

function createDescentChart(host) {
  if (!host) return;
  charts.push(new SharedTrackChart(host, {
    title: 'Descent history', subtitle: 'Raw A4 samples', xLabel: 'DESCENT T+ s',
    getData: () => store.descentHistory,
    tracks: [
      { weight: 1, lanes: [{ label: 'Parachute angle', fallbackRange: [0, 360], series: [{ key: 'paraAngle', label: 'PARA', unit: '°', color: '#f05a28' }] }] },
      { weight: 1, lanes: [
        { label: 'Height', fallbackRange: [0, 1500], series: [{ key: 'height', label: 'HEIGHT', unit: 'm', color: '#3f6f90' }] },
        { label: 'Pressure', fallbackRange: [800, 1020], series: [{ key: 'pressure', label: 'PRESS', unit: 'hPa', color: '#68794d' }] },
      ] },
    ],
  }));
}

function attachVisualsAndCharts() {
  const rocketHost = document.querySelector('#rocket-host');
  const mapHost = document.querySelector('#map-host');
  if (rocketHost) rocketView.attach(rocketHost, { interactive: store.state === 'CommandReceive' && commandTab === 'calibration' });
  else rocketView.attach(rocketParking, { interactive: false });
  if (mapHost) mapView.attach(mapHost); else mapView.attach(mapParking);
  const flightHost = document.querySelector('#flight-chart-host');
  const descentHost = document.querySelector('#descent-chart-host');
  const systemHost = document.querySelector('#system-chart-host');
  if (flightHost) createFlightChart(flightHost, store.communicationMode === 'MissionLinkFallback');
  if (descentHost) createDescentChart(descentHost);
  if (systemHost) createSystemChart(systemHost, store.state === 'CommandReceive' && commandTab === 'overview');
}

function renderDrawers() {
  dataDrawerInner.innerHTML = screens.drawer(dataTab);
  dataDrawer.classList.toggle('open', dataOpen);
  if (DEV_MODE) {
    devDrawerInner.innerHTML = screens.developerDrawer(syntheticRunning);
    devDrawer.classList.toggle('open', devOpen);
  }
}

function bindUi() {
  forceStartUi.decorateScreen(viewRoot);
  document.querySelectorAll('[data-command-tab]').forEach((button) => button.addEventListener('click', () => {
    commandTab = button.dataset.commandTab;
    renderAll(true);
  }));
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => void dispatchAction(button.dataset.action)));
  document.querySelectorAll('[data-ui="data-open"]').forEach((button) => button.addEventListener('click', () => { dataOpen = true; renderDrawers(); bindDrawerUi(); }));
  document.querySelectorAll('[data-ui="dev-open"]').forEach((button) => button.addEventListener('click', () => { devOpen = true; renderDrawers(); bindDrawerUi(); }));
  document.querySelectorAll('[data-view-reset]').forEach((button) => button.addEventListener('click', () => rocketView.resetObliqueView()));
  document.querySelectorAll('[data-view-copy]').forEach((button) => button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(rocketView.copyView()); showToast('CAMERA VIEW JSON COPIED');
  }));
  document.querySelectorAll('[data-map-load]').forEach((button) => button.addEventListener('click', () => document.querySelector('#map-file').click()));
  document.querySelectorAll('[data-move-fin]').forEach((button) => button.addEventListener('click', () => {
    const value = Number(document.querySelector('#fin-relative')?.value ?? 0) * Number(button.dataset.moveFin);
    void dispatchAction('finMoveRelative', { angle: value });
  }));
  document.querySelectorAll('[data-move-para]').forEach((button) => button.addEventListener('click', () => {
    const value = Number(document.querySelector('#para-relative')?.value ?? 0) * Number(button.dataset.movePara);
    void dispatchAction('paraMoveRelative', { angle: value });
  }));
  document.querySelectorAll('[data-set-para-absolute]').forEach((button) => button.addEventListener('click', () => {
    void setParachuteEndpointAbsolute(button.dataset.setParaAbsolute);
  }));
}

function bindDrawerUi() {
  document.querySelectorAll('[data-data-tab]').forEach((button) => button.addEventListener('click', () => { dataTab = button.dataset.dataTab; renderDrawers(); bindDrawerUi(); }));
  document.querySelectorAll('[data-ui="data-close"]').forEach((button) => button.addEventListener('click', () => { dataOpen = false; dataDrawer.classList.remove('open'); }));
  if (!DEV_MODE) return;
  document.querySelectorAll('[data-ui="dev-close"]').forEach((button) => button.addEventListener('click', () => { devOpen = false; renderDrawers(); bindDrawerUi(); }));
  document.querySelectorAll('[data-ui="synthetic-toggle"]').forEach((button) => button.addEventListener('click', toggleSynthetic));
  document.querySelectorAll('[data-ui="liftoff-test"]').forEach((button) => button.addEventListener('click', () => triggerLiftoff({ source: 'MANUAL DEV TEST' })));
  const form = document.querySelector('#dev-console-form');
  if (form) form.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.querySelector('#dev-console-input');
    void sendCommand(input.value);
    input.value = '';
  });
}

function renderAll(force = false) {
  if (!force && activeInput()) {
    renderTopbar();
    if (dataOpen || devOpen) { renderDrawers(); bindDrawerUi(); }
    return;
  }
  disposeCharts();
  renderTopbar();
  tabsRoot.innerHTML = screens.tabs(commandTab);
  viewRoot.innerHTML = screens.screen(commandTab);
  renderDrawers();
  attachVisualsAndCharts();
  bindUi();
  bindDrawerUi();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(false); });
}

async function sendCommand(line, { throwOnError = false } = {}) {
  const normalized = String(line ?? '').trim();
  if (!normalized) return null;
  if (!store.connection.connected) {
    const error = new Error('connect USB port first');
    showToast('CONNECT USB PORT FIRST');
    if (throwOnError) throw error;
    return null;
  }
  let tracked;
  try {
    tracked = store.queueOutboundCommand(normalized);
    const result = window.groundApi ? await window.groundApi.sendCommand(normalized) : null;
    store.markCommandUsbWritten(tracked.localId, result?.localId ?? tracked.localId);
    showToast(`USB WRITTEN / ${normalized}`);
    return tracked;
  } catch (error) {
    if (tracked) store.markCommandUsbWriteFailed(tracked.localId, error.message);
    store.addEvent(`TX FAILED / ${error.message}`, 'error');
    showToast(`TX FAILED / ${error.message}`);
    if (throwOnError) throw error;
    return null;
  }
}

async function dispatchAction(name, options = {}) {
  const state = effectiveCommandState();
  if (!isActionAvailable(name, state, store.communicationMode)) {
    showToast(`COMMAND DISABLED / ${name}`);
    return;
  }
  try {
    if (name === 'exitRecovery' &&
        !window.confirm('Exit Recovery, clear the Mission Recovery latch, and reboot Mission into CommandReceive?'))
      return;
    if (name === 'finMoveRelative' && options.angle === undefined) options.angle = Number(document.querySelector('#fin-relative')?.value ?? 0);
    if (name === 'paraMoveRelative' && options.angle === undefined) options.angle = Number(document.querySelector('#para-relative')?.value ?? 0);
    await sendCommand(buildCommand(name, options));
  } catch (error) {
    showToast(`COMMAND ERROR / ${error.message}`);
  }
}

async function refreshPorts() {
  const select = document.querySelector('#port-select');
  select.innerHTML = '<option value="">SELECT USB PORT</option>';
  if (!window.groundApi) return;
  try {
    for (const port of await window.groundApi.listPorts()) {
      const option = document.createElement('option');
      option.value = port.path;
      option.textContent = `${port.path}${port.manufacturer ? ` / ${port.manufacturer}` : ''}${port.serialNumber ? ` / ${port.serialNumber}` : ''}`;
      select.appendChild(option);
    }
  } catch (error) { showToast(`PORT LIST ERROR / ${error.message}`); }
}

async function connectSelectedPort() {
  if (!window.groundApi) { showToast('SERIAL IS AVAILABLE IN ELECTRON BUILD'); return; }
  try {
    if (connected) await window.groundApi.disconnect();
    else {
      const path = document.querySelector('#port-select').value;
      if (!path) throw new Error('select a port');
      await window.groundApi.connect(path);
    }
  } catch (error) { showToast(`CONNECT ERROR / ${error.message}`); }
}

function toggleSynthetic() {
  if (!DEV_MODE) return;
  syntheticRunning = !syntheticRunning;
  if (syntheticRunning) synthetic.start(); else synthetic.stop();
  showToast(syntheticRunning ? 'SYNTHETIC SOURCE STARTED' : 'SYNTHETIC SOURCE STOPPED');
  renderDrawers(); bindDrawerUi();
}

function triggerLiftoff(detail = {}) {
  alertSound.playLiftoff();
  document.querySelector('#liftoff-source').textContent = `SOURCE / ${detail.source ?? 'UNKNOWN'}`;
  shell.classList.remove('liftoff-flash');
  void shell.offsetWidth;
  shell.classList.add('liftoff-flash');
  document.querySelector('#liftoff-banner').classList.add('show');
  setTimeout(() => {
    shell.classList.remove('liftoff-flash');
    document.querySelector('#liftoff-banner').classList.remove('show');
  }, 1200);
}

async function maybeReplyGroundTime() {
  const id = store.latestTimeRequestId;
  if (!connected || !Number.isInteger(id) || id <= 0 || id === lastHandledTimeRequestId) return;
  lastHandledTimeRequestId = id;
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const milliseconds = now - seconds * 1000;
  await sendCommand(`time ${id} ${seconds} ${milliseconds}`);
}

store.addEventListener('update', () => { scheduleRender(); void maybeReplyGroundTime(); });
store.addEventListener('liftoff', (event) => triggerLiftoff(event.detail));
store.addEventListener('command-result', (event) => {
  forceStartUi.handleCommandResult(event.detail);
  const { matched, result, entry } = event.detail ?? {};
  if (matched && entry?.description?.expectsAck && result?.phase === 0 && result.reason === 0) {
    showToast(`ACK / id=${result.transactionId} command=0x${result.command.toString(16).padStart(2, '0').toUpperCase()}`);
  }
});
store.addEventListener('app-decode-mismatch', (event) => { if (window.groundApi) window.groundApi.recordAppDecodeMismatch(event.detail); });

document.querySelector('#refresh-ports').addEventListener('click', refreshPorts);
document.querySelector('#connect-port').addEventListener('click', connectSelectedPort);
document.querySelector('#open-data').addEventListener('click', () => { dataOpen = true; renderDrawers(); bindDrawerUi(); });
if (DEV_MODE) document.querySelector('#open-dev').addEventListener('click', () => { devOpen = true; renderDrawers(); bindDrawerUi(); });
document.querySelector('#map-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  mapView.loadImage(URL.createObjectURL(file));
  showToast(`OFFLINE MAP LOADED / ${file.name}`);
});

document.addEventListener('keydown', (event) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (event.code === 'Space' && store.state === 'CommandReceive' && store.communicationMode === 'Normal') {
    event.preventDefault();
    if (event.repeat || spaceTimer) return;
    spaceFired = false;
    spaceTimer = setTimeout(() => { spaceFired = true; spaceTimer = null; void dispatchAction('actuatorEmergency'); }, 300);
  }
  if (event.key.toLowerCase() === 'q' && store.state === 'EngineBurn' && store.communicationMode === 'Normal' && !event.repeat) {
    event.preventDefault();
    void dispatchAction('liftoffEmergency');
  }
  if (DEV_MODE && event.key === 'F9') triggerLiftoff({ source: 'MANUAL DEV TEST' });
});
document.addEventListener('keyup', (event) => {
  if (event.code !== 'Space') return;
  if (spaceTimer) { clearTimeout(spaceTimer); spaceTimer = null; }
  if (spaceFired) spaceFired = false;
});

if (window.groundApi) {
  window.groundApi.onSerialLine((record) => store.ingestLineRecord(record));
  window.groundApi.onSessionStatus((status) => { loggerStatus = status; scheduleRender(); });
  window.groundApi.onConnectionStatus((status) => {
    connected = status.state === 'connected';
    store.setConnection(status);
    document.querySelector('#connection-label').textContent = connected ? `${status.path} / CONNECTED` : String(status.state ?? 'DISCONNECTED').toUpperCase();
    const button = document.querySelector('#connect-port');
    button.textContent = status.state === 'connecting' ? 'CONNECTING' : connected ? 'DISCONNECT' : 'CONNECT';
    button.disabled = status.state === 'connecting';
  });
  window.groundApi.onError((error) => store.addEvent(`SERIAL ERROR / ${error.code ?? error.message}`, 'error'));
  const session = await window.groundApi.getSession();
  store.setSessionOrigin(session.createdAt);
  store.beginReplay();
  for (const record of session.replay ?? []) store.ingestSessionEvent(record);
  store.endReplay();
  store.setConnection(session.connection ?? { state: 'disconnected' });
  window.groundApi.rendererReady();
  window.addEventListener('beforeunload', () => window.groundApi.rendererReload());
  loggerStatus = session.directory ? (session.status ?? { healthy: true }) : { healthy: false, error: 'session unavailable' };
}

if (SYNTHETIC_AUTOSTART) toggleSynthetic();
rocketView.setMode(predictiveMode ? 'predictive' : 'hold');
await refreshPorts();
renderAll(true);
// RX age and other clock-derived topbar values need a timer, but chart redraws are
// driven by store updates / resize / view changes. Redrawing long histories at
// 10 Hz while idle wastes CPU and battery without changing any data.
setInterval(renderTopbar, 250);
