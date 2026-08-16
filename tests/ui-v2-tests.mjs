import assert from 'node:assert/strict';
import { classifyUsbLine } from '../shared/usb-v1.js';
import { TelemetryStore } from '../renderer/src/store-v2.js';
import { createScreenRenderer } from '../renderer/src/screens-v2.js';
import { buildCommand, isActionAvailable } from '../shared/command-catalog.js';
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
  assert.equal(store.attitudeSamples.length, 1);
  assert.equal(store.attitudeSamples.at(-1).roll, 30);
  assert.equal(store.getLatestValue('finMode').raw, 3);
  assert.equal(store.getLatestValue('finMode').value, 'ZeroHold');

  const commandTabs = createScreenRenderer({ store }).tabs('overview');
  assert.match(commandTabs, /OVERVIEW/);
  assert.match(commandTabs, /ACTUATORS/);
  assert.match(commandTabs, /SYSTEM/);
  assert.doesNotMatch(commandTabs, /CALIBRATION/);

  const commandOverview = createScreenRenderer({ store }).screen('overview');
  assert.match(commandOverview, /FIN ZERO/);
  assert.match(commandOverview, /Minimal MissionBoard/);
  assert.doesNotMatch(commandOverview, /PARA OPEN/);
  assert.doesNotMatch(commandOverview, /PARA CLOSE/);
  assert.doesNotMatch(commandOverview, /MOTOR PROFILE/);
  assert.doesNotMatch(commandOverview, /RUN PREFLIGHT CAL/);
  assert.doesNotMatch(commandOverview, /ACTUATOR EMERGENCY STOP/);
  assert.doesNotMatch(commandOverview, /SPACE HOLD/);
  assert.doesNotMatch(commandOverview, /data-command-tab="calibration"/);
  assert.match(commandOverview, /data-action="startSequence"/);
  assert.match(commandOverview, /data-action="finHold"/);
  assert.doesNotMatch(commandOverview, /data-action="finZeroHold"/);
  assert.match(commandOverview, /class="start-gate-summary" hidden/);

  const devDrawer = createScreenRenderer({ store, devMode: true }).developerDrawer(false);
  assert.doesNotMatch(devDrawer, /dev-console-form/);
  assert.doesNotMatch(devDrawer, /SEND RAW/);
  assert.match(devDrawer, /Raw command transmission is omitted/);

  const actuatorScreen = createScreenRenderer({ store }).screen('actuators');
  assert.match(actuatorScreen, /data-action="finFree"/);
  assert.match(actuatorScreen, /data-action="setFinZero"/);
  assert.match(actuatorScreen, /data-action="finHold"/);
  assert.match(actuatorScreen, /ZeroHold/);
  assert.doesNotMatch(actuatorScreen, /data-move-fin/);
  assert.doesNotMatch(actuatorScreen, /fin-relative/);
  assert.match(actuatorScreen, /data-action="paraOpen"/);
  assert.match(actuatorScreen, /data-action="paraClose"/);
  assert.doesNotMatch(actuatorScreen, /data-action="paraFree"/);
  assert.doesNotMatch(actuatorScreen, /data-action="paraHold"/);
  assert.doesNotMatch(actuatorScreen, /data-move-para/);
  assert.doesNotMatch(actuatorScreen, /data-set-para-absolute/);
  assert.doesNotMatch(actuatorScreen, /ACTUATOR EMERGENCY STOP/);

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
  assert.equal(store.attitudeSamples.length, 0);

  // One valid MissionStatus-bearing state packet immediately restores Normal.
  store.ingestLineRecord(envelope(vectors.get('RX_A1_VALID'), 2000));
  assert.equal(store.state, 'LiftoffDetection');
  assert.equal(store.communicationMode, 'Normal');
  assert.equal(store.lastKnownMissionState, 'LiftoffDetection');
  assert.equal(store.attitudeSamples.length, 1);

  // Ground board BOOT/reconnectで旧sessionの姿勢を残さない。
  const resetAttitudeStore = new TelemetryStore();
  resetAttitudeStore.ingestLineRecord(envelope(vectors.get('RX_A0_VALID'), 1000));
  assert.equal(resetAttitudeStore.attitudeSamples.length, 1);
  resetAttitudeStore.ingestLineRecord(envelope(vectors.get('SYS_BOOT'), 1100));
  assert.equal(resetAttitudeStore.attitudeSamples.length, 0);

  // RecoveryBeacon is a communication mode and must not become a MissionState.
  const recoveryStore = new TelemetryStore();
  recoveryStore.ingestLineRecord(envelope(vectors.get('RX_A4_VALID'), 1000));
  recoveryStore.ingestLineRecord(envelope(vectors.get('RX_A5_VALID'), 11000));
  assert.equal(recoveryStore.state, 'Descent');
  assert.equal(recoveryStore.communicationMode, 'RecoveryBeacon');
  assert.equal(recoveryStore.estimatedMissed, 0);
  assert.equal(recoveryStore.attitudeSamples.length, 0);

  assert.equal(buildCommand('startSequence'), 'g 0x01');
  assert.equal(buildCommand('finFree'), 'g 0x10');
  assert.equal(buildCommand('setFinZero'), 'g 0x11');
  assert.equal(buildCommand('finHold'), 'g 0x13');
  assert.equal(buildCommand('paraOpen'), 'g 0x25');
  assert.equal(buildCommand('paraClose'), 'g 0x26');
  for (const omitted of [
    'forceStartSequence', 'cancelSequence', 'disableFinControl', 'finZeroHold',
    'finMoveRelative', 'paraFree', 'paraHold', 'paraMoveRelative', 'setParaOpen',
    'setParaClose', 'runCalibration', 'exportFlash', 'enterRecovery', 'exitRecovery', 'actuatorEmergency',
  ]) {
    assert.throws(() => buildCommand(omitted), /unknown action/);
  }
  assert.equal(buildCommand('liftoffEmergency'), 'le');
  assert.equal(buildCommand('startLogging'), 'local 108');
  assert.equal(buildCommand('wakeMission'), 'local 119');
  assert.equal(isActionAvailable('startSequence', 'Control', 'Normal'), false);
  assert.equal(isActionAvailable('startSequence', 'CommandReceive', 'Normal'), true);
  assert.equal(isActionAvailable('actuatorEmergency', 'CommandReceive', 'Normal'), false);
  assert.equal(isActionAvailable('forceStartSequence', 'CommandReceive', 'Normal'), false);
  assert.equal(isActionAvailable('selectMotorProfile', 'CommandReceive', 'Normal'), false);
  assert.equal(isActionAvailable('wakeMission', 'Descent', 'Normal'), false);
  assert.equal(isActionAvailable('wakeMission', 'Descent', 'RecoveryBeacon'), true);
  assert.equal(isActionAvailable('exitRecovery', 'Descent', 'RecoveryBeacon'), false);
  assert.equal(isActionAvailable('exitRecovery', 'Descent', 'MissionLinkFallback'), false);
  assert.equal(isActionAvailable('dumpMissionSd', 'Control', 'MissionLinkFallback'), true);
  assert.throws(() => buildCommand('selectMotorProfile', { profile: 1 }), /unknown action/);
}
