/**
 * 99L LoRa application packet decoder.
 * Bit fields follow the Vault LSB-first compact packing convention.
 * The E220 fixed-transmission prefix and appended RSSI byte are outside these packets.
 */

export const PacketHeader = Object.freeze({
  COMMAND_RECEIVE: 0xA0,
  LIFTOFF_DETECTION: 0xA1,
  ENGINE_BURN: 0xA2,
  CONTROL: 0xA3,
  DESCENT: 0xA4,
  RECOVERY_BEACON: 0xA5,
  RECOVERY_LOG_DATA: 0xA6,
  COMBOARD_FALLBACK: 0xA7,
  COMMAND_RESULT: 0xB0,
  GROUND_TIME_REQUEST: 0xB1,
});

export const packetNames = Object.freeze({
  [PacketHeader.COMMAND_RECEIVE]: 'CommandReceive',
  [PacketHeader.LIFTOFF_DETECTION]: 'LiftoffDetection',
  [PacketHeader.ENGINE_BURN]: 'EngineBurn',
  [PacketHeader.CONTROL]: 'Control',
  [PacketHeader.DESCENT]: 'Descent',
  [PacketHeader.RECOVERY_BEACON]: 'RecoveryBeacon',
  [PacketHeader.RECOVERY_LOG_DATA]: 'RecoveryLogData',
  [PacketHeader.COMBOARD_FALLBACK]: 'ComBoardFallback',
  [PacketHeader.COMMAND_RESULT]: 'CommandResult',
  [PacketHeader.GROUND_TIME_REQUEST]: 'GroundTimeRequest',
});

export const expectedApplicationLengths = Object.freeze({
  [PacketHeader.COMMAND_RECEIVE]: 22,
  [PacketHeader.LIFTOFF_DETECTION]: 24,
  [PacketHeader.ENGINE_BURN]: 24,
  [PacketHeader.CONTROL]: 24,
  [PacketHeader.DESCENT]: 15,
  [PacketHeader.RECOVERY_BEACON]: 12,
  [PacketHeader.RECOVERY_LOG_DATA]: 24,
  [PacketHeader.COMMAND_RESULT]: 10,
  [PacketHeader.GROUND_TIME_REQUEST]: 3,
});

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.bit = 0;
  }

  read(width) {
    if (!Number.isInteger(width) || width < 0 || width > 32) throw new RangeError('invalid width');
    if (this.bit + width > this.bytes.length * 8) throw new RangeError('packet too short');
    let value = 0;
    for (let index = 0; index < width; index += 1) {
      const absolute = this.bit + index;
      const byte = this.bytes[absolute >> 3];
      const bit = (byte >> (absolute & 7)) & 1;
      value += bit * 2 ** index;
    }
    this.bit += width;
    return value >>> 0;
  }

  skip(width) {
    this.read(width);
  }

  alignByte() {
    const remainder = this.bit & 7;
    if (remainder !== 0) this.skip(8 - remainder);
  }
}

function signed(raw, width) {
  const signBit = 2 ** (width - 1);
  const full = 2 ** width;
  return raw >= signBit ? raw - full : raw;
}

function field(key, label, group, raw, value = null, unit = '', status = 'VALID') {
  return { key, label, group, raw, value, unit, status };
}

function semantic(raw, validMax, scale, offset, errors, width = null) {
  if (raw <= validMax) {
    const count = width ? signed(raw, width) : raw;
    return { value: offset + count * scale, status: 'VALID' };
  }
  return { value: null, status: errors[raw] ?? `RESERVED_0x${raw.toString(16).toUpperCase()}` };
}

function signedWithReserved(raw, width, reservedStart, reservedEnd, scale, errors) {
  if (raw >= reservedStart && raw <= reservedEnd) {
    return { value: null, status: errors[raw] ?? `RESERVED_0x${raw.toString(16).toUpperCase()}` };
  }
  return { value: signed(raw, width) * scale, status: 'VALID' };
}

