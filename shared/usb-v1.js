import { expectedApplicationLengths, xorChecksumValid } from './protocol.js';

export const USB_V1 = 1;

export const UsbV1ParseErrorCode = Object.freeze({
  UNKNOWN_RECORD: 'UNKNOWN_RECORD',
  MISSING_KEY: 'MISSING_KEY',
  DUPLICATE_KEY: 'DUPLICATE_KEY',
  INVALID_VALUE: 'INVALID_VALUE',
  INVALID_HEX: 'INVALID_HEX',
  LENGTH_MISMATCH: 'LENGTH_MISMATCH',
  HEADER_MISMATCH: 'HEADER_MISMATCH',
  RSSI_MISMATCH: 'RSSI_MISMATCH',
  VERSION_UNSUPPORTED: 'VERSION_UNSUPPORTED',
});

const RX_ERRORS = new Set([
  'NONE', 'CHECKSUM', 'INVALID_LENGTH', 'INVALID_PADDING',
  'INVALID_FIELD', 'INVALID_ENUM', 'DECODE_ERROR',
]);
const TX_ERRORS = new Set(['NONE', 'AUX_TIMEOUT', 'UART_WRITE', 'UART_FLUSH']);
const UPLINK_ABORT_ERRORS = new Set(['AUX_TIMEOUT', 'BOUNDARY_TIMEOUT']);
const FRAGMENT_REASONS = new Set([
  'UNKNOWN_HEADER', 'FRAME_TIMEOUT', 'FRAME_OVERFLOW', 'RESYNC',
]);
const TOKEN = /^[A-Z][A-Z0-9_]*$/;

class UsbV1ValidationError extends Error {
  constructor(code, message, key = null) {
    super(message);
    this.code = code;
    this.key = key;
  }
}

function invalid(code, message, key = null) {
  throw new UsbV1ValidationError(code, message, key);
}

export function parseKeyValueFields(tokens) {
  const fields = new Map();
  for (const token of tokens) {
    const separator = token.indexOf('=');
    if (separator <= 0 || separator === token.length - 1) {
      invalid(UsbV1ParseErrorCode.INVALID_VALUE, `invalid field: ${token}`);
    }
    const key = token.slice(0, separator);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      invalid(UsbV1ParseErrorCode.INVALID_VALUE, `invalid key: ${key}`, key);
    }
    if (fields.has(key)) {
      invalid(UsbV1ParseErrorCode.DUPLICATE_KEY, `duplicate key: ${key}`, key);
    }
    fields.set(key, token.slice(separator + 1));
  }
  return fields;
}

function required(fields, key) {
  if (!fields.has(key)) invalid(UsbV1ParseErrorCode.MISSING_KEY, `missing key: ${key}`, key);
  return fields.get(key);
}

export function parseUnsigned(value, maximum = Number.MAX_SAFE_INTEGER, key = 'value') {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    invalid(UsbV1ParseErrorCode.INVALID_VALUE, `${key} is not unsigned decimal`, key);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    invalid(UsbV1ParseErrorCode.INVALID_VALUE, `${key} is out of range`, key);
  }
  return parsed;
}

export function parseSigned(value, minimum, maximum, key = 'value') {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) {
    invalid(UsbV1ParseErrorCode.INVALID_VALUE, `${key} is not signed decimal`, key);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid(UsbV1ParseErrorCode.INVALID_VALUE, `${key} is out of range`, key);
  }
  return parsed;
}

