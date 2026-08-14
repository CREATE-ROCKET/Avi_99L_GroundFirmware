import './style.css';
import { TelemetryStore } from './store.js';
import { SyntheticSource } from './synthetic.js';
import { RocketView } from './three-view.js';
import { LocalMapView } from './map-view.js';
import { SharedTrackChart } from './chart.js';
import { AlertSound } from './sound.js';
import { escapeHtml } from '../../shared/html.js';

const app = document.querySelector('#app');

app.innerHTML = `
<div class="app-shell" id="app-shell">
  <header class="topbar">
    <div class="brand-block">
      <div class="brand">CREATE / 99L</div>
      <div class="brand-sub">GROUND STATION</div>
    </div>
    <div class="state-block">
      <div class="state-label">MISSION STATE</div>
      <div id="mission-state" class="mission-state">UNKNOWN</div>
    </div>
    <div class="header-metric"><span id="time-label">T+</span><strong id="flight-time">—</strong></div>
    <div class="header-metric"><span>LAST RX</span><strong id="rx-age">—</strong></div>
    <div class="header-metric"><span>RSSI</span><strong id="rssi">—</strong></div>
    <div class="header-status"><span class="status-dot" id="rec-dot"></span><div><small>LOG</small><strong id="log-state">ACTIVE</strong></div></div>
    <div class="connection-controls">
      <select id="port-select" aria-label="Serial port"><option value="">SELECT USB PORT</option></select>
      <button id="refresh-ports" class="button ghost">REFRESH</button>
      <button id="connect-port" class="button dark">CONNECT</button>
      <button id="synthetic-toggle" class="button accent">SYNTHETIC</button>
    </div>
  </header>

  <main class="dashboard">
    <section class="panel attitude-panel">
      <div class="panel-title"><span class="section-no">01</span><span>ATTITUDE / 3D</span>
        <div class="panel-actions">
          <button id="pose-mode" class="tiny-button">PREDICT</button>
          <button id="reset-view" class="tiny-button">OBLIQUE</button>
          <button id="copy-view" class="tiny-button">COPY VIEW</button>
        </div>
      </div>
      <div id="rocket-view" class="rocket-view"></div>
      <div class="view-status"><span id="model-status">MODEL LOADING</span><span id="sound-status">SOUND / ARM ON CLICK</span></div>
      <div class="metric-strip" id="attitude-metrics"></div>
    </section>

    <section class="panel map-panel">
      <div class="panel-title"><span class="section-no">02</span><span>FLIGHT / BIRD'S-EYE MAP</span>
        <div class="panel-actions">
          <button id="load-map" class="tiny-button">LOAD OFFLINE MAP</button>
          <input id="map-file" type="file" accept="image/png,image/jpeg,image/webp" hidden />
        </div>
      </div>
      <div id="map-view" class="map-view"></div>
      <div class="metric-strip" id="position-metrics"></div>
    </section>

    <section class="panel inspector-panel">
      <div class="panel-title"><span class="section-no">03</span><span>TELEMETRY / ALL VALUES</span></div>
      <div class="tabs" id="inspector-tabs">
        <button data-tab="overview" class="active">OVERVIEW</button>
        <button data-tab="all">ALL VALUES</button>
        <button data-tab="raw">RAW PACKETS</button>
      </div>
      <div id="inspector-content" class="inspector-content"></div>
    </section>

    <section class="panel flight-chart-panel">
      <div class="panel-title"><span class="section-no">04</span><span>FLIGHT DYNAMICS / FIXED 0–15 s</span>
        <span class="title-note">LATEST VALUES ARE SHOWN INSIDE EACH TRACK</span>
      </div>
      <div id="flight-chart" class="chart-host"></div>
    </section>

    <section class="panel side-bottom-panel">
      <div class="panel-title"><span class="section-no">05</span><span>SYSTEM HISTORY / ALL RUN TIME</span></div>
      <div id="system-chart" class="system-chart-host"></div>
      <div class="console-tabs">
        <button data-console-tab="events" class="active">EVENTS</button>
        <button data-console-tab="console">COMMAND / CONSOLE</button>
      </div>
      <div id="console-content" class="console-content"></div>
    </section>
  </main>

  <div class="liftoff-banner" id="liftoff-banner">
    <span>LIFTOFF DETECTED</span><strong id="liftoff-source">SOURCE / UNKNOWN</strong>
  </div>
  <div class="toast" id="toast"></div>
</div>`;

