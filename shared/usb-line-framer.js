export const USB_V1_MAX_LINE_BYTES = 2048;

export class UsbLineFramer {
  constructor(maxLineBytes = USB_V1_MAX_LINE_BYTES) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new RangeError('maxLineBytes must be a positive integer');
    }
    this.maxLineBytes = maxLineBytes;
    this.buffer = Buffer.allocUnsafe(maxLineBytes);
    this.length = 0;
    this.discardReason = null;
    this.discardedBytes = 0;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    const events = [];
    for (const byte of chunk) {
      if (this.discardReason !== null) {
        this.discardedBytes += 1;
        if (byte === 0x0A) {
          events.push({
            type: 'error',
            code: this.discardReason,
            discardedBytes: this.discardedBytes,
          });
          this.discardReason = null;
          this.discardedBytes = 0;
        }
        continue;
      }

      if (byte === 0x0A) {
        const lineLength = this.length > 0 && this.buffer[this.length - 1] === 0x0D
          ? this.length - 1
          : this.length;
        const bytes = Buffer.from(this.buffer.subarray(0, lineLength));
        events.push({ type: 'line', line: bytes.toString('ascii'), bytes });
        this.length = 0;
        continue;
      }

      if (byte >= 0x80) {
        this.discardReason = 'NON_ASCII';
        this.discardedBytes = this.length + 1;
        this.length = 0;
        continue;
      }

      if (this.length === this.maxLineBytes) {
        this.discardReason = 'LINE_TOO_LONG';
        this.discardedBytes = this.length + 1;
        this.length = 0;
        continue;
      }

      this.buffer[this.length] = byte;
      this.length += 1;
    }
    return events;
  }

  reset(reason = 'RESET') {
    const discardedBytes = this.length + this.discardedBytes;
    this.length = 0;
    this.discardReason = null;
    this.discardedBytes = 0;
    return discardedBytes === 0 ? null : { type: 'reset', reason, discardedBytes };
  }
}
