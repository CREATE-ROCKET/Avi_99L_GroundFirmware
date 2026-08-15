import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GroundSerialService, validateCommandText } from '../electron/ground-serial-service.mjs';
import { readControlRollVectors } from './protocol-smoke.mjs';

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

const rollExports = [];
const sessionWriter = {
  setPort() {},
  appendConnectionEvent() {},
  appendParserError() {},
  appendSerialChunk() {},
  appendSerialLine() {},
  appendRollTelemetry(value) { rollExports.push(value); },
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

  rollExports.length = 0;
  const loggingService = new GroundSerialService({ sessionWriter });
  const vector = readControlRollVectors().find((item) => item.name === 'PLUS_380');
  loggingService.receiveChunk(Buffer.from(
    `@RX usb_v=1 seq=25 board_ms=1000 dt_ms=NA rssi_present=0 rssi_raw=NA rssi_dbm=NA valid=1 header=0xA7 len=9 error=NONE raw=${vector.rawHex}\n`));
  assert.equal(rollExports.length, 1);
  assert.equal(rollExports[0].wrappedOrientationDeg, null);
  assert.equal(rollExports[0].controlRollReferenceUnwrappedDeg, 0);
  assert.equal(rollExports[0].rollDeviationUnwrappedDeg, 380);
  assert.equal(rollExports[0].correctiveRollErrorUnwrappedDeg, -380);
  loggingService.receiveChunk(Buffer.from(
    '@RX usb_v=1 seq=26 board_ms=1500 dt_ms=500 rssi_present=0 rssi_raw=NA rssi_dbm=NA valid=1 header=0xA7 len=9 error=NONE raw=A7010000F802051148\n'));
  assert.equal(rollExports.length, 1);
}
