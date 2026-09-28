/**
 * Small synthesized sound effects (no audio files): reel ticks, countdown beeps, a win fanfare and firework booms.
 * Everything goes through one master gain that also feeds a MediaStream, so the draw video has the same sound.
 */
export class Sfx {
  readonly ctx: AudioContext | null;
  private master: GainNode | null = null;
  readonly stream: MediaStream | null = null;
  private lastTick = 0;
  private noise: AudioBuffer | null = null;

  constructor() {
    const AC: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    this.ctx = AC ? new AC() : null;
    if (!this.ctx) return;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);
    try {
      const dest = this.ctx.createMediaStreamDestination();
      this.master.connect(dest);
      this.stream = dest.stream;
    } catch {
      /* recording without sound */
    }
    const len = Math.floor(this.ctx.sampleRate * 0.6);
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    void this.ctx.resume().catch(() => undefined);
  }

  set muted(v: boolean) {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v ? 0 : 0.9, this.ctx.currentTime, 0.02);
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, at = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** A soft click when a name passes the arrow (rate-limited so a fast spin stays pleasant). */
  tick() {
    const now = performance.now();
    if (now - this.lastTick < 45) return;
    this.lastTick = now;
    this.tone(1800 + Math.random() * 200, 0.035, "square", 0.05);
  }

  beep(high = false) {
    this.tone(high ? 1320 : 880, high ? 0.35 : 0.16, "sine", 0.25);
  }

  fanfare() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, 0.5, "triangle", 0.22, i * 0.11));
    [1046.5, 1318.5, 1568].forEach((f) => this.tone(f, 1.2, "sine", 0.08, 0.5));
  }

  boom(power = 1) {
    if (!this.ctx || !this.master || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.5 + Math.random() * 0.3;
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 900;
    const g = this.ctx.createGain();
    g.gain.value = 0.35 * power;
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
  }

  close() {
    void this.ctx?.close().catch(() => undefined);
  }
}
