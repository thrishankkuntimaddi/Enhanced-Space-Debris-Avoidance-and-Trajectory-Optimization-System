// Procedural audio + mission-control voice loop.
//
// Engine: filtered noise whose loudness follows thrust AND the ambient air pressure (sound needs a
// medium: the roar fades to a faint structure-borne hum in vacuum).
//
// Voice: pre-rendered mission-control clips (static/sf/audio/vo/, built by tools/callouts.py) played
// through one of two links, the way a real launch broadcast sounds:
//   'ground' — the launch-control loop: clean, slightly compressed, a short room reverb.
//   'radio'  — space-to-ground after orbit insertion: band-limited 300–3000 Hz, soft clipping,
//              a hiss bed that opens with the transmission, and Quindar tones (2525 Hz on key-up,
//              2475 Hz on release), the beeps of the Apollo air-to-ground loop.
// If a clip is missing, the browser's speech synthesis says the line instead.
export class Audio {
  constructor() {
    this.ctx = null; this.muted = false; this.voice = true;
    this.link = 'ground'; this.clips = new Map(); this.manifest = null;
    this.queue = []; this.playing = null; this.speaker = 'lc';
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    const ctx = this.ctx = new C();
    this.master = ctx.createDynamicsCompressor();
    this.master.threshold.value = -10; this.master.ratio.value = 4;
    this.master.connect(ctx.destination);
    // engine
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { b = 0.985 * b + 0.15 * (Math.random() * 2 - 1); d[i] = b; }   // brown-ish noise
    this.noise = buf;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    this.low = ctx.createBiquadFilter(); this.low.type = 'lowpass'; this.low.frequency.value = 400;
    this.crackle = ctx.createBiquadFilter(); this.crackle.type = 'bandpass'; this.crackle.frequency.value = 1800; this.crackle.Q.value = 0.7;
    this.gMain = ctx.createGain(); this.gMain.gain.value = 0;
    this.gCrack = ctx.createGain(); this.gCrack.gain.value = 0;
    src.connect(this.low).connect(this.gMain).connect(this.master);
    src.connect(this.crackle).connect(this.gCrack).connect(this.master);
    // sub-bass rumble: felt more than heard, strongest near the pad
    this.sub = ctx.createOscillator(); this.sub.type = 'sine'; this.sub.frequency.value = 34;
    this.gSub = ctx.createGain(); this.gSub.gain.value = 0;
    this.sub.connect(this.gSub).connect(this.master); this.sub.start();
    src.start();
    this._initVoice();
    this._loadClips();
  }

  _initVoice() {
    const ctx = this.ctx;
    this.vIn = ctx.createGain();
    // ground: presence lift + compression + small room
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 110;
    const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3000; pres.gain.value = 3; pres.Q.value = 0.8;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -22; comp.ratio.value = 3;
    const room = ctx.createConvolver(); room.buffer = this._impulse(0.45, 3.5);
    const wet = ctx.createGain(); wet.gain.value = 0.16;
    this.gGround = ctx.createGain(); this.gGround.gain.value = 1;
    this.vIn.connect(hp).connect(pres).connect(comp);
    comp.connect(this.gGround); comp.connect(room).connect(wet).connect(this.gGround);
    this.gGround.connect(this.master);
    // radio: band-limit + drive + hiss
    const rhp = ctx.createBiquadFilter(); rhp.type = 'highpass'; rhp.frequency.value = 320; rhp.Q.value = 0.9;
    const rlp = ctx.createBiquadFilter(); rlp.type = 'lowpass'; rlp.frequency.value = 2900; rlp.Q.value = 0.9;
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1400; mid.gain.value = 6; mid.Q.value = 1.2;
    const drive = ctx.createWaveShaper(); drive.curve = this._softClip(2.6); drive.oversample = '2x';
    this.gRadio = ctx.createGain(); this.gRadio.gain.value = 0;
    this.vIn.connect(rhp).connect(rlp).connect(mid).connect(drive).connect(this.gRadio).connect(this.master);
    const hiss = ctx.createBufferSource(); hiss.buffer = this._whiteNoise(2); hiss.loop = true;
    const hf = ctx.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 2000; hf.Q.value = 0.6;
    this.gHiss = ctx.createGain(); this.gHiss.gain.value = 0;
    hiss.connect(hf).connect(this.gHiss).connect(this.master); hiss.start();
  }

