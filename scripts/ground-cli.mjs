#!/usr/bin/env node

import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { parseUsbLine } from '../shared/usb-line.js';

const HELP = `Usage:
  npm run cli -- --list
  npm run cli -- --port /dev/ttyUSB0 [--baud 115200] [--duration-ms 10000]
                 [--reset-to-run] [--settle-ms 250]
                 [--send "help"] [--send "g 0x7F"]

stdinへ入力した行も接続中のGround Boardへ送信します。
受信・送信・接続eventはtimestamp付きJSON Linesでstdoutへ出力します。`;

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`${option} requires a value`);
  return value;
}

function parseArguments(argv) {
  const options = { baudRate: 115200, durationMs: 0, settleMs: 250, sends: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    switch (option) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--port':
        options.port = requireValue(argv, index, option);
        index += 1;
        break;
      case '--reset-to-run':
        options.resetToRun = true;
        break;
      case '--baud':
        options.baudRate = Number(requireValue(argv, index, option));
        index += 1;
        break;
      case '--duration-ms':
        options.durationMs = Number(requireValue(argv, index, option));
        index += 1;
        break;
      case '--settle-ms':
        options.settleMs = Number(requireValue(argv, index, option));
        index += 1;
        break;
      case '--send':
        options.sends.push(requireValue(argv, index, option));
        index += 1;
        break;
      default:
        throw new Error(`unknown option: ${option}`);
    }
  }
  if (!Number.isSafeInteger(options.baudRate) || options.baudRate <= 0) {
    throw new Error('--baud must be a positive integer');
  }
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs < 0) {
    throw new Error('--duration-ms must be a non-negative integer');
  }
  if (!Number.isSafeInteger(options.settleMs) || options.settleMs < 0) {
    throw new Error('--settle-ms must be a non-negative integer');
  }
  if (options.sends.some((line) => !line.trim())) {
    throw new Error('--send must not be empty');
  }
  return options;
}

function emit(direction, detail = {}) {
  console.log(JSON.stringify({
    host_time_utc: new Date().toISOString(),
    host_monotonic_ms: performance.now(),
    direction,
    ...detail,
  }));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }

  const { SerialPort } = await import('serialport');
  if (options.list) {
    console.log(JSON.stringify(await SerialPort.list(), null, 2));
    return;
  }
  if (!options.port) throw new Error('--port is required unless --list is used');

  const port = new SerialPort({
    path: options.port,
    baudRate: options.baudRate,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    autoOpen: false,
  });
  await new Promise((resolve, reject) => {
    port.open((error) => error ? reject(error) : resolve());
  });
  emit('event', { event: 'connected', port: options.port, baud_rate: options.baudRate });

  const setControlLines = (dtr, rts) => new Promise((resolve, reject) => {
    port.set({ dtr, rts }, (error) => error ? reject(error) : resolve());
  });
  if (options.resetToRun) {
    emit('event', { event: 'reset_to_run_start' });
    await setControlLines(false, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await setControlLines(false, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setControlLines(false, false);
    emit('event', { event: 'reset_to_run_complete' });
  }

  let serialBuffer = '';
  let stopping = false;
  let stopTimer = null;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (stopTimer !== null) clearTimeout(stopTimer);
    process.stdin.pause();
    if (!port.isOpen) {
      finish();
      return;
    }
    port.set({ dtr: false, rts: false }, () => port.close(() => finish()));
  };

  const sendLine = async (line) => {
    const normalized = line.trim();
    if (!normalized) return;
    await new Promise((resolve, reject) => {
      port.write(`${normalized}\n`, 'utf8', (error) => {
        if (error) return reject(error);
        port.drain((drainError) => drainError ? reject(drainError) : resolve());
      });
    });
    emit('tx', { raw_line: normalized });
  };

  port.on('data', (chunk) => {
    serialBuffer += chunk.toString('utf8');
    while (true) {
      const newline = serialBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = serialBuffer.slice(0, newline).replace(/\r$/, '');
      serialBuffer = serialBuffer.slice(newline + 1);
      if (line) emit('rx', { raw_line: line, parsed: parseUsbLine(line) });
    }
    if (serialBuffer.length > 65536) {
      emit('event', { event: 'line_overflow', bytes: serialBuffer.length });
      serialBuffer = '';
    }
  });
  port.on('error', (error) => {
    emit('event', { event: 'serial_error', message: error.message });
    stop();
  });
  port.on('close', () => {
    emit('event', { event: 'disconnected', port: options.port });
    finish();
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  process.stdin.setEncoding('utf8');
  let stdinBuffer = '';
  process.stdin.on('data', (chunk) => {
    stdinBuffer += chunk;
    while (true) {
      const newline = stdinBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdinBuffer.slice(0, newline).replace(/\r$/, '');
      stdinBuffer = stdinBuffer.slice(newline + 1);
      void sendLine(line).catch((error) => {
        emit('event', { event: 'write_error', message: error.message });
        stop();
      });
    }
  });

  if (options.sends.length > 0 && options.settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.settleMs));
  }
  for (const line of options.sends) await sendLine(line);
  if (options.durationMs > 0) stopTimer = setTimeout(stop, options.durationMs);
  await finished;
  process.stdin.pause();
}

main().catch((error) => {
  emit('event', { event: 'fatal', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
