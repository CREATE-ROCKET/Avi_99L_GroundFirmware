import { escapeHtml } from '../../shared/html.js';
import { createScreenRenderer as createBaseScreenRenderer } from './screens-v2-base.js';

const OMITTED_MISSION_ACTIONS = [
  'forceStartSequence',
  'disableFinControl',
  'runCalibration',
  'exportFlash',
  'enterRecovery',
  'exitRecovery',
  'actuatorEmergency',
  'finZeroHold',
  'finMoveRelative',
  'paraFree',
  'paraHold',
  'paraMoveRelative',
  'setParaOpen',
  'setParaClose',
];

function fieldText(store, key, fallback = '—') {
  const item = store.getLatestValue(key);
  if (!item) return fallback;
  if (!['VALID', 'TEMPORARY_SCALE', 'LAST_KNOWN'].includes(item.status)) return item.status;
  if (typeof item.value === 'number') {
    const digits = Math.abs(item.value) >= 100 ? 0 : Math.abs(item.value) >= 10 ? 1 : 2;
    return `${item.value.toFixed(digits)}${item.unit ? ` ${item.unit}` : ''}`;
  }
  if (typeof item.value === 'boolean') return item.value ? 'YES' : 'NO';
  return String(item.value ?? fallback);
}

function fieldNumber(store, key) {
  const item = store.getLatestValue(key);
  return item && ['VALID', 'TEMPORARY_SCALE'].includes(item.status) && typeof item.value === 'number'
    ? item.value
    : null;
}

function metric(label, value, note = '', tone = '') {
  return `<div class="metric-card ${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`;
}