export function parseHexBytes(value, key = 'raw', byteLength = null) {
  if (!/^(?:[0-9A-F]{2})*$/.test(value)) {
    invalid(UsbV1ParseErrorCode.INVALID_HEX, `${key} is not uppercase hexadecimal`, key);
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  if (byteLength !== null && bytes.length !== byteLength) {
    invalid(UsbV1ParseErrorCode.LENGTH_MISMATCH, `${key} length mismatch`, key);
  }
  return bytes;
}

function parseByteHex(value, key) {
  if (!/^0x[0-9A-F]{2}$/.test(value)) {
    invalid(UsbV1ParseErrorCode.INVALID_HEX, `${key} must be 0xHH`, key);
  }
  return Number.parseInt(value.slice(2), 16);
}

function parseBit(value, key) {
  const parsed = parseUnsigned(value, 1, key);
  return parsed === 1;
}

function parseToken(value, key) {
  if (!TOKEN.test(value)) invalid(UsbV1ParseErrorCode.INVALID_VALUE, `${key} is not a token`, key);
  return value;
}

function extrasFrom(fields, known) {
  const extras = {};
  for (const [key, value] of fields) {
    if (!known.has(key)) extras[key] = value;
  }
  return extras;
}

function common(fields) {
  const version = parseUnsigned(required(fields, 'usb_v'), 255, 'usb_v');
  if (version !== USB_V1) {
    invalid(UsbV1ParseErrorCode.VERSION_UNSUPPORTED, `unsupported usb_v=${version}`, 'usb_v');
  }
  return version;
}

export function validateRxRecord(fields) {
  const known = new Set([
    'usb_v', 'seq', 'board_ms', 'dt_ms', 'rssi_present', 'rssi_raw',
    'rssi_dbm', 'valid', 'header', 'len', 'error', 'raw',
  ]);
  const usbVersion = common(fields);
  const seq = parseUnsigned(required(fields, 'seq'), 0xFFFFFFFF, 'seq');
  const boardMs = parseUnsigned(required(fields, 'board_ms'), 0xFFFFFFFF, 'board_ms');
  const dtValue = required(fields, 'dt_ms');
  const dtMs = dtValue === 'NA' ? null : parseUnsigned(dtValue, 0xFFFFFFFF, 'dt_ms');
  const rssiPresent = parseBit(required(fields, 'rssi_present'), 'rssi_present');
  const rssiRawValue = required(fields, 'rssi_raw');
  const rssiDbmValue = required(fields, 'rssi_dbm');
  const rssiRaw = rssiRawValue === 'NA' ? null : parseUnsigned(rssiRawValue, 255, 'rssi_raw');
  const rssiDbm = rssiDbmValue === 'NA' ? null : parseSigned(rssiDbmValue, -256, -1, 'rssi_dbm');
  if (rssiPresent !== (rssiRaw !== null && rssiDbm !== null)) {
    invalid(UsbV1ParseErrorCode.RSSI_MISMATCH, 'RSSI presence mismatch', 'rssi_present');
  }
  if (rssiPresent && rssiDbm !== rssiRaw - 256) {
    invalid(UsbV1ParseErrorCode.RSSI_MISMATCH, 'RSSI value mismatch', 'rssi_dbm');
  }
  const valid = parseBit(required(fields, 'valid'), 'valid');
  const header = parseByteHex(required(fields, 'header'), 'header');
  if (expectedApplicationLengths[header] === undefined) {
    invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'unknown @RX header', 'header');
  }
  const len = parseUnsigned(required(fields, 'len'), 255, 'len');
  const error = required(fields, 'error');
  if (!RX_ERRORS.has(error)) invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'unknown @RX error', 'error');
  if (valid !== (error === 'NONE')) {
    invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'valid/error mismatch', 'error');
  }
  const rawHex = required(fields, 'raw');
  const rawBytes = parseHexBytes(rawHex, 'raw');
  if (rawBytes.length !== len) {
    invalid(UsbV1ParseErrorCode.LENGTH_MISMATCH, 'len/raw mismatch', 'len');
  }
  if (len !== expectedApplicationLengths[header]) {
    invalid(UsbV1ParseErrorCode.LENGTH_MISMATCH, 'header/len mismatch', 'len');
  }
  if (rawBytes.length === 0 || rawBytes[0] !== header) {
    invalid(UsbV1ParseErrorCode.HEADER_MISMATCH, 'header/raw mismatch', 'header');
  }
  return {
    type: 'RX', usbVersion, seq, boardMs, dtMs, rssiPresent, rssiRaw, rssiDbm,
    valid, header, len, error, rawHex, rawBytes: Array.from(rawBytes),
    extras: extrasFrom(fields, known),
  };
}

export function validateTxRecord(fields) {
  const known = new Set([
    'usb_v', 'board_ms', 'ok', 'kind', 'id', 'command', 'prefix', 'len', 'raw', 'error',
  ]);
  const usbVersion = common(fields);
  const boardMs = parseUnsigned(required(fields, 'board_ms'), 0xFFFFFFFF, 'board_ms');
  const ok = parseBit(required(fields, 'ok'), 'ok');
  const kind = parseUnsigned(required(fields, 'kind'), 4, 'kind');
  const id = parseUnsigned(required(fields, 'id'), 255, 'id');
  if (id === 0) invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'id must be nonzero', 'id');
  const command = parseByteHex(required(fields, 'command'), 'command');
  const prefix = required(fields, 'prefix');
  parseHexBytes(prefix, 'prefix', 3);
  const len = parseUnsigned(required(fields, 'len'), 255, 'len');
  if (len !== 11) invalid(UsbV1ParseErrorCode.LENGTH_MISMATCH, '@TX len must be 11', 'len');
  const rawHex = required(fields, 'raw');
  const rawBytes = parseHexBytes(rawHex, 'raw', len);
  if (rawBytes[0] !== 0x55) {
    invalid(UsbV1ParseErrorCode.HEADER_MISMATCH, '@TX raw header must be 0x55', 'raw');
  }
  if (rawBytes[1] !== kind || rawBytes[2] !== id || rawBytes[3] !== command) {
    invalid(UsbV1ParseErrorCode.HEADER_MISMATCH, '@TX fields/raw mismatch', 'raw');
  }
  if (!xorChecksumValid(rawBytes)) {
    invalid(UsbV1ParseErrorCode.INVALID_VALUE, '@TX XOR mismatch', 'raw');
  }
  const error = required(fields, 'error');
  if (!TX_ERRORS.has(error)) invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'unknown @TX error', 'error');
  if (ok !== (error === 'NONE')) {
    invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'ok/error mismatch', 'error');
  }
  return {
    type: 'TX', usbVersion, boardMs, ok, kind, id, command, prefix, len,
    rawHex, rawBytes: Array.from(rawBytes), error, extras: extrasFrom(fields, known),
  };
}