const commonImuErrors = {
  0x8000: 'UNAVAILABLE', 0x8001: 'NOT_INITIALIZED', 0x8002: 'SPI_TIMEOUT',
  0x8003: 'SPI_ERROR', 0x8004: 'STALE_OR_NO_NEW_SAMPLE', 0x8005: 'FIFO_FULL',
  0x8006: 'FIFO_LOST_PACKET', 0x8007: 'FIFO_FORMAT_FAULT', 0x8008: 'SAMPLE_INVALID',
  0x8009: 'ODR_CHANGED', 0x800A: 'SATURATED_OR_OUT_OF_RANGE', 0x800B: 'TIMESTAMP_INVALID',
  0x800C: 'ATTITUDE_ESTIMATOR_INVALID', 0x800D: 'RESET_INVALIDATED',
  0x800E: 'INTERNAL_ERROR', 0x800F: 'UNKNOWN',
};

const finAngleErrors = {
  241: 'NOT_INITIALIZED', 242: 'SPI_TIMEOUT', 243: 'SPI_ERROR',
  244: 'RESPONSE_PARITY_ERROR', 245: 'SENSOR_PARITY_ERROR', 246: 'INVALID_COMMAND',
  247: 'FRAMING_ERROR', 248: 'PIPELINE_STATE_ERROR', 249: 'STALE',
  250: 'UNWRAP_AMBIGUOUS', 251: 'ZERO_NOT_CONFIGURED', 252: 'RESET_INVALIDATED',
  253: 'OUTPUT_ANGLE_INVALID', 254: 'OUT_OF_MECHANICAL_RANGE', 255: 'INTERNAL_OR_UNKNOWN',
};

const finRateErrors = {
  0x8000: 'UNAVAILABLE', 0x8001: 'SOURCE_ANGLE_ERROR', 0x8002: 'STALE',
  0x8003: 'NOT_ENOUGH_SAMPLES', 0x8004: 'UNWRAP_AMBIGUOUS', 0x8005: 'TIMESTAMP_INVALID',
  0x8006: 'ESTIMATOR_NOT_READY', 0x8007: 'ESTIMATOR_NUMERIC_ERROR',
  0x8008: 'OUT_OF_RANGE', 0x8009: 'RESET_INVALIDATED',
};

const pressureErrors = {
  2032: 'NOT_INITIALIZED', 2033: 'I2C_TIMEOUT_OR_NO_RESPONSE', 2034: 'I2C_BUS_ERROR',
  2035: 'DATA_NOT_READY', 2036: 'WHO_AM_I_MISMATCH', 2037: 'RESET_TIMEOUT',
  2038: 'PRESSURE_OVERRUN', 2039: 'STALE', 2040: 'POWERED_OFF',
  2041: 'BELOW_RANGE', 2042: 'ABOVE_RANGE', 2043: 'CONFIGURATION_ERROR',
  2044: 'INVALID_SAMPLE', 2045: 'INTERNAL_ERROR', 2046: 'UNKNOWN', 2047: 'UNAVAILABLE',
};

const temperatureErrors = {
  240: 'NOT_INITIALIZED', 241: 'I2C_TIMEOUT_OR_NO_RESPONSE', 242: 'I2C_BUS_ERROR',
  243: 'DATA_NOT_READY', 244: 'WHO_AM_I_MISMATCH', 245: 'RESET_TIMEOUT',
  246: 'TEMPERATURE_OVERRUN', 247: 'STALE', 248: 'POWERED_OFF',
  249: 'BELOW_RANGE', 250: 'ABOVE_RANGE', 251: 'CONFIGURATION_ERROR',
  252: 'INVALID_SAMPLE', 253: 'INTERNAL_ERROR', 254: 'UNKNOWN', 255: 'UNAVAILABLE',
};

const airspeedErrors = {
  246: 'BELOW_RANGE_OR_NEGATIVE_DIFFERENTIAL_PRESSURE', 247: 'ABOVE_RANGE',
  248: 'STATIC_PRESSURE_INVALID', 249: 'SSC_NOT_INITIALIZED', 250: 'SSC_I2C_TIMEOUT',
  251: 'SSC_I2C_ERROR', 252: 'SSC_STALE', 253: 'SSC_COMMAND_MODE',
  254: 'SSC_DIAGNOSTIC_FAULT', 255: 'AIRDATA_INTERNAL_INVALID',
};

