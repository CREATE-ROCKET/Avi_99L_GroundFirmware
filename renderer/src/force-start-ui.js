import './force-start.css';
import { escapeHtml } from '../../shared/html.js';

export const START_SEQUENCE_COMMAND = 0x01;
export const FORCE_START_SEQUENCE_COMMAND = 0x04;
export const COMMAND_PHASE_COMPLETED = 1;
export const COMMAND_PHASE_REJECTED = 2;
export const COMMAND_PHASE_FAILED = 3;
export const COMMAND_REASON_NOT_CONFIGURED = 4;
export const START_GATE_MASK = 0x7F;

const START_GATE_ITEMS = Object.freeze([
  { bit: 0, label: 'FIN ZERO', key: 'FinZeroConfigured' },
  { bit: 1, label: 'PARA OPEN', key: 'ParachuteOpenConfigured' },
  { bit: 2, label: 'PARA CLOSE', key: 'ParachuteCloseConfigured' },
  { bit: 3, label: 'MOTOR PROFILE', key: 'MotorProfileValid' },
  { bit: 4, label: 'GYRO BIAS', key: 'GyroBiasValid' },
  { bit: 5, label: 'GRAVITY REF', key: 'GravityReferenceValid' },
  { bit: 6, label: 'SSC ZERO', key: 'SscZeroValid' },
]);

const PHASE_NAMES = ['Accepted', 'Completed', 'Rejected', 'Failed'];
const REASON_NAMES = [
  'None', 'Busy', 'InvalidState', 'InvalidArgument', 'NotConfigured', 'DeviceUnavailable',
  'Timeout', 'Stall', 'ProtocolError', 'InterruptedByEmergency', 'PersistenceError',
  'InternalError', 'NotSupported', 'SafetyInterlock', 'AlreadySatisfied',
];

export function decodeStartGateDetail(detail) {
  const raw = Number(detail) >>> 0;
  return START_GATE_ITEMS.filter(({ bit }) => ((raw >>> bit) & 1) !== 0);
}

export function mayOfferForceStart({ matched, result }) {
  if (!matched || !result) return false;
  return result.command === START_SEQUENCE_COMMAND
    && result.phase === COMMAND_PHASE_REJECTED
    && result.reason === COMMAND_REASON_NOT_CONFIGURED
    && (result.detail & START_GATE_MASK) !== 0
    && (result.detail & ~START_GATE_MASK) === 0;
}

function phaseName(value) { return PHASE_NAMES[value] ?? `UNKNOWN(${value})`; }
function reasonName(value) { return REASON_NAMES[value] ?? `UNKNOWN(${value})`; }

export function createForceStartUi({ store, onForce }) {
  const overlay = document.createElement('div');
  overlay.className = 'force-start-overlay';
  overlay.hidden = true;
  document.body.appendChild(overlay);

  function close() {
    overlay.hidden = true;
    overlay.innerHTML = '';
  }

  function show(result, allowForce) {
    const missing = allowForce ? decodeStartGateDetail(result.detail) : [];
    const rows = missing.length
      ? missing.map((item) => `<div class="force-start-missing"><span>${escapeHtml(item.label)}</span><strong>NOT CONFIGURED</strong></div>`).join('')
      : '<div class="force-start-no-mask">No bypassable initial-setup detail was provided.</div>';
    const forceButton = allowForce
      ? '<button type="button" class="button danger" data-force-confirm>FORCE START SEQUENCE</button>'
      : '';
    overlay.innerHTML = `<div class="force-start-modal" role="dialog" aria-modal="true" aria-labelledby="force-start-title">
      <header><small>COMMAND RESULT</small><h2 id="force-start-title">SEQUENCE START REJECTED</h2></header>
      <div class="force-start-result"><span>PHASE <b>${escapeHtml(phaseName(result.phase))}</b></span><span>REASON <b>${escapeHtml(reasonName(result.reason))}</b></span><span>DETAIL <b>0x${(result.detail >>> 0).toString(16).padStart(8, '0').toUpperCase()}</b></span></div>
      ${allowForce ? `<p>The normal LiftoffDetection start gate is not satisfied.</p><div class="force-start-list">${rows}</div>
      <div class="force-start-danger"><strong>DANGER / PREFLIGHT BYPASS</strong><p>Force start ignores only the seven initial setup gates listed above and attempts the transition to LiftoffDetection. Fin control, attitude estimation, airspeed judgement, parachute deployment, or other downstream functions may not operate correctly. Unknown faults not shown here may also exist.</p><p>Force does not mark invalid configuration or calibration as valid, and it does not bypass runtime safety, Busy, resource preallocation, Emergency, or deployment safety logic.</p></div>` : `<p>This failure is not eligible for ForceStartSequence. Resolve the reported error before retrying.</p>`}
      <footer>${forceButton}<button type="button" class="button ghost" data-force-cancel>${allowForce ? 'CANCEL' : 'CLOSE'}</button></footer>
    </div>`;
    overlay.hidden = false;
    overlay.querySelector('[data-force-cancel]')?.addEventListener('click', close, { once: true });
    overlay.querySelector('[data-force-confirm]')?.addEventListener('click', () => {
      close();
      void onForce();
    }, { once: true });
  }

  function handleCommandResult(detail) {
    if (!detail?.matched || !detail.result) return;
    const { result } = detail;
    if (result.command !== START_SEQUENCE_COMMAND && result.command !== FORCE_START_SEQUENCE_COMMAND) return;
    if (result.phase !== COMMAND_PHASE_REJECTED && result.phase !== COMMAND_PHASE_FAILED) return;
    // A Force failure never offers another Force recursively.
    show(result, result.command === START_SEQUENCE_COMMAND && mayOfferForceStart(detail));
  }

  function decorateTopbar(topbar) {
    topbar.querySelector('.forced-start-warning')?.remove();
    if (!store.forcedStartCompleted) return;
    const warning = document.createElement('div');
    warning.className = 'forced-start-warning';
    warning.textContent = 'FORCED START / PREFLIGHT BYPASSED';
    topbar.appendChild(warning);
  }

  function decorateScreen(root) {
    if (store.state !== 'CommandReceive' || store.communicationMode !== 'Normal') return;
    const start = root.querySelector('[data-action="startSequence"]');
    if (start) {
      // The Mission Board is the source of truth for the seven-item gate. Do not
      // suppress Start locally; a Rejected/NotConfigured result carries the mask.
      start.disabled = false;
    }
    const panel = root.querySelector('.readiness-panel');
    if (!panel || panel.querySelector('.start-gate-summary')) return;
    const bits = [5, 6, 7, 21, 16, 17, 18];
    const names = ['FIN ZERO', 'PARA OPEN', 'PARA CLOSE', 'MOTOR PROFILE', 'GYRO BIAS', 'GRAVITY REF', 'SSC ZERO'];
    const summary = document.createElement('div');
    summary.className = 'start-gate-summary';
    summary.innerHTML = bits.map((bit, index) => {
      const value = store.getLatestValue(`Command status.bit${bit}`)?.value;
      const state = value === true ? 'READY' : value === false ? 'NOT SET' : 'UNKNOWN';
      const tone = value === true ? 'ok' : value === false ? 'error' : 'muted';
      return `<div><span>${names[index]}</span><strong class="${tone}">${state}</strong></div>`;
    }).join('');
    panel.querySelector('.action-row')?.before(summary);
  }

  return { close, handleCommandResult, decorateTopbar, decorateScreen };
}
