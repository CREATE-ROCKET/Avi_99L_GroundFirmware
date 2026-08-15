import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  decodeApplicationPacket,
  PacketHeader,
} from '../shared/protocol.js';

function loadSharedVectors() {
  const content = fs.readFileSync(
    new URL('../testdata/99l_protocol_golden_vectors.txt', import.meta.url),
    'utf8',
  );
  const vectors = new Map();
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    assert.notEqual(separator, -1, line);
    vectors.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return vectors;
}

function bytesFromHex(hex) {
  assert.equal(hex.length % 2, 0);
  return Uint8Array.from(hex.match(/../g).map((value) => Number.parseInt(value, 16)));
}

function decodeLoRaVector(vectors, name) {
  const bytes = bytesFromHex(vectors.get(name));
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0x00, 0x00, 0x04], name);
  return decodeApplicationPacket(bytes.slice(3));
}

export function runSharedWireGoldenTests() {
  const vectors = loadSharedVectors();

  const controlRoll = decodeLoRaVector(vectors, 'LORA_CONTROL_ROLL_V2');
  assert.equal(controlRoll.header, PacketHeader.CONTROL_ROLL_TELEMETRY_V2);
  assert.equal(controlRoll.lengthValid, true);
  assert.equal(controlRoll.checksumValid, true);
  assert.equal(controlRoll.contractValid, true);

  const fallback = decodeLoRaVector(vectors, 'LORA_MISSION_LINK_FALLBACK');
  assert.equal(fallback.header, PacketHeader.MISSION_LINK_FALLBACK_TELEMETRY);
  assert.equal(fallback.lengthValid, true);
  assert.equal(fallback.checksumValid, true);
  assert.equal(fallback.contractValid, true);
  assert.equal(fallback.missionState, null);
  assert.equal(fallback.communicationMode, 'MissionLinkFallback');
}
