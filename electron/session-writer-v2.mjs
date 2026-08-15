import { SessionWriter as BaseSessionWriter } from './session-writer.mjs';

// The original 4096-event replay window is too short for long CommandReceive waits.
// Keep several hours of 2 Hz telemetry available in Main-process RAM so a Renderer
// reload can reconstruct startup-to-current power history without touching disk.
const DEFAULT_V2_REPLAY_LIMIT = 100000;

export class SessionWriter extends BaseSessionWriter {
  constructor(options) {
    super({ ...options, replayLimit: options?.replayLimit ?? DEFAULT_V2_REPLAY_LIMIT });
  }
}
