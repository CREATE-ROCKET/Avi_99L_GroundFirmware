import {
  decodeApplicationPacket,
  fieldMap,
  PacketHeader,
  packetNames,
} from '../../shared/protocol.js';
import { COMMAND_ACK_TIMEOUT_MS, OutboundCommandTracker } from '../../shared/command-lifecycle.js';

const MAX_RAW_PACKETS = 1000;
const MAX_EVENTS = 500;
const MAX_ATTITUDE_SAMPLES = 8;
const MAX_PACKET_MONITOR = 1000;
const MAX_LATENCY_SAMPLES = 2048;
const MAX_HISTORY_SAMPLES = 1000;

function pushBounded(target, value, limit = MAX_HISTORY_SAMPLES) {
  target.push(value);
  if (target.length > limit) target.shift();
}

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
    this.communicationMode = 'Normal';
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
    this.packetMonitor = [];
    this.parserErrors = 0;
    this.appDecodeMismatches = 0;
    this.latestTimeRequestId = null;
    this.commandTracker = new OutboundCommandTracker(64);
    this.commandAckTimers = new Map();
    this.storeLatenciesMs = [];
    this.paintLatenciesMs = [];
    this.pendingPaintReceivedAtMs = null;
    this.lastRxSequence = null;
    this.sequenceGaps = 0;
    this.duplicateSequences = 0;
    this.seenStreamIds = new Set();
    this.streamIdOrder = [];
    this.replaying = false;
    this.replayDirty = false;
  }

  setSessionOrigin(value) {
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    if (Number.isFinite(parsed)) this.sessionStartedHostMs = parsed;
  }

  notify(type = 'update', detail = null) {
    if (this.replaying) {
      this.replayDirty = true;
      return;
    }
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  beginReplay() {
    this.replaying = true;
    this.replayDirty = false;
  }

  endReplay() {
    this.replaying = false;
    this.resumeCommandAckTimers();
    if (this.replayDirty) this.notify();
    this.replayDirty = false;
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
    const connected = connection.state === 'connected' || connection.connected === true;
    this.connection = { ...this.connection, ...connection, connected };
    if (!connected && connection.state !== 'connecting') {
      this.clearCurrentTelemetry();
    }
    this.addEvent(connected ? `USB CONNECTED / ${connection.path ?? ''}` : `USB ${String(connection.state ?? 'DISCONNECTED').toUpperCase()} / ${connection.reason ?? connection.error ?? ''}`,
      connected ? 'ok' : 'warn');
    this.notify();
  }

  clearCurrentTelemetry() {
    this.state = 'UNKNOWN';
    this.communicationMode = 'Normal';
    this.latestByPacket.clear();
    this.latestValues.clear();
    this.latestFieldByKey.clear();
    this.lastPeriodicRxHostMs = null;
    this.lastAnyRxHostMs = null;
    this.lastIntervalMs = null;
    this.estimatedMissed = 0;
    this.rssiDbm = null;
    this.latestTimeRequestId = null;
    this.lastRxSequence = null;
  }

  addPacketMonitor(entry) {
    this.packetMonitor.push(entry);
    if (this.packetMonitor.length > MAX_PACKET_MONITOR) this.packetMonitor.shift();
  }

  clearCommandAckTimer(localId) {
    const timer = this.commandAckTimers.get(localId);
    if (timer !== undefined) clearTimeout(timer);
    this.commandAckTimers.delete(localId);
  }

  scheduleCommandAckTimer(entry) {
    if (!entry?.description?.expectsAck || entry.state !== 'BOARD_TX_OK' || !Number.isFinite(entry.txAtMs)) return;
    this.clearCommandAckTimer(entry.localId);
    const deadlineAtMs = entry.txAtMs + COMMAND_ACK_TIMEOUT_MS;
    const delayMs = Math.max(0, deadlineAtMs - Date.now());
    const timer = setTimeout(() => {
      this.commandAckTimers.delete(entry.localId);
      const timedOut = this.commandTracker.markAckTimeout(
        entry.localId,
        deadlineAtMs,
        COMMAND_ACK_TIMEOUT_MS,
      );
      if (!timedOut) return;
      this.addEvent(
        `COMMAND ACK TIMEOUT / id=${timedOut.transactionId} command=0x${timedOut.description.command.toString(16).padStart(2, '0').toUpperCase()} timeout_ms=${COMMAND_ACK_TIMEOUT_MS}`,
        'error',
        { localId: timedOut.localId, transactionId: timedOut.transactionId, timeoutMs: COMMAND_ACK_TIMEOUT_MS },
      );
      this.notify('command-result', {
        matched: true,
        entry: timedOut,
        ackTimeout: true,
        timeoutMs: COMMAND_ACK_TIMEOUT_MS,
      });
      this.notify();
    }, delayMs);
    this.commandAckTimers.set(entry.localId, timer);
  }

  resumeCommandAckTimers() {
    for (const entry of this.commandTracker.commands) {
      if (entry.description?.expectsAck && entry.state === 'BOARD_TX_OK') {
        this.scheduleCommandAckTimer(entry);
      }
    }
  }

  ingestLineRecord(input) {
    if (Number.isSafeInteger(input?.streamId)) {
      if (this.seenStreamIds.has(input.streamId)) return;
      this.seenStreamIds.add(input.streamId);
      this.streamIdOrder.push(input.streamId);
      if (this.streamIdOrder.length > 4096) {
        this.seenStreamIds.delete(this.streamIdOrder.shift());
      }
    }
    const replay = input?.type === 'serial_line';
    const classification = input?.classification;
    if (!classification) return;
    const hostMs = Number(replay ? Date.parse(input.pcUtc) : input.hostUnixMs);
    const receivedAtMs = Number.isFinite(hostMs) ? hostMs : Date.now();
    this.latestRecord = input;
    if (!replay) {
      const storeLatency = Math.max(0, Date.now() - receivedAtMs);
      this.storeLatenciesMs.push(storeLatency);
      if (this.storeLatenciesMs.length > MAX_LATENCY_SAMPLES) this.storeLatenciesMs.shift();
      this.pendingPaintReceivedAtMs = receivedAtMs;
    }

    if (classification.kind === 'pretty' || classification.kind === 'unclassified') {
      this.addPacketMonitor({ type: classification.kind, rawLine: classification.rawLine, hostMs: receivedAtMs });
      if (classification.kind === 'unclassified') {
        this.addEvent(`UNCLASSIFIED / ${classification.rawLine}`, 'debug');
      }
      this.notify();
      return;
    }
    if (classification.kind === 'parser-error') {
      this.parserErrors += 1;
      this.addPacketMonitor({ type: 'parser-error', ...classification, hostMs: receivedAtMs });
      this.addEvent(`USB PARSER ERROR / ${classification.error.code}`, 'error');
      this.notify();
      return;
    }
    if (classification.kind !== 'record') return;
    const record = classification.record;
    const monitorEntry = { type: record.type, record, rawLine: classification.rawLine, hostMs: receivedAtMs };
    this.addPacketMonitor(monitorEntry);
    if (record.type === 'RX') this.ingestRx(record, receivedAtMs, monitorEntry);
    else if (record.type === 'TX') this.ingestTx(record, receivedAtMs);
    else if (record.type === 'FRAG') {
      this.addEvent(`SERIAL FRAGMENT / ${record.reason}`, 'warn', { raw: record.rawHex });
      this.notify();
    } else if (record.type === 'SYS') {
      if (record.event === 'BOOT') this.clearCurrentTelemetry();
      if (record.event === 'TRANSACTION_RELEASE') {
        const outcome = this.commandTracker.applyTransactionRelease(record, receivedAtMs);
        if (!outcome.matched) this.addEvent(`UNMATCHED RELEASE / id=${record.id}`, 'warn');
        if (outcome.released) this.clearCommandAckTimer(outcome.released.localId);
      }
      if (record.event === 'UPLINK_ABORTED') {
        const outcome = this.commandTracker.applyUplinkAborted(record, receivedAtMs);
        this.addEvent(
          `UPLINK ABORTED / id=${record.id} command=0x${record.command.toString(16).padStart(2, '0').toUpperCase()} error=${record.error}`,
          'error',
        );
        if (!outcome.matched) this.addEvent(`UNMATCHED UPLINK_ABORTED / id=${record.id}`, 'warn');
        this.notify();
        return;
      }
      this.addEvent(`GROUND BOARD / ${record.event}`, record.event === 'TASK_INIT_FAILED' ? 'error' : 'info');
      this.notify();
    }
  }

  ingestTx(record, hostMs) {
    const outcome = this.commandTracker.applyTx(record, hostMs);
    const waitingAck = Boolean(outcome.matched && record.ok && outcome.entry.description?.expectsAck);
    this.addEvent(
      `UPLINK ${record.ok ? (waitingAck ? 'SENT / WAITING ACK' : 'SENT') : 'FAILED'} / id=${record.id} command=0x${record.command.toString(16).padStart(2, '0').toUpperCase()}`,
      record.ok ? 'ok' : 'error',
    );
    if (!outcome.matched) this.addEvent(`UNMATCHED @TX / id=${record.id}`, 'warn');
    if (waitingAck && !this.replaying) this.scheduleCommandAckTimer(outcome.entry);
    this.notify();
  }

  ingestRx(record, hostMs = Date.now(), monitorEntry = null) {
    const bytes = Uint8Array.from(record.rawBytes);
    let decoded = null;
    let appMismatch = null;
    if (record.valid) {
      try {
        decoded = decodeApplicationPacket(bytes);
        if (!decoded.lengthValid || !decoded.checksumValid || !decoded.contractValid) {
          appMismatch = decoded.contractError || 'APP_DECODE_MISMATCH';
        }
      } catch {
        appMismatch = 'APP_DECODE_MISMATCH';
      }
    }
    const valid = Boolean(record.valid && decoded && appMismatch === null);
    const metadata = {
      hostMs,
      hostTime: new Date(hostMs),
      boardMs: record.boardMs,
      sequence: record.seq,
      intervalMs: record.dtMs,
      rssiDbm: record.rssiDbm,
      rssiRaw: record.rssiRaw,
      rawHex: record.rawHex,
      firmwareValid: record.valid,
      valid,
      error: appMismatch ?? record.error,
    };

    this.totalPackets += 1;
    this.lastAnyRxHostMs = hostMs;
    if (this.lastRxSequence !== null) {
      const advance = (record.seq - this.lastRxSequence) >>> 0;
      if (advance === 0) this.duplicateSequences += 1;
      else if (advance > 1) this.sequenceGaps += advance - 1;
    }
    this.lastRxSequence = record.seq;
    if (!valid) this.invalidPackets += 1;
    if (appMismatch !== null) {
      this.appDecodeMismatches += 1;
      if (monitorEntry) monitorEntry.appDecodeMismatch = true;
      this.notify('app-decode-mismatch', {
        seq: record.seq,
        header: record.header,
        error: 'APP_DECODE_MISMATCH',
      });
    }

    const packetRecord = {
      metadata,
      decoded,
      line: record.rawLine,
      packetName: decoded?.packetName ?? packetNames[record.header] ?? `Unknown_0x${record.header.toString(16).padStart(2, '0')}`,
    };
    this.rawPackets.push(packetRecord);
    if (this.rawPackets.length > MAX_RAW_PACKETS) this.rawPackets.shift();

    if (!valid || !decoded) {
      this.addEvent(`PACKET REJECTED / ${metadata.error ?? 'INVALID'}`, 'error', { rawHex: metadata.rawHex });
      this.notify();
      return;
    }

    this.rssiDbm = metadata.rssiDbm;

    if (decoded.header === PacketHeader.GROUND_TIME_REQUEST) {
      this.latestTimeRequestId = fieldMap(decoded).requestId?.raw ?? null;
    }
    if (decoded.header === PacketHeader.COMMAND_RESULT) {
      const fields = fieldMap(decoded);
      const result = {
        transactionId: fields.transactionId.raw,
        command: fields.command.raw,
        phase: fields.phase.raw,
        reason: fields.reason.raw,
        detail: fields.detail.raw,
      };
      const outcome = this.commandTracker.applyCommandResult(result, hostMs);
      if (!outcome.matched) this.addEvent(`UNMATCHED B0 / id=${fields.transactionId.raw}`, 'warn');
      else {
        this.clearCommandAckTimer(outcome.entry.localId);
        if (outcome.duplicate) this.addEvent(`DUPLICATE B0 / id=${fields.transactionId.raw}`, 'warn');
        else if (outcome.late) this.addEvent(`LATE B0 / id=${fields.transactionId.raw}`, 'warn');
        else if (outcome.ack) {
          this.addEvent(
            `COMMAND ACK${outcome.lateAck ? ' / LATE' : ''} / id=${result.transactionId} command=0x${result.command.toString(16).padStart(2, '0').toUpperCase()}`,
            outcome.lateAck ? 'warn' : 'ok',
          );
        } else if (outcome.ackInvalid) {
          this.addEvent(
            `INVALID COMMAND ACK / id=${result.transactionId} command=0x${result.command.toString(16).padStart(2, '0').toUpperCase()} reason=${result.reason}`,
            'error',
          );
        } else if (outcome.ackMissing && result.phase === 1) {
          this.addEvent(
            `COMMAND ACK MISSING / terminal=Completed id=${result.transactionId} command=0x${result.command.toString(16).padStart(2, '0').toUpperCase()}`,
            'error',
          );
        }
      }
    }
    this.ingestDecoded(decoded, metadata);
  }

  queueOutboundCommand(text, atMs = Date.now()) {
    return this.commandTracker.queue(text, atMs);
  }

  markCommandUsbWritten(localId, transportLocalId, atMs = Date.now()) {
    const entry = this.commandTracker.adoptLocalId(localId, transportLocalId);
    return entry ? this.commandTracker.markUsbWritten(transportLocalId, atMs) : null;
  }

  markCommandUsbWriteFailed(localId, error, atMs = Date.now()) {
    return this.commandTracker.markUsbWriteFailed(localId, error, atMs);
  }

  markPaint(atMs = Date.now()) {
    if (this.pendingPaintReceivedAtMs === null) return null;
    const receivedAtMs = this.pendingPaintReceivedAtMs;
    const paintLatencyMs = Math.max(0, atMs - receivedAtMs);
    this.paintLatenciesMs.push(paintLatencyMs);
    if (this.paintLatenciesMs.length > MAX_LATENCY_SAMPLES) this.paintLatenciesMs.shift();
    this.pendingPaintReceivedAtMs = null;
    return {
      receivedAtMs,
      storeLatencyMs: this.storeLatenciesMs.at(-1) ?? null,
      paintLatencyMs,
    };
  }

  ingestSessionEvent(event) {
    if (event?.type === 'serial_line') {
      this.ingestLineRecord(event);
      return;
    }
    if (event?.type !== 'command' || !Number.isInteger(event.localId)) return;
    let entry = this.commandTracker.findLocal(event.localId);
    if (!entry) entry = this.commandTracker.queue(event.command, Date.parse(event.pcUtc), event.localId);
    if (event.state === 'USB_WRITTEN') this.commandTracker.markUsbWritten(entry.localId, Date.parse(event.pcUtc));
    else if (event.state === 'USB_WRITE_FAILED') {
      this.commandTracker.markUsbWriteFailed(entry.localId, event.error, Date.parse(event.pcUtc));
    }
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
    if (decoded.communicationMode) {
      this.communicationMode = decoded.communicationMode;
    } else if (decoded.header >= PacketHeader.COMMAND_RECEIVE
        && decoded.header <= PacketHeader.RECOVERY_LOG_DATA) {
      this.communicationMode = 'Normal';
    }

    const periodic = (decoded.header >= PacketHeader.COMMAND_RECEIVE
      && decoded.header <= PacketHeader.RECOVERY_BEACON)
      || decoded.header === PacketHeader.MISSION_LINK_FALLBACK_TELEMETRY;
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
    const wrappedOrientation = numericField(map, 'wrappedOrientation');
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
      pushBounded(this.flightHistory, {
        t: flightElapsed, hostMs, roll, wrappedOrientation, rollRate, tilt, tiltDirection,
        finAngle, finRate,
        requestedTorque, pressure, temperature, airspeed, east, north, height,
      });
    }

    const systemPoint = {
      t: sessionSec, hostMs, logicVoltage, motorVoltage, pressure, temperature,
      rssi: metadata.rssiDbm,
    };
    if ([logicVoltage, motorVoltage, pressure, temperature, systemPoint.rssi].some(Number.isFinite)) {
      pushBounded(this.systemHistory, systemPoint);
    }

    if (east !== null && north !== null) {
      pushBounded(this.positionHistory, { t: flightElapsed ?? sessionSec, hostMs, east, north, height, valid: true });
    }

    if (wrappedOrientation !== null && tilt !== null && tiltDirection !== null) {
      this.attitudeSamples.push({
        hostMs, roll: wrappedOrientation, rollRate: rollRate ?? 0, tilt, tiltDirection,
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