const store = new TelemetryStore();
const synthetic = new SyntheticSource(store);
const alertSound = new AlertSound();
const shell = document.querySelector('#app-shell');
const missionStateElement = document.querySelector('#mission-state');
const flightTimeElement = document.querySelector('#flight-time');
const rxAgeElement = document.querySelector('#rx-age');
const rssiElement = document.querySelector('#rssi');
const inspector = document.querySelector('#inspector-content');
const consoleContent = document.querySelector('#console-content');
const toast = document.querySelector('#toast');
let inspectorTab = 'overview';
let consoleTab = 'events';
let predictive = true;
let syntheticRunning = false;
let connected = false;
let loggerHealthy = true;

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const rocketView = new RocketView(document.querySelector('#rocket-view'), store, {
  statusElement: document.querySelector('#model-status'),
});
const mapView = new LocalMapView(document.querySelector('#map-view'), store);

const flightChart = new SharedTrackChart(document.querySelector('#flight-chart'), {
  title: 'Flight dynamics',
  subtitle: 'Raw samples / shared 0–15 s time axis',
  fixedX: [0, 15],
  xLabel: 'T+ s',
  getData: () => store.flightHistory,
  tracks: [
    { label: 'Attitude [deg]', maxGap: 1.0, series: [
      { key: 'roll', label: 'ROLL', unit: '°', color: '#11110f' },
      { key: 'tilt', label: 'TILT', unit: '°', color: '#f05a28' },
    ], fallbackRange: [-30, 60], includeZero: true },
    { label: 'Angular rate [deg/s]', maxGap: 1.0, series: [
      { key: 'rollRate', label: 'ROLL RATE', unit: '°/s', color: '#2c879a' },
      { key: 'finRate', label: 'FIN RATE', unit: '°/s', color: '#6c4e90' },
    ], fallbackRange: [-80, 80], includeZero: true },
    { label: 'Fin angle [deg]', maxGap: 1.0, range: [-15, 15], series: [
      { key: 'finAngle', label: 'FIN', unit: '°', color: '#c58b23', width: 2.2 },
    ] },
    { label: 'Requested torque [N·m]', maxGap: 1.0, series: [
      { key: 'requestedTorque', label: 'TORQUE', unit: 'N·m', color: '#c73c32' },
    ], fallbackRange: [-1, 1], includeZero: true },
    { label: 'Airspeed [m/s]', maxGap: 1.0, range: [0, 200], series: [
      { key: 'airspeed', label: 'AIRSPEED', unit: 'm/s', color: '#2d8a59' },
    ] },
    { label: 'Absolute height [m]', maxGap: 1.0, fallbackRange: [0, 1500], series: [
      { key: 'height', label: 'HEIGHT', unit: 'm', color: '#3f6f90' },
    ], includeZero: true },
    { label: 'Static pressure [hPa]', maxGap: 1.0, fallbackRange: [800, 1020], series: [
      { key: 'pressure', label: 'PRESSURE', unit: 'hPa', color: '#68794d' },
    ] },
  ],
});

const systemChart = new SharedTrackChart(document.querySelector('#system-chart'), {
  title: 'System history',
  subtitle: 'From Ground Station application startup',
  xLabel: 'RUN s',
  getData: () => store.systemHistory,
  tracks: [
    { label: 'Power [V]', maxGap: 1.5, range: [0, 12], series: [
      { key: 'logicVoltage', label: 'LOGIC', unit: 'V', color: '#11110f' },
      { key: 'motorVoltage', label: 'MOTOR', unit: 'V', color: '#f05a28' },
    ] },
    { label: 'RSSI [dBm]', maxGap: 1.5, range: [-130, -30], series: [
      { key: 'rssi', label: 'RSSI', unit: 'dBm', color: '#2c879a' },
    ] },
    { label: 'Environment', maxGap: 1.5, series: [
      { key: 'pressure', label: 'PRESS', unit: 'hPa', color: '#2d8a59' },
      { key: 'temperature', label: 'TEMP', unit: '°C', color: '#c58b23' },
    ], fallbackRange: [0, 1050] },
  ],
});