export function validateFragRecord(fields) {
  const known = new Set(['usb_v', 'seq', 'board_ms', 'reason', 'len', 'raw']);
  const usbVersion = common(fields);
  const seq = parseUnsigned(required(fields, 'seq'), 0xFFFFFFFF, 'seq');
  const boardMs = parseUnsigned(required(fields, 'board_ms'), 0xFFFFFFFF, 'board_ms');
  const reason = required(fields, 'reason');
  if (!FRAGMENT_REASONS.has(reason)) {
    invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'unknown fragment reason', 'reason');
  }
  const len = parseUnsigned(required(fields, 'len'), 255, 'len');
  const rawHex = required(fields, 'raw');
  const rawBytes = parseHexBytes(rawHex, 'raw');
  if (rawBytes.length !== len) {
    invalid(UsbV1ParseErrorCode.LENGTH_MISMATCH, 'len/raw mismatch', 'len');
  }
  return {
    type: 'FRAG', usbVersion, seq, boardMs, reason, len, rawHex,
    rawBytes: Array.from(rawBytes), extras: extrasFrom(fields, known),
  };
}

export function validateSysRecord(fields) {
  const baseKnown = new Set(['usb_v', 'board_ms', 'event']);
  const usbVersion = common(fields);
  const boardMs = parseUnsigned(required(fields, 'board_ms'), 0xFFFFFFFF, 'board_ms');
  const event = parseToken(required(fields, 'event'), 'event');
  const detail = {};
  if (event === 'QUEUE_OVERFLOW') {
    baseKnown.add('source');
    baseKnown.add('count');
    detail.source = parseToken(required(fields, 'source'), 'source');
    detail.count = parseUnsigned(required(fields, 'count'), 0xFFFFFFFF, 'count');
  } else if (event === 'TASK_INIT_FAILED') {
    baseKnown.add('task');
    baseKnown.add('error');
    detail.task = parseToken(required(fields, 'task'), 'task');
    detail.error = parseToken(required(fields, 'error'), 'error');
  } else if (event === 'TRANSACTION_RELEASE') {
    baseKnown.add('id');
    baseKnown.add('ok');
    detail.id = parseUnsigned(required(fields, 'id'), 255, 'id');
    detail.ok = parseBit(required(fields, 'ok'), 'ok');
  } else if (event === 'UPLINK_ABORTED') {
    for (const key of ['kind', 'id', 'command', 'error']) baseKnown.add(key);
    detail.kind = parseUnsigned(required(fields, 'kind'), 4, 'kind');
    detail.id = parseUnsigned(required(fields, 'id'), 255, 'id');
    if (detail.id === 0) {
      invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'id must be nonzero', 'id');
    }
    detail.command = parseByteHex(required(fields, 'command'), 'command');
    detail.error = parseToken(required(fields, 'error'), 'error');
    if (!UPLINK_ABORT_ERRORS.has(detail.error)) {
      invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'unknown uplink abort error', 'error');
    }
  }
  return {
    type: 'SYS', usbVersion, boardMs, event, ...detail,
    extras: extrasFrom(fields, baseKnown),
  };
}

const VALIDATORS = Object.freeze({
  RX: validateRxRecord,
  TX: validateTxRecord,
  FRAG: validateFragRecord,
  SYS: validateSysRecord,
});

export function parseUsbV1Line(line) {
  const rawLine = String(line ?? '').replace(/\r?\n$/, '');
  try {
    if (!/^[\x20-\x7E]+$/.test(rawLine)) {
      invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'line is not printable ASCII');
    }
    const tokens = rawLine.split(' ');
    const marker = tokens.shift();
    if (!/^@[A-Z]+$/.test(marker)) {
      invalid(UsbV1ParseErrorCode.UNKNOWN_RECORD, 'unknown record marker');
    }
    if (tokens.some((token) => token.length === 0)) {
      invalid(UsbV1ParseErrorCode.INVALID_VALUE, 'fields must use one ASCII space');
    }
    const type = marker.slice(1);
    const validator = VALIDATORS[type];
    if (!validator) invalid(UsbV1ParseErrorCode.UNKNOWN_RECORD, `unknown record: ${marker}`);
    const record = validator(parseKeyValueFields(tokens));
    return { ok: true, record: { ...record, rawLine } };
  } catch (error) {
    if (error instanceof UsbV1ValidationError) {
      return {
        ok: false,
        error: { code: error.code, message: error.message, key: error.key },
        rawLine,
      };
    }
    throw error;
  }
}

export function classifyUsbLine(line) {
  const rawLine = String(line ?? '').replace(/\r?\n$/, '');
  if (rawLine.startsWith('#')) {
    return { kind: 'pretty', rawLine, text: rawLine.slice(1).trim() };
  }
  if (rawLine.startsWith('@')) {
    const parsed = parseUsbV1Line(rawLine);
    return parsed.ok
      ? { kind: 'record', rawLine, record: parsed.record }
      : { kind: 'parser-error', rawLine, error: parsed.error };
  }
  return { kind: 'unclassified', rawLine };
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}
