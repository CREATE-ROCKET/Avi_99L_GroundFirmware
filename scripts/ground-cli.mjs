#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { GroundSerialService } from '../electron/ground-serial-service.mjs';
import { SessionWriter } from '../electron/session-writer.mjs';

const HELP = `Usage:
  npm run cli -- --list
  npm run cli -- --port /dev/ttyUSB0 [--baud 115200] [--duration-ms 10000]
                 [--session-dir <directory>] [--reset-to-run] [--settle-ms 250]
                 [--send "help"] [--send "g 0x7F"]

stdinへ入力した行も接続中のGround Boardへ送信します。
USB v1 parsed record、raw line、接続eventをtimestamp付きJSON Linesで出力・保存します。`;

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
      case '--session-dir':
        options.sessionDirectory = requireValue(argv, index, option);
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
  if (options.baudRate !== 115200) throw new Error('--baud must be 115200 for USB v1');
  if (!Number.isSafeInteger(options.durationMs) || options.durationMs < 0) {
    throw new Error('--duration-ms must be a non-negative integer');
  }
  if (!Number.isSafeInteger(options.settleMs) || options.settleMs < 0) {
    throw new Error('--settle-ms must be a non-negative integer');
  }
  if (options.sends.some((line) => !line.trim())) throw new Error('--send must not be empty');
  return options;
}

function emit(type, detail = {}) {
  console.log(JSON.stringify({
    pcUtc: new Date().toISOString(),
    pcMonotonicMs: performance.now(),
    type,
    ...detail,
  }));
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.list) {
    const { SerialPort } = await import('serialport');
    console.log(JSON.stringify(await SerialPort.list(), null, 2));
    return;
  }
  if (!options.port) throw new Error('--port is required unless --list is used');

  const baseDirectory = path.resolve(options.sessionDirectory
    ?? path.join(os.homedir(), '.local', 'state', 'create-99l-ground-station', 'cli'));
  const sessionWriter = new SessionWriter({
    baseDirectory,
    appVersion: 'cli',
    onStatus: (status) => {
      if (!status.healthy) emit('session_error', status);
    },
  });
  sessionWriter.start();
  const service = new GroundSerialService({ sessionWriter });
  service.on('line', (line) => emit('serial_line', line));
  service.on('status', (status) => emit('connection', status));
  service.on('serial-error', (error) => emit('parser_or_serial_error', error));
  try {
    await service.connect(options.port);
    emit('session', { directory: sessionWriter.directory });

    if (options.resetToRun) {
      emit('reset_to_run_start');
      await service.setControlLines({ dtr: false, rts: false });
      await delay(50);
      await service.setControlLines({ dtr: false, rts: true });
      await delay(100);
      await service.setControlLines({ dtr: false, rts: false });
      emit('reset_to_run_complete');
    }

    let stopping = false;
    let stopTimer = null;
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (stopTimer !== null) clearTimeout(stopTimer);
      process.stdin.pause();
      finish();
    };

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
        void service.sendCommand(line).then((result) => emit('command', result)).catch((error) => {
          emit('command_error', { message: error.message });
        });
      }
    });

    if (options.sends.length > 0 && options.settleMs > 0) await delay(options.settleMs);
    for (const command of options.sends) {
      const result = await service.sendCommand(command);
      emit('command', result);
    }
    if (options.durationMs > 0) stopTimer = setTimeout(stop, options.durationMs);
    await finished;
  } finally {
    process.stdin.pause();
    await service.disconnect('cli');
    sessionWriter.close();
  }
}

main().catch((error) => {
  emit('fatal', { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
