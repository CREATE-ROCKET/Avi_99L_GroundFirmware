import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { classifyUsbLine } from '../shared/usb-v1.js';
import { UsbLineFramer } from '../shared/usb-line-framer.js';

function consoleUnsigned(value, maximum) {
  if (!/^(?:0x[0-9A-Fa-f]+|[0-9]+)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

export function validateCommandText(value) {
  if (typeof value !== 'string') throw new TypeError('command must be a string');
  const command = value.trim();
  if (!command || command.length > 256 || /[\r\n\x00-\x1F\x7F]/.test(command)) {
    throw new Error('invalid command text');
  }
  const tokens = command.split(/\s+/);
  if (tokens[0] === 'help' || tokens[0] === 'ae' || tokens[0] === 'le') {
    if (tokens.length !== 1) throw new Error('unexpected command argument');
  } else if (tokens[0] === 'g' || tokens[0] === 'local') {
    if (tokens.length < 2 || tokens.length > 8
        || tokens.slice(1).some((token) => consoleUnsigned(token, 255) === null)) {
      throw new Error('invalid command or argument');
    }
  } else if (tokens[0] === 'time') {
    if (tokens.length !== 4
        || consoleUnsigned(tokens[1], 255) === null || consoleUnsigned(tokens[1], 255) === 0
        || consoleUnsigned(tokens[2], 0xFFFFFFFF) === null
        || consoleUnsigned(tokens[3], 999) === null) {
      throw new Error('invalid time response');
    }
  } else if (tokens[0] === 'release') {
    if (tokens.length !== 2
        || consoleUnsigned(tokens[1], 255) === null || consoleUnsigned(tokens[1], 255) === 0) {
      throw new Error('invalid transaction release');
    }
  } else {
    throw new Error('unsupported command form');
  }
  return command;
}

export class GroundSerialService extends EventEmitter {
  constructor({ sessionWriter, serialportLoader = () => import('serialport') }) {
    super();
    if (!sessionWriter) throw new Error('sessionWriter is required');
    this.sessionWriter = sessionWriter;
    this.serialportLoader = serialportLoader;
    this.serialportModule = null;
    this.port = null;
    this.portPath = null;
    this.framer = new UsbLineFramer();
    this.status = { state: 'disconnected', path: null, error: null };
    this.nextCommandId = 1;
    this.handlers = null;
    this.commandQueue = [];
    this.commandActive = false;
    this.disconnectPromise = null;
    this.connectPromise = null;
    this.connectionGeneration = 0;
    this.nextStreamId = 1;
  }

  async module() {
    if (!this.serialportModule) this.serialportModule = await this.serialportLoader();
    return this.serialportModule;
  }

  async listPorts() {
    const { SerialPort } = await this.module();
    return SerialPort.list();
  }

  currentStatus() {
    return { ...this.status };
  }

  setStatus(state, detail = {}) {
    this.status = { state, path: this.portPath, error: null, ...detail };
    this.emit('status', this.currentStatus());
  }

  connect(portPath) {
    if (typeof portPath !== 'string' || !portPath || /[\r\n\x00]/.test(portPath)) {
      return Promise.reject(new Error('valid port path is required'));
    }
    if (this.connectPromise) return Promise.reject(new Error('serial connection is already in progress'));
    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;
    this.portPath = portPath;
    this.setStatus('connecting');
    this.connectPromise = this.connectNow(portPath, generation).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async connectNow(portPath, generation) {
    await this.disconnect('switch');
    if (generation !== this.connectionGeneration) throw new Error('serial connection was cancelled');
    this.portPath = portPath;
    this.setStatus('connecting');
    const { SerialPort } = await this.module();
    if (generation !== this.connectionGeneration) throw new Error('serial connection was cancelled');
    const port = new SerialPort({
      path: portPath,
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      xon: false,
      xoff: false,
      autoOpen: false,
    });
    try {
      await new Promise((resolve, reject) => {
        port.open((error) => error ? reject(error) : resolve());
      });
    } catch (error) {
      if (generation !== this.connectionGeneration) throw new Error('serial connection was cancelled');
      this.portPath = null;
      this.setStatus('error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    if (generation !== this.connectionGeneration) {
      if (port.isOpen) await new Promise((resolve) => port.close(() => resolve()));
      throw new Error('serial connection was cancelled');
    }

    this.port = port;
    this.framer.reset('CONNECT');
    this.sessionWriter.setPort(portPath);
    this.sessionWriter.appendConnectionEvent('connected', { path: portPath, baudRate: 115200 });
    this.attach(port);
    this.setStatus('connected');
    return this.currentStatus();
  }

  attach(port) {
    const onData = (chunk) => this.receiveChunk(chunk);
    const onError = (error) => {
      this.sessionWriter.appendConnectionEvent('serial_error', { message: error.message });
      this.setStatus('error', { error: error.message });
      this.emit('serial-error', { code: 'SERIAL_ERROR', message: error.message });
    };
    const onClose = () => this.handleUnexpectedClose(port);
    this.handlers = { onData, onError, onClose };
    port.on('data', onData);
    port.on('error', onError);
    port.on('close', onClose);
  }

  detach(port) {
    if (!this.handlers) return;
    port.removeListener('data', this.handlers.onData);
    port.removeListener('error', this.handlers.onError);
    port.removeListener('close', this.handlers.onClose);
    this.handlers = null;
  }

  receiveChunk(chunk) {
    const bytes = Buffer.from(chunk);
    const receivedAt = {
      hostTimeUtc: new Date().toISOString(),
      hostUnixMs: Date.now(),
      hostMonotonicMs: performance.now(),
      hostMonotonicNs: process.hrtime.bigint().toString(),
    };
    this.sessionWriter.appendSerialChunk('rx', bytes);
    for (const event of this.framer.push(bytes)) {
      if (event.type === 'error') {
        const detail = { code: event.code, discardedBytes: event.discardedBytes };
        this.sessionWriter.appendParserError(detail, null);
        this.emit('serial-error', detail);
        continue;
      }
      const classification = classifyUsbLine(event.line);
      const streamId = this.nextStreamId;
      this.nextStreamId = this.nextStreamId === Number.MAX_SAFE_INTEGER ? 1 : this.nextStreamId + 1;
      const envelope = {
        ...receivedAt,
        streamId,
        port: this.portPath,
        rawLine: event.line,
        classification,
      };
      this.sessionWriter.appendSerialLine('rx', event.line, classification, {
        streamId,
        hostTimeUtc: receivedAt.hostTimeUtc,
        hostUnixMs: receivedAt.hostUnixMs,
        hostMonotonicNs: receivedAt.hostMonotonicNs,
      });
      if (classification.kind === 'parser-error') {
        this.sessionWriter.appendParserError(classification.error, event.line);
      }
      this.emit('line', envelope);
    }
  }

  sendCommand(value) {
    const command = validateCommandText(value);
    if (!this.port?.isOpen) return Promise.reject(new Error('serial port is not connected'));
    if (this.commandQueue.length >= 32) return Promise.reject(new Error('command queue is full'));
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ command, resolve, reject });
      void this.pumpCommandQueue();
    });
  }

  async pumpCommandQueue() {
    if (this.commandActive) return;
    this.commandActive = true;
    while (this.commandQueue.length > 0) {
      const pending = this.commandQueue.shift();
      try {
        pending.resolve(await this.writeCommand(pending.command));
      } catch (error) {
        pending.reject(error);
      }
    }
    this.commandActive = false;
  }

  async writeCommand(command) {
    const port = this.port;
    if (!port?.isOpen) throw new Error('serial port is not connected');
    const localId = this.nextCommandId;
    this.nextCommandId = this.nextCommandId === 0xFFFFFFFF ? 1 : this.nextCommandId + 1;
    this.sessionWriter.appendCommand(command, { localId, state: 'LOCAL_QUEUED' });
    const bytes = Buffer.from(`${command}\n`, 'ascii');
    try {
      await new Promise((resolve, reject) => {
        if (!port.isOpen) return reject(new Error('serial port disconnected'));
        port.write(bytes, (error) => {
          if (error) return reject(error);
          if (!port.isOpen) return reject(new Error('serial port disconnected'));
          port.drain((drainError) => drainError ? reject(drainError) : resolve());
        });
      });
    } catch (error) {
      this.sessionWriter.appendCommand(command, {
        localId,
        state: 'USB_WRITE_FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.sessionWriter.appendSerialChunk('tx', bytes);
    this.sessionWriter.appendSerialLine('tx', command, { kind: 'command', localId });
    this.sessionWriter.appendCommand(command, { localId, state: 'USB_WRITTEN' });
    return { ok: true, localId, command };
  }

  async setControlLines({ dtr, rts }) {
    const port = this.port;
    if (!port?.isOpen) throw new Error('serial port is not connected');
    if (typeof dtr !== 'boolean' || typeof rts !== 'boolean') {
      throw new TypeError('dtr and rts must be boolean');
    }
    await new Promise((resolve, reject) => {
      if (!port.isOpen) return reject(new Error('serial port disconnected'));
      port.set({ dtr, rts }, (error) => error ? reject(error) : resolve());
    });
  }

  disconnect(reason = 'user') {
    if (reason !== 'switch') this.connectionGeneration += 1;
    if (this.disconnectPromise) return this.disconnectPromise;
    this.disconnectPromise = this.disconnectNow(reason).finally(() => {
      this.disconnectPromise = null;
    });
    return this.disconnectPromise;
  }

  async disconnectNow(reason) {
    const port = this.port;
    if (!port) {
      if (this.status.state !== 'disconnected') {
        this.portPath = null;
        this.setStatus('disconnected', { reason });
      }
      return;
    }
    this.port = null;
    for (const pending of this.commandQueue.splice(0)) {
      pending.reject(new Error('serial port disconnected'));
    }
    this.detach(port);
    const resetEvent = this.framer.reset('DISCONNECT');
    if (resetEvent) this.sessionWriter.appendParserError(resetEvent, null);
    const path = this.portPath;
    if (port.isOpen) {
      await new Promise((resolve) => port.close(() => resolve()));
    }
    this.sessionWriter.appendConnectionEvent('disconnected', { path, reason });
    this.sessionWriter.setPort(null);
    this.portPath = null;
    this.setStatus('disconnected', { reason });
  }

  handleUnexpectedClose(port) {
    if (port !== this.port) return;
    this.detach(port);
    this.port = null;
    const resetEvent = this.framer.reset('CLOSE');
    if (resetEvent) this.sessionWriter.appendParserError(resetEvent, null);
    const path = this.portPath;
    this.sessionWriter.appendConnectionEvent('disconnected', { path, reason: 'closed' });
    this.sessionWriter.setPort(null);
    this.portPath = null;
    this.setStatus('disconnected', { reason: 'closed' });
  }
}
