import fs from 'node:fs';
import path from 'node:path';
import { CONTROL_ROLL_TELEMETRY_V2_VAULT_SOURCE } from '../shared/protocol.js';

const DEFAULT_REPLAY_LIMIT = 4096;
const ROLL_EXPORT_COLUMNS = [
  'pc_utc', 'usb_sequence', 'packet_header', 'kind',
  'wrapped_orientation_deg', 'liftoff_roll_unwrapped_deg', 'liftoff_roll_status',
  'control_roll_reference_unwrapped_deg', 'control_roll_reference_status',
  'roll_deviation_unwrapped_deg', 'roll_deviation_status',
  'corrective_roll_error_unwrapped_deg', 'reference_valid', 'reference_captured',
  'control_active', 'reference_out_of_range', 'deviation_out_of_range',
  'capture_event_sequence',
];

function isoForPath(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function csvValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export class SessionWriter {
  constructor({
    baseDirectory,
    appVersion,
    platform = process.platform,
    arch = process.arch,
    replayLimit = DEFAULT_REPLAY_LIMIT,
    onStatus = () => {},
  }) {
    if (!baseDirectory) throw new Error('baseDirectory is required');
    if (!Number.isSafeInteger(replayLimit) || replayLimit < 1) {
      throw new RangeError('replayLimit must be a positive integer');
    }
    this.baseDirectory = baseDirectory;
    this.appVersion = appVersion;
    this.platform = platform;
    this.arch = arch;
    this.replayLimit = replayLimit;
    this.onStatus = onStatus;
    this.directory = null;
    this.createdAt = null;
    this.eventsFd = null;
    this.rawFd = null;
    this.rollFd = null;
    this.portPath = null;
    this.replay = [];
    this.status = { healthy: false, lastFlushUtc: null, error: 'session not started' };
    this.failed = false;
  }

  start(date = new Date()) {
    if (this.eventsFd !== null) return this.snapshot();
    this.createdAt = date;
    this.directory = path.join(this.baseDirectory, isoForPath(date));
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      this.eventsFd = fs.openSync(path.join(this.directory, 'events.jsonl'), 'a');
      this.rawFd = fs.openSync(path.join(this.directory, 'serial.bin'), 'a');
      const rollPath = path.join(this.directory, 'roll-telemetry.csv');
      const writeRollHeader = !fs.existsSync(rollPath) || fs.statSync(rollPath).size === 0;
      this.rollFd = fs.openSync(rollPath, 'a');
      if (writeRollHeader) {
        const header = `${ROLL_EXPORT_COLUMNS.join(',')}\n`;
        const written = fs.writeSync(this.rollFd, header, null, 'utf8');
        if (written !== Buffer.byteLength(header)) throw new Error('partial roll-telemetry.csv header write');
        fs.fsyncSync(this.rollFd);
      }
      fs.writeFileSync(path.join(this.directory, 'session.json'), `${JSON.stringify({
        schema: 2,
        createdAtUtc: date.toISOString(),
        appVersion: this.appVersion,
        platform: this.platform,
        arch: this.arch,
        controlRollTelemetryV2VaultSource: CONTROL_ROLL_TELEMETRY_V2_VAULT_SOURCE,
      }, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.failed = true;
      if (this.eventsFd !== null) {
        try { fs.closeSync(this.eventsFd); } catch {}
      }
      if (this.rawFd !== null) {
        try { fs.closeSync(this.rawFd); } catch {}
      }
      if (this.rollFd !== null) {
        try { fs.closeSync(this.rollFd); } catch {}
      }
      this.eventsFd = null;
      this.rawFd = null;
      this.rollFd = null;
      this.status = {
        healthy: false,
        lastFlushUtc: null,
        error: error instanceof Error ? error.message : String(error),
      };
      this.onStatus(this.status);
      return this.snapshot();
    }
    this.status = { healthy: true, lastFlushUtc: null, error: null };
    this.onStatus(this.status);
    this.appendConnectionEvent('session_started', { directory: this.directory });
    return this.snapshot();
  }

  timestamp() {
    return {
      pcUtc: new Date().toISOString(),
      pcMonotonicNs: process.hrtime.bigint().toString(),
      port: this.portPath,
    };
  }

  setPort(portPath) {
    this.portPath = portPath;
  }

  append(type, detail = {}, replay = false) {
    if (this.eventsFd === null) return false;
    const event = { ...detail, ...this.timestamp(), type };
    try {
      const line = `${JSON.stringify(event)}\n`;
      const written = fs.writeSync(this.eventsFd, line, null, 'utf8');
      if (written !== Buffer.byteLength(line)) throw new Error('partial events.jsonl write');
      fs.fsyncSync(this.eventsFd);
      if (!this.failed) this.status = { healthy: true, lastFlushUtc: event.pcUtc, error: null };
      if (replay) {
        this.replay.push(event);
        if (this.replay.length > this.replayLimit) {
          this.replay.splice(0, this.replay.length - this.replayLimit);
        }
      }
      this.onStatus(this.status);
      return true;
    } catch (error) {
      this.failed = true;
      this.status = {
        healthy: false,
        lastFlushUtc: this.status.lastFlushUtc,
        error: error instanceof Error ? error.message : String(error),
      };
      this.onStatus(this.status);
      return false;
    }
  }

  appendSerialChunk(direction, chunk) {
    if (this.rawFd === null) return false;
    const bytes = Buffer.from(chunk);
    try {
      const written = fs.writeSync(this.rawFd, bytes);
      if (written !== bytes.length) throw new Error('partial serial.bin write');
      fs.fsyncSync(this.rawFd);
    } catch (error) {
      this.failed = true;
      this.status = {
        healthy: false,
        lastFlushUtc: this.status.lastFlushUtc,
        error: error instanceof Error ? error.message : String(error),
      };
      this.onStatus(this.status);
      return false;
    }
    return this.append('serial_chunk', {
      direction,
      byteLength: bytes.length,
      rawHex: bytes.toString('hex').toUpperCase(),
    });
  }

  appendSerialLine(direction, rawLine, classification, detail = {}) {
    return this.append('serial_line', { direction, rawLine, classification, ...detail },
      direction === 'tx' || classification?.kind === 'record' || classification?.kind === 'parser-error');
  }

  appendRollTelemetry(detail) {
    if (!this.append('roll_telemetry', detail, true)) return false;
    if (this.rollFd === null) return false;
    const row = {
      pc_utc: new Date().toISOString(),
      usb_sequence: detail.usbSequence,
      packet_header: Number.isInteger(detail.packetHeader)
        ? `0x${detail.packetHeader.toString(16).padStart(2, '0').toUpperCase()}` : null,
      kind: detail.kind,
      wrapped_orientation_deg: detail.wrappedOrientationDeg,
      liftoff_roll_unwrapped_deg: detail.liftoffRollUnwrappedDeg,
      liftoff_roll_status: detail.liftoffRollStatus,
      control_roll_reference_unwrapped_deg: detail.controlRollReferenceUnwrappedDeg,
      control_roll_reference_status: detail.controlRollReferenceStatus,
      roll_deviation_unwrapped_deg: detail.rollDeviationUnwrappedDeg,
      roll_deviation_status: detail.rollDeviationStatus,
      corrective_roll_error_unwrapped_deg: detail.correctiveRollErrorUnwrappedDeg,
      reference_valid: detail.referenceValid,
      reference_captured: detail.referenceCaptured,
      control_active: detail.controlActive,
      reference_out_of_range: detail.referenceOutOfRange,
      deviation_out_of_range: detail.deviationOutOfRange,
      capture_event_sequence: detail.captureEventSequence,
    };
    const line = `${ROLL_EXPORT_COLUMNS.map((column) => csvValue(row[column])).join(',')}\n`;
    try {
      const written = fs.writeSync(this.rollFd, line, null, 'utf8');
      if (written !== Buffer.byteLength(line)) throw new Error('partial roll-telemetry.csv write');
      fs.fsyncSync(this.rollFd);
      return true;
    } catch (error) {
      this.failed = true;
      this.status = {
        healthy: false,
        lastFlushUtc: this.status.lastFlushUtc,
        error: error instanceof Error ? error.message : String(error),
      };
      this.onStatus(this.status);
      return false;
    }
  }

  appendParserError(error, rawLine) {
    return this.append('parser_error', { error, rawLine }, true);
  }

  appendCommand(command, detail = {}) {
    return this.append('command', { command, ...detail }, true);
  }

  appendConnectionEvent(event, detail = {}) {
    return this.append('connection', { event, ...detail }, true);
  }

  appendSessionError(error) {
    return this.append('session_error', { error }, true);
  }

  snapshot() {
    return {
      directory: this.directory,
      createdAt: this.createdAt?.toISOString() ?? null,
      portPath: this.portPath,
      replay: [...this.replay],
      status: { ...this.status },
    };
  }

  flush() {
    if (this.eventsFd !== null) fs.fsyncSync(this.eventsFd);
    if (this.rawFd !== null) fs.fsyncSync(this.rawFd);
    if (this.rollFd !== null) fs.fsyncSync(this.rollFd);
  }

  close() {
    if (this.eventsFd === null && this.rawFd === null && this.rollFd === null) return;
    this.appendConnectionEvent('session_stopping');
    try {
      this.flush();
    } catch (error) {
      this.failed = true;
      this.status = {
        healthy: false,
        lastFlushUtc: this.status.lastFlushUtc,
        error: error instanceof Error ? error.message : String(error),
      };
      this.onStatus(this.status);
    } finally {
      if (this.eventsFd !== null) {
        try { fs.closeSync(this.eventsFd); } catch {}
      }
      if (this.rawFd !== null) {
        try { fs.closeSync(this.rawFd); } catch {}
      }
      if (this.rollFd !== null) {
        try { fs.closeSync(this.rollFd); } catch {}
      }
      this.eventsFd = null;
      this.rawFd = null;
      this.rollFd = null;
      this.portPath = null;
    }
  }
}
