export const GenericCommand = Object.freeze({
  START_SEQUENCE: 0x01,
  CANCEL_SEQUENCE: 0x02,
  DISABLE_FIN_CONTROL: 0x03,
  FORCE_START_SEQUENCE: 0x04,
  FIN_FREE: 0x10,
  SET_FIN_ZERO: 0x11,
  START_FIN_ZERO_HOLD: 0x12,
  FIN_MOVE_RELATIVE: 0x13,
  PARA_FREE: 0x20,
  PARA_HOLD: 0x21,
  PARA_MOVE_RELATIVE: 0x22,
  SET_PARA_OPEN: 0x23,
  SET_PARA_CLOSE: 0x24,
  PARA_OPEN: 0x25,
  PARA_CLOSE: 0x26,
  RUN_PREFLIGHT_CALIBRATION: 0x30,
  EXPORT_FLASH_LOG_TO_SD_AND_ERASE: 0x31,
  SELECT_MOTOR_PROFILE: 0x32,
  ENTER_RECOVERY: 0x33,
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
  forceStartSequence: { label: 'ForceStartSequence', states: ['CommandReceive'], forceOnly: true },
  cancelSequence: { label: 'CancelSequence', states: ['LiftoffDetection'] },
  disableFinControl: { label: 'DisableFinControl', states: ['LiftoffDetection', 'EngineBurn', 'Control'] },
  finFree: { label: 'FinFree', states: ['CommandReceive'] },
  setFinZero: { label: 'SetFinZero', states: ['CommandReceive'] },
  finZeroHold: { label: 'StartFinZeroHold', states: ['CommandReceive'] },
  finMoveRelative: { label: 'FinMoveRelative', states: ['CommandReceive'], needs: 'angle' },
  paraFree: { label: 'ParaFree', states: ['CommandReceive'] },
  paraHold: { label: 'ParaHold', states: ['CommandReceive'] },
  paraMoveRelative: { label: 'ParaMoveRelative', states: ['CommandReceive'], needs: 'angle' },
  setParaOpen: { label: 'SetParaOpen', states: ['CommandReceive'], needs: 'direction' },
  setParaClose: { label: 'SetParaClose', states: ['CommandReceive'], needs: 'direction' },
  paraOpen: { label: 'ParaOpen', states: ['CommandReceive'] },
  paraClose: { label: 'ParaClose', states: ['CommandReceive'] },
  runCalibration: { label: 'RunPreflightCalibration', states: ['CommandReceive'] },
  exportFlash: { label: 'ExportFlashLogToSdAndErase', states: ['CommandReceive'] },
  selectMotorProfile: { label: 'SelectMotorProfile', states: ['CommandReceive'], needs: 'profile' },
  enterRecovery: { label: 'EnterRecovery', states: ['Descent'] },
  actuatorEmergency: { label: 'ActuatorEmergencyStop', states: ['CommandReceive'], emergency: true },
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

function encodeDirection(direction) {
  if (direction === 'CW') return 0x01;
  if (direction === 'CCW') return 0xFF;
  throw new RangeError('parachute direction must be CW or CCW');
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
    case 'forceStartSequence': return generic(GenericCommand.FORCE_START_SEQUENCE);
    case 'cancelSequence': return generic(GenericCommand.CANCEL_SEQUENCE);
    case 'disableFinControl': return generic(GenericCommand.DISABLE_FIN_CONTROL);
    case 'finFree': return generic(GenericCommand.FIN_FREE);
    case 'setFinZero': return generic(GenericCommand.SET_FIN_ZERO);
    case 'finZeroHold': return generic(GenericCommand.START_FIN_ZERO_HOLD);
    case 'finMoveRelative': return generic(GenericCommand.FIN_MOVE_RELATIVE, encodeSignedTenths(options.angle));
    case 'paraFree': return generic(GenericCommand.PARA_FREE);
    case 'paraHold': return generic(GenericCommand.PARA_HOLD);
    case 'paraMoveRelative': {
      const angle = Number(options.angle);
      if (!Number.isFinite(angle) || Math.abs(angle) >= 180) throw new RangeError('parachute relative move must be < 180 deg');
      return generic(GenericCommand.PARA_MOVE_RELATIVE, encodeSignedTenths(angle));
    }
    case 'setParaOpen': return generic(GenericCommand.SET_PARA_OPEN, [encodeDirection(options.direction)]);
    case 'setParaClose': return generic(GenericCommand.SET_PARA_CLOSE, [encodeDirection(options.direction)]);
    case 'paraOpen': return generic(GenericCommand.PARA_OPEN);
    case 'paraClose': return generic(GenericCommand.PARA_CLOSE);
    case 'runCalibration': return generic(GenericCommand.RUN_PREFLIGHT_CALIBRATION);
    case 'exportFlash': return generic(GenericCommand.EXPORT_FLASH_LOG_TO_SD_AND_ERASE);
    case 'selectMotorProfile': return generic(GenericCommand.SELECT_MOTOR_PROFILE, [byte(Number(options.profile))]);
    case 'enterRecovery': return generic(GenericCommand.ENTER_RECOVERY);
    case 'actuatorEmergency': return 'ae';
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
