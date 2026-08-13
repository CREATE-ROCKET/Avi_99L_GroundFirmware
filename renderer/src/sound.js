export class AlertSound {
  constructor() {
    this.context = null;
    this.armed = false;
    const arm = () => this.arm();
    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });
  }

  arm() {
    if (!this.context) this.context = new AudioContext();
    if (this.context.state === 'suspended') this.context.resume();
    this.armed = true;
  }

  beep(at, duration = 0.12, frequency = 880) {
    if (!this.context) this.arm();
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.16, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.02);
  }

  playLiftoff() {
    this.arm();
    const now = this.context.currentTime + 0.015;
    this.beep(now, 0.12, 920);
    this.beep(now + 0.25, 0.12, 920);
  }
}
