import assert from 'node:assert/strict';
import {
  COMMAND_ACK_TIMEOUT_MS,
  OutboundCommandTracker,
  describeConsoleCommand,
} from '../shared/command-lifecycle.js';

function sentGeneric(command = 0x13) {
  const tracker = new OutboundCommandTracker();
  const entry = tracker.queue(`g 0x${command.toString(16).padStart(2, '0')}`, 1000);
  tracker.markUsbWritten(entry.localId, 1010);
  const tx = tracker.applyTx({ kind: 0, id: 42, command, ok: true }, 1100);
  assert.equal(tx.matched, true);
  return { tracker, entry };
}

export function runCommandAckTests() {
  assert.equal(COMMAND_ACK_TIMEOUT_MS, 3000);
  assert.equal(describeConsoleCommand('g 0x13').expectsAck, true);
  assert.equal(describeConsoleCommand('local 0x6c').expectsAck, false);
  assert.equal(describeConsoleCommand('ae').expectsAck, false);

  {
    const { tracker, entry } = sentGeneric();
    const accepted = tracker.applyCommandResult({
      transactionId: 42, command: 0x13, phase: 0, reason: 0, detail: 0,
    }, 1200);
    assert.equal(accepted.ack, true);
    assert.equal(entry.state, 'ACCEPTED');
    assert.equal(entry.acknowledgedAtMs, 1200);
    assert.equal(tracker.markAckTimeout(entry.localId, 4100), null);

    const completed = tracker.applyCommandResult({
      transactionId: 42, command: 0x13, phase: 1, reason: 0, detail: 0,
    }, 1300);
    assert.equal(completed.ackMissing, false);
    assert.equal(entry.state, 'FINAL');
  }

  {
    const { tracker, entry } = sentGeneric();
    const timedOut = tracker.markAckTimeout(entry.localId, 4100);
    assert.equal(timedOut, entry);
    assert.equal(entry.state, 'ACK_TIMEOUT');
    assert.equal(entry.ackTimeoutMs, 3000);
    assert.equal(tracker.byTransaction.get(42), entry, 'ACK timeout must not release the transaction');

    const lateAccepted = tracker.applyCommandResult({
      transactionId: 42, command: 0x13, phase: 0, reason: 0, detail: 0,
    }, 4300);
    assert.equal(lateAccepted.ack, true);
    assert.equal(lateAccepted.lateAck, true);
    assert.equal(entry.state, 'ACCEPTED');
  }

  {
    const { tracker, entry } = sentGeneric();
    const completed = tracker.applyCommandResult({
      transactionId: 42, command: 0x13, phase: 1, reason: 0, detail: 0,
    }, 1200);
    assert.equal(completed.ackMissing, true);
    assert.equal(entry.ackMissingTerminal, true);
    assert.equal(entry.state, 'FINAL');
  }

  {
    const { tracker, entry } = sentGeneric();
    const rejected = tracker.applyCommandResult({
      transactionId: 42, command: 0x13, phase: 2, reason: 2, detail: 0,
    }, 1200);
    assert.equal(rejected.ackMissing, true);
    assert.equal(entry.state, 'FINAL');
  }

  {
    const { tracker, entry } = sentGeneric();
    const invalidAck = tracker.applyCommandResult({
      transactionId: 42, command: 0x13, phase: 0, reason: 1, detail: 0,
    }, 1200);
    assert.equal(invalidAck.ackInvalid, true);
    assert.equal(entry.state, 'ACK_INVALID');
  }
}
