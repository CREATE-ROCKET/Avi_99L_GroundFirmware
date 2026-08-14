import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  decodeApplicationPacket,
  expectedApplicationLengths,
  fieldMap,
  PacketHeader,
} from '../shared/protocol.js';
import { parseUsbV1Line, UsbV1ParseErrorCode } from '../shared/usb-v1.js';

export function readGoldenVectors() {
  const content = fs.readFileSync(new URL('../testdata/99l_usb_v1_vectors.txt', import.meta.url), 'utf8');
  return content.split('\n').filter((line) => line && !line.startsWith('#')).map((line) => {
    const [name, delimiter, record] = line.split('|');
    return { name, delimiter, record };
  });
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
  return vectors.length;
}
