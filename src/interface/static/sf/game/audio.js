// Procedural audio: engine roar from filtered noise, whose loudness follows thrust AND the ambient
// air pressure (sound needs a medium: the roar fades to a faint structure-borne hum in vacuum).
export class Audio {
  constructor() { this.ctx = null; this.muted = false; this.voice = true; }
  init() {
    if (this.ctx) return;
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    const ctx = this.ctx = new C();
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { b = 0.985 * b + 0.15 * (Math.random() * 2 - 1); d[i] = b; }   // brown-ish noise
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    this.low = ctx.createBiquadFilter(); this.low.type = 'lowpass'; this.low.frequency.value = 400;
    this.crackle = ctx.createBiquadFilter(); this.crackle.type = 'bandpass'; this.crackle.frequency.value = 1800; this.crackle.Q.value = 0.7;
    this.gMain = ctx.createGain(); this.gMain.gain.value = 0;
    this.gCrack = ctx.createGain(); this.gCrack.gain.value = 0;
    src.connect(this.low).connect(this.gMain).connect(ctx.destination);
    src.connect(this.crackle).connect(this.gCrack).connect(ctx.destination);
    src.start();
  }
  update(thrustN, pressureRatio, warp) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = thrustN > 0 && !this.muted && warp <= 10;
    const loud = on ? Math.min(1, Math.pow(thrustN / 1.5e7, 0.25)) : 0;
    const air = 0.12 + 0.88 * Math.min(1, pressureRatio * 1.5);
    this.gMain.gain.setTargetAtTime(0.55 * loud * air, t, 0.15);
    this.gCrack.gain.setTargetAtTime(0.18 * loud * Math.min(1, pressureRatio * 3), t, 0.1);
    this.low.frequency.setTargetAtTime(160 + 600 * air * loud, t, 0.2);
  }
  say(text) {
    if (this.muted || !this.voice || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 0.9; u.volume = 0.8;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  beep(f = 880, dur = 0.08) {
    if (!this.ctx || this.muted) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = f; g.gain.value = 0.08; o.connect(g).connect(this.ctx.destination);
    o.start(); o.stop(this.ctx.currentTime + dur);
  }
  toggle() { this.muted = !this.muted; if (this.muted && window.speechSynthesis) speechSynthesis.cancel(); return this.muted; }
}
