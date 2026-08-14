import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GroundSerialService } from '../electron/ground-serial-service.mjs';
import { SessionWriter } from '../electron/session-writer.mjs';
import { TelemetryStore } from '../renderer/src/store.js';
import { readGoldenVectors } from './protocol-smoke.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`timeout: ${message}`);
}

async function readUntil(fd, expected, timeoutMs = 3000) {
  const chunks = [];
  return waitFor(() => {
    const buffer = Buffer.alloc(256);
    try {
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (length > 0) chunks.push(buffer.subarray(0, length));
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
    }
    const text = Buffer.concat(chunks).toString('ascii');
    return text.includes(expected) ? text : null;
  }, `read ${expected}`, timeoutMs);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '99l-pty-test-'));
  const hostPath = path.join(root, 'host');
  const boardPath = path.join(root, 'board');
  const socat = spawn('socat', [
    '-d', '-d',
    `pty,raw,echo=0,link=${hostPath}`,
    `pty,raw,echo=0,link=${boardPath}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socatError = '';
  socat.stderr.on('data', (chunk) => { socatError += chunk.toString(); });

  let boardFd = null;
  let writer = null;
  let service = null;
  try {
    await waitFor(() => fs.existsSync(hostPath) && fs.existsSync(boardPath), `socat PTYs: ${socatError}`);
    boardFd = fs.openSync(boardPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    writer = new SessionWriter({ baseDirectory: path.join(root, 'sessions'), appVersion: 'pty-test' });
    writer.start();
    service = new GroundSerialService({ sessionWriter: writer });
    const received = [];
    const errors = [];
    const store = new TelemetryStore();
    service.on('line', (line) => {
      received.push(line);
      store.ingestLineRecord(line);
    });
    service.on('serial-error', (error) => errors.push(error));

    await service.connect(hostPath);
    assert.equal(service.port.listenerCount('data'), 1);
    assert.equal(service.port.listenerCount('error'), 1);
    assert.equal(service.port.listenerCount('close'), 1);

    fs.writeSync(boardFd, Buffer.from('# partial'));
    await delay(30);
    assert.equal(received.length, 0);
    await service.disconnect('partial-test');
    await service.connect(hostPath);

    const b1 = readGoldenVectors().find((vector) => vector.name === 'RX_B1_VALID').record;
    for (const byte of Buffer.from(`${b1}\r\n`)) fs.writeSync(boardFd, Buffer.from([byte]));
    await waitFor(() => received.length === 1, 'one-byte fragmented record');
    assert.equal(received[0].classification.kind, 'record');
    assert.equal(received[0].classification.record.type, 'RX');
    assert.equal(store.latestTimeRequestId, 7);

    fs.writeSync(boardFd, Buffer.from('@RX usb_v=1\n# human\nESP-ROM:boot\n'));
    await waitFor(() => received.length === 4, 'back-to-back records');
    assert.equal(received[1].classification.kind, 'parser-error');
    assert.equal(received[2].classification.kind, 'pretty');
    assert.equal(received[3].classification.kind, 'unclassified');
    assert.equal(store.latestTimeRequestId, 7);

    const boot = readGoldenVectors().find((vector) => vector.name === 'SYS_BOOT').record;
    fs.writeSync(boardFd, Buffer.from(`${boot}\n`));
    await waitFor(() => received.length === 5, 'board reset record');
    assert.equal(store.latestTimeRequestId, null);
    assert.equal(store.lastRxSequence, null);

    const command = await service.sendCommand('help');
    assert.equal(command.ok, true);
    assert.match(await readUntil(boardFd, 'help\n'), /help\n/);

    for (let iteration = 0; iteration < 10; iteration += 1) {
      fs.writeSync(boardFd, Buffer.from('@SYS usb_v=1'));
      await delay(5);
      await service.disconnect(`cycle-${iteration}`);
      await service.connect(hostPath);
      assert.equal(service.port.listenerCount('data'), 1);
      assert.equal(service.port.listenerCount('error'), 1);
      assert.equal(service.port.listenerCount('close'), 1);
    }

    const wrap = readGoldenVectors().filter((vector) => vector.name.startsWith('RX_WRAP_'));
    fs.writeSync(boardFd, Buffer.from(`${wrap[0].record}\n${wrap[1].record}\n`));
    await waitFor(() => received.length === 7, 'sequence wrap records');
    assert.equal(store.latestTimeRequestId, 7);
    assert.equal(received.filter((line) => line.classification.kind === 'record').length, 4);
    assert.equal(errors.length, 0);

    await service.disconnect('test-complete');
    writer.close();
    const events = fs.readFileSync(path.join(writer.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(events.some((event) => event.type === 'command' && event.state === 'USB_WRITTEN'));
    assert.ok(events.some((event) => event.type === 'parser_error'));
    assert.ok(events.filter((event) => event.type === 'connection' && event.event === 'connected').length >= 11);
    console.log(`PTY integration: ${received.length} lines, store path, 10 reconnect cycles passed`);
  } finally {
    if (service?.port?.isOpen) await service.disconnect('cleanup');
    if (writer?.eventsFd !== null || writer?.rawFd !== null) writer?.close();
    if (boardFd !== null) fs.closeSync(boardFd);
    socat.kill('SIGTERM');
    await new Promise((resolve) => socat.once('exit', resolve));
    fs.rmSync(root, { recursive: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
