import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GroundSerialService, validateCommandText } from '../electron/ground-serial-service.mjs';

class FakeSerialPort extends EventEmitter {
  static instances = [];

  static list() { return Promise.resolve([{ path: '/fake' }]); }

  constructor() {
    super();
    this.isOpen = false;
    FakeSerialPort.instances.push(this);
  }

  open(callback) {
    setTimeout(() => {
      this.isOpen = true;
      callback(null);
    }, 20);
  }

  close(callback) {
    this.isOpen = false;
    callback(null);
  }

  write(_bytes, callback) { callback(null); }
  drain(callback) { callback(null); }
  set(_lines, callback) { callback(null); }
}

const sessionWriter = {
  setPort() {},
  appendConnectionEvent() {},
  appendParserError() {},
  appendSerialChunk() {},
  appendSerialLine() {},
  appendCommand() {},
};

export async function runServiceTests() {
  assert.equal(validateCommandText('g 0x7F 1 2'), 'g 0x7F 1 2');
  assert.throws(() => validateCommandText('g 256'));
  assert.throws(() => validateCommandText('time 0 1 0'));
  assert.throws(() => validateCommandText('release nope'));
  assert.throws(() => validateCommandText('help extra'));

  const service = new GroundSerialService({
    sessionWriter,
    serialportLoader: async () => ({ SerialPort: FakeSerialPort }),
  });
  const first = service.connect('/fake');
  await assert.rejects(service.connect('/fake'), /already in progress/);
  await first;
  assert.equal(service.port.listenerCount('data'), 1);
  await service.disconnect('test');

  FakeSerialPort.instances.length = 0;
  const cancelledService = new GroundSerialService({
    sessionWriter,
    serialportLoader: async () => ({ SerialPort: FakeSerialPort }),
  });
  const cancelledConnect = cancelledService.connect('/fake');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await cancelledService.disconnect('user');
  await assert.rejects(cancelledConnect, /cancelled/);
  assert.equal(cancelledService.currentStatus().state, 'disconnected');
  assert.equal(cancelledService.port, null);
  assert.equal(FakeSerialPort.instances.length, 1);
  assert.equal(FakeSerialPort.instances[0].isOpen, false);
  assert.equal(FakeSerialPort.instances[0].listenerCount('data'), 0);
}