const coordinateErrors = {
  0x8000: 'UNAVAILABLE', 0x8001: 'NO_FIX', 0x8002: 'STALE', 0x8003: 'OUT_OF_RANGE',
  0x8004: 'INVALID_SAMPLE', 0x8005: 'RECEIVER_ERROR', 0x8006: 'REFERENCE_INVALID',
  0x8007: 'INTERNAL_ERROR', 0x8008: 'UNKNOWN',
};

const heightErrors = {
  496: 'UNAVAILABLE', 497: 'NO_FIX', 498: 'STALE', 499: 'OUT_OF_RANGE',
  500: 'INVALID_SAMPLE', 501: 'RECEIVER_ERROR', 502: 'INTERNAL_ERROR', 503: 'UNKNOWN',
};

const paraErrors = {
  241: 'NOT_INITIALIZED', 242: 'UART_TIMEOUT', 243: 'UART_PROTOCOL_ERROR',
  244: 'DEVICE_ERROR_RESPONSE', 245: 'CONFIGURATION_INVALID', 246: 'WRONG_OPERATING_MODE',
  247: 'STALE', 248: 'POSITION_OUT_OF_RANGE', 249: 'POWERED_OFF',
  250: 'OPEN_COMMAND_FAILED', 251: 'RETRY_EXHAUSTED', 252: 'POSITION_INVALID',
  253: 'INTERNAL_ERROR', 254: 'UNKNOWN', 255: 'UNAVAILABLE',
};

const batteryErrors = { 253: 'STALE', 254: 'ADC_ERROR', 255: 'UNAVAILABLE' };

const flightStatusNames = [
  'LPS liftoff detected', 'ICM liftoff detected', 'ICM42688 alive', 'STS3215 alive',
  'Roll Control active', 'Logic source present', 'Motor source present', 'ComBoard microSD healthy',
  'Mission-ComBoard CAN healthy', 'ICM data loss/error', 'AS5047D error', 'AirData error',
  'Fin motor saturation', 'Fin Brake', 'Mission reset/recovery event', 'Control re-entry inhibited',
];

const commandStatusNames = [
  'ICM healthy', 'LPS healthy', 'SSC healthy', 'AS5047D healthy', 'STS3215 healthy',
  'Fin zero configured', 'Para open configured', 'Para close configured', 'Logic battery present',
  'Motor battery present', 'Mission SD healthy', 'ComBoard SD healthy', 'CAN healthy',
  'Persistence healthy', 'Fin busy', 'Para busy', 'Gyro bias valid', 'Gravity reference valid',
  'SSC zero valid', 'Flash backup has data', 'Flash backup healthy', 'Motor profile valid',
  'Fin control disabled', 'Calibration busy',
];

const descentStatusNames = [
  'LPS deployment condition', 'Elapsed deployment condition', null, null,
  'Deployment power cutoff done', 'ComBoard microSD healthy', 'Mission-ComBoard CAN healthy',
  'Deployment shock confirmed', 'STS overload', 'STS overcurrent', 'STS overtemperature',
  'STS encoder fault', 'STS voltage fault',
];

const finModeNames = ['Free / Hi-Z', 'HoldPosition', 'ZeroHold', 'MoveRelative', 'RollControl', 'Brake'];
const paraModeNames = ['Free', 'Hold', 'MoveRelative', 'MovingToOpen', 'MovingToClose', 'PoweredOff'];
const phaseNames = ['Accepted', 'Completed', 'Rejected', 'Failed'];
const reasonNames = [
  'None', 'Busy', 'InvalidState', 'InvalidArgument', 'NotConfigured', 'DeviceUnavailable',
  'Timeout', 'Stall', 'ProtocolError', 'InterruptedByEmergency', 'PersistenceError',
  'InternalError', 'NotSupported', 'SafetyInterlock', 'AlreadySatisfied',
];

function addStatusBits(fields, raw, names, group) {
  names.forEach((name, bit) => {
    if (!name) return;
    fields.push(field(`${group}.bit${bit}`, name, group, (raw >> bit) & 1, Boolean((raw >> bit) & 1), ''));
  });
}

function addSemantic(fields, key, label, group, raw, decoded, unit) {
  fields.push(field(key, label, group, raw, decoded.value, unit, decoded.status));
}

