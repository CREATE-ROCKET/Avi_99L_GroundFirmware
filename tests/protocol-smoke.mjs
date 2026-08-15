import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONTROL_ROLL_TELEMETRY_V2_VAULT_SOURCE,
  decodeApplicationPacket,
  expectedApplicationLengths,
  fieldMap,
  PacketHeader,
  rollTelemetryExport,
  wrapOrientationDegrees,
} from '../shared/protocol.js';
import { parseUsbV1Line, UsbV1ParseErrorCode } from '../shared/usb-v1.js';

export function readGoldenVectors() {
  const content = fs.readFileSync(new URL('../testdata/99l_usb_v1_vectors.txt', import.meta.url), 'utf8');
  return content.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const [name, delimiter, record] = line.split('|');
    return { name, delimiter, record };
  });
}

export function readControlRollVectors() {
  const content = fs.readFileSync(
    new URL('../testdata/99l_control_roll_v2_vectors.txt', import.meta.url), 'utf8');
  return content.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const [name, rawHex, referenceCount, deviationCount, referenceStatus,
      deviationStatus, flagsHex, captureSequence] = line.split('|');
    return {
      name,
      rawHex,
      referenceCount: referenceCount === 'NA' ? null : Number(referenceCount),
      deviationCount: deviationCount === 'NA' ? null : Number(deviationCount),
      referenceStatus,
      deviationStatus,
      flags: Number(flagsHex),
      captureSequence: Number(captureSequence),
    };
  });
}

function bytesFromHex(hex) {
  return Uint8Array.from(hex.match(/../g).map((value) => Number.parseInt(value, 16)));
}

function withChecksum(bytes) {
  let checksum = 0;
  for (let index = 0; index < bytes.length - 1; index += 1) checksum ^= bytes[index];
  bytes[bytes.length - 1] = checksum;
  return bytes;
}

function expectError(line, code) {
  const result = parseUsbV1Line(line);
  assert.equal(result.ok, false, line);
  assert.equal(result.error.code, code, line);
}

