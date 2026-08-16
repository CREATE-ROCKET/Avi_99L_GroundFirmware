import { escapeHtml } from '../../shared/html.js';
import { ACTIONS, isActionAvailable } from '../../shared/command-catalog.js';

export function createScreenRenderer({ store, devMode = false, loggerStatus = () => ({ healthy: true }) }) {
  const field = (key) => store.getLatestValue(key);
  const fieldBool = (key) => typeof field(key)?.value === 'boolean' ? field(key).value : null;
  const fieldNum = (key) => {
    const item = field(key);
    return item && (item.status === 'VALID' || item.status === 'TEMPORARY_SCALE') && typeof item.value === 'number'
      ? item.value : null;
  };
  const fieldText = (key, fallback = '—') => {
    const item = field(key);
    if (!item) return fallback;
    if (!['VALID', 'TEMPORARY_SCALE', 'LAST_KNOWN'].includes(item.status)) return item.status;
    if (typeof item.value === 'number') {
      const digits = Math.abs(item.value) >= 100 ? 0 : Math.abs(item.value) >= 10 ? 1 : 2;
      return `${item.value.toFixed(digits)}${item.unit ? ` ${item.unit}` : ''}`;
    }
    if (typeof item.value === 'boolean') return item.value ? 'YES' : 'NO';
    return String(item.value ?? fallback);
  };
  const metric = (label, value, note = '', tone = '') => `<div class="metric-card ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`;
  const statusRow = (label, value, tone = 'ok') => `<div class="status-row"><span>${escapeHtml(label)}</span><i class="dot ${tone}"></i><strong class="${tone}">${escapeHtml(value)}</strong></div>`;
  const commandBit = (bit) => fieldBool(`Command status.bit${bit}`);
  const flightBit = (bit) => fieldBool(`Flight status.bit${bit}`);
  const eventList = (limit = 6) => `<div class="event-list">${[...store.events].reverse().slice(0, limit).map((e) => `<div><time>${e.sessionSec.toFixed(3)}</time><span>${escapeHtml(e.label)}</span></div>`).join('')}</div>`;
  const action = (name, label, { kind = '', disabled = false } = {}) => `<button class="button ${kind}" data-action="${name}" ${disabled ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
  const renderReadiness = () => {
    const fin = commandBit(5) === true;
    const open = commandBit(6) === true;
    const close = commandBit(7) === true;
    const motorProfile = commandBit(21) === true;
    const gyroBias = commandBit(16) === true;
    const gravityReference = commandBit(17) === true;
    const sscZero = commandBit(18) === true;
    const ready = fin && open && close && motorProfile && gyroBias && gravityReference && sscZero;
    return { fin, open, close, motorProfile, gyroBias, gravityReference, sscZero, ready };
  };

  function deviceStatus(name) {
    if (store.communicationMode === 'MissionLinkFallback') return { text: 'N/R', tone: 'muted' };
    if (store.communicationMode === 'RecoveryBeacon') return { text: 'SLEEP', tone: 'muted' };
    if (store.state === 'CommandReceive') {
      const map = { ICM: 0, LPS: 1, SSC: 2, AS5047D: 3, STS: 4 };
      const value = commandBit(map[name]);
      return value === null ? { text: 'N/R', tone: 'muted' } : value ? { text: 'OK', tone: 'ok' } : { text: 'FAULT', tone: 'error' };
    }
    if (['LiftoffDetection', 'EngineBurn', 'Control'].includes(store.state)) {
      if (name === 'ICM') { const v = flightBit(2); return v === null ? { text: 'N/R', tone: 'muted' } : v ? { text: 'OK', tone: 'ok' } : { text: 'FAULT', tone: 'error' }; }
      if (name === 'STS') { const v = flightBit(3); return v === null ? { text: 'N/R', tone: 'muted' } : v ? { text: 'OK', tone: 'ok' } : { text: 'FAULT', tone: 'error' }; }
      if (name === 'AS5047D') return flightBit(10) ? { text: 'FAULT', tone: 'error' } : fieldNum('finAngle') !== null ? { text: 'OK', tone: 'ok' } : { text: 'N/R', tone: 'muted' };
      if (name === 'LPS') return fieldNum('pressure') !== null ? { text: 'OK', tone: 'ok' } : { text: 'N/R', tone: 'muted' };
      if (name === 'SSC') return fieldNum('airspeed') !== null ? { text: 'OK', tone: 'ok' } : { text: 'N/R', tone: 'muted' };
    }
    if (store.state === 'Descent') {
      // 最新A4はLPS/STS/SSC health bitを持たない。観測できないhealthをOKと断定しない。
      if (name === 'LPS') return fieldNum('pressure') !== null ? { text: 'DATA', tone: 'ok' } : { text: 'N/R', tone: 'muted' };
      return { text: 'N/R', tone: 'muted' };
    }
    return { text: 'N/R', tone: 'muted' };
  }

  function topbar() {
    const rxAge = store.getRxAgeMs();
    const recovery = store.communicationMode === 'RecoveryBeacon';
    const late = recovery ? 15000 : 750;
    const lost = recovery ? 25000 : 2000;
    const rxTone = rxAge >= lost ? 'error' : rxAge >= late ? 'warn' : 'ok';
    const devices = ['ICM', 'LPS', 'SSC', 'AS5047D', 'STS'].map((name) => {
      const s = deviceStatus(name);
      return `<div class="device-chip"><span>${name}</span><strong class="${s.tone}">${s.text}</strong></div>`;
    }).join('');
    const gnss = field('gnssState') ? fieldText('gnssState') : field('east') ? (field('east').status === 'VALID' ? 'POSITION' : field('east').status) : '—';
    const power = (key) => {
      const text = fieldText(key);
      return store.communicationMode === 'MissionLinkFallback' || (store.communicationMode === 'Normal' && store.state !== 'CommandReceive') ? `LAST ${text}` : text;
    };
    const log = loggerStatus();
    return `<div class="brand-block"><strong>CREATE / 99L</strong><small>MISSION CONTROL</small></div>
      <div class="state-block"><strong data-state="${store.state}">${escapeHtml(store.state.toUpperCase())}</strong><small>MISSION STATE</small></div>
      <div class="comm-block"><small>COMM MODE</small><strong>${escapeHtml(store.communicationMode.toUpperCase())}</strong></div>
      <div class="device-strip">${devices}</div>
      <div class="top-metric"><span>GNSS</span><strong>${escapeHtml(gnss)}</strong></div>
      <div class="top-metric"><span>LORA</span><strong class="${rxTone}">${store.rssiDbm === null ? '—' : `${store.rssiDbm} dBm`}</strong></div>
      <div class="top-metric"><span>RX AGE</span><strong class="${rxTone}">${Number.isFinite(rxAge) ? `${(rxAge / 1000).toFixed(2)} s` : '—'}</strong></div>
      <div class="top-metric"><span>LOGIC</span><strong>${escapeHtml(power('logicVoltage'))}</strong></div>
      <div class="top-metric"><span>MOTOR</span><strong>${escapeHtml(power('motorVoltage'))}</strong></div>
      <div class="top-metric"><span>REC</span><strong class="${log.healthy ? 'ok' : 'error'}">${log.healthy ? '●' : 'ERR'}</strong></div>
      <div class="top-metric"><span>FSYNC</span><strong>${log.lastFlushUtc ? 'OK' : '—'}</strong></div>`;
  }

  function tabs(commandTab) {
    if (store.communicationMode !== 'Normal') return '';
    if (store.state === 'CommandReceive') {
      return [['overview', 'OVERVIEW'], ['calibration', 'CALIBRATION'], ['actuators', 'ACTUATORS'], ['system', 'SYSTEM']]
        .map(([key, label]) => `<button data-command-tab="${key}" class="${commandTab === key ? 'active' : ''}">${label}</button>`).join('');
    }
    if (['LiftoffDetection', 'EngineBurn', 'Control'].includes(store.state)) {
      return ['LiftoffDetection', 'EngineBurn', 'Control'].map((s) => `<button disabled class="${store.state === s ? 'active' : ''}">${s.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()}</button>`).join('');
    }
    return '';
  }

  function overview() {
    const r = renderReadiness();
    return `<div class="grid command-overview">
      <section class="panel readiness-panel"><div class="panel-title"><b>01</b> FLIGHT READINESS</div><div class="big-state ${r.ready ? 'ok' : 'error'}">${r.ready ? 'FLIGHT READY' : 'NOT READY'}</div>${statusRow('FIN ZERO', r.fin ? 'READY' : 'NOT SET', r.fin ? 'ok' : 'error')}${statusRow('PARA OPEN', r.open ? 'READY' : 'NOT SET', r.open ? 'ok' : 'error')}${statusRow('PARA CLOSE', r.close ? 'READY' : 'NOT SET', r.close ? 'ok' : 'error')}${statusRow('MOTOR PROFILE', r.motorProfile ? 'VALID' : 'INVALID', r.motorProfile ? 'ok' : 'error')}${statusRow('GYRO BIAS', r.gyroBias ? 'VALID' : 'INVALID', r.gyroBias ? 'ok' : 'error')}${statusRow('GRAVITY REFERENCE', r.gravityReference ? 'VALID' : 'INVALID', r.gravityReference ? 'ok' : 'error')}${statusRow('SSC ZERO', r.sscZero ? 'VALID' : 'INVALID', r.sscZero ? 'ok' : 'error')}<div class="action-row">${action('runCalibration', 'RUN PREFLIGHT CAL')}${action('setFinZero', 'SET FIN ZERO')}${action('finZeroHold', 'ZERO HOLD')}${action('startSequence', 'START SEQUENCE', { kind: 'dark' })}</div></section>
      <section class="panel vehicle-panel"><div class="panel-title"><b>02</b> VEHICLE / 3D</div><div id="rocket-host" class="visual-host"></div><div class="metric-grid small">${metric('FIN', fieldText('finAngle'))}${metric('PARA', fieldText('paraAngle'))}${metric('TILT', fieldText('tilt'))}</div></section>
      <section class="panel map-panel"><div class="panel-title"><b>03</b> MAP / POSITION</div><div id="map-host" class="visual-host"></div><div class="metric-grid small">${metric('EAST', fieldText('east'))}${metric('NORTH', fieldText('north'))}${metric('HEIGHT', fieldText('height'))}</div></section>
      <section class="panel quick-panel"><div class="panel-title"><b>04</b> QUICK STATUS</div><div class="quick-cards"><button data-command-tab="calibration"><span>CALIBRATION</span><strong>${commandBit(16) && commandBit(17) ? 'VALID' : 'CHECK'}</strong></button><button data-command-tab="actuators"><span>ACTUATORS</span><strong>FIN / PARA</strong></button><button data-command-tab="system"><span>SYSTEM</span><strong>POWER / STORAGE</strong></button></div><div class="emergency-hint">SPACE HOLD 300 ms / ACTUATOR EMERGENCY STOP</div></section>
      <section class="panel power-mini"><div class="panel-title"><b>05</b> POWER</div><div class="power-values">${metric('LOGIC', fieldText('logicVoltage'))}${metric('MOTOR', fieldText('motorVoltage'))}</div><div class="mini-history" id="system-chart-host"></div><small>Voltage history is live; endurance remains disabled until the review power model is encoded.</small></section></div>`;
  }

  function calibration() {
    return `<div class="grid calibration-view"><section class="panel calibration-3d"><div class="panel-title"><b>01</b> PRE-FLIGHT CALIBRATION / 3D</div><div class="calibration-overlay"><span>ICM Z = VEHICLE LONGITUDINAL AXIS / SIGN RESOLVED FROM GRAVITY</span><span>HEADING = LAUNCHER TRUE AZIMUTH / NOT GRAVITY-DERIVED</span></div><div id="rocket-host" class="visual-host"></div><div class="calibration-footer">GRAVITY REFERENCE ${commandBit(17) ? 'VALID' : 'INVALID'} • TILT ${escapeHtml(fieldText('tilt'))}</div></section><section class="panel calibration-detail"><div class="panel-title"><b>02</b> CALIBRATION DETAILS</div>${statusRow('GYRO BIAS', commandBit(16) ? 'VALID' : 'INVALID', commandBit(16) ? 'ok' : 'warn')}${statusRow('GRAVITY REFERENCE', commandBit(17) ? 'VALID' : 'INVALID', commandBit(17) ? 'ok' : 'warn')}${statusRow('SSC ZERO', commandBit(18) ? 'VALID' : 'INVALID', commandBit(18) ? 'ok' : 'warn')}<div class="not-telemetried"><b>GRAVITY VECTOR XYZ</b><span>NOT TELEMETRIED IN CURRENT A0</span><b>GYRO BIAS XYZ</b><span>NOT TELEMETRIED IN CURRENT A0</span><b>SAMPLE COUNT / RESIDUAL</b><span>NOT TELEMETRIED</span></div><div class="action-row">${action('runCalibration', 'RUN CALIBRATION', { kind: 'dark' })}<button class="button ghost" data-view-reset>RESET VIEW</button><button class="button ghost" data-view-copy>COPY VIEW</button></div></section><section class="panel full-row"><div class="panel-title"><b>03</b> CALIBRATION NOTE</div><p>Detailed values that are not present on the wire stay explicitly unavailable. The GUI does not fabricate calibration vectors from status bits.</p></section></div>`;
  }

  function actuators() {
    const finAngle = fieldText('finAngle'), paraAngle = fieldText('paraAngle');
    return `<div class="grid actuator-view"><section class="panel actuator-half"><div class="panel-title"><b>01</b> LINKED FIN PAIR</div><div class="actuator-graphic fin-graphic"><span>LINKED MECHANISM</span><strong>${escapeHtml(finAngle)}</strong><small>COMMAND LIMIT ENFORCED BY MISSION</small></div><div class="metric-grid">${metric('CURRENT', finAngle)}${metric('MODE', fieldText('finMode'))}${metric('ZERO', commandBit(5) ? 'CONFIGURED' : 'NOT SET')}</div><div class="action-row wrap">${action('finFree', 'FREE')}${action('setFinZero', 'SET ZERO')}${action('finZeroHold', 'ZERO HOLD', { kind: 'dark' })}<input id="fin-relative" class="numeric-input" type="number" step="0.1" min="0" max="30" value="5.0"/><button class="button ghost" data-move-fin="-1">MOVE −</button><button class="button ghost" data-move-fin="1">MOVE +</button></div></section><section class="panel actuator-half"><div class="panel-title"><b>02</b> PARACHUTE SERVO</div><div class="actuator-graphic para-graphic"><span>STS3215 / CURRENT ANGLE</span><strong>${escapeHtml(paraAngle)}</strong><small>OPEN ANGLE ? / CLOSE ANGLE ? — NOT TELEMETRIED</small></div><div class="metric-grid">${metric('CURRENT', paraAngle)}${metric('MODE', fieldText('paraMode'))}${metric('OPEN', commandBit(6) ? 'CONFIGURED' : 'NOT SET')}${metric('CLOSE', commandBit(7) ? 'CONFIGURED' : 'NOT SET')}</div><div class="action-row wrap">${action('paraFree', 'FREE')}${action('paraHold', 'HOLD', { kind: 'dark' })}<input id="para-relative" class="numeric-input" type="number" step="0.1" min="0" max="179.9" value="10.0"/><button class="button ghost" data-move-para="-1">MOVE −</button><button class="button ghost" data-move-para="1">MOVE +</button></div><div class="action-row wrap">${action('setParaOpen', 'SET CURRENT AS OPEN')}${action('setParaClose', 'SET CURRENT AS CLOSE')}${action('paraOpen', 'OPEN')}${action('paraClose', 'CLOSE')}</div></section><section class="panel full-row emergency-panel"><strong>SPACE HOLD 300 ms</strong><span>ACTUATOR EMERGENCY STOP</span></section></div>`;
  }

  function system() {
    return `<div class="grid system-view"><section class="panel power-detail"><div class="panel-title"><b>01</b> POWER / ALL RUN TIME</div><div class="power-values">${metric('LOGIC', fieldText('logicVoltage'))}${metric('MOTOR', fieldText('motorVoltage'))}<div class="tte"><span>EST. ENDURANCE</span><strong>MODEL NOT CONFIGURED</strong></div></div><div id="system-chart-host" class="system-chart-large"></div><small>TTE stays disabled until battery-capacity and review current-budget constants are encoded and verified.</small></section><section class="panel storage-panel"><div class="panel-title"><b>02</b> STORAGE / PERSISTENCE</div>${statusRow('MISSION SD', commandBit(10) ? 'OK' : 'FAULT', commandBit(10) ? 'ok' : 'error')}${statusRow('COMBOARD SD', commandBit(11) ? 'OK' : 'FAULT', commandBit(11) ? 'ok' : 'error')}${statusRow('PERSISTENCE', commandBit(13) ? 'OK' : 'FAULT', commandBit(13) ? 'ok' : 'error')}${statusRow('FLASH DATA', commandBit(19) ? 'PRESENT' : 'EMPTY', commandBit(19) ? 'ok' : 'muted')}${statusRow('FLASH BACKUP', commandBit(20) ? 'HEALTHY' : 'FAULT', commandBit(20) ? 'ok' : 'error')}${action('exportFlash', 'EXPORT FLASH LOG → SD AND ERASE', { disabled: commandBit(14) || commandBit(15) || commandBit(23) })}</section><section class="panel comboard-panel"><div class="panel-title"><b>03</b> COMBOARD / GNSS</div>${statusRow('GNSS', fieldNum('east') !== null ? 'POSITION VALID' : 'NO VALID POSITION', fieldNum('east') !== null ? 'ok' : 'warn')}${statusRow('LORA', store.rssiDbm === null ? 'NO RX' : `${store.rssiDbm} dBm`, store.rssiDbm === null ? 'warn' : 'ok')}<div class="action-row wrap">${action('gnssOn', 'GNSS ON')}${action('gnssOff', 'GNSS OFF')}${action('startLogging', 'START LOGGING')}${action('stopLogging', 'STOP LOGGING')}<button class="button ghost" data-map-load>LOAD OFFLINE MAP</button></div><div class="port-summary">USB: ${escapeHtml(store.connection.path ?? 'DISCONNECTED')}</div></section><section class="panel motor-profile"><div class="panel-title"><b>04</b> MOTOR PROFILE</div>${metric('ACTIVE PROFILE', fieldText('motorProfile'))}${statusRow('PROFILE VALID', commandBit(21) ? 'YES' : 'NO', commandBit(21) ? 'ok' : 'warn')}<div class="small-summary">BUILD-TIME FIXED / RUNTIME SELECTION DISABLED</div></section><section class="panel system-events"><div class="panel-title"><b>05</b> RECENT EVENTS / ACCESS</div>${eventList(7)}<div class="action-row"><button class="button ghost" data-ui="data-open">OPEN DATA INSPECTOR</button>${devMode ? '<button class="button ghost" data-ui="dev-open">OPEN DEV MODE</button>' : ''}</div></section></div>`;
  }

  function flight() {
    const state = store.state;
    const elapsed = fieldNum('flightElapsed'), airspeed = fieldNum('airspeed');
    const attitudeValid = fieldNum('roll') !== null && fieldNum('tilt') !== null;
    const gate = [
      ['T+ ≥ 8 S', elapsed === null ? 'UNKNOWN' : elapsed >= 8 ? 'PASS' : `${elapsed.toFixed(1)} s`, elapsed !== null && elapsed >= 8 ? 'ok' : 'warn'],
      ['AIRSPEED > 60', airspeed === null ? 'UNKNOWN' : airspeed > 60 ? 'PASS' : 'FAIL', airspeed !== null && airspeed > 60 ? 'ok' : 'warn'],
      ['ATTITUDE', attitudeValid ? 'PASS' : 'UNKNOWN', attitudeValid ? 'ok' : 'warn'],
      ['FIN ZERO HOLD', field('Command status.bit5') ? (commandBit(5) ? 'LAST OK' : 'LAST FAIL') : 'UNKNOWN', 'muted'],
      ['LPS', field('Command status.bit1') ? (commandBit(1) ? 'LAST OK' : 'LAST FAIL') : 'UNKNOWN', 'muted'],
      ['SSC', field('Command status.bit2') ? (commandBit(2) ? 'LAST OK' : 'LAST FAIL') : 'UNKNOWN', 'muted'],
      ['GYRO BIAS', field('Command status.bit16') ? (commandBit(16) ? 'LAST OK' : 'LAST FAIL') : 'UNKNOWN', 'muted'],
      ['SSC ZERO', field('Command status.bit18') ? (commandBit(18) ? 'LAST OK' : 'LAST FAIL') : 'UNKNOWN', 'muted'],
      ['REENTRY INHIBITED', flightBit(15) ? 'YES' : 'NO', flightBit(15) ? 'error' : 'ok'],
    ];
    const statePanel = state === 'LiftoffDetection'
      ? `<div class="state-title amber">ARMED</div><small>WAITING FOR LIFTOFF</small>${statusRow('ICM TRIGGER', flightBit(1) ? 'DETECTED' : 'WAIT', flightBit(1) ? 'ok' : 'warn')}${statusRow('LPS TRIGGER', flightBit(0) ? 'DETECTED' : 'WAIT', flightBit(0) ? 'ok' : 'warn')}<div class="action-row">${action('cancelSequence', 'CANCEL SEQUENCE')}${action('disableFinControl', 'DISABLE FIN CONTROL', { kind: 'dark' })}</div>`
      : state === 'EngineBurn'
        ? `<div class="state-title">CONTROL GATE</div><small>ENTRY CONDITIONS / GROUND DOES NOT INVENT UNSENT CONDITIONS</small>${gate.map(([a, b, c]) => statusRow(a, b, c)).join('')}<div class="key-hint">Q / LIFTOFF DETECTION EMERGENCY STOP</div><div class="action-row">${action('disableFinControl', 'DISABLE FIN CONTROL')}</div>`
        : `<div class="state-title cyan">ROLL CONTROL</div><small>ACTIVE / CLOSED LOOP</small><div class="metric-grid">${metric('REFERENCE', fieldText('controlRollReference'))}${metric('DEVIATION', fieldText('rollDeviation'))}${metric('ROLL', fieldText('roll'))}${metric('FIN', fieldText('finAngle'))}</div>${statusRow('REFERENCE VALID', field('Control roll flags.bit0') ? (fieldBool('Control roll flags.bit0') ? 'YES' : 'NO') : 'UNKNOWN', fieldBool('Control roll flags.bit0') ? 'ok' : 'warn')}${statusRow('CONTROL ACTIVE', (fieldBool('Control roll flags.bit2') ?? flightBit(4)) ? 'YES' : 'NO', (fieldBool('Control roll flags.bit2') ?? flightBit(4)) ? 'ok' : 'warn')}${statusRow('SATURATION', flightBit(12) ? 'YES' : 'NO', flightBit(12) ? 'error' : 'ok')}${statusRow('BRAKE', flightBit(13) ? 'YES' : 'NO', flightBit(13) ? 'warn' : 'ok')}<div class="action-row">${action('disableFinControl', 'DISABLE FIN CONTROL')}</div>`;
    return `<div class="grid flight-view"><section class="panel flight-3d"><div class="panel-title"><b>01</b> ATTITUDE / 3D</div><div id="rocket-host" class="visual-host"></div><div class="metric-grid small">${metric('ROLL', fieldText('roll'))}${metric('TILT', fieldText('tilt'))}${metric('TILT DIR', fieldText('tiltDirection'))}${metric('FIN', fieldText('finAngle'))}</div></section><section class="panel flight-map"><div class="panel-title"><b>02</b> BIRD'S-EYE / MAP</div><div id="map-host" class="visual-host"></div><div class="metric-grid small">${metric('EAST', fieldText('east'))}${metric('NORTH', fieldText('north'))}${metric('HEIGHT', fieldText('height'))}${metric('AIRSPEED', fieldText('airspeed'))}${metric('PRESSURE', fieldText('pressure'))}</div></section><section class="panel flight-state"><div class="panel-title"><b>03</b> STATE / CONTROL</div>${statePanel}</section><section class="panel flight-chart"><div class="panel-title"><b>04</b> FLIGHT DYNAMICS / FIXED 0–20 S</div><div id="flight-chart-host" class="flight-chart-host"></div></section><section class="panel flight-events"><div class="panel-title"><b>05</b> EVENT / SAFETY</div>${eventList(6)}<div class="small-summary">RX ${Number.isFinite(store.getRxAgeMs()) ? `${(store.getRxAgeMs() / 1000).toFixed(2)} s` : '—'}<br/>A7 ${field('controlRollReference') ? `REF ${fieldText('controlRollReference')} / DEV ${fieldText('rollDeviation')}` : 'NOT RECEIVED'}<br/>POWER L ${fieldText('logicVoltage')} / M ${fieldText('motorVoltage')}</div><button class="button ghost" data-ui="data-open">OPEN DATA INSPECTOR</button></section></div>`;
  }

  function descent() {
    const failure = field('parachuteDeploymentFailure');
    const failureText = failure?.status === 'VALID' ? String(failure.value) : fieldText('parachuteDeploymentFailure', 'UNKNOWN');
    const failureActive = failure?.status === 'VALID' && failure.raw !== 0;
    const persistenceCorrupt = fieldBool('parachutePersistenceCorrupt');
    const reservedStatus = field('descentReservedStatus');
    return `<div class="grid descent-view"><section class="panel descent-map"><div class="panel-title"><b>01</b> RECOVERY POSITION / MAP</div><div id="map-host" class="visual-host"></div><div class="metric-grid">${metric('EAST', fieldText('east'))}${metric('NORTH', fieldText('north'))}${metric('HEIGHT', fieldText('height'))}${metric('PARA', fieldText('paraAngle'))}</div></section><section class="panel deployment"><div class="panel-title"><b>02</b> PARACHUTE / DEPLOYMENT</div><div class="state-title ${failureActive ? 'red' : 'amber'}">${failureActive ? 'DEPLOYMENT FAILURE' : 'NO FAILURE LATCHED'}</div>${statusRow('FAILURE CODE', failureText, failureActive ? 'error' : 'ok')}${statusRow('PERSISTENCE', persistenceCorrupt === true ? 'CORRUPT' : persistenceCorrupt === false ? 'OK' : 'N/R', persistenceCorrupt === true ? 'error' : persistenceCorrupt === false ? 'ok' : 'muted')}${statusRow('RESERVED STATUS', reservedStatus?.raw ? `NONZERO 0x${reservedStatus.raw.toString(16).toUpperCase()}` : 'ZERO', reservedStatus?.raw ? 'error' : 'ok')}<div class="metric-grid small">${metric('PARA ANGLE', fieldText('paraAngle'))}${metric('DESCENT TIME', fieldText('descentElapsed'))}${metric('PRESSURE', fieldText('pressure'))}</div><div class="action-row">${action('enterRecovery', 'REQUEST RECOVERY', { kind: 'dark' })}</div><small>Recovery entry is Mission-owned. The GUI sends MissionGeneric EnterRecovery; Mission validates deployment-power and state preconditions.</small></section><section class="panel descent-chart"><div class="panel-title"><b>03</b> DESCENT HISTORY</div><div id="descent-chart-host" class="flight-chart-host"></div></section><section class="panel descent-system"><div class="panel-title"><b>04</b> SYSTEM</div>${statusRow('LPS DATA', fieldNum('pressure') !== null ? 'RECEIVED' : 'N/R', fieldNum('pressure') !== null ? 'ok' : 'muted')}${statusRow('STS HEALTH', 'NOT TELEMETRIED IN CURRENT A4', 'muted')}${statusRow('POWER CUTOFF', 'NOT TELEMETRIED IN CURRENT A4', 'muted')}${eventList(4)}</section></div>`;
  }

  function recovery() {
    return `<div class="recovery-banner"><strong>RECOVERY BEACON</strong><span>${store.state === 'Descent' ? 'MISSION STATE REMAINS DESCENT' : `MISSION STATE ${escapeHtml(store.state)} / LAST ${escapeHtml(store.lastKnownMissionState ?? 'UNKNOWN')}`} / MISSION-OWNED RECOVERY ENTRY</span></div><div class="grid recovery-view"><section class="panel recovery-map"><div class="panel-title"><b>01</b> RECOVERY POSITION / MAP</div><div id="map-host" class="visual-host"></div><div class="metric-grid">${metric('EAST', fieldText('east'))}${metric('NORTH', fieldText('north'))}${metric('HEIGHT', fieldText('height'))}${metric('GNSS', fieldNum('east') !== null ? 'VALID POSITION' : field('east')?.status ?? '—')}</div></section><section class="panel recovery-link"><div class="panel-title"><b>02</b> LINK / RECOVERY STATUS</div><div class="state-title">${Number.isFinite(store.getRxAgeMs()) ? `${(store.getRxAgeMs() / 1000).toFixed(1)} s` : '—'}</div><small>LAST BEACON RX</small>${statusRow('COMM MODE', 'RECOVERY', 'ok')}${statusRow('GNSS', fieldNum('east') !== null ? 'VALID' : 'NO FIX', fieldNum('east') !== null ? 'ok' : 'warn')}${statusRow('LORA', store.rssiDbm === null ? '—' : `${store.rssiDbm} dBm`, store.rssiDbm === null ? 'warn' : 'ok')}${statusRow('GROUND LOG', loggerStatus().healthy ? 'FSYNC OK' : 'ERROR', loggerStatus().healthy ? 'ok' : 'error')}</section><section class="panel recovery-power"><div class="panel-title"><b>03</b> POWER / LOG DUMP</div><div class="metric-grid">${metric('LOGIC', fieldText('logicVoltage'))}${metric('MOTOR', fieldText('motorVoltage'))}${metric('ENDURANCE', 'MODEL PENDING')}</div><div class="action-row wrap">${action('wakeMission', 'WAKE MISSION')}${action('dumpInternalFlash', 'DUMP INTERNAL FLASH', { kind: 'dark' })}${action('dumpMissionSd', 'DUMP MISSION SD')}${action('stopLogDump', 'STOP DUMP')}${action('exitRecovery', 'EXIT RECOVERY', { kind: 'dark' })}</div><div class="small-summary">EXIT RECOVERY clears the Mission persistent Recovery latch only after Mission acknowledgement, then reboots Mission into CommandReceive.</div><div class="small-summary">TRANSFER ${fieldText('transferId')} / OFFSET ${fieldText('offset')} / EOF ${fieldText('eof')}</div></section><section class="panel recovery-events"><div class="panel-title"><b>04</b> RECOVERY EVENTS / DATA</div>${eventList(4)}<button class="button ghost" data-ui="data-open">OPEN DATA INSPECTOR</button></section></div>`;
  }

  function fallback() {
    return `<div class="fallback-banner"><strong>MISSION LINK LOST</strong><span>LAST STATE ${escapeHtml(store.lastKnownMissionState ?? fieldText('lastMissionState'))} / ${escapeHtml(fieldText('missionStatusAge'))} AGO</span><em>MISSION TELEMETRY FROZEN — COMBOARD / GNSS / LORA REMAIN LIVE</em></div><div class="grid fallback-view"><section class="panel fallback-map"><div class="panel-title"><b>01</b> LIVE GNSS / MAP</div><div id="map-host" class="visual-host"></div><div class="metric-grid small">${metric('EAST', fieldText('east'))}${metric('NORTH', fieldText('north'))}${metric('HEIGHT', fieldText('height'))}${metric('GNSS', fieldText('gnssState'))}${metric('LORA', store.rssiDbm === null ? '—' : `${store.rssiDbm} dBm`)}</div></section><section class="panel fallback-diagnosis"><div class="panel-title"><b>02</b> MISSION LINK DIAGNOSIS</div><div class="state-title red">${escapeHtml(fieldText('fallbackReason'))}</div>${statusRow('MISSION STATUS AGE', fieldText('missionStatusAge'), 'error')}${statusRow('ANY MISSION CAN AGE', fieldText('anyMissionCanAge'), 'error')}${statusRow('POWER TIME AGE', fieldText('powerTimeAge'), 'warn')}${statusRow('CAN HEALTH', fieldText('canHealth'), fieldText('canHealth') === 'ACTIVE' ? 'ok' : 'warn')}${statusRow('GNSS STATE', fieldText('gnssState'), fieldText('gnssState') === 'VALID_FIX' ? 'ok' : 'warn')}<hr/><strong>LAST POWER — NOT LIVE</strong><p>LOGIC ${escapeHtml(fieldText('logicVoltage'))}<br/>MOTOR ${escapeHtml(fieldText('motorVoltage'))}<br/>ENDURANCE UNAVAILABLE</p></section><section class="panel fallback-snapshot"><div class="panel-title"><b>03</b> LAST MISSION SNAPSHOT</div><div id="rocket-host" class="visual-host small-frozen"></div><div class="frozen-label">FROZEN / NO PREDICTION / NO INTERPOLATION</div></section><section class="panel fallback-chart"><div class="panel-title"><b>04</b> MISSION GRAPH / FROZEN</div><div id="flight-chart-host" class="flight-chart-host"></div></section><section class="panel fallback-ops"><div class="panel-title"><b>05</b> COMBOARD LIVE</div>${statusRow('GNSS', fieldText('gnssState'), 'ok')}${statusRow('LOGGING', fieldBool('Fallback status.bit6') ? 'ACTIVE' : 'UNKNOWN', fieldBool('Fallback status.bit6') ? 'ok' : 'warn')}<div class="action-row wrap">${action('gnssOn', 'GNSS ON')}${action('gnssOff', 'GNSS OFF')}${action('startLogging', 'START LOG')}${action('stopLogging', 'STOP LOG')}${action('wakeMission', 'WAKE')}${action('dumpInternalFlash', 'DUMP FLASH')}</div><small>Mission generic commands are disabled. Emergency commands are best-effort only and are never queued across recovery.</small></section></div>`;
  }

  function waiting() {
    return `<div class="waiting"><div class="state-title">WAITING FOR MISSION TELEMETRY</div><p>Select a USB port and connect. MissionState remains UNKNOWN until Mission-derived telemetry arrives.</p></div>`;
  }

  function screen(commandTab) {
    if (store.communicationMode === 'MissionLinkFallback') return fallback();
    if (store.communicationMode === 'RecoveryBeacon') return recovery();
    if (store.state === 'CommandReceive') return commandTab === 'calibration' ? calibration() : commandTab === 'actuators' ? actuators() : commandTab === 'system' ? system() : overview();
    if (['LiftoffDetection', 'EngineBurn', 'Control'].includes(store.state)) return flight();
    if (store.state === 'Descent') return descent();
    return waiting();
  }

  function currentValues() {
    const rows = [...store.latestValues.values()].sort((a, b) => `${a.packetName}/${a.group}/${a.label}`.localeCompare(`${b.packetName}/${b.group}/${b.label}`));
    return `<div class="drawer-table"><table><thead><tr><th>PACKET</th><th>GROUP</th><th>FIELD</th><th>VALUE</th><th>RAW</th><th>STATUS</th><th>AGE</th></tr></thead><tbody>${rows.map((item) => {
      let value = item.value;
      if (typeof value === 'boolean') value = value ? 'YES' : 'NO';
      if (typeof value === 'number') value = `${value}${item.unit ? ` ${item.unit}` : ''}`;
      if (value === null || value === undefined) value = '—';
      const age = item.hostMs ? `${((Date.now() - item.hostMs) / 1000).toFixed(2)} s` : '—';
      return `<tr><td>${escapeHtml(item.packetName ?? '')}</td><td>${escapeHtml(item.group ?? '')}</td><td>${escapeHtml(item.label ?? item.key)}</td><td>${escapeHtml(value)}</td><td>${escapeHtml(item.raw ?? '—')}</td><td>${escapeHtml(item.status ?? '')}</td><td>${age}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }

  function packets() {
    return `<div class="raw-list">${[...store.packetMonitor].reverse().slice(0, 300).map((entry) => {
      const r = entry.record;
      return `<article><b>${escapeHtml(r?.type ?? entry.type)}</b><span>${new Date(entry.hostMs ?? Date.now()).toISOString()}</span><code>${escapeHtml(entry.rawLine ?? r?.rawLine ?? '')}</code></article>`;
    }).join('')}</div>`;
  }

  function commands() {
    const tracked = [...(store.commandTracker.commands ?? [])].reverse();
    return `<div class="command-matrix">${Object.entries(ACTIONS).map(([name, spec]) => {
      const available = isActionAvailable(name, store.state, store.communicationMode);
      return `<div class="command-matrix-row"><b>${escapeHtml(spec.label)}</b><span>${spec.states ? `STATE ${spec.states.join(', ')}` : spec.communicationModes ? `MODE ${spec.communicationModes.join(', ')}` : 'COMBOARD LOCAL'}</span><strong class="${available ? 'ok' : 'muted'}">${available ? 'AVAILABLE' : 'DISABLED'}</strong></div>`;
    }).join('')}<h4>RECENT COMMAND LIFECYCLE</h4>${tracked.slice(0, 80).map((c) => `<code>#${c.localId} ${escapeHtml(c.state)} ${escapeHtml(c.text)} TX=${c.transactionId ?? '—'}</code>`).join('')}</div>`;
  }

  function systemInspector() {
    return `<dl class="system-inspector"><dt>MissionState</dt><dd>${escapeHtml(store.state)}</dd><dt>CommunicationMode</dt><dd>${escapeHtml(store.communicationMode)}</dd><dt>Last-known MissionState</dt><dd>${escapeHtml(store.lastKnownMissionState ?? '—')}</dd><dt>Total packets</dt><dd>${store.totalPackets}</dd><dt>Invalid packets</dt><dd>${store.invalidPackets}</dd><dt>Estimated missed</dt><dd>${store.estimatedMissed}</dd><dt>Sequence gaps</dt><dd>${store.sequenceGaps}</dd><dt>Duplicates</dt><dd>${store.duplicateSequences}</dd><dt>Parser errors</dt><dd>${store.parserErrors}</dd><dt>App mismatches</dt><dd>${store.appDecodeMismatches}</dd><dt>Last interval</dt><dd>${store.lastIntervalMs ?? '—'} ms</dd><dt>USB port</dt><dd>${escapeHtml(store.connection.path ?? '—')}</dd></dl>`;
  }

  function drawer(tab) {
    const body = tab === 'packets' ? packets() : tab === 'commands' ? commands() : tab === 'events' ? eventList(120) : tab === 'system' ? systemInspector() : currentValues();
    return `<div class="drawer-head"><strong>DATA INSPECTOR</strong><button data-ui="data-close">×</button></div><div class="drawer-tabs">${[['current', 'CURRENT VALUES'], ['packets', 'PACKETS'], ['commands', 'COMMANDS'], ['events', 'EVENTS'], ['system', 'SYSTEM']].map(([key, label]) => `<button data-data-tab="${key}" class="${tab === key ? 'active' : ''}">${label}</button>`).join('')}</div>${body}`;
  }

  function developerDrawer(syntheticRunning) {
    if (!devMode) return '';
    return `<div class="drawer-head"><strong>DEVELOPER MODE</strong><button data-ui="dev-close">×</button></div><p>Raw console, Synthetic source, and fault/manual tests are intentionally isolated from normal operations.</p><div class="dev-actions"><button class="button accent" data-ui="synthetic-toggle">${syntheticRunning ? 'STOP SYNTHETIC' : 'START SYNTHETIC'}</button><button class="button ghost" data-ui="liftoff-test">TEST LIFTOFF ALERT</button></div><form id="dev-console-form" class="dev-console"><input id="dev-console-input" placeholder="g ... / local ... / time ... / release ..."/><button class="button dark">SEND RAW</button></form><div class="console-lines">${[...(store.commandTracker.commands ?? [])].reverse().slice(0, 40).map((c) => `<code>#${c.localId} ${escapeHtml(c.state)} ${escapeHtml(c.text)}</code>`).join('')}</div>`;
  }

  return { topbar, tabs, screen, drawer, developerDrawer, fieldText, fieldBool, fieldNum };
}