function decodeCommonPosition(reader, fields, group = 'Position') {
  const eastRaw = reader.read(16);
  const northRaw = reader.read(16);
  const heightRaw = reader.read(9);
  addSemantic(fields, 'east', 'GNSS East', group, eastRaw,
    signedWithReserved(eastRaw, 16, 0x8000, 0x800F, 1, coordinateErrors), 'm');
  addSemantic(fields, 'north', 'GNSS North', group, northRaw,
    signedWithReserved(northRaw, 16, 0x8000, 0x800F, 1, coordinateErrors), 'm');
  addSemantic(fields, 'height', 'GNSS absolute height', group, heightRaw,
    semantic(heightRaw, 495, 5, -100, heightErrors), 'm');
}

function decodeFlight(bytes, header) {
  const reader = new BitReader(bytes);
  const fields = [];
  reader.read(8);
  const status = reader.read(16);
  fields.push(field('flightStatusRaw', 'Flight status raw', 'Status', status, `0x${status.toString(16).padStart(4, '0').toUpperCase()}`));
  addStatusBits(fields, status, flightStatusNames, 'Flight status');

  const rollRaw = reader.read(16);
  const rollRateRaw = reader.read(16);
  addSemantic(fields, 'roll', 'Roll', 'Attitude', rollRaw,
    signedWithReserved(rollRaw, 16, 0x8000, 0x800F, 0.5, commonImuErrors), 'deg');
  addSemantic(fields, 'rollRate', 'Roll rate', 'Attitude', rollRateRaw,
    signedWithReserved(rollRateRaw, 16, 0x8000, 0x800F, 0.1, commonImuErrors), 'deg/s');

  const tiltRaw = reader.read(7);
  const tiltDirRaw = reader.read(9);
  addSemantic(fields, 'tilt', 'Tilt from vertical', 'Attitude', tiltRaw,
    semantic(tiltRaw, 120, 0.75, 0, {121:'UNAVAILABLE',122:'NOT_INITIALIZED',123:'STALE',124:'ESTIMATOR_INVALID',125:'RESET_INVALIDATED',126:'OUT_OF_RANGE',127:'UNKNOWN'}), 'deg');
  addSemantic(fields, 'tiltDirection', 'Tilt direction true', 'Attitude', tiltDirRaw,
    semantic(tiltDirRaw, 359, 1, 0, {}), 'deg');

  const finRaw = reader.read(8);
  const finRateRaw = reader.read(16);
  addSemantic(fields, 'finAngle', 'Fin angle', 'Fin', finRaw,
    semantic(finRaw, 240, 0.125, -15, finAngleErrors), 'deg');
  addSemantic(fields, 'finRate', 'Fin rate', 'Fin', finRateRaw,
    signedWithReserved(finRateRaw, 16, 0x8000, 0x800F, 0.02, finRateErrors), 'deg/s');

  const pressureRaw = reader.read(11);
  const tempRaw = reader.read(8);
  const airspeedRaw = reader.read(8);
  addSemantic(fields, 'pressure', 'LPS pressure', 'Air data', pressureRaw,
    semantic(pressureRaw, 2031, 0.2, 800, pressureErrors), 'hPa');
  addSemantic(fields, 'temperature', 'LPS temperature', 'Air data', tempRaw,
    semantic(tempRaw, 200, 1, -50, temperatureErrors), '°C');
  addSemantic(fields, 'airspeed', 'Airspeed', 'Air data', airspeedRaw,
    semantic(airspeedRaw, 245, 1, 0, airspeedErrors), 'm/s');

  const torqueRaw = reader.read(12);
  const torqueDecoded = torqueRaw >= 0x800 && torqueRaw <= 0x80F
    ? { value: null, status: ({0x800:'UNAVAILABLE',0x801:'CONTROLLER_INPUT_INVALID',0x802:'CONTROLLER_NUMERIC_ERROR',0x803:'RESET_INVALIDATED',0x804:'LIMIT_OR_SATURATION_CONFIG_INVALID',0x805:'INTERNAL_ERROR',0x806:'UNKNOWN',0x807:'STALE'})[torqueRaw] ?? 'RESERVED' }
    : { value: signed(torqueRaw, 12) * 0.002, status: 'TEMPORARY_SCALE' };
  addSemantic(fields, 'requestedTorque', 'Requested output torque', 'Control', torqueRaw, torqueDecoded, 'N·m');

  const elapsedRaw = reader.read(8);
  addSemantic(fields, 'flightElapsed', 'Flight elapsed', 'Time', elapsedRaw,
    elapsedRaw <= 0xEF ? {value: elapsedRaw * 0.1, status:'VALID'} : {value:null,status:`TIME_ERROR_0x${elapsedRaw.toString(16).toUpperCase()}`}, 's');

  decodeCommonPosition(reader, fields);
  reader.alignByte();
  const checksum = reader.read(8);
  fields.push(field('checksum', 'XOR checksum', 'Protocol', checksum, `0x${checksum.toString(16).padStart(2,'0').toUpperCase()}`));

  return {
    header,
    packetName: packetNames[header],
    missionState: packetNames[header],
    fields,
  };
}