export function runProtocolTests() {
  const vectors = readGoldenVectors();
  const parsed = new Map();
  for (const vector of vectors) {
    const result = parseUsbV1Line(vector.record);
    assert.equal(result.ok, true, `${vector.name}: ${result.error?.message}`);
    parsed.set(vector.name, result.record);
  }

  const packetNames = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B0', 'B1'];
  for (const suffix of packetNames) {
    const record = parsed.get(`RX_${suffix}_VALID`);
    assert.equal(record.type, 'RX');
    assert.equal(record.len, expectedApplicationLengths[record.header]);
    const decoded = decodeApplicationPacket(Uint8Array.from(record.rawBytes));
    assert.equal(decoded.lengthValid, true);
    assert.equal(decoded.checksumValid, true);
  }

  const a0 = fieldMap(decodeApplicationPacket(Uint8Array.from(parsed.get('RX_A0_VALID').rawBytes)));
  assert.equal(a0.commandStatusRaw.raw, 0xABCDEF);
  assert.equal(a0.motorProfile.raw, 3);
  assert.equal(a0.finMode.raw, 3);
  assert.equal(a0.paraMode.raw, 1);
  assert.equal(a0.airspeed.status, 'SSC_NOT_INITIALIZED');
  assert.equal(a0.east.status, 'NO_FIX');

  assert.equal(parsed.get('RX_A0_BAD_CHECKSUM').valid, false);
  assert.equal(parsed.get('RX_A0_RSSI_ABSENT').rssiRaw, null);
  assert.equal(parsed.get('SYS_UNKNOWN_EXTRA').extras.future, 'VALUE');
  assert.equal(parsed.get('RX_WRAP_BEFORE').seq, 0xFFFFFFFF);
  assert.equal(parsed.get('RX_WRAP_AFTER').seq, 0);

  const rx = vectors.find((vector) => vector.name === 'RX_A0_VALID').record;
  expectError(rx.replace(' seq=1 ', ' seq=1 seq=2 '), UsbV1ParseErrorCode.DUPLICATE_KEY);
  expectError(rx.replace(' seq=1', ''), UsbV1ParseErrorCode.MISSING_KEY);
  expectError(rx.replace('usb_v=1', 'usb_v=2'), UsbV1ParseErrorCode.VERSION_UNSUPPORTED);
  expectError(rx.replace('seq=1', 'seq=4294967296'), UsbV1ParseErrorCode.INVALID_VALUE);
  expectError(rx.replace('raw=A0', 'raw=a0'), UsbV1ParseErrorCode.INVALID_HEX);
  expectError(rx.replace('len=22', 'len=21'), UsbV1ParseErrorCode.LENGTH_MISMATCH);
  expectError(rx.replace('raw=A0', 'raw=A1'), UsbV1ParseErrorCode.HEADER_MISMATCH);
  expectError(rx.replace('rssi_dbm=-84', 'rssi_dbm=-85'), UsbV1ParseErrorCode.RSSI_MISMATCH);
  expectError(rx.replace('@RX', '@UNKNOWN'), UsbV1ParseErrorCode.UNKNOWN_RECORD);
  expectError(rx.replace('valid=1', 'valid=0'), UsbV1ParseErrorCode.INVALID_VALUE);
  expectError(rx.replace('error=NONE', 'error=OTHER'), UsbV1ParseErrorCode.INVALID_VALUE);

  const tx = vectors.find((vector) => vector.name === 'TX_SUCCESS').record;
  expectError(tx.replace('0000000016', '0000000017'), UsbV1ParseErrorCode.INVALID_VALUE);
  expectError(tx.replace('kind=0', 'kind=1'), UsbV1ParseErrorCode.HEADER_MISMATCH);
  expectError(tx.replace('command=0x13', 'command=0x14'), UsbV1ParseErrorCode.HEADER_MISMATCH);
  expectError(tx.replace('id=42', 'id=0'), UsbV1ParseErrorCode.INVALID_VALUE);

  assert.equal(decodeApplicationPacket(Uint8Array.from(parsed.get('RX_B0_VALID').rawBytes)).header,
    PacketHeader.COMMAND_RESULT);

  assert.equal(CONTROL_ROLL_TELEMETRY_V2_VAULT_SOURCE,
    '2a6fa974a9b7a50a9b9d574174262068e2e5b8bf');
  const controlVectors = readControlRollVectors();
  assert.equal(controlVectors.length, 9);
  for (const vector of controlVectors) {
    const bytes = bytesFromHex(vector.rawHex);
    const decoded = decodeApplicationPacket(bytes);
    assert.equal(decoded.header, PacketHeader.CONTROL_ROLL_TELEMETRY_V2, vector.name);
    assert.equal(decoded.actualLength, 9, vector.name);
    assert.equal(decoded.lengthValid, true, vector.name);
    assert.equal(decoded.checksumValid, true, vector.name);
    assert.equal(decoded.contractValid, true, vector.name);
    const fields = fieldMap(decoded);
    assert.equal(fields.controlRollReferenceUnwrapped.raw,
      bytes[2] | (bytes[3] << 8), vector.name);
    assert.equal(fields.rollDeviationUnwrapped.raw,
      bytes[4] | (bytes[5] << 8), vector.name);
    assert.equal(fields.controlRollReferenceUnwrapped.status, vector.referenceStatus, vector.name);
    assert.equal(fields.rollDeviationUnwrapped.status, vector.deviationStatus, vector.name);
    assert.equal(fields.controlRollReferenceUnwrapped.value,
      vector.referenceCount === null ? null : vector.referenceCount * 0.5, vector.name);
    assert.equal(fields.rollDeviationUnwrapped.value,
      vector.deviationCount === null ? null : vector.deviationCount * 0.5, vector.name);
    assert.equal(fields.controlRollFlagsRaw.raw, vector.flags, vector.name);
    assert.equal(fields.controlRollCaptureEventSequence.value, vector.captureSequence, vector.name);

    const rxLine = `@RX usb_v=1 seq=25 board_ms=1000 dt_ms=NA rssi_present=0 rssi_raw=NA rssi_dbm=NA valid=1 header=0xA7 len=9 error=NONE raw=${vector.rawHex}`;
    const parsedControl = parseUsbV1Line(rxLine);
    assert.equal(parsedControl.ok, true, vector.name);
  }

  const plus380 = decodeApplicationPacket(bytesFromHex(
    controlVectors.find((vector) => vector.name === 'PLUS_380').rawHex));
  const plus380Fields = fieldMap(plus380);
  assert.equal(plus380Fields.rollDeviationUnwrapped.value, 380);
  assert.equal(plus380Fields.correctiveRollErrorUnwrapped.value, -380);
  assert.equal(rollTelemetryExport(plus380, 25).rollDeviationUnwrappedDeg, 380);
  assert.equal(wrapOrientationDegrees(380), 20);
  assert.notEqual(plus380Fields.rollDeviationUnwrapped.value, wrapOrientationDegrees(380));

  const a3Fields = fieldMap(decodeApplicationPacket(
    Uint8Array.from(parsed.get('RX_A3_VALID').rawBytes)));
  assert.ok(a3Fields.roll);
  assert.ok(a3Fields.wrappedOrientation);
  assert.equal(a3Fields.controlRollReferenceUnwrapped, undefined);
  assert.equal(a3Fields.rollDeviationUnwrapped, undefined);

  const malformedSchema = bytesFromHex(controlVectors[0].rawHex);
  malformedSchema[1] = 1;
  assert.equal(decodeApplicationPacket(withChecksum(malformedSchema)).contractValid, false);
  const malformedFlags = bytesFromHex(controlVectors[0].rawHex);
  malformedFlags[6] |= 0x20;
  assert.equal(decodeApplicationPacket(withChecksum(malformedFlags)).contractValid, false);
  const rangeMismatch = bytesFromHex(
    controlVectors.find((vector) => vector.name === 'OUT_OF_RANGE').rawHex);
  rangeMismatch[6] = 0;
  assert.equal(decodeApplicationPacket(withChecksum(rangeMismatch)).contractValid, false);

  const fallback = withChecksum(Uint8Array.from([
    0xA8, 1, 9, 1, 0x13, 0x20, 3, 6, 10, 0, 9, 0, 8, 0,
    12, 0, 0xF4, 0xFF, 40, 0, 180, 190, 1, 0,
  ]));
  const fallbackDecoded = decodeApplicationPacket(fallback);
  assert.equal(fallbackDecoded.packetName, 'MissionLinkFallbackTelemetry');
  assert.equal(fallbackDecoded.missionState, null);
  assert.equal(fallbackDecoded.communicationMode, 'MissionLinkFallback');
  assert.equal(fallbackDecoded.contractValid, true);
  assert.equal(PacketHeader.COMBOARD_FALLBACK, undefined);
  assert.equal(expectedApplicationLengths[PacketHeader.CONTROL_ROLL_TELEMETRY_V2], 9);
  assert.equal(expectedApplicationLengths[PacketHeader.MISSION_LINK_FALLBACK_TELEMETRY], 24);
  return vectors.length + controlVectors.length;
}
