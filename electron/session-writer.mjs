import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_REPLAY_LIMIT = 4096;

function isoForPath(date) {
  return date.toISOString().replace(/[:.]/g, '-');
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
      fs.writeFileSync(path.join(this.directory, 'session.json'), `${JSON.stringify({
        schema: 1,
        createdAtUtc: date.toISOString(),
        appVersion: this.appVersion,
        platform: this.platform,
        arch: this.arch,
      }, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.failed = true;
      if (this.eventsFd !== null) {
        try { fs.closeSync(this.eventsFd); } catch {}
      }
      if (this.rawFd !== null) {
        try { fs.closeSync(this.rawFd); } catch {}
      }
      this.eventsFd = null;
      this.rawFd = null;
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
  }

  close() {
    if (this.eventsFd === null && this.rawFd === null) return;
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
      this.eventsFd = null;
      this.rawFd = null;
      this.portPath = null;
    }
  }
}