function decodeCommandReceive(bytes) {
  const reader = new BitReader(bytes);
  const fields = [];
  reader.read(8);
  const status = reader.read(24);
  fields.push(field('commandStatusRaw', 'CommandReceive status raw', 'Status', status, `0x${status.toString(16).padStart(6,'0').toUpperCase()}`));
  addStatusBits(fields, status, commandStatusNames, 'Command status');

  const profile = reader.read(8);
  fields.push(field('motorProfile', 'Motor profile ID', 'Configuration', profile, profile));

  const tiltRaw = reader.read(7);
  const tiltDirRaw = reader.read(9);
  addSemantic(fields, 'tilt', 'Tilt from vertical', 'Attitude', tiltRaw,
    semantic(tiltRaw,120,0.75,0,{121:'UNAVAILABLE',122:'NOT_INITIALIZED',123:'STALE',124:'ESTIMATOR_INVALID',125:'RESET_INVALIDATED',126:'OUT_OF_RANGE',127:'UNKNOWN'}),'deg');
  addSemantic(fields, 'tiltDirection', 'Tilt direction true', 'Attitude', tiltDirRaw,
    semantic(tiltDirRaw,359,1,0,{}),'deg');

  const modes = reader.read(8);
  const finMode = modes & 0x0F;
  const paraMode = (modes >> 4) & 0x0F;
  fields.push(field('finMode', 'Fin mode', 'Modes', finMode, finModeNames[finMode] ?? 'Unknown'));
  fields.push(field('paraMode', 'Parachute mode', 'Modes', paraMode, paraModeNames[paraMode] ?? 'Unknown'));

  const finRaw = reader.read(8);
  const paraRaw = reader.read(8);
  addSemantic(fields, 'finAngle', 'Fin angle', 'Fin', finRaw,
    semantic(finRaw,240,0.125,-15,finAngleErrors),'deg');
  addSemantic(fields, 'paraAngle', 'Parachute angle', 'Parachute', paraRaw,
    semantic(paraRaw,240,1.5,0,paraErrors),'deg');

  const pressureRaw = reader.read(11);
  const tempRaw = reader.read(8);
  const airspeedRaw = reader.read(8);
  addSemantic(fields, 'pressure', 'LPS pressure', 'Air data', pressureRaw,
    semantic(pressureRaw,2031,0.2,800,pressureErrors),'hPa');
  addSemantic(fields, 'temperature', 'LPS temperature', 'Air data', tempRaw,
    semantic(tempRaw,200,1,-50,temperatureErrors),'°C');
  addSemantic(fields, 'airspeed', 'Airspeed', 'Air data', airspeedRaw,
    semantic(airspeedRaw,245,1,0,airspeedErrors),'m/s');

  const logicRaw = reader.read(8);
  const motorRaw = reader.read(8);
  addSemantic(fields, 'logicVoltage', 'Logic voltage', 'Power', logicRaw,
    semantic(logicRaw,240,0.05,0,batteryErrors),'V');
  addSemantic(fields, 'motorVoltage', 'Motor voltage', 'Power', motorRaw,
    semantic(motorRaw,240,0.05,0,batteryErrors),'V');

  decodeCommonPosition(reader, fields);
  reader.alignByte();
  const checksum = reader.read(8);
  fields.push(field('checksum', 'XOR checksum', 'Protocol', checksum, `0x${checksum.toString(16).padStart(2,'0').toUpperCase()}`));

  return { header: PacketHeader.COMMAND_RECEIVE, packetName: 'CommandReceive', missionState: 'CommandReceive', fields };
}

