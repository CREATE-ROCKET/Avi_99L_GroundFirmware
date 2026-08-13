/**
 * 99L Ground Station USB line protocol parser.
 * Machine-readable records start with '@'. Human-readable lines start with '#'.
 */

function parseScalar(value) {
  if (value === undefined) return undefined;
  if (value === 'NA') return null;
  if (/^-?0x[0-9a-f]+$/i.test(value)) {
    const sign = value.startsWith('-') ? -1 : 1;
    const body = value.replace(/^-?0x/i, '');
    return sign * Number.parseInt(body, 16);
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export function parseUsbLine(line, hostTime = new Date()) {
  const normalized = String(line ?? '').replace(/[\r\n]+$/, '');
  if (!normalized) return null;

  if (normalized.startsWith('#')) {
    return {
      kind: 'pretty',
      rawLine: normalized,
      text: normalized.slice(1).trim(),
      hostTime,
    };
  }

  if (!normalized.startsWith('@')) {
    return {
      kind: 'console',
      rawLine: normalized,
      text: normalized,
      hostTime,
    };
  }

  const tokens = normalized.trim().split(/\s+/);
  const recordType = tokens.shift().slice(1).toUpperCase();
  const fields = {};
  const malformed = [];

  for (const token of tokens) {
    const separator = token.indexOf('=');
    if (separator <= 0) {
      malformed.push(token);
      continue;
    }
    const key = token.slice(0, separator);
    const rawValue = token.slice(separator + 1);
    fields[key] = parseScalar(rawValue);
  }

  return {
    kind: 'machine',
    recordType,
    fields,
    malformed,
    rawLine: normalized,
    hostTime,
  };
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string') throw new TypeError('hex must be a string');
  const normalized = hex.replace(/^0x/i, '').replace(/[^0-9a-f]/gi, '');
  if (normalized.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}
