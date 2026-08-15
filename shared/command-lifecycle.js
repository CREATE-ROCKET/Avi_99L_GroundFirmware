function byte(value) {
  if (!/^(?:0x[0-9A-Fa-f]{1,2}|[0-9]{1,3})$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : null;
}

export function describeConsoleCommand(text) {
  const tokens = String(text ?? '').trim().split(/\s+/);
  if (tokens[0] === 'g' || tokens[0] === 'local') {
    const command = byte(tokens[1]);
    if (command === null) return null;
    return {
      kind: tokens[0] === 'g' ? 0 : 3,
      command,
      expectedResultCommand: command,
      expectsTx: true,
      expectsResult: true,
    };
  }
  if (tokens[0] === 'ae') {
    return { kind: 1, command: 0, expectedResultCommand: 0xF0, expectsTx: true, expectsResult: true };
  }
  if (tokens[0] === 'le') {
    return { kind: 2, command: 0, expectedResultCommand: 0xF1, expectsTx: true, expectsResult: true };
  }
  if (tokens[0] === 'time') {
    const requestId = byte(tokens[1]);
    if (requestId === null || requestId === 0) return null;
    return { kind: 4, command: 2, expectedId: requestId, expectsTx: true, expectsResult: false };
  }
  if (tokens[0] === 'release') return { expectsTx: false, releaseId: byte(tokens[1]) };
  if (tokens[0] === 'help') return { expectsTx: false };
  return null;
}

export class OutboundCommandTracker {
  constructor(limit = 64) {
    this.limit = limit;
    this.nextLocalId = 1;
    this.commands = [];
    this.byTransaction = new Map();
  }

  queue(text, atMs = Date.now(), forcedLocalId = null) {
    const description = describeConsoleCommand(text);
    const entry = {
      localId: forcedLocalId ?? this.nextLocalId,
      text,
      description,
      state: 'LOCAL_QUEUED',
      queuedAtMs: atMs,
      transactionId: null,
      results: [],
    };
    if (forcedLocalId === null) {
      this.nextLocalId = this.nextLocalId === 0xFFFFFFFF ? 1 : this.nextLocalId + 1;
    } else if (forcedLocalId >= this.nextLocalId) {
      this.nextLocalId = forcedLocalId === 0xFFFFFFFF ? 1 : forcedLocalId + 1;
    }
    if (this.commands.length >= this.limit) {
      const removable = this.commands.findIndex((candidate) =>
        ['USB_WRITE_FAILED', 'BOARD_TX_FAILED', 'FINAL', 'RESULT_UNKNOWN'].includes(candidate.state));
      if (removable < 0) throw new Error('outbound command tracker is full');
      const [removed] = this.commands.splice(removable, 1);
      if (removed.transactionId !== null) this.byTransaction.delete(removed.transactionId);
    }
    this.commands.push(entry);
    return entry;
  }

  findLocal(localId) {
    return this.commands.find((entry) => entry.localId === localId) ?? null;
  }

  markUsbWritten(localId, atMs = Date.now()) {
    const entry = this.findLocal(localId);
    if (!entry) return null;
    if (entry.state === 'LOCAL_QUEUED') {
      entry.state = entry.description?.expectsTx === false && entry.description.releaseId === undefined
        ? 'FINAL'
        : 'USB_WRITTEN';
    }
    entry.usbWrittenAtMs = atMs;
    return entry;
  }

  markUsbWriteFailed(localId, error, atMs = Date.now()) {
    const entry = this.findLocal(localId);
    if (!entry) return null;
    if (entry.state !== 'BOARD_TX_OK' && entry.state !== 'ACCEPTED' && entry.state !== 'FINAL') {
      entry.state = 'USB_WRITE_FAILED';
    }
    entry.usbWriteFailedAtMs = atMs;
    entry.error = error;
    return entry;
  }

  adoptLocalId(localId, transportLocalId) {
    const entry = this.findLocal(localId);
    if (!entry) return null;
    if (this.commands.some((candidate) => candidate !== entry && candidate.localId === transportLocalId)) {
      throw new Error('duplicate transport local ID');
    }
    entry.localId = transportLocalId;
    if (transportLocalId >= this.nextLocalId) {
      this.nextLocalId = transportLocalId === 0xFFFFFFFF ? 1 : transportLocalId + 1;
    }
    return entry;
  }

  applyTx(record, atMs = Date.now()) {
    const entry = this.commands.find((candidate) => {
      const description = candidate.description;
      return (candidate.state === 'USB_WRITTEN' || candidate.state === 'LOCAL_QUEUED')
        && description?.expectsTx
        && description.kind === record.kind
        && description.command === record.command
        && (description.expectedId === undefined || description.expectedId === record.id);
    });
    if (!entry) return { matched: false, record };
    entry.transactionId = record.id;
    entry.txAtMs = atMs;
    entry.txRecord = record;
    entry.state = record.ok ? 'BOARD_TX_OK' : 'BOARD_TX_FAILED';
    if (record.ok && entry.description.expectsResult) this.byTransaction.set(record.id, entry);
    return { matched: true, entry };
  }

  applyUplinkAborted(record, atMs = Date.now()) {
    const entry = this.commands.find((candidate) => {
      const description = candidate.description;
      return (candidate.state === 'USB_WRITTEN' || candidate.state === 'LOCAL_QUEUED')
        && description?.expectsTx
        && description.kind === record.kind
        && description.command === record.command
        && (description.expectedId === undefined || description.expectedId === record.id);
    });
    if (!entry) return { matched: false, record };
    entry.transactionId = record.id;
    entry.abortedAtMs = atMs;
    entry.abortRecord = record;
    entry.error = record.error;
    entry.state = 'BOARD_TX_FAILED';
    entry.finalAtMs = atMs;
    // UARTへ書いていないため、CommandResult待ちのMapには登録しない。
    return { matched: true, entry };
  }

  applyCommandResult(result, atMs = Date.now()) {
    const entry = this.byTransaction.get(result.transactionId);
    if (!entry || entry.description.expectedResultCommand !== result.command) {
      return { matched: false, result };
    }
    const signature = `${result.phase}:${result.reason}:${result.detail}`;
    if (entry.results.some((item) => item.signature === signature)) {
      return { matched: true, duplicate: true, entry };
    }
    if (entry.state === 'FINAL') {
      entry.results.push({ ...result, signature, atMs, late: true });
      return { matched: true, duplicate: false, late: true, entry };
    }
    entry.results.push({ ...result, signature, atMs });
    if (result.phase === 0) entry.state = 'ACCEPTED';
    else {
      entry.state = 'FINAL';
      entry.finalAtMs = atMs;
    }
    return { matched: true, duplicate: false, entry };
  }

  applyTransactionRelease(record, atMs = Date.now()) {
    const entry = this.commands.find((candidate) =>
      (candidate.state === 'LOCAL_QUEUED' || candidate.state === 'USB_WRITTEN')
      && candidate.description?.releaseId === record.id);
    if (!entry) return { matched: false, record };
    entry.state = 'FINAL';
    entry.releaseOk = record.ok;
    entry.finalAtMs = atMs;
    const released = this.byTransaction.get(record.id) ?? null;
    if (record.ok && released) {
      released.state = 'RESULT_UNKNOWN';
      released.releasedAtMs = atMs;
      this.byTransaction.delete(record.id);
    }
    return { matched: true, entry, released };
  }
}