function updateLogStatus(status = {}) {
  loggerHealthy = status.healthy !== false;
  document.querySelector('#log-state').textContent = loggerHealthy ? 'ACTIVE' : 'ERROR';
  const dot = document.querySelector('#rec-dot');
  dot.style.background = loggerHealthy ? 'var(--green)' : 'var(--red)';
  dot.title = loggerHealthy ? `Last fsync: ${status.lastFlushUtc ?? 'pending'}` : `Log error: ${status.error ?? 'unknown'}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function fieldValue(key) {
  const item = store.getLatestValue(key);
  if (!item) return { text: '—', state: 'unknown' };
  if (item.status !== 'VALID' && item.status !== 'TEMPORARY_SCALE') return { text: item.status, state: 'invalid' };
  if (typeof item.value === 'boolean') return { text: item.value ? 'YES' : 'NO', state: item.value ? 'ok' : 'neutral' };
  if (typeof item.value === 'number') {
    const digits = Math.abs(item.value) >= 100 ? 0 : Math.abs(item.value) >= 10 ? 1 : 2;
    return { text: `${item.value.toFixed(digits)}${item.unit ? ` ${item.unit}` : ''}`, state: 'ok' };
  }
  return { text: String(item.value ?? '—'), state: 'neutral' };
}

function metric(label, key) {
  const value = fieldValue(key);
  return `<div class="metric ${value.state}"><span>${label}</span><strong>${value.text}</strong></div>`;
}

function renderMetrics() {
  document.querySelector('#attitude-metrics').innerHTML = [
    metric('ROLL', 'roll'), metric('ROLL RATE', 'rollRate'), metric('TILT', 'tilt'),
    metric('TILT DIR', 'tiltDirection'), metric('FIN', 'finAngle'),
  ].join('');
  document.querySelector('#position-metrics').innerHTML = [
    metric('EAST', 'east'), metric('NORTH', 'north'), metric('HEIGHT ABS', 'height'),
    metric('AIRSPEED', 'airspeed'), metric('PRESSURE', 'pressure'),
  ].join('');
}

function valueRow(item) {
  const valid = item.status === 'VALID' || item.status === 'TEMPORARY_SCALE';
  let display = item.value;
  if (typeof display === 'number') display = `${display.toFixed(Math.abs(display) >= 100 ? 0 : 3)}${item.unit ? ` ${item.unit}` : ''}`;
  else if (typeof display === 'boolean') display = display ? 'YES' : 'NO';
  else if (display === null || display === undefined) display = item.status;
  return `<tr class="${valid ? '' : 'invalid'}"><td>${escapeHtml(item.packetName ?? '')}</td><td>${escapeHtml(item.group)}</td><td>${escapeHtml(item.label)}</td><td>${escapeHtml(display)}</td><td>${escapeHtml(item.raw ?? '—')}</td><td>${escapeHtml(item.status)}</td></tr>`;
}

function renderOverview() {
  const state = store.state;
  const rxAge = store.getRxAgeMs();
  const ageClass = rxAge >= 2000 ? 'error' : rxAge >= 1000 ? 'stale' : rxAge >= 750 ? 'warn' : 'ok';
  return `
    <div class="state-summary ${ageClass}">
      <span>STATE</span><strong>${state}</strong><small>RX AGE ${Number.isFinite(rxAge) ? `${(rxAge/1000).toFixed(2)} s` : '—'}</small>
    </div>
    <div class="overview-grid">
      ${metric('ROLL', 'roll')}${metric('TILT', 'tilt')}${metric('FIN', 'finAngle')}
      ${metric('TORQUE', 'requestedTorque')}${metric('LOGIC', 'logicVoltage')}${metric('MOTOR', 'motorVoltage')}
      ${metric('AIRSPEED', 'airspeed')}${metric('PARA', 'paraAngle')}${metric('HEIGHT', 'height')}
    </div>
    <div class="link-diagnostics">
      <div><span>PACKETS</span><strong>${store.totalPackets}</strong></div>
      <div><span>INVALID</span><strong>${store.invalidPackets}</strong></div>
      <div><span>LAST INTERVAL</span><strong>${store.lastIntervalMs === null ? '—' : `${store.lastIntervalMs} ms`}</strong></div>
      <div><span>EST. MISSED</span><strong>${store.estimatedMissed}</strong></div>
      <div><span>SEQ GAP / DUP</span><strong>${store.sequenceGaps} / ${store.duplicateSequences}</strong></div>
      <div><span>PARSER / APP</span><strong>${store.parserErrors} / ${store.appDecodeMismatches}</strong></div>
      <div><span>TIME REQUEST</span><strong>${store.latestTimeRequestId ?? '—'}</strong></div>
      <div><span>STORE / PAINT P95</span><strong>${percentile(store.storeLatenciesMs, .95) ?? '—'} / ${percentile(store.paintLatenciesMs, .95) ?? '—'} ms</strong></div>
    </div>
    <p class="inspector-note">全packet・全fieldは ALL VALUES と RAW PACKETS に保持される。現在値が存在しないfieldを0へ置換しない。</p>`;
}

function renderAllValues() {
  const items = [...store.latestValues.values()].sort((a, b) =>
    `${a.packetName}/${a.group}/${a.label}`.localeCompare(`${b.packetName}/${b.group}/${b.label}`));
  return `<div class="table-scroll"><table class="value-table"><thead><tr><th>PACKET</th><th>GROUP</th><th>FIELD</th><th>VALUE</th><th>RAW</th><th>STATUS</th></tr></thead><tbody>${items.map(valueRow).join('')}</tbody></table></div>`;
}

function renderRawPackets() {
  const entries = [...store.packetMonitor].reverse().slice(0, 180);
  const content = entries.map((entry) => {
    const record = entry.record;
    const invalid = entry.type === 'parser-error'
      || (record?.type === 'RX' && (!record.valid || entry.appDecodeMismatch));
    const label = record?.type ?? entry.type;
    const detail = record?.type === 'RX'
      ? `SEQ ${record.seq} / RSSI ${record.rssiDbm ?? 'NA'} dBm / ${entry.appDecodeMismatch ? 'APP_DECODE_MISMATCH' : record.valid ? 'VALID' : record.error}`
      : record?.type === 'TX'
        ? `ID ${record.id} / ${record.ok ? 'SENT' : record.error}`
        : record?.type === 'FRAG'
          ? record.reason
          : record?.type === 'SYS' ? record.event : entry.error?.code ?? '';
    return `
    <article class="raw-packet ${invalid ? 'invalid' : ''}">
      <div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(new Date(entry.hostMs).toISOString())}</span></div>
      <div class="raw-meta">${escapeHtml(detail)}</div>
      <code>${escapeHtml(entry.rawLine ?? record?.rawLine ?? '')}</code>
    </article>`;
  }).join('');
  return `<div class="raw-list">${content}</div>`;
}

function renderInspector() {
  if (inspectorTab === 'all') inspector.innerHTML = renderAllValues();
  else if (inspectorTab === 'raw') inspector.innerHTML = renderRawPackets();
  else inspector.innerHTML = renderOverview();
}

function renderEvents() {
  const events = [...store.events].reverse().slice(0, 60);
  consoleContent.innerHTML = `<div class="event-list">${events.map((event) => `
    <div class="event-row ${event.level}"><time>${event.sessionSec.toFixed(3)}</time><span>${escapeHtml(event.label)}</span></div>`).join('')}</div>`;
}

function renderCommandConsole() {
  const disabled = store.connection.connected ? '' : 'disabled';
  const commands = [...store.commandTracker.commands].reverse().slice(0, 20);
  consoleContent.innerHTML = `
    <div class="command-console">
      <div class="quick-commands">
        <button data-command="help" ${disabled}>HELP</button>
        <button data-command="le" ${disabled}>LIFTOFF ESTOP</button>
      </div>
      <form id="command-form"><input id="command-input" autocomplete="off" ${disabled} placeholder="g <command> [arg0 ... arg5] / local ..."/><button ${disabled}>SEND</button></form>
      <div class="console-lines">${commands.map((command) => `<code>#${command.localId} ${escapeHtml(command.state)} ${escapeHtml(command.text)} TX_ID=${command.transactionId ?? '—'}</code>`).join('')}</div>
    </div>`;
  document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => sendCommand(button.dataset.command)));
  document.querySelector('#command-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.querySelector('#command-input');
    sendCommand(input.value);
    input.value = '';
  });
}

function renderConsole() {
  if (consoleTab === 'console') renderCommandConsole(); else renderEvents();
}

function updateHeader() {
  const state = store.state;
  missionStateElement.textContent = state;
  missionStateElement.dataset.state = state;
  const timeLabel = document.querySelector('#time-label');
  const flightElapsed = store.getLatestValue('flightElapsed')?.value;
  const descentElapsed = store.getLatestValue('descentElapsed')?.value;
  const recoveryElapsed = store.getLatestValue('recoveryElapsed')?.value;
  let elapsed = flightElapsed;
  let label = 'T+';
  if (state === 'Descent' && typeof descentElapsed === 'number') { elapsed = descentElapsed; label = 'DESCENT T+'; }
  if (state === 'RecoveryBeacon' && typeof recoveryElapsed === 'number') { elapsed = recoveryElapsed; label = 'RECOVERY T+'; }
  timeLabel.textContent = label;
  flightTimeElement.textContent = typeof elapsed === 'number' ? `${elapsed.toFixed(1)} s` : '—';
  const rxAge = store.getRxAgeMs();
  rxAgeElement.textContent = Number.isFinite(rxAge) ? `${(rxAge / 1000).toFixed(2)} s` : '—';
  rxAgeElement.className = rxAge >= 2000 ? 'link-lost' : rxAge >= 1000 ? 'stale' : rxAge >= 750 ? 'late' : '';
  rssiElement.textContent = store.rssiDbm === null ? '—' : `${store.rssiDbm} dBm`;
  shell.classList.toggle('telemetry-stale', rxAge >= 1000);
}

function redraw() {
  updateHeader();
  renderMetrics();
  renderInspector();
  renderConsole();
  flightChart.draw();
  systemChart.draw();
  requestAnimationFrame(() => {
    const metric = store.markPaint();
    if (metric && window.groundApi) window.groundApi.recordLatency(metric);
  });
}

function triggerLiftoff(detail = {}) {
  alertSound.playLiftoff();
  document.querySelector('#sound-status').textContent = 'SOUND / DOUBLE BEEP';
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

async function sendCommand(line) {
  const normalized = String(line ?? '').trim();
  if (!normalized) return;
  if (!store.connection.connected) {
    showToast('CONNECT USB PORT FIRST');
    return;
  }
  let tracked;
  try {
    tracked = store.queueOutboundCommand(normalized);
    let result = null;
    if (window.groundApi) result = await window.groundApi.sendCommand(normalized);
    else store.addEvent(`SIM TX / ${normalized}`, 'debug');
    store.markCommandUsbWritten(tracked.localId, result?.localId ?? tracked.localId);
    showToast(`SENT / ${normalized}`);
  } catch (error) {
    if (tracked) store.markCommandUsbWriteFailed(tracked.localId, error.message);
    store.addEvent(`TX FAILED / ${error.message}`, 'error');
    showToast(`TX FAILED / ${error.message}`);
  }
}

async function refreshPorts() {
  const select = document.querySelector('#port-select');
  select.innerHTML = '<option value="">SELECT USB PORT</option>';
  if (!window.groundApi) {
    select.innerHTML += '<option value="browser-demo">BROWSER DEMO / NO SERIAL</option>';
    return;
  }
  try {
    const ports = await window.groundApi.listPorts();
    for (const port of ports) {
      const option = document.createElement('option');
      option.value = port.path;
      option.textContent = `${port.path}${port.manufacturer ? ` / ${port.manufacturer}` : ''}${port.serialNumber ? ` / ${port.serialNumber}` : ''}`;
      select.appendChild(option);
    }
  } catch (error) {
    showToast(`PORT LIST ERROR / ${error.message}`);
  }
}

async function connectSelectedPort() {
  if (!window.groundApi) { showToast('SERIAL IS AVAILABLE IN ELECTRON BUILD'); return; }
  try {
    if (connected) {
      await window.groundApi.disconnect();
      return;
    }
    const path = document.querySelector('#port-select').value;
    if (!path) throw new Error('select a port');
    await window.groundApi.connect(path);
  } catch (error) {
    showToast(`CONNECT ERROR / ${error.message}`);
  }
}

function toggleSynthetic() {
  syntheticRunning = !syntheticRunning;
  if (syntheticRunning) synthetic.start(); else synthetic.stop();
  document.querySelector('#synthetic-toggle').classList.toggle('active', syntheticRunning);
  showToast(syntheticRunning ? 'SYNTHETIC SOURCE STARTED' : 'SYNTHETIC SOURCE STOPPED');
}

store.addEventListener('update', redraw);
store.addEventListener('event', () => { if (consoleTab === 'events') renderEvents(); });
store.addEventListener('liftoff', (event) => triggerLiftoff(event.detail));
store.addEventListener('app-decode-mismatch', (event) => {
  if (window.groundApi) window.groundApi.recordAppDecodeMismatch(event.detail);
});

for (const button of document.querySelectorAll('#inspector-tabs button')) {
  button.addEventListener('click', () => {
    inspectorTab = button.dataset.tab;
    document.querySelectorAll('#inspector-tabs button').forEach((item) => item.classList.toggle('active', item === button));
    renderInspector();
  });
}
for (const button of document.querySelectorAll('.console-tabs button')) {
  button.addEventListener('click', () => {
    consoleTab = button.dataset.consoleTab;
    document.querySelectorAll('.console-tabs button').forEach((item) => item.classList.toggle('active', item === button));
    renderConsole();
  });
}

document.querySelector('#pose-mode').addEventListener('click', (event) => {
  predictive = !predictive;
  rocketView.setMode(predictive ? 'predictive' : 'hold');
  event.currentTarget.textContent = predictive ? 'PREDICT' : 'RAW / HOLD';
});
document.querySelector('#reset-view').addEventListener('click', () => rocketView.resetObliqueView());
document.querySelector('#copy-view').addEventListener('click', async () => {
  const view = rocketView.copyView();
  await navigator.clipboard.writeText(view);
  showToast('CAMERA VIEW JSON COPIED');
});
document.querySelector('#load-map').addEventListener('click', () => document.querySelector('#map-file').click());
document.querySelector('#map-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  mapView.loadImage(URL.createObjectURL(file));
  showToast(`OFFLINE MAP LOADED / ${file.name}`);
});
document.querySelector('#refresh-ports').addEventListener('click', refreshPorts);
document.querySelector('#connect-port').addEventListener('click', connectSelectedPort);
document.querySelector('#synthetic-toggle').addEventListener('click', toggleSynthetic);

document.addEventListener('keydown', (event) => {
  if (event.key === 'F9') triggerLiftoff({ source: 'MANUAL TEST' });
});

if (window.groundApi) {
  window.groundApi.onSerialLine((record) => store.ingestLineRecord(record));
  window.groundApi.onSessionStatus((status) => updateLogStatus(status));
  window.groundApi.onConnectionStatus((status) => {
    connected = status.state === 'connected';
    store.setConnection(status);
    const connectButton = document.querySelector('#connect-port');
    connectButton.textContent = status.state === 'connecting' ? 'CONNECTING' : connected ? 'DISCONNECT' : 'CONNECT';
    connectButton.disabled = status.state === 'connecting';
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
  updateLogStatus(session.directory ? (session.status ?? { healthy: true }) : { healthy: false, error: 'session unavailable' });
} else {
  toggleSynthetic();
}

await refreshPorts();
redraw();
setInterval(() => {
  updateHeader();
  if (inspectorTab === 'overview') renderInspector();
}, 100);
