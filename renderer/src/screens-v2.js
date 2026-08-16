import { escapeHtml } from '../../shared/html.js';
import { createScreenRenderer as createBaseScreenRenderer } from './screens-v2-base.js';

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

function simplifyOverview(html, store) {
  const ready = [5, 21, 16, 17, 18].every((bit) => commandBit(store, bit) === true);
  return html
    .replace(/<div class="status-row"><span>PARA OPEN<\/span><i class="dot [^"]+"><\/i><strong class="[^"]+">[^<]*<\/strong><\/div>/g, '')
    .replace(/<div class="status-row"><span>PARA CLOSE<\/span><i class="dot [^"]+"><\/i><strong class="[^"]+">[^<]*<\/strong><\/div>/g, '')
    .replace(
      /<div class="big-state (?:ok|error)">(?:FLIGHT READY|NOT READY)<\/div>/,
      `<div class="big-state ${ready ? 'ok' : 'error'}">${ready ? 'FLIGHT READY' : 'NOT READY'}</div>`,
    );
}

function renderActuators(store) {
  const finAngle = fieldText(store, 'finAngle');
  const paraAngle = fieldText(store, 'paraAngle');
  return `<div class="grid actuator-view"><section class="panel actuator-half"><div class="panel-title"><b>01</b> LINKED FIN PAIR</div><div class="actuator-graphic fin-graphic"><span>LINKED MECHANISM</span><strong>${escapeHtml(finAngle)}</strong><small>COMMAND LIMIT ENFORCED BY MISSION</small></div><div class="metric-grid">${metric('CURRENT', finAngle)}${metric('MODE', fieldText(store, 'finMode'))}${metric('ZERO', commandBit(store, 5) ? 'CONFIGURED' : 'NOT SET')}</div><div class="action-row wrap">${action('finFree', 'FREE')}${action('setFinZero', 'SET ZERO')}${action('finZeroHold', 'ZERO HOLD', { kind: 'dark' })}<input id="fin-relative" class="numeric-input" type="number" step="0.1" min="0" max="30" value="5.0"/><button class="button ghost" data-move-fin="-1">MOVE −</button><button class="button ghost" data-move-fin="1">MOVE +</button></div></section><section class="panel actuator-half"><div class="panel-title"><b>02</b> PARACHUTE SERVO</div><div class="actuator-graphic para-graphic"><span>STS3215 / PARACHUTE</span><strong>${escapeHtml(paraAngle)}</strong><small>OPEN / CLOSE ONLY</small></div><div class="metric-grid">${metric('CURRENT', paraAngle)}${metric('MODE', fieldText(store, 'paraMode'))}</div><div class="small-summary">OPEN / CLOSE only. Mission performs the fixed relative movement and keeps the servo holding until Descent power-off.</div><div class="action-row wrap">${action('paraOpen', 'OPEN')}${action('paraClose', 'CLOSE')}</div></section><section class="panel full-row emergency-panel"><strong>SPACE HOLD 300 ms</strong><span>ACTUATOR EMERGENCY STOP</span></section></div>`;
}

export function createScreenRenderer(options) {
  const { store } = options;
  const base = createBaseScreenRenderer(options);
  return {
    ...base,
    screen(commandTab) {
      if (store.communicationMode === 'Normal' && store.state === 'CommandReceive') {
        if (commandTab === 'overview') return simplifyOverview(base.screen(commandTab), store);
        if (commandTab === 'actuators') return renderActuators(store);
      }
      return base.screen(commandTab);
    },
  };
}
