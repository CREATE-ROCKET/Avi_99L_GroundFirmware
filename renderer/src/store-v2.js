import { TelemetryStore as BaseTelemetryStore } from './store.js';
import { decodeApplicationPacket, fieldMap, PacketHeader } from '../../shared/protocol.js';

const MISSION_STATES = new Set(['CommandReceive', 'LiftoffDetection', 'EngineBurn', 'Control', 'Descent']);
const LONG_HISTORY_LIMIT = 100000;
const FIN_MODE_NAMES = Object.freeze({
  0: 'Free / Hi-Z',
  1: 'Brake',
  2: 'HoldPosition',
  3: 'ZeroHold',
  4: 'MoveRelative',
  5: 'RollControl',
  15: 'Unknown',
});
const FALLBACK_ALIASES = Object.freeze({
  fallbackReason: 'fallbackReason', lastMissionState: 'fallbackLastMissionState',
  gnssState: 'fallbackGnssState', missionStatusAge: 'fallbackMissionStatusAge',
  anyMissionCanAge: 'fallbackMissionPeriodicAge', powerTimeAge: 'fallbackPowerTimeAge',
  east: 'fallbackEast', north: 'fallbackNorth', height: 'fallbackHeight',
  logicVoltage: 'fallbackLogicVoltage', motorVoltage: 'fallbackMotorVoltage', canHealth: 'fallbackCanHealth',
});
const CONTROL_ALIASES = Object.freeze({
  controlRollReference: 'controlRollReferenceUnwrapped', rollDeviation: 'rollDeviationUnwrapped',
  'Control roll flags.bit0': 'controlRollReferenceValid',
  'Control roll flags.bit1': 'controlRollReferenceCaptured',
  'Control roll flags.bit2': 'controlActiveV2',
  'Control roll flags.bit3': 'controlRollReferenceOutOfRange',
  'Control roll flags.bit4': 'rollDeviationOutOfRange',
  referenceCaptureEventSequence: 'controlRollCaptureEventSequence',
});
const FALLBACK_FLAG_LABELS = [
  'MissionStatus ever received', 'Mission periodic CAN ever received', 'MissionStatus age < 1.0 s',
  'Any Mission periodic CAN age < 1.0 s', 'ComBoard microSD healthy', 'Logging requested',
  'Logging active', 'Unflushed data present', 'GNSS enabled', 'GNSS valid numeric fix', 'GNSS stale',
  'Last PowerTimeTelemetry available', 'Last MissionState valid', 'CAN controller active',
  'CAN runtime error', 'Reserved bit15',
];
function pushLong(target, value) { target.push(value); if (target.length > LONG_HISTORY_LIMIT) target.shift(); }
function numberFrom(map, key) { const item=map[key]; return item?.status==='VALID'||item?.status==='TEMPORARY_SCALE'? (typeof item.value==='number'?item.value:null):null; }

export class TelemetryStore extends BaseTelemetryStore {
  constructor() {
    super();
    this.communicationMode = 'Normal';
    this.lastKnownMissionState = null;
    this.lastExpectedRxHostMs = null;
    this.lastExpectedIntervalMs = null;
    this.allRunSystemHistory = [];
    this.descentHistory = [];
    this.forcedStartCompleted = false;
  }

  clearCurrentTelemetry() {
    super.clearCurrentTelemetry();
    this.communicationMode = 'Normal';
    this.lastKnownMissionState = null;
    this.lastExpectedRxHostMs = null;
    this.lastExpectedIntervalMs = null;
    // 再接続/BOOT後に旧sessionの姿勢を正常値として表示しない。
    this.attitudeSamples.length = 0;
    // forcedStartCompleted is session-local audit state. USB reconnect must not
    // erase the warning after a successful ForceStartSequence.
  }

