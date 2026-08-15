import assert from 'node:assert/strict';
import { classifyUsbLine } from '../shared/usb-v1.js';
import { escapeHtml } from '../shared/html.js';
import { OutboundCommandTracker } from '../shared/command-lifecycle.js';
import { TelemetryStore } from '../renderer/src/store.js';
import { readControlRollVectors, readGoldenVectors } from './protocol-smoke.mjs';

function envelope(line, hostUnixMs = Date.now()) {
  return { hostUnixMs, rawLine: line, classification: classifyUsbLine(line) };
}

export function runStoreAndLifecycleTests() {
  const vectorMap = new Map(readGoldenVectors().map((vector) => [vector.name, vector.record]));
  const dedupeStore = new TelemetryStore();
  const live = { ...envelope(vectorMap.get('RX_A0_VALID')), streamId: 1 };
  dedupeStore.ingestLineRecord(live);
  dedupeStore.beginReplay();
  dedupeStore.ingestSessionEvent({
    type: 'serial_line',
    pcUtc: new Date().toISOString(),
    streamId: 1,
    rawLine: live.rawLine,
    classification: live.classification,
  });
  dedupeStore.endReplay();
  assert.equal(dedupeStore.totalPackets, 1);

  const store = new TelemetryStore();
  store.ingestLineRecord(envelope(vectorMap.get('RX_A0_VALID')));
  assert.equal(store.totalPackets, 1);
  assert.equal(store.state, 'CommandReceive');
  assert.equal(store.getLatestValue('airspeed').status, 'SSC_NOT_INITIALIZED');
  assert.equal(store.getLatestValue('airspeed').value, null);
  assert.equal(store.rssiDbm, -84);
  assert.equal(store.getLatestValue('controlRollReferenceUnwrapped'), null);
  const orientationStore = new TelemetryStore();
  orientationStore.ingestLineRecord(envelope(vectorMap.get('RX_A3_VALID')));
  assert.ok(orientationStore.getLatestValue('wrappedOrientation'));
  assert.ok(orientationStore.getLatestValue('roll'));
  assert.equal(orientationStore.getLatestValue('controlRollReferenceUnwrapped'), null);
  const controlVector = readControlRollVectors().find((vector) => vector.name === 'PLUS_380');
  store.ingestLineRecord(envelope(
    `@RX usb_v=1 seq=25 board_ms=1500 dt_ms=500 rssi_present=1 rssi_raw=172 rssi_dbm=-84 valid=1 header=0xA7 len=9 error=NONE raw=${controlVector.rawHex}`));
  assert.equal(store.state, 'CommandReceive');
  assert.equal(store.getLatestValue('controlRollReferenceUnwrapped').value, 0);
  assert.equal(store.getLatestValue('rollDeviationUnwrapped').value, 380);
  assert.equal(store.getLatestValue('correctiveRollErrorUnwrapped').value, -380);
  const invalidControlStore = new TelemetryStore();
  invalidControlStore.ingestLineRecord(envelope(
    `@RX usb_v=1 seq=25 board_ms=1500 dt_ms=NA rssi_present=0 rssi_raw=NA rssi_dbm=NA valid=1 header=0xA7 len=9 error=NONE raw=${controlVector.rawHex}`));
  invalidControlStore.ingestLineRecord(envelope(
    '@RX usb_v=1 seq=26 board_ms=2000 dt_ms=500 rssi_present=0 rssi_raw=NA rssi_dbm=NA valid=1 header=0xA7 len=9 error=NONE raw=A7010000F802051148'));
  assert.equal(invalidControlStore.appDecodeMismatches, 1);
  assert.equal(invalidControlStore.getLatestValue('rollDeviationUnwrapped').value, 380);
  const fallbackStore = new TelemetryStore();
  fallbackStore.ingestLineRecord(envelope(vectorMap.get('RX_A0_VALID')));
  fallbackStore.ingestLineRecord(envelope(
    '@RX usb_v=1 seq=26 board_ms=2000 dt_ms=500 rssi_present=1 rssi_raw=172 rssi_dbm=-84 valid=1 header=0xA8 len=24 error=NONE raw=A8010901132003060A00090008000C00F4FF2800B4BE01B8'));
  assert.equal(fallbackStore.state, 'CommandReceive');
  assert.equal(fallbackStore.communicationMode, 'MissionLinkFallback');
  const priorStatus = store.getLatestValue('commandStatusRaw').raw;
  const invalidWithDifferentRssi = vectorMap.get('RX_A0_BAD_CHECKSUM')
    .replace('rssi_raw=172 rssi_dbm=-84', 'rssi_raw=160 rssi_dbm=-96');
  store.ingestLineRecord(envelope(invalidWithDifferentRssi));
  assert.equal(store.invalidPackets, 1);
  assert.equal(store.getLatestValue('commandStatusRaw').raw, priorStatus);
  assert.equal(store.rssiDbm, -84);
  const mismatch = vectorMap.get('RX_A0_BAD_CHECKSUM')
    .replace('valid=0', 'valid=1')
    .replace('error=CHECKSUM', 'error=NONE');
  store.ingestLineRecord(envelope(mismatch));
  assert.equal(store.appDecodeMismatches, 1);
  assert.equal(store.packetMonitor.at(-1).appDecodeMismatch, true);
  store.ingestLineRecord(envelope(vectorMap.get('FRAG_RESYNC')));
  assert.equal(store.state, 'CommandReceive');
  store.ingestLineRecord(envelope(vectorMap.get('RX_A0_RSSI_ABSENT')));
  assert.equal(store.rssiDbm, null);

  const resetStore = new TelemetryStore();
  resetStore.ingestLineRecord(envelope(vectorMap.get('RX_A0_VALID')));
  const pending = resetStore.queueOutboundCommand('g 0x13');
  resetStore.ingestLineRecord(envelope(vectorMap.get('SYS_BOOT')));
  assert.equal(resetStore.state, 'UNKNOWN');
  assert.equal(resetStore.lastRxSequence, null);
  assert.equal(resetStore.getLatestValue('commandStatusRaw'), null);
  assert.equal(resetStore.commandTracker.findLocal(pending.localId).state, 'LOCAL_QUEUED');

  for (let index = 0; index < 1005; index += 1) {
    store.ingestLineRecord(envelope(`# line-${index}`));
  }
  assert.equal(store.packetMonitor.length, 1000);

  assert.equal(escapeHtml('<img/onerror=alert(1)>'), '&lt;img/onerror=alert(1)&gt;');

  const tracker = new OutboundCommandTracker(8);
  const generic = tracker.queue('g 0x13', 0);
  tracker.markUsbWritten(generic.localId, 1);
  assert.equal(tracker.applyTx({ kind: 0, id: 42, command: 0x13, ok: true }, 2).matched, true);
  assert.equal(generic.state, 'BOARD_TX_OK');
  assert.equal(tracker.applyCommandResult({ transactionId: 42, command: 0x13, phase: 0, reason: 0, detail: 0 }, 3000).matched, true);
  assert.equal(generic.state, 'ACCEPTED');
  assert.equal(tracker.applyCommandResult({ transactionId: 42, command: 0x14, phase: 2, reason: 12, detail: 0 }).matched, false);
  assert.equal(generic.state, 'ACCEPTED');
  const final = { transactionId: 42, command: 0x13, phase: 2, reason: 12, detail: 0 };
  assert.equal(tracker.applyCommandResult(final, 4000).duplicate, false);
  assert.equal(generic.state, 'FINAL');
  assert.equal(tracker.applyCommandResult(final, 5000).duplicate, true);
  assert.equal(tracker.applyCommandResult({ ...final, phase: 0, reason: 0, detail: 1 }, 5500).late, true);
  assert.equal(generic.state, 'FINAL');

  const emergency = tracker.queue('le', 6000);
  tracker.markUsbWritten(emergency.localId, 6001);
  tracker.applyTx({ kind: 2, id: 43, command: 0, ok: true }, 6002);
  assert.equal(tracker.applyCommandResult({ transactionId: 43, command: 0xF0, phase: 2, reason: 2, detail: 0 }).matched, false);
  assert.equal(tracker.applyCommandResult({ transactionId: 43, command: 0xF1, phase: 2, reason: 2, detail: 0 }).matched, true);

  const reused = tracker.queue('g 0x22', 7000);
  tracker.markUsbWritten(reused.localId, 7001);
  tracker.applyTx({ kind: 0, id: 42, command: 0x22, ok: true }, 7002);
  assert.equal(tracker.applyCommandResult(final, 7003).matched, false);
  assert.equal(reused.state, 'BOARD_TX_OK');

  const help = tracker.queue('help', 8000);
  tracker.markUsbWritten(help.localId, 8001);
  assert.equal(help.state, 'FINAL');
  const releaseTarget = tracker.queue('g 0x22', 8500);
  tracker.markUsbWritten(releaseTarget.localId, 8501);
  tracker.applyTx({ kind: 0, id: 44, command: 0x22, ok: true }, 8502);
  const release = tracker.queue('release 44', 9000);
  const releaseResult = tracker.applyTransactionRelease({ id: 44, ok: true }, 9002);
  assert.equal(releaseResult.matched, true);
  assert.equal(release.state, 'FINAL');
  assert.equal(releaseTarget.state, 'RESULT_UNKNOWN');
  assert.equal(tracker.applyCommandResult({ transactionId: 44, command: 0x22, phase: 2, reason: 12, detail: 0 }).matched, false);

  const failedReleaseTarget = tracker.queue('g 0x23', 9100);
  tracker.markUsbWritten(failedReleaseTarget.localId, 9101);
  tracker.applyTx({ kind: 0, id: 45, command: 0x23, ok: true }, 9102);
  const failedRelease = tracker.queue('release 45', 9200);
  assert.equal(tracker.applyTransactionRelease({ id: 45, ok: false }, 9201).matched, true);
  assert.equal(failedRelease.state, 'FINAL');
  assert.equal(failedReleaseTarget.state, 'BOARD_TX_OK');
}
