# Command ACK lifecycle

Mission generic command (`g ...`) is not considered acknowledged when the GUI finishes writing the console line or when the Ground Board reports `@TX ok=1`.

The ACK is the matching valid B0 `CommandResult` with:

```text
phase=Accepted
reason=None
```

The GUI starts a 3000 ms timer when the matching `@TX ok=1` is received.

- `Accepted / None` before the deadline stops the timer.
- no ACK by 3000 ms produces `COMMAND ACK TIMEOUT` and a visible error dialog.
- `Rejected` is an immediate error and does not wait for the timeout.
- `Failed` is an error; if no prior Accepted was observed, it is also marked `ACK MISSING`.
- `Completed` without a prior Accepted is retained as a terminal success result but is shown as `COMMAND COMPLETED / ACK MISSING`.
- `Accepted` with a non-None reason is an invalid ACK/protocol error.

ACK timeout does not release the transaction ID and does not automatically retry the command. A late B0 is still correlated to the pending transaction. This avoids duplicate execution when only the downlink ACK was lost.

Emergency (`ae`, `le`) and ComBoard local commands do not use this generic ACK rule because their current contracts may return a terminal result directly.

The normative system contract is `Natsu-B/Vault/CREATE/99L Ground Station/03_Command ACK lifecycle.md`.
