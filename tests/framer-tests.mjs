import assert from 'node:assert/strict';
import { UsbLineFramer } from '../shared/usb-line-framer.js';
import { readGoldenVectors } from './protocol-smoke.mjs';

function lines(events) {
  return events.filter((event) => event.type === 'line').map((event) => event.line);
}

export function runFramerTests() {
  const vector = readGoldenVectors().find((item) => item.name === 'RX_A0_VALID');
  const line = `${vector.record}\r\n`;

  const byteFramer = new UsbLineFramer();
  const byteEvents = [];
  for (const byte of Buffer.from(line)) byteEvents.push(...byteFramer.push(Buffer.from([byte])));
  assert.deepEqual(lines(byteEvents), [vector.record]);

  for (let split = 0; split <= line.length; split += 1) {
    const framer = new UsbLineFramer();
    const buffer = Buffer.from(line);
    const events = [
      ...framer.push(buffer.subarray(0, split)),
      ...framer.push(buffer.subarray(split)),
    ];
    assert.deepEqual(lines(events), [vector.record], `split=${split}`);
  }

  const multiple = new UsbLineFramer();
  assert.deepEqual(lines(multiple.push(Buffer.from(`a\nb\r\nc\n`))), ['a', 'b', 'c']);

  const partial = new UsbLineFramer();
  assert.deepEqual(partial.push(Buffer.from('abc')), []);
  assert.deepEqual(lines(partial.push(Buffer.from('def\n'))), ['abcdef']);
  assert.equal(partial.push(Buffer.from('partial')).length, 0);
  assert.deepEqual(partial.reset('DISCONNECT'), { type: 'reset', reason: 'DISCONNECT', discardedBytes: 7 });
  assert.deepEqual(lines(partial.push(Buffer.from('fresh\n'))), ['fresh']);

  const overflow = new UsbLineFramer(4);
  const overflowEvents = overflow.push(Buffer.from('abcde\nnext\n'));
  assert.equal(overflowEvents[0].code, 'LINE_TOO_LONG');
  assert.deepEqual(lines(overflowEvents), ['next']);

  const nonAscii = new UsbLineFramer();
  const nonAsciiEvents = nonAscii.push(Buffer.from([0x41, 0x80, 0x42, 0x0A, 0x43, 0x0A]));
  assert.equal(nonAsciiEvents[0].code, 'NON_ASCII');
  assert.deepEqual(lines(nonAsciiEvents), ['C']);
}
