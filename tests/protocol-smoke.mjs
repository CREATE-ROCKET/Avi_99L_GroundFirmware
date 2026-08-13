import assert from 'node:assert/strict';
import {
  PacketHeader,
  decodeApplicationPacket,
  expectedApplicationLengths,
} from '../shared/protocol.js';
import { parseUsbLine, bytesToHex } from '../shared/usb-line.js';

function validPacket(header, length) {
  const bytes = new Uint8Array(length);
  bytes[0] = header;
  let xor = 0;
  for (let i = 0; i < length - 1; i += 1) xor ^= bytes[i];
  bytes[length - 1] = xor;
  return bytes;
}

const expected = [
  [PacketHeader.COMMAND_RECEIVE, 'CommandReceive'],
  [PacketHeader.LIFTOFF_DETECTION, 'LiftoffDetection'],
  [PacketHeader.ENGINE_BURN, 'EngineBurn'],
  [PacketHeader.CONTROL, 'Control'],
  [PacketHeader.DESCENT, 'Descent'],
  [PacketHeader.RECOVERY_BEACON, 'RecoveryBeacon'],
  [PacketHeader.RECOVERY_LOG_DATA, 'RecoveryLogData'],
  [PacketHeader.COMMAND_RESULT, 'CommandResult'],
  [PacketHeader.GROUND_TIME_REQUEST, 'GroundTimeRequest'],
];

for (const [header, name] of expected) {
  const length = expectedApplicationLengths[header];
  const bytes = validPacket(header, length);
  const decoded = decodeApplicationPacket(bytes);
  assert.equal(decoded.packetName, name);
  assert.equal(decoded.actualLength, length);
  assert.equal(decoded.lengthValid, true);
  assert.equal(decoded.checksumValid, true);
  assert.ok(decoded.fields.length > 0);

  const line = `@RX usb_v=1 seq=1 board_ms=100 dt_ms=500 rssi_present=1 rssi_raw=172 rssi_dbm=-84 valid=1 header=0x${header.toString(16).toUpperCase()} len=${length} error=NONE raw=${bytesToHex(bytes)}`;
  const parsed = parseUsbLine(line);
  assert.equal(parsed.recordType, 'RX');
  assert.equal(parsed.fields.len, length);
  assert.equal(parsed.fields.rssi_dbm, -84);
}

const bad = validPacket(PacketHeader.CONTROL, expectedApplicationLengths[PacketHeader.CONTROL]);
bad[bad.length - 1] ^= 1;
assert.equal(decodeApplicationPacket(bad).checksumValid, false);

const frag = parseUsbLine('@FRAG usb_v=1 seq=7 board_ms=123 reason=UNKNOWN_HEADER len=2 raw=7F12');
assert.equal(frag.recordType, 'FRAG');
assert.equal(frag.fields.reason, 'UNKNOWN_HEADER');

console.log(`protocol smoke: ${expected.length} packet types passed`);