  ingestRx(record, hostMs = Date.now(), monitorEntry = null) {
    super.ingestRx(record, hostMs, monitorEntry);
    if (!record?.valid || record.header !== PacketHeader.COMMAND_RESULT) return;
    try {
      const decoded = decodeApplicationPacket(Uint8Array.from(record.rawBytes));
      if (!decoded.lengthValid || !decoded.checksumValid || !decoded.contractValid) return;
      const fields = fieldMap(decoded);
      const result = {
        transactionId: fields.transactionId.raw,
        command: fields.command.raw,
        phase: fields.phase.raw,
        reason: fields.reason.raw,
        detail: fields.detail.raw >>> 0,
      };
      const entry = this.commandTracker.byTransaction.get(result.transactionId) ?? null;
      const matched = Boolean(entry && entry.description?.expectedResultCommand === result.command);
      if (matched && result.command === 0x04 && result.phase === 1 && !this.forcedStartCompleted) {
        this.forcedStartCompleted = true;
        this.addEvent('FORCED START / PREFLIGHT BYPASSED', 'warn', {
          transactionId: result.transactionId,
          command: result.command,
        });
      }
      this.notify('command-result', { matched, entry, result });
    } catch {
      // Base store already records malformed application packets. Do not create
      // a second synthetic command result when the packet cannot be decoded.
    }
  }

  ingestDecoded(decoded, metadata = {}) {
    const previousState = this.state;
    const previousMode = this.communicationMode;
    const map = fieldMap(decoded);
    let normalized = decoded;

    if (MISSION_STATES.has(decoded.missionState)) {
      this.lastKnownMissionState = decoded.missionState;
      normalized = { ...decoded, communicationMode: 'Normal' };
    } else if (decoded.header === PacketHeader.RECOVERY_BEACON) {
      // A5 is a ComBoard communication mode. It must never create a MissionState.
      normalized = { ...decoded, missionState: null, communicationMode: 'RecoveryBeacon' };
    } else if (decoded.header === PacketHeader.MISSION_LINK_FALLBACK_TELEMETRY) {
      const last = map.fallbackLastMissionState?.value;
      if (MISSION_STATES.has(last)) this.lastKnownMissionState = last;
      normalized = { ...decoded, missionState: null, communicationMode: 'MissionLinkFallback' };
    } else if (decoded.header === PacketHeader.RECOVERY_LOG_DATA) {
      normalized = { ...decoded, communicationMode: this.communicationMode };
    }

    super.ingestDecoded(normalized, metadata);

    const hostMs = metadata.hostMs ?? Date.now();
    const sessionSec = Math.max(0, (hostMs - this.sessionStartedHostMs) / 1000);

    if (decoded.header === PacketHeader.MISSION_LINK_FALLBACK_TELEMETRY) {
      // GUI state is never inferred from last-known MissionState while the link is lost.
      this.state = 'UNKNOWN';
      this.attitudeSamples.length = 0;
      this.expandFallbackFlags(decoded, hostMs);
      this.appendFallbackPosition(map, hostMs);
      if (previousState !== 'UNKNOWN') this.addEvent(`MISSION LINK LOST / last=${this.lastKnownMissionState ?? previousState}`, 'error');
    }

    if (decoded.header === PacketHeader.COMMAND_RECEIVE) {
      const tilt = numberFrom(map, 'tilt');
      const tiltDirection = numberFrom(map, 'tiltDirection');
      const displayRoll = numberFrom(map, 'displayRoll');
      const direction = tilt === 0 ? 0 : tiltDirection;
      if (tilt !== null && direction !== null && displayRoll !== null) {
        this.attitudeSamples.push({ hostMs, roll: displayRoll, rollRate: 0, tilt, tiltDirection: direction,
          finAngle: numberFrom(map, 'finAngle'), finRate: 0, preflightDisplayRoll: true });
        if (this.attitudeSamples.length > 8) this.attitudeSamples.shift();
      } else {
        // invalidを旧姿勢のholdとして見せず、3D表示をUNKNOWNへ落とす。
        this.attitudeSamples.length = 0;
      }
    } else if ([PacketHeader.LIFTOFF_DETECTION, PacketHeader.ENGINE_BURN, PacketHeader.CONTROL].includes(decoded.header)) {
      const tilt = numberFrom(map, 'tilt');
      const tiltDirection = numberFrom(map, 'tiltDirection');
      const wrappedOrientation = numberFrom(map, 'wrappedOrientation');
      const directionValid = tilt === 0 || tiltDirection !== null;
      if (tilt === null || wrappedOrientation === null || !directionValid) {
        this.attitudeSamples.length = 0;
      }
    } else if ([PacketHeader.DESCENT, PacketHeader.RECOVERY_BEACON].includes(decoded.header)) {
      // これらのpacketは姿勢を運ばないため、直前姿勢を現在姿勢として表示しない。
      this.attitudeSamples.length = 0;
    }

    const systemPoint = {
      t: sessionSec, hostMs,
      logicVoltage: numberFrom(map, 'logicVoltage'), motorVoltage: numberFrom(map, 'motorVoltage'),
      pressure: numberFrom(map, 'pressure'), temperature: numberFrom(map, 'temperature'),
      rssi: Number.isFinite(metadata.rssiDbm) ? metadata.rssiDbm : null,
    };
    if (Object.values(systemPoint).some((value, index) => index > 1 && Number.isFinite(value))) pushLong(this.allRunSystemHistory, systemPoint);

    if (decoded.header === PacketHeader.DESCENT) {
      const t = numberFrom(map, 'descentElapsed');
      if (t !== null) pushLong(this.descentHistory, {
        t, hostMs, paraAngle: numberFrom(map, 'paraAngle'), pressure: numberFrom(map, 'pressure'),
        temperature: numberFrom(map, 'temperature'), east: numberFrom(map, 'east'),
        north: numberFrom(map, 'north'), height: numberFrom(map, 'height'),
      });
    }

    const expected = this.expectedIntervalFor(decoded.header);
    if (expected !== null) {
      if (this.lastExpectedRxHostMs !== null) {
        this.lastIntervalMs = hostMs - this.lastExpectedRxHostMs;
        this.estimatedMissed = Math.max(0, Math.round(this.lastIntervalMs / expected) - 1);
      }
      this.lastExpectedRxHostMs = hostMs;
      this.lastExpectedIntervalMs = expected;
    }

    if (previousMode !== this.communicationMode) this.addEvent(`COMM MODE / ${previousMode} → ${this.communicationMode}`, 'state');
  }

