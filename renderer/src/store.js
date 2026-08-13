import { parseUsbLine, hexToBytes, bytesToHex } from '../../shared/usb-line.js';
import { decodeApplicationPacket, fieldMap, PacketHeader } from '../../shared/protocol.js';

const MAX_RAW_PACKETS = 1000;
const MAX_EVENTS = 500;
const MAX_ATTITUDE_SAMPLES = 8;

function numericField(map, key) {
  const item = map[key];
  return item && item.status !== 'VALID' && item.status !== 'TEMPORARY_SCALE'
    ? null
    : (typeof item?.value === 'number' ? item.value : null);
}

function booleanField(map, key) {
  const value = map[key]?.value;
  return typeof value === 'boolean' ? value : null;
}

export class TelemetryStore extends EventTarget {
  constructor() {
    super();
    this.sessionStartedAt = performance.now();
    this.sessionStartedHostMs = Date.now();
    this.state = 'UNKNOWN';
    this.connection = { connected: false, path: null };
    this.latestByPacket = new Map();
    this.latestValues = new Map();
    // Field keyごとの最新値。packet種別のMap挿入順には依存しない。
    this.latestFieldByKey = new Map();
    this.rawPackets = [];
    this.events = [];
    this.flightHistory = [];
    this.systemHistory = [];
    this.positionHistory = [];
    this.attitudeSamples = [];
    this.lastPeriodicRxHostMs = null;
    this.lastAnyRxHostMs = null;
    this.lastIntervalMs = null;
    this.estimatedMissed = 0;
    this.rssiDbm = null;
    this.invalidPackets = 0;
    this.totalPackets = 0;
    this.latestRecord = null;
  }

