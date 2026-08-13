import { PacketHeader } from '../../shared/protocol.js';

function f(key, label, group, raw, value, unit = '', status = 'VALID') {
  return { key, label, group, raw, value, unit, status };
}

function statusFields(prefix, names, bits) {
  return names.map((name, index) => f(`${prefix}.bit${index}`, name, prefix, (bits >> index) & 1, Boolean((bits >> index) & 1)));
}

const flightStatusNames = [
  'LPS liftoff detected','ICM liftoff detected','ICM42688 alive','STS3215 alive','Roll Control active',
  'Logic source present','Motor source present','ComBoard microSD healthy','Mission-ComBoard CAN healthy',
  'ICM data loss/error','AS5047D error','AirData error','Fin motor saturation','Fin Brake',
  'Mission reset/recovery event','Control re-entry inhibited',
];

const commandStatusNames = [
  'ICM healthy','LPS healthy','SSC healthy','AS5047D healthy','STS3215 healthy','Fin zero configured',
  'Para open configured','Para close configured','Logic battery present','Motor battery present','Mission SD healthy',
  'ComBoard SD healthy','CAN healthy','Persistence healthy','Fin busy','Para busy','Gyro bias valid',
  'Gravity reference valid','SSC zero valid','Flash backup has data','Flash backup healthy','Motor profile valid',
  'Fin control disabled','Calibration busy',
];

export class SyntheticSource {
  constructor(store) {
    this.store = store;
    this.timer = null;
    this.startedAt = performance.now();
    this.flightStartedAt = null;
    this.stage = 'CommandReceive';
    this.sequence = 0;
    this.paused = false;
  }