function decodeDescent(bytes) {
  const reader = new BitReader(bytes);
  const fields = [];
  reader.read(8);
  const status = reader.read(13);
  fields.push(field('descentStatusRaw', 'Descent status raw', 'Status', status, `0x${status.toString(16).padStart(4,'0').toUpperCase()}`));
  addStatusBits(fields, status, descentStatusNames, 'Descent status');
  const paraState = (status >> 2) & 0x03;
  fields.push(field('parachuteState', 'Parachute state', 'Parachute', paraState,
    ['Holding / not opened','Opening or retrying','Open confirmed','Open failed'][paraState]));

  const pressureRaw = reader.read(11);
  const tempRaw = reader.read(8);
  const paraRaw = reader.read(8);
  const elapsedRaw = reader.read(16);
  addSemantic(fields, 'pressure', 'LPS pressure', 'Air data', pressureRaw,
    semantic(pressureRaw,2031,0.2,800,pressureErrors),'hPa');
  addSemantic(fields, 'temperature', 'LPS temperature', 'Air data', tempRaw,
    semantic(tempRaw,200,1,-50,temperatureErrors),'°C');
  addSemantic(fields, 'paraAngle', 'Parachute angle', 'Parachute', paraRaw,
    semantic(paraRaw,240,1.5,0,paraErrors),'deg');
  addSemantic(fields, 'descentElapsed', 'Descent elapsed', 'Time', elapsedRaw,
    elapsedRaw <= 0xFFEF ? {value:elapsedRaw*0.1,status:'VALID'} : {value:null,status:`TIME_ERROR_0x${elapsedRaw.toString(16).toUpperCase()}`},'s');
  decodeCommonPosition(reader, fields);
  reader.alignByte();
  const checksum = reader.read(8);
  fields.push(field('checksum','XOR checksum','Protocol',checksum,`0x${checksum.toString(16).padStart(2,'0').toUpperCase()}`));
  return {header:PacketHeader.DESCENT,packetName:'Descent',missionState:'Descent',fields};
}

function decodeRecovery(bytes) {
  const reader = new BitReader(bytes);
  const fields = [];
  reader.read(8);
  const logicRaw = reader.read(8);
  const motorRaw = reader.read(8);
  addSemantic(fields,'logicVoltage','Logic voltage','Power',logicRaw,semantic(logicRaw,240,0.05,0,batteryErrors),'V');
  addSemantic(fields,'motorVoltage','Motor voltage','Power',motorRaw,semantic(motorRaw,240,0.05,0,batteryErrors),'V');
  decodeCommonPosition(reader, fields);
  const elapsedRaw = reader.read(16);
  addSemantic(fields,'recoveryElapsed','Recovery elapsed','Time',elapsedRaw,
    elapsedRaw <= 0xFFEF ? {value:elapsedRaw*10,status:'VALID'} : {value:null,status:`TIME_ERROR_0x${elapsedRaw.toString(16).toUpperCase()}`},'s');
  reader.alignByte();
  const checksum = reader.read(8);
  fields.push(field('checksum','XOR checksum','Protocol',checksum,`0x${checksum.toString(16).padStart(2,'0').toUpperCase()}`));
  return {header:PacketHeader.RECOVERY_BEACON,packetName:'RecoveryBeacon',missionState:'RecoveryBeacon',fields};
}

function decodeCommandResult(bytes) {
  const transactionId = bytes[1];
  const command = bytes[2];
  const phase = bytes[3];
  const reason = bytes[4];
  const detail = bytes[5] | (bytes[6]<<8) | (bytes[7]<<16) | (bytes[8]<<24);
  const checksum = bytes[9];
  const fields = [
    field('transactionId','Transaction ID','Command',transactionId,transactionId),
    field('command','Command code','Command',command,`0x${command.toString(16).padStart(2,'0').toUpperCase()}`),
    field('phase','Command phase','Command',phase,phaseNames[phase] ?? 'Unknown'),
    field('reason','Command reason','Command',reason,reasonNames[reason] ?? 'Unknown'),
    field('detail','Command detail','Command',detail>>>0,`0x${(detail>>>0).toString(16).padStart(8,'0').toUpperCase()}`),
    field('checksum','XOR checksum','Protocol',checksum,`0x${checksum.toString(16).padStart(2,'0').toUpperCase()}`),
  ];
  return {header:PacketHeader.COMMAND_RESULT,packetName:'CommandResult',missionState:null,fields};
}

