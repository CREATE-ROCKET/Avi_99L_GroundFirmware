export const GenericCommand = Object.freeze({
  START_SEQUENCE: 0x01,
  CANCEL_SEQUENCE: 0x02,
  FIN_FREE: 0x10,
  SET_FIN_ZERO: 0x11,
  FIN_HOLD: 0x13,
  PARA_OPEN: 0x25,
  PARA_CLOSE: 0x26,
});

export const LocalCommand = Object.freeze({
  START_LOGGING: 'l'.charCodeAt(0),
  STOP_LOGGING: 'm'.charCodeAt(0),
  GNSS_ON: 'g'.charCodeAt(0),
  GNSS_OFF: 'h'.charCodeAt(0),
  WAKE_MISSION: 'w'.charCodeAt(0),
  DUMP_INTERNAL_FLASH: 'f'.charCodeAt(0),
  DUMP_MISSION_SD: 's'.charCodeAt(0),
  STOP_LOG_DUMP: 'x'.charCodeAt(0),
});

export const ACTIONS = Object.freeze({
  startSequence: { label: 'StartSequence', states: ['CommandReceive'] },
  cancelSequence: { label: 'CancelSequence', states: ['LiftoffDetection'] },
  finFree: { label: 'FinFree', states: ['CommandReceive'] },
  setFinZero: { label: 'FinZero', states: ['CommandReceive'] },
  finHold: { label: 'FinHold', states: ['CommandReceive'] },
  paraOpen: { label: 'ParaOpen', states: ['CommandReceive'] },
  paraClose: { label: 'ParaClose', states: ['CommandReceive'] },
  liftoffEmergency: { label: 'LiftoffDetectionEmergencyStop', states: ['EngineBurn'], emergency: true },
  startLogging: { label: 'ComBoard StartLogging', local: true },
  stopLogging: { label: 'ComBoard StopLogging', local: true },
  gnssOn: { label: 'ComBoard GNSS On', local: true },
  gnssOff: { label: 'ComBoard GNSS Off', local: true },
  wakeMission: { label: 'ComBoard Wake Mission', local: true, communicationModes: ['RecoveryBeacon', 'MissionLinkFallback'] },
  dumpInternalFlash: { label: 'ComBoard Dump Internal Flash', local: true, communicationModes: ['RecoveryBeacon', 'MissionLinkFallback'] },
  dumpMissionSd: { label: 'ComBoard Dump Mission SD', local: true, communicationModes: ['RecoveryBeacon', 'MissionLinkFallback'] },
  stopLogDump: { label: 'ComBoard Stop Log Dump', local: true, communicationModes: ['RecoveryBeacon', 'MissionLinkFallback'] },
});

function byte(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xFF) throw new RangeError('argument byte out of range');
  return value;
}

function generic(code, args = []) {
  return ['g', `0x${byte(code).toString(16).padStart(2, '0')}`, ...args.map((v) => `0x${byte(v).toString(16).padStart(2, '0')}`)].join(' ');
}

function local(code, args = []) {
  return ['local', byte(code), ...args.map(byte)].join(' ');
}

export function encodeSignedTenths(degrees) {
  const value = Number(degrees);
  if (!Number.isFinite(value)) throw new TypeError('angle must be finite');
  const raw = Math.round(value * 10);
  if (raw < -32768 || raw > 32767) throw new RangeError('angle does not fit signed int16');
  const encoded = raw < 0 ? raw + 0x10000 : raw;
  return [encoded & 0xFF, (encoded >> 8) & 0xFF];
}

export function isActionAvailable(action, missionState, communicationMode = 'Normal') {
  const spec = ACTIONS[action];
  if (!spec) return false;
  if (spec.local) return !spec.communicationModes || spec.communicationModes.includes(communicationMode);
  if (communicationMode === 'MissionLinkFallback') {
    return Boolean(spec.emergency && spec.states.includes(missionState));
  }
  if (communicationMode !== 'Normal') return false;
  return spec.states.includes(missionState);
}

export function buildCommand(action, options = {}) {
  switch (action) {
    case 'startSequence': return generic(GenericCommand.START_SEQUENCE);
    case 'cancelSequence': return generic(GenericCommand.CANCEL_SEQUENCE);
    case 'finFree': return generic(GenericCommand.FIN_FREE);
    case 'setFinZero': return generic(GenericCommand.SET_FIN_ZERO);
    case 'finHold': return generic(GenericCommand.FIN_HOLD);
    case 'paraOpen': return generic(GenericCommand.PARA_OPEN);
    case 'paraClose': return generic(GenericCommand.PARA_CLOSE);
    case 'liftoffEmergency': return 'le';
    case 'startLogging': return local(LocalCommand.START_LOGGING);
    case 'stopLogging': return local(LocalCommand.STOP_LOGGING);
    case 'gnssOn': return local(LocalCommand.GNSS_ON);
    case 'gnssOff': return local(LocalCommand.GNSS_OFF);
    case 'wakeMission': return local(LocalCommand.WAKE_MISSION);
    case 'dumpInternalFlash': return local(LocalCommand.DUMP_INTERNAL_FLASH);
    case 'dumpMissionSd': return local(LocalCommand.DUMP_MISSION_SD);
    case 'stopLogDump': return local(LocalCommand.STOP_LOG_DUMP);
    default: throw new Error(`unknown action: ${action}`);
  }
}