function action(name, label, { kind = '', disabled = false } = {}) {
  return `<button class="button ${kind}" data-action="${name}" ${disabled ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
}

function commandBit(store, bit) {
  const item = store.getLatestValue(`Command status.bit${bit}`);
  return typeof item?.value === 'boolean' ? item.value : null;
}

function finZeroAvailable(store) {
  // 現行ComBoardは縮小MissionのMissionStatus.status bit2 (Fin zero valid)を
  // CommandReceive status bit0へ写している。Fin角がnumericな場合もzero validとみなす。
  return commandBit(store, 0) === true || fieldNumber(store, 'finAngle') !== null;
}

function stripUnsupportedMissionActions(html) {
  const actionPattern = OMITTED_MISSION_ACTIONS.join('|');
  return html
    .replace(new RegExp(`<button[^>]*data-action="(?:${actionPattern})"[^>]*>[^<]*<\\/button>`, 'g'), '')
    .replace(/<div class="emergency-hint">SPACE HOLD 300 ms \/ ACTUATOR EMERGENCY STOP<\/div>/g, '')
    .replace(/<section class="panel full-row emergency-panel"><strong>SPACE HOLD 300 ms<\/strong><span>ACTUATOR EMERGENCY STOP<\/span><\/section>/g, '');
}

function simplifyOverview(html, store) {
  const finZero = finZeroAvailable(store);
  const omittedRows = ['PARA OPEN', 'PARA CLOSE', 'MOTOR PROFILE', 'GYRO BIAS', 'GRAVITY REFERENCE', 'SSC ZERO'];
  let result = html;
  for (const label of omittedRows) {
    result = result.replace(
      new RegExp(`<div class="status-row"><span>${label}<\\/span><i class="dot [^"]+"><\\/i><strong class="[^"]+">[^<]*<\\/strong><\\/div>`, 'g'),
      '',
    );
  }
  result = result
    .replace(
      /<div class="status-row"><span>FIN ZERO<\/span><i class="dot [^"]+"><\/i><strong class="[^"]+">[^<]*<\/strong><\/div>/,
      `<div class="status-row"><span>FIN ZERO</span><i class="dot ${finZero ? 'ok' : 'warn'}"></i><strong class="${finZero ? 'ok' : 'warn'}">${finZero ? 'CAPTURED' : 'NOT SET'}</strong></div>`,
    )
    .replace(
      /<div class="big-state (?:ok|error)">(?:FLIGHT READY|NOT READY)<\/div>/,
      `<div class="big-state ${finZero ? 'ok' : 'warn'}">${finZero ? 'MINIMAL READY' : 'SET FIN ZERO'}</div>`,
    )
    .replace(/data-action="finZeroHold"/g, 'data-action="finHold"')
    .replace(/<button data-command-tab="calibration">[\s\S]*?<\/button>/, '')
    .replace(
      '<div class="action-row">',
      '<div class="start-gate-summary" hidden></div><div class="small-summary">Minimal MissionBoard: StartSequence is unconditional. Confirm FIN ZERO/HOLD and parachute OPEN/CLOSE independently before launch.</div><div class="action-row">',
    );
  return stripUnsupportedMissionActions(result);
}

function renderActuators(store) {
  const finAngle = fieldText(store, 'finAngle');
  const paraAngle = fieldText(store, 'paraAngle');
  const finZero = finZeroAvailable(store);
  return `<div class="grid actuator-view"><section class="panel actuator-half"><div class="panel-title"><b>01</b> LINKED FIN PAIR</div><div class="actuator-graphic fin-graphic"><span>LINKED MECHANISM</span><strong>${escapeHtml(finAngle)}</strong><small>MINIMAL COMMAND SET / 0x10 0x11 0x13</small></div><div class="metric-grid">${metric('CURRENT', finAngle)}${metric('MODE', fieldText(store, 'finMode'))}${metric('ZERO', finZero ? 'CAPTURED' : 'NOT SET')}</div><div class="action-row wrap">${action('finFree', 'FREE')}${action('setFinZero', 'SET ZERO')}${action('finHold', 'ZERO HOLD', { kind: 'dark' })}</div></section><section class="panel actuator-half"><div class="panel-title"><b>02</b> PARACHUTE SERVO</div><div class="actuator-graphic para-graphic"><span>STS3215 / PARACHUTE</span><strong>${escapeHtml(paraAngle)}</strong><small>OPEN / CLOSE ONLY</small></div><div class="metric-grid">${metric('CURRENT', paraAngle)}${metric('MODE', fieldText(store, 'paraMode'))}</div><div class="small-summary">OPEN / CLOSE only. Mission performs the fixed ±130° relative movement and keeps the servo holding until the absolute power cutoff.</div><div class="action-row wrap">${action('paraOpen', 'OPEN')}${action('paraClose', 'CLOSE')}</div></section></div>`;
}

export function createScreenRenderer(options) {
  const { store } = options;
  const base = createBaseScreenRenderer(options);
  return {
    ...base,
    tabs(commandTab) {
      if (store.communicationMode === 'Normal' && store.state === 'CommandReceive') {
        return [['overview', 'OVERVIEW'], ['actuators', 'ACTUATORS'], ['system', 'SYSTEM']]
          .map(([key, label]) => `<button data-command-tab="${key}" class="${commandTab === key ? 'active' : ''}">${label}</button>`)
          .join('');
      }
      return base.tabs(commandTab);
    },
    screen(commandTab) {
      if (store.communicationMode === 'Normal' && store.state === 'CommandReceive') {
        if (commandTab === 'overview') return simplifyOverview(base.screen(commandTab), store);
        if (commandTab === 'actuators') return renderActuators(store);
      }
      return stripUnsupportedMissionActions(base.screen(commandTab));
    },
    developerDrawer(syntheticRunning) {
      return base.developerDrawer(syntheticRunning)
        .replace(/<form id="dev-console-form"[\s\S]*?<\/form>/, '')
        .replace('Raw console, Synthetic source, and fault/manual tests are intentionally isolated from normal operations.',
          'Synthetic source and fault/manual tests are intentionally isolated from normal operations. Raw command transmission is omitted in the reduced MissionBoard GUI.');
    },
  };
}
