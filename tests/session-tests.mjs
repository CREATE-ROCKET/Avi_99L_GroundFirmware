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
  writer.appendRollTelemetry({
    kind: 'control_roll_v2', usbSequence: 25, packetHeader: 0xA7,
    wrappedOrientationDeg: null, liftoffRollUnwrappedDeg: null,
    liftoffRollStatus: 'NOT_IN_PACKET', controlRollReferenceUnwrappedDeg: 0,
    controlRollReferenceStatus: 'VALID', rollDeviationUnwrappedDeg: 380,
    rollDeviationStatus: 'VALID', correctiveRollErrorUnwrappedDeg: -380,
    referenceValid: true, referenceCaptured: false, controlActive: true,
    referenceOutOfRange: false, deviationOutOfRange: false, captureEventSequence: 17,
  });
  writer.appendConnectionEvent('disconnected');
  const lines = fs.readFileSync(path.join(writer.directory, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(lines.slice(-4).map((event) => event.type),
    ['command', 'serial_line', 'roll_telemetry', 'connection']);
  assert.ok(lines.every((event) => typeof event.pcMonotonicNs === 'string'));
  const rollLines = fs.readFileSync(path.join(writer.directory, 'roll-telemetry.csv'), 'utf8').trim().split(/\r?\n/);
  assert.equal(rollLines.length, 2);
  assert.match(rollLines[0], /wrapped_orientation_deg/);
  assert.match(rollLines[1], /0,VALID,380,VALID,-380,1,0,1,0,0,17$/);
  const session = JSON.parse(fs.readFileSync(path.join(writer.directory, 'session.json'), 'utf8'));
  assert.equal(session.schema, 2);
  assert.equal(session.controlRollTelemetryV2VaultSource,
    'f789fdef395c7b066d838a8f566ea4984231ab34');

  const closedFd = writer.eventsFd;
  fs.closeSync(closedFd);
  assert.equal(writer.appendCommand('help', { localId: 2 }), false);
  assert.equal(writer.status.healthy, false);
  writer.eventsFd = null;
  writer.close();
  assert.equal(statuses.at(-1).healthy, false);

  const blocker = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocker, 'block');
  const bad = new SessionWriter({ baseDirectory: path.join(blocker, 'child'), appVersion: 'test' });
  assert.doesNotThrow(() => bad.start());
  assert.equal(bad.status.healthy, false);
  fs.rmSync(root, { recursive: true, force: true });
}