  _impulse(sec, decay) {
    const n = Math.floor(this.ctx.sampleRate * sec), b = this.ctx.createBuffer(2, n, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** decay; }
    return b;
  }
  _whiteNoise(sec) {
    const n = this.ctx.sampleRate * sec, b = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  _softClip(k) {
    const c = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }

  async _loadClips() {
    try {
      const r = await fetch('/static/sf/audio/vo/manifest.json');
      if (!r.ok) return;
      this.manifest = await r.json();
    } catch { /* no clips: speech-synthesis fallback */ }
  }
  async _clip(id) {
    if (this.clips.has(id)) return this.clips.get(id);
    const p = (async () => {
      if (!this.manifest || !this.manifest.clips[id]) return null;
      const r = await fetch('/static/sf/audio/vo/' + this.manifest.clips[id].file);
      return await this.ctx.decodeAudioData(await r.arrayBuffer());
    })().catch(() => null);
    this.clips.set(id, p);
    return p;
  }
  /** Warm the cache so the first call of each line plays on time. */
  preload(ids) { if (this.ctx) ids.forEach((id) => this._clip(id)); }

  /** 'ground' before orbit, 'radio' after insertion. */
  setLink(mode) {
    this.link = mode;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.gGround.gain.setTargetAtTime(mode === 'ground' ? 1 : 0, t, 0.05);
    this.gRadio.gain.setTargetAtTime(mode === 'radio' ? 1.15 : 0, t, 0.05);
  }

  _quindar(f, at) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = f; g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.07, at + 0.01);
    g.gain.setValueAtTime(0.07, at + 0.24); g.gain.linearRampToValueAtTime(0, at + 0.25);
    o.connect(g).connect(this.master); o.start(at); o.stop(at + 0.26);
  }

  /** Mission-control line. id: clip key from the manifest; text: fallback words.
   *  opts.now interrupts the queue (countdown numbers must land on the second). */
  call(id, text, opts = {}) {
    if (this.muted || !this.voice) return Promise.resolve();
    if (!this.ctx) { this._speak(text); return Promise.resolve(); }
    return new Promise((done) => {
      const job = { id, text, done, ...opts };
      if (opts.now) { this._stop(); this.queue = [job]; } else this.queue.push(job);
      if (!this.playing) this._next();
    });
  }
  _stop() {
    if (this.playing?.src) try { this.playing.src.onended = null; this.playing.src.stop(); } catch { /* already stopped */ }
    if (this.playing) this.playing.done();
    this.playing = null;
  }
  async _next() {
    const job = this.queue.shift();
    if (!job) { this.playing = null; return; }
    this.playing = job;
    const buf = await this._clip(job.id);
    if (this.playing !== job) return;            // interrupted while decoding
    if (!buf) {
      this._speak(job.text);
      setTimeout(() => { if (this.playing === job) { job.done(); this._next(); } }, 300 + job.text.length * 55);
      return;
    }
    const t = this.ctx.currentTime + 0.02, radio = this.link === 'radio';
    let start = t;
    if (radio) {
      this._quindar(2525, t); start = t + 0.3;
      this.gHiss.gain.setTargetAtTime(0.018, t, 0.02);
    }
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const g = this.ctx.createGain(); g.gain.value = job.gain ?? 1;
    src.connect(g).connect(this.vIn);
    src.start(start);
    job.src = src;
    src.onended = () => {
      if (radio) { const e = this.ctx.currentTime; this._quindar(2475, e + 0.03); this.gHiss.gain.setTargetAtTime(0, e + 0.3, 0.03); }
      job.done();
      setTimeout(() => this._next(), job.gap ?? (radio ? 420 : 160));
    };
  }
  _speak(text) {
    if (!window.speechSynthesis || !text) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 0.9; u.volume = 0.8;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  /** Old single-line API, kept for free-text messages. */
  say(text) { this.call('', text); }

  update(thrustN, pressureRatio, warp, altM = 1e6) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const on = thrustN > 0 && !this.muted && warp <= 10;
    const loud = on ? Math.min(1, Math.pow(thrustN / 1.5e7, 0.25)) : 0;
    const air = 0.12 + 0.88 * Math.min(1, pressureRatio * 1.5);
    this.gMain.gain.setTargetAtTime(0.55 * loud * air, t, 0.15);
    this.gCrack.gain.setTargetAtTime(0.18 * loud * Math.min(1, pressureRatio * 3), t, 0.1);
    this.low.frequency.setTargetAtTime(160 + 600 * air * loud, t, 0.2);
    this.gSub.gain.setTargetAtTime(0.22 * loud * Math.exp(-altM / 4000), t, 0.2);
  }
  /** Low thump: ignition, staging, separation. */
  thump(strength = 1) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.5);
    g.gain.setValueAtTime(0.5 * strength, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.75);
    const n = this.ctx.createBufferSource(); n.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    const gn = this.ctx.createGain(); gn.gain.setValueAtTime(0.35 * strength, t); gn.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    n.connect(f).connect(gn).connect(this.master); n.start(t); n.stop(t + 0.4);
  }
  /** Rising two-tone alarm for RED conjunctions. */
  alarm() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    for (let k = 0; k < 3; k++) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'square'; o.frequency.setValueAtTime(880, t + k * 0.32); o.frequency.setValueAtTime(1175, t + k * 0.32 + 0.14);
      g.gain.setValueAtTime(0.0, t + k * 0.32); g.gain.linearRampToValueAtTime(0.045, t + k * 0.32 + 0.01); g.gain.setValueAtTime(0, t + k * 0.32 + 0.28);
      o.connect(g).connect(this.master); o.start(t + k * 0.32); o.stop(t + k * 0.32 + 0.3);
    }
  }
  beep(f = 880, dur = 0.08) {
    if (!this.ctx || this.muted) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = f; g.gain.value = 0.06; o.connect(g).connect(this.master);
    o.start(); o.stop(this.ctx.currentTime + dur);
  }
  toggle() {
    this.muted = !this.muted;
    if (this.muted) { this.queue = []; this._stop(); if (window.speechSynthesis) speechSynthesis.cancel(); }
    return this.muted;
  }
}