function decodeGroundTimeRequest(bytes) {
  return {header:PacketHeader.GROUND_TIME_REQUEST,packetName:'GroundTimeRequest',missionState:null,fields:[
    field('requestId','Request ID','Time',bytes[1],bytes[1]),
    field('checksum','XOR checksum','Protocol',bytes[2],`0x${bytes[2].toString(16).padStart(2,'0').toUpperCase()}`),
  ]};
}

function decodeRecoveryLog(bytes) {
  const transferId = bytes[1];
  const meta = bytes[2];
  const offset = bytes[3] | (bytes[4]<<8) | (bytes[5]<<16);
  const dataLength = bytes[6];
  const data = bytes.slice(7, 23);
  return {header:PacketHeader.RECOVERY_LOG_DATA,packetName:'RecoveryLogData',missionState:null,fields:[
    field('transferId','Transfer ID','Recovery log',transferId,transferId),
    field('source','Source','Recovery log',meta&1,(meta&1)?'Mission microSD':'Internal Flash'),
    field('eof','EOF','Recovery log',(meta>>1)&1,Boolean((meta>>1)&1)),
    field('meta','Meta raw','Recovery log',meta,`0x${meta.toString(16).padStart(2,'0').toUpperCase()}`),
    field('offset','Offset','Recovery log',offset,offset,'byte'),
    field('dataLength','Data length','Recovery log',dataLength,dataLength,'byte'),
    field('data','Data','Recovery log',null,Array.from(data.slice(0,Math.min(dataLength,16)),v=>v.toString(16).padStart(2,'0')).join('').toUpperCase()),
    field('checksum','XOR checksum','Protocol',bytes[23],`0x${bytes[23].toString(16).padStart(2,'0').toUpperCase()}`),
  ]};
}

export function xorChecksumValid(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 2) return false;
  let xor = 0;
  for (let i = 0; i < bytes.length - 1; i += 1) xor ^= bytes[i];
  return xor === bytes[bytes.length - 1];
}

export function decodeApplicationPacket(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = Uint8Array.from(bytes);
  if (bytes.length === 0) throw new Error('empty packet');
  const header = bytes[0];
  const expected = expectedApplicationLengths[header];
  const lengthValid = expected === undefined || expected === bytes.length;
  const checksumValid = xorChecksumValid(bytes);

  let decoded;
  switch (header) {
    case PacketHeader.COMMAND_RECEIVE: decoded = decodeCommandReceive(bytes); break;
    case PacketHeader.LIFTOFF_DETECTION:
    case PacketHeader.ENGINE_BURN:
    case PacketHeader.CONTROL: decoded = decodeFlight(bytes, header); break;
    case PacketHeader.DESCENT: decoded = decodeDescent(bytes); break;
    case PacketHeader.RECOVERY_BEACON: decoded = decodeRecovery(bytes); break;
    case PacketHeader.RECOVERY_LOG_DATA: decoded = decodeRecoveryLog(bytes); break;
    case PacketHeader.COMMAND_RESULT: decoded = decodeCommandResult(bytes); break;
    case PacketHeader.GROUND_TIME_REQUEST: decoded = decodeGroundTimeRequest(bytes); break;
    default:
      decoded = {
        header,
        packetName: packetNames[header] ?? `Unknown_0x${header.toString(16).padStart(2,'0').toUpperCase()}`,
        missionState: header === PacketHeader.COMBOARD_FALLBACK ? 'ComBoardFallback' : null,
        fields: [],
      };
  }

  return {
    ...decoded,
    expectedLength: expected ?? null,
    actualLength: bytes.length,
    lengthValid,
    checksumValid,
    bytes,
  };
}

export function fieldMap(decoded) {
  return Object.fromEntries(decoded.fields.map((item) => [item.key, item]));
}
