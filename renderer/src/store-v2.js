import { TelemetryStore as BaseTelemetryStore } from './store.js';
import { fieldMap, PacketHeader } from '../../shared/protocol.js';

const MISSION_STATES = new Set(['CommandReceive', 'LiftoffDetection', 'EngineBurn', 'Control', 'Descent']);
const FALLBACK_ALIASES = Object.freeze({
  fallbackReason: 'fallbackReason',
  lastMissionState: 'fallbackLastMissionState',
  gnssState: 'fallbackGnssState',
  missionStatusAge: 'fallbackMissionStatusAge',
  anyMissionCanAge: 'fallbackMissionPeriodicAge',
  powerTimeAge: 'fallbackPowerTimeAge',
  east: 'fallbackEast',
  north: 'fallbackNorth',
  height: 'fallbackHeight',
  logicVoltage: 'fallbackLogicVoltage',
  motorVoltage: 'fallbackMotorVoltage',
  canHealth: 'fallbackCanHealth',
});
const CONTROL_ALIASES = Object.freeze({
  controlRollReference: 'controlRollReferenceUnwrapped',
  rollDeviation: 'rollDeviationUnwrapped',
  'Control roll flags.bit0': 'controlRollReferenceValid',
  'Control roll flags.bit1': 'controlRollReferenceCaptured',
  'Control roll flags.bit2': 'controlActiveV2',
  'Control roll flags.bit3': 'controlRollReferenceOutOfRange',
  'Control roll flags.bit4': 'rollDeviationOutOfRange',
  referenceCaptureEventSequence: 'controlRollCaptureEventSequence',
});
const FALLBACK_FLAG_LABELS = [
  'MissionStatus ever received',
  'Mission periodic CAN ever received',
  'MissionStatus age < 1.0 s',
  'Any Mission periodic CAN age < 1.0 s',
  'ComBoard microSD healthy',
  'Logging requested',
  'Logging active',
  'Unflushed data present',
  'GNSS enabled',
  'GNSS valid numeric fix',
  'GNSS stale',
  'Last PowerTimeTelemetry available',
  'Last MissionState valid',
  'CAN controller active',
  'CAN runtime error',
  'Reserved bit15',
];

export class TelemetryStore extends BaseTelemetryStore {
  constructor() {
    super();
    this.communicationMode = 'Normal';
    this.lastKnownMissionState = null;
    this.lastExpectedRxHostMs = null;
    this.lastExpectedIntervalMs = null;
  }

  clearCurrentTelemetry() {
    super.clearCurrentTelemetry();
    this.communicationMode = 'Normal';
    this.lastKnownMissionState = null;
    this.lastExpectedRxHostMs = null;
    this.lastExpectedIntervalMs = null;
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
      // A6 is payload transfer inside the existing communication mode.
      normalized = { ...decoded, communicationMode: this.communicationMode };
    }

    super.ingestDecoded(normalized, metadata);

    const hostMs = metadata.hostMs ?? Date.now();
    if (decoded.header === PacketHeader.MISSION_LINK_FALLBACK_TELEMETRY) {
      // The GUI may only show a current MissionState received from Mission telemetry.
      this.state = 'UNKNOWN';
      this.expandFallbackFlags(decoded, hostMs);
      this.appendFallbackPosition(map, hostMs);
      if (previousState !== 'UNKNOWN') {
        this.addEvent(`MISSION LINK LOST / last=${this.lastKnownMissionState ?? previousState}`, 'error');
      }
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

    if (previousMode !== this.communicationMode) {
      this.addEvent(`COMM MODE / ${previousMode} → ${this.communicationMode}`, 'state');
    }
  }

  appendFallbackPosition(map, hostMs) {
    const east = map.fallbackEast?.status === 'VALID' ? map.fallbackEast.value : null;
    const north = map.fallbackNorth?.status === 'VALID' ? map.fallbackNorth.value : null;
    const height = map.fallbackHeight?.status === 'VALID' ? map.fallbackHeight.value : null;
    const valid = Number.isFinite(east) && Number.isFinite(north);
    this.positionHistory.push({
      t: Math.max(0, (hostMs - this.sessionStartedHostMs) / 1000),
      hostMs,
      east,
      north,
      height,
      valid,
      source: 'MissionLinkFallbackTelemetry',
    });
    if (this.positionHistory.length > 1000) this.positionHistory.shift();
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
      const item = {
        key: `Fallback status.bit${bit}`,
        label,
        group: 'Fallback status',
        raw: value ? 1 : 0,
        value,
        unit: '',
        status: bit === 15 && value ? 'RESERVED_BITS_NONZERO' : 'VALID',
        packetName: decoded.packetName,
        hostMs,
      };
      this.latestValues.set(`${decoded.packetName}.${item.key}`, item);
      this.latestFieldByKey.set(item.key, item);
    });
  }

  getLatestValue(key) {
    let actualKey = key;
    if (this.communicationMode === 'MissionLinkFallback' && FALLBACK_ALIASES[key]) {
      actualKey = FALLBACK_ALIASES[key];
    } else if (CONTROL_ALIASES[key]) {
      actualKey = CONTROL_ALIASES[key];
    }
    const item = super.getLatestValue(actualKey);
    if (!item) return null;
    if (this.communicationMode === 'MissionLinkFallback'
        && (key === 'logicVoltage' || key === 'motorVoltage')
        && item.status === 'VALID') {
      return { ...item, status: 'LAST_KNOWN' };
    }
    return item;
  }

  getRxAgeMs(now = Date.now()) {
    return this.lastExpectedRxHostMs === null ? Infinity : Math.max(0, now - this.lastExpectedRxHostMs);
  }
}
