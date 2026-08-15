import assert from 'node:assert/strict';
import { classifyUsbLine } from '../shared/usb-v1.js';
import { TelemetryStore } from '../renderer/src/store-v2.js';
import { buildCommand, encodeSignedTenths, isActionAvailable } from '../shared/command-catalog.js';
import { readGoldenVectors } from './protocol-smoke.mjs';

function envelope(line, hostUnixMs = Date.now()) {
  return { hostUnixMs, rawLine: line, classification: classifyUsbLine(line) };
}

export function runUiV2Tests() {
  const vectors = new Map(readGoldenVectors().map((vector) => [vector.name, vector.record]));
  const store = new TelemetryStore();
  store.ingestLineRecord(envelope(vectors.get('RX_A0_VALID'), 1000));
  assert.equal(store.state, 'CommandReceive');
  assert.equal(store.communicationMode, 'Normal');
  assert.equal(store.lastKnownMissionState, 'CommandReceive');

  // Current canonical A8 vector from the versioned protocol tests.
  store.ingestLineRecord(envelope(
    '@RX usb_v=1 seq=26 board_ms=2000 dt_ms=500 rssi_present=1 rssi_raw=172 rssi_dbm=-84 valid=1 header=0xA8 len=24 error=NONE raw=A8010901132003060A00090008000C00F4FF2800B4BE01B8', 1500));
  assert.equal(store.state, 'UNKNOWN');
  assert.equal(store.communicationMode, 'MissionLinkFallback');
  assert.equal(store.lastKnownMissionState, 'Control');
  assert.equal(store.getLatestValue('fallbackReason').value, 'MISSION_STATUS_TIMEOUT');
  assert.equal(store.getLatestValue('missionStatusAge').value, 1.0);
  assert.equal(store.getLatestValue('logicVoltage').status, 'LAST_KNOWN');
  assert.equal(typeof store.getLatestValue('Fallback status.bit4').value, 'boolean');

  // One valid MissionStatus-bearing state packet immediately restores Normal.
  store.ingestLineRecord(envelope(vectors.get('RX_A1_VALID'), 2000));
  assert.equal(store.state, 'LiftoffDetection');
  assert.equal(store.communicationMode, 'Normal');
  assert.equal(store.lastKnownMissionState, 'LiftoffDetection');

  // RecoveryBeacon is a communication mode and must not become a MissionState.
  const recoveryStore = new TelemetryStore();
  recoveryStore.ingestLineRecord(envelope(vectors.get('RX_A4_VALID'), 1000));
  recoveryStore.ingestLineRecord(envelope(vectors.get('RX_A5_VALID'), 11000));
  assert.equal(recoveryStore.state, 'Descent');
  assert.equal(recoveryStore.communicationMode, 'RecoveryBeacon');
  assert.equal(recoveryStore.estimatedMissed, 0);

  assert.deepEqual(encodeSignedTenths(-12.3), [0x85, 0xff]);
  assert.equal(buildCommand('startSequence'), 'g 0x01');
  assert.equal(buildCommand('forceStartSequence'), 'g 0x04');
  assert.equal(buildCommand('finMoveRelative', { angle: -12.3 }), 'g 0x13 0x85 0xff');
  assert.equal(buildCommand('paraMoveRelative', { angle: 17.5 }), 'g 0x22 0xaf 0x00');
  assert.equal(buildCommand('setParaOpen', { direction: 'CW' }), 'g 0x23 0x01');
  assert.equal(buildCommand('setParaClose', { direction: 'CCW' }), 'g 0x24 0xff');
  assert.equal(buildCommand('enterRecovery'), 'g 0x33');
  assert.equal(buildCommand('actuatorEmergency'), 'ae');
  assert.equal(buildCommand('liftoffEmergency'), 'le');
  assert.equal(buildCommand('startLogging'), 'local 108');
  assert.equal(buildCommand('wakeMission'), 'local 119');
  assert.equal(isActionAvailable('startSequence', 'Control', 'Normal'), false);
  assert.equal(isActionAvailable('forceStartSequence', 'CommandReceive', 'Normal'), true);
  assert.equal(isActionAvailable('forceStartSequence', 'EngineBurn', 'Normal'), false);
  assert.equal(isActionAvailable('forceStartSequence', 'CommandReceive', 'MissionLinkFallback'), false);
  assert.equal(isActionAvailable('wakeMission', 'Descent', 'Normal'), false);
  assert.equal(isActionAvailable('wakeMission', 'Descent', 'RecoveryBeacon'), true);
  assert.equal(isActionAvailable('dumpMissionSd', 'Control', 'MissionLinkFallback'), true);
  assert.throws(() => buildCommand('paraMoveRelative', { angle: 180 }), /< 180/);
  assert.throws(() => buildCommand('setParaOpen', { direction: undefined }), /CW or CCW/);
  assert.throws(() => buildCommand('setParaOpen', { direction: 'cw' }), /CW or CCW/);
  assert.throws(() => buildCommand('setParaClose', { direction: 'LEFT' }), /CW or CCW/);
}