  start() {
    if (this.timer) return;
    this.startedAt = performance.now();
    this.timer = setInterval(() => this.tick(), 500);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  setPaused(paused) {
    this.paused = paused;
  }

  forceLiftoff() {
    if (this.stage === 'CommandReceive') this.stage = 'LiftoffDetection';
    this.stage = 'EngineBurn';
    this.flightStartedAt = performance.now();
    this.tick(true);
  }

  setStage(stage) {
    this.stage = stage;
    if (['EngineBurn','Control','Descent'].includes(stage) && this.flightStartedAt === null) this.flightStartedAt = performance.now();
    this.tick(true);
  }

  tick(force = false) {
    if (this.paused && !force) return;
    const sessionSec = (performance.now() - this.startedAt) / 1000;
    if (!force) {
      if (sessionSec > 4 && this.stage === 'CommandReceive') this.stage = 'LiftoffDetection';
      if (sessionSec > 8 && this.stage === 'LiftoffDetection') {
        this.stage = 'EngineBurn';
        this.flightStartedAt = performance.now();
      }
      const flightSec = this.flightStartedAt === null ? 0 : (performance.now() - this.flightStartedAt) / 1000;
      if (flightSec > 8 && this.stage === 'EngineBurn') this.stage = 'Control';
      if (flightSec > 15 && this.stage === 'Control') this.stage = 'Descent';
    }

    const hostMs = Date.now();
    const rssiDbm = -72 - Math.round(sessionSec * 0.25) + Math.round(Math.sin(sessionSec * 0.7) * 3);
    const decoded = this.stage === 'CommandReceive' ? this.commandPacket(sessionSec) : this.flightPacket(sessionSec);
    this.store.ingestSynthetic(decoded, { hostMs, rssiDbm, sequence: this.sequence++, intervalMs: 500 });
  }

  commandPacket(sessionSec) {
    let status = 0;
    [0,1,2,3,4,5,6,7,8,9,10,11,12,13,16,17,18,20,21].forEach((bit) => { status |= 1 << bit; });
    const logic = 9.25 - sessionSec * 0.002 + Math.sin(sessionSec * 0.1) * 0.015;
    const motor = 9.12 - sessionSec * 0.0015 + Math.sin(sessionSec * 0.12) * 0.02;
    const fields = [
      f('commandStatusRaw','CommandReceive status raw','Status',status,`0x${status.toString(16).padStart(6,'0')}`),
      ...statusFields('Command status', commandStatusNames, status),
      f('finMode','Fin mode','Modes',2,'ZeroHold'), f('paraMode','Parachute mode','Modes',1,'Hold'),
      f('motorProfile','Motor profile ID','Configuration',1,1),
      f('tilt','Tilt from vertical','Attitude',27,20.25,'deg'), f('tiltDirection','Tilt direction true','Attitude',281,281,'deg'),
      f('finAngle','Fin angle','Fin',120,0,'deg'), f('paraAngle','Parachute angle','Parachute',87,130.5,'deg'),
      f('pressure','LPS pressure','Air data',930,986 + Math.sin(sessionSec*0.03)*0.2,'hPa'),
      f('temperature','LPS temperature','Air data',73,23,'°C'), f('airspeed','Airspeed','Air data',0,0,'m/s'),
      f('logicVoltage','Logic voltage','Power',Math.round(logic/0.05),logic,'V'),
      f('motorVoltage','Motor voltage','Power',Math.round(motor/0.05),motor,'V'),
      f('east','GNSS East','Position',0,0,'m'), f('north','GNSS North','Position',0,0,'m'), f('height','GNSS absolute height','Position',52,160,'m'),
      f('checksum','XOR checksum','Protocol',0x5A,'0x5A'),
    ];
    return { header:PacketHeader.COMMAND_RECEIVE, packetName:'CommandReceive', missionState:'CommandReceive', fields };
  }

  flightPacket(sessionSec) {
    const flightSec = this.flightStartedAt === null ? 0 : Math.max(0, (performance.now() - this.flightStartedAt) / 1000);
    const state = this.stage;
    const header = state === 'LiftoffDetection' ? PacketHeader.LIFTOFF_DETECTION
      : state === 'EngineBurn' ? PacketHeader.ENGINE_BURN
      : state === 'Control' ? PacketHeader.CONTROL : PacketHeader.DESCENT;

    if (state === 'Descent') return this.descentPacket(flightSec, sessionSec);

    const roll = state === 'LiftoffDetection' ? 0 : 18*Math.exp(-flightSec/9)*Math.sin(flightSec*1.35);
    const rollRate = state === 'LiftoffDetection' ? 0 : 24*Math.exp(-flightSec/9)*Math.cos(flightSec*1.35);
    const tilt = state === 'LiftoffDetection' ? 20 : 20 + Math.min(18, flightSec*1.25) + Math.sin(flightSec*0.45)*2;
    const tiltDirection = 280.66 + Math.sin(flightSec*0.22)*7;
    const finAngle = state === 'Control' ? Math.max(-12, Math.min(12, -roll*0.34 + Math.sin(flightSec*2.5))) : 0;
    const finRate = state === 'Control' ? -rollRate*0.34 + Math.cos(flightSec*2.5)*2.5 : 0;
    const airspeed = state === 'LiftoffDetection' ? 0 : Math.max(0, 175 - Math.abs(flightSec-4)*13);
    const torque = state === 'Control' ? -roll*0.035 - rollRate*0.01 : 0;
    const pressure = 986 - flightSec*6.8 + Math.sin(flightSec*0.4)*0.4;
    const height = 160 + Math.max(0, 93*flightSec - 3.1*flightSec*flightSec);
    const east = -Math.max(0, flightSec*22);
    const north = Math.max(0, flightSec*4.5);

    let status = (1<<2)|(1<<3)|(1<<5)|(1<<6)|(1<<7)|(1<<8);
    if (state !== 'LiftoffDetection') status |= (1<<1);
    if (state === 'Control') status |= (1<<4);
    if (state !== 'Control') status |= (1<<13);

    const fields = [
      f('flightStatusRaw','Flight status raw','Status',status,`0x${status.toString(16).padStart(4,'0')}`),
      ...statusFields('Flight status',flightStatusNames,status),
      f('roll','Roll','Attitude',0,roll,'deg'), f('rollRate','Roll rate','Attitude',0,rollRate,'deg/s'),
      f('tilt','Tilt from vertical','Attitude',0,tilt,'deg'), f('tiltDirection','Tilt direction true','Attitude',0,tiltDirection,'deg'),
      f('finAngle','Fin angle','Fin',0,finAngle,'deg'), f('finRate','Fin rate','Fin',0,finRate,'deg/s'),
      f('pressure','LPS pressure','Air data',0,pressure,'hPa'), f('temperature','LPS temperature','Air data',0,23.5,'°C'),
      f('airspeed','Airspeed','Air data',0,airspeed,'m/s'), f('requestedTorque','Requested output torque','Control',0,torque,'N·m','TEMPORARY_SCALE'),
      f('flightElapsed','Flight elapsed','Time',0,flightSec,'s'),
      f('east','GNSS East','Position',0,east,'m'), f('north','GNSS North','Position',0,north,'m'), f('height','GNSS absolute height','Position',0,height,'m'),
      f('checksum','XOR checksum','Protocol',0,'0x00'),
    ];
    return { header, packetName:state, missionState:state, fields };
  }

  descentPacket(flightSec) {
    const descentSec = Math.max(0, flightSec - 15);
    const paraAngle = Math.min(130, descentSec*85);
    const height = Math.max(160, 1050 - descentSec*48);
    const status = (1<<1) | (1<<7) | (descentSec>1.6 ? (2<<2) : (1<<2)) | (descentSec>5 ? (1<<4):0) | (1<<5) | (1<<6);
    const fields = [
      f('descentStatusRaw','Descent status raw','Status',status,`0x${status.toString(16).padStart(4,'0')}`),
      f('parachuteState','Parachute state','Parachute',(status>>2)&3,descentSec>1.6?'Open confirmed':'Opening or retrying'),
      f('pressure','LPS pressure','Air data',0,914+descentSec*2.1,'hPa'), f('temperature','LPS temperature','Air data',0,21.8,'°C'),
      f('paraAngle','Parachute angle','Parachute',0,paraAngle,'deg'), f('descentElapsed','Descent elapsed','Time',0,descentSec,'s'),
      f('east','GNSS East','Position',0,-350-descentSec*6,'m'), f('north','GNSS North','Position',0,73+descentSec*2,'m'), f('height','GNSS absolute height','Position',0,height,'m'),
      f('checksum','XOR checksum','Protocol',0,'0x00'),
    ];
    return {header:PacketHeader.DESCENT,packetName:'Descent',missionState:'Descent',fields};
  }
}