  appendFallbackPosition(map, hostMs) {
    const east = numberFrom(map, 'fallbackEast');
    const north = numberFrom(map, 'fallbackNorth');
    const height = numberFrom(map, 'fallbackHeight');
    const valid = Number.isFinite(east) && Number.isFinite(north);
    this.positionHistory.push({ t: Math.max(0, (hostMs - this.sessionStartedHostMs) / 1000), hostMs,
      east, north, height, valid, source: 'MissionLinkFallbackTelemetry' });
    if (this.positionHistory.length > LONG_HISTORY_LIMIT) this.positionHistory.shift();
  }

  expectedIntervalFor(header) {
    if (header >= PacketHeader.COMMAND_RECEIVE && header <= PacketHeader.DESCENT) return 500;
    if (header === PacketHeader.MISSION_LINK_FALLBACK_TELEMETRY) return 500;
    if (header === PacketHeader.RECOVERY_BEACON) return 10000;
    return null;
  }

  expandFallbackFlags(decoded, hostMs) {
    const raw = fieldMap(decoded).fallbackStatusFlagsRaw?.raw;
    if (!Number.isInteger(raw)) return;
    FALLBACK_FLAG_LABELS.forEach((label, bit) => {
      const value = Boolean((raw >> bit) & 1);
      const item = { key: `Fallback status.bit${bit}`, label, group: 'Fallback status', raw: value ? 1 : 0,
        value, unit: '', status: bit === 15 && value ? 'RESERVED_BITS_NONZERO' : 'VALID',
        packetName: decoded.packetName, hostMs };
      this.latestValues.set(`${decoded.packetName}.${item.key}`, item);
      this.latestFieldByKey.set(item.key, item);
    });
  }

  getLatestValue(key) {
    if (key === 'gnssState' && this.communicationMode !== 'MissionLinkFallback') return null;
    let actualKey = key;
    if (this.communicationMode === 'MissionLinkFallback' && FALLBACK_ALIASES[key]) actualKey = FALLBACK_ALIASES[key];
    else if (CONTROL_ALIASES[key]) actualKey = CONTROL_ALIASES[key];
    const item = super.getLatestValue(actualKey);
    if (!item) return null;
    if (key === 'finMode' && Number.isInteger(item.raw)) {
      return { ...item, value: FIN_MODE_NAMES[item.raw] ?? 'Unknown' };
    }
    if (this.communicationMode === 'MissionLinkFallback' && (key === 'logicVoltage' || key === 'motorVoltage') && item.status === 'VALID') {
      return { ...item, status: 'LAST_KNOWN' };
    }
    return item;
  }

  getRxAgeMs(now = Date.now()) {
    return this.lastExpectedRxHostMs === null ? Infinity : Math.max(0, now - this.lastExpectedRxHostMs);
  }
}
