import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionWriter } from '../electron/session-writer.mjs';

export function runSessionTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '99l-session-test-'));
  const statuses = [];
  const writer = new SessionWriter({
    baseDirectory: root,
    appVersion: 'test',
    onStatus: (status) => statuses.push({ ...status }),
  });
  writer.start(new Date('2026-08-14T00:00:00.000Z'));
  writer.setPort('/dev/test');
  writer.appendCommand('help', { localId: 1, state: 'LOCAL_QUEUED' });
  writer.appendSerialLine('rx', '# ok', { kind: 'pretty', rawLine: '# ok', text: 'ok' });
  writer.appendConnectionEvent('disconnected');
  const lines = fs.readFileSync(path.join(writer.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.slice(-3).map((event) => event.type), ['command', 'serial_line', 'connection']);
  assert.ok(lines.every((event) => typeof event.pcMonotonicNs === 'string'));

  const closedFd = writer.eventsFd;
  fs.closeSync(closedFd);
  assert.equal(writer.appendCommand('help', { localId: 2 }), false);
  assert.equal(writer.status.healthy, false);
  writer.eventsFd = null;
  writer.close();
  assert.equal(statuses.at(-1).healthy, false);

  const bad = new SessionWriter({ baseDirectory: '/dev/null/not-a-directory', appVersion: 'test' });
  assert.doesNotThrow(() => bad.start());
  assert.equal(bad.status.healthy, false);
  fs.rmSync(root, { recursive: true });
}