  setSessionOrigin(value) {
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(parsed)) this.sessionStartedHostMs = parsed;
  }

  notify(type = 'update', detail = null) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  addEvent(label, level = 'info', detail = {}) {
    const event = {
      at: new Date(),
      sessionSec: Math.max(0, (Date.now() - this.sessionStartedHostMs) / 1000),
      label,
      level,
      ...detail,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.notify('event', event);
  }

  setConnection(connection) {
    this.connection = { ...this.connection, ...connection };
    this.addEvent(connection.connected ? `USB CONNECTED / ${connection.path ?? ''}` : `USB DISCONNECTED / ${connection.reason ?? ''}`,
      connection.connected ? 'ok' : 'warn');
    this.notify();
  }

  ingestLineRecord(record) {
    const parsed = record?.parsed ?? parseUsbLine(record?.raw_line ?? record?.rawLine ?? '', new Date(record?.host_time_utc ?? Date.now()));
    if (!parsed) return;
    this.latestRecord = record;

    if (parsed.kind !== 'machine') {
      if (parsed.kind === 'console' && parsed.text) this.addEvent(`CONSOLE / ${parsed.text}`, 'debug');
      return;
    }

    if (parsed.recordType === 'RX') {
      this.ingestRx(parsed, record);
      return;
    }
    if (parsed.recordType === 'FRAG') {
      this.addEvent(`SERIAL FRAGMENT / ${parsed.fields.reason ?? 'UNKNOWN'}`, 'warn', { raw: parsed.fields.raw });
      return;
    }
    if (parsed.recordType === 'TX') {
      this.addEvent(`UPLINK ${parsed.fields.ok === 1 ? 'SENT' : 'FAILED'} / command=${parsed.fields.command ?? 'NA'}`,
        parsed.fields.ok === 1 ? 'ok' : 'error');
      return;
    }
    if (parsed.recordType === 'SYS') {
      this.addEvent(`GROUND BOARD / ${parsed.fields.event ?? parsed.rawLine}`, 'info');
    }
  }

  ingestRx(parsed, record = {}) {
    const fields = parsed.fields;
    const rawHex = typeof fields.raw === 'string' ? fields.raw : '';
    let bytes = null;
    let decoded = null;
    let error = null;
    try {
      bytes = hexToBytes(rawHex);
      decoded = decodeApplicationPacket(bytes);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    const firmwareValid = fields.valid === undefined ? true : fields.valid === 1;
    const valid = Boolean(decoded && firmwareValid && decoded.lengthValid && decoded.checksumValid);
    const hostMs = Number(record.host_unix_ms ?? parsed.hostTime?.getTime?.() ?? Date.now());
    const metadata = {
      hostMs,
      hostTime: new Date(hostMs),
      boardMs: typeof fields.board_ms === 'number' ? fields.board_ms : null,
      sequence: typeof fields.seq === 'number' ? fields.seq : null,
      intervalMs: typeof fields.dt_ms === 'number' ? fields.dt_ms : null,
      rssiDbm: typeof fields.rssi_dbm === 'number' ? fields.rssi_dbm : null,
      rssiRaw: typeof fields.rssi_raw === 'number' ? fields.rssi_raw : null,
      rawHex: rawHex || (bytes ? bytesToHex(bytes) : ''),
      firmwareValid,
      valid,
      error: error ?? fields.error ?? (decoded && !decoded.checksumValid ? 'XOR_MISMATCH' : null),
    };

    this.totalPackets += 1;
    this.lastAnyRxHostMs = hostMs;
    if (metadata.rssiDbm !== null) this.rssiDbm = metadata.rssiDbm;
    if (!valid) this.invalidPackets += 1;

    const packetRecord = {
      metadata,
      decoded,
      line: parsed.rawLine,
      packetName: decoded?.packetName ?? `Unknown_0x${bytes?.[0]?.toString(16).padStart(2, '0') ?? '??'}`,
    };
    this.rawPackets.push(packetRecord);
    if (this.rawPackets.length > MAX_RAW_PACKETS) this.rawPackets.shift();

    if (!valid || !decoded) {
      this.addEvent(`PACKET REJECTED / ${metadata.error ?? 'INVALID'}`, 'error', { rawHex: metadata.rawHex });
      this.notify();
      return;
    }

    this.ingestDecoded(decoded, metadata);
  }

  ingestDecoded(decoded, metadata = {}) {
    const hostMs = metadata.hostMs ?? Date.now();
    const map = fieldMap(decoded);
    const previousState = this.state;

    this.latestByPacket.set(decoded.packetName, { decoded, metadata, fieldMap: map });
    for (const item of decoded.fields) {
      const latestItem = { ...item, packetName: decoded.packetName, hostMs };
      this.latestValues.set(`${decoded.packetName}.${item.key}`, latestItem);
      this.latestFieldByKey.set(item.key, latestItem);
    }

    if (decoded.missionState) this.state = decoded.missionState;

    const periodic = decoded.header >= PacketHeader.COMMAND_RECEIVE && decoded.header <= PacketHeader.RECOVERY_BEACON;
    if (periodic) {
      if (this.lastPeriodicRxHostMs !== null) {
        this.lastIntervalMs = hostMs - this.lastPeriodicRxHostMs;
        this.estimatedMissed = Math.max(0, Math.round(this.lastIntervalMs / 500) - 1);
      }
      this.lastPeriodicRxHostMs = hostMs;
    }

    const sessionSec = Math.max(0, (hostMs - this.sessionStartedHostMs) / 1000);
    const flightElapsed = numericField(map, 'flightElapsed');
    const roll = numericField(map, 'roll');
    const rollRate = numericField(map, 'rollRate');
    const tilt = numericField(map, 'tilt');
    const tiltDirection = numericField(map, 'tiltDirection');
    const finAngle = numericField(map, 'finAngle');
    const finRate = numericField(map, 'finRate');
    const requestedTorque = numericField(map, 'requestedTorque');
    const pressure = numericField(map, 'pressure');
    const temperature = numericField(map, 'temperature');
    const airspeed = numericField(map, 'airspeed');
    const logicVoltage = numericField(map, 'logicVoltage');
    const motorVoltage = numericField(map, 'motorVoltage');
    const east = numericField(map, 'east');
    const north = numericField(map, 'north');
    const height = numericField(map, 'height');

    if (flightElapsed !== null) {
      this.flightHistory.push({
        t: flightElapsed, hostMs, roll, rollRate, tilt, tiltDirection, finAngle, finRate,
        requestedTorque, pressure, temperature, airspeed, east, north, height,
      });
    }

    const systemPoint = {
      t: sessionSec, hostMs, logicVoltage, motorVoltage, pressure, temperature,
      rssi: metadata.rssiDbm ?? this.rssiDbm,
    };
    if ([logicVoltage, motorVoltage, pressure, temperature, systemPoint.rssi].some(Number.isFinite)) {
      this.systemHistory.push(systemPoint);
    }

    if (east !== null && north !== null) {
      this.positionHistory.push({ t: flightElapsed ?? sessionSec, hostMs, east, north, height, valid: true });
    }

    if (roll !== null && tilt !== null && tiltDirection !== null) {
      this.attitudeSamples.push({
        hostMs, roll, rollRate: rollRate ?? 0, tilt, tiltDirection,
        finAngle, finRate: finRate ?? 0,
      });
      if (this.attitudeSamples.length > MAX_ATTITUDE_SAMPLES) this.attitudeSamples.shift();
    }

    if (previousState !== this.state) {
      this.addEvent(`STATE / ${previousState} → ${this.state}`, 'state');
      if (previousState === 'LiftoffDetection' && this.state === 'EngineBurn') {
        this.notify('liftoff', { source: booleanField(map, 'Flight status.bit1') ? 'ICM' : booleanField(map, 'Flight status.bit0') ? 'LPS' : 'UNKNOWN' });
      }
    }

    this.notify();
  }

  ingestSynthetic(decoded, metadata = {}) {
    this.totalPackets += 1;
    const hostMs = metadata.hostMs ?? Date.now();
    this.lastAnyRxHostMs = hostMs;
    this.rssiDbm = metadata.rssiDbm ?? this.rssiDbm;
    this.rawPackets.push({ metadata: { ...metadata, hostMs, valid: true, rawHex: metadata.rawHex ?? 'SYNTHETIC' }, decoded, packetName: decoded.packetName, line: '@SYNTHETIC' });
    if (this.rawPackets.length > MAX_RAW_PACKETS) this.rawPackets.shift();
    this.ingestDecoded(decoded, { ...metadata, hostMs, valid: true });
  }

  getLatestValue(key) {
    return this.latestFieldByKey.get(key) ?? null;
  }

  getRxAgeMs(now = Date.now()) {
    return this.lastPeriodicRxHostMs === null ? Infinity : now - this.lastPeriodicRxHostMs;
  }
}
