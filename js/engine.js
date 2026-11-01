// Audio plumbing: AudioContext, the DSP worklet, input sources and output recording.

export class Engine {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.src = null;
    this.mic = null;
    this.onMeter = null;
    this.buffers = {};
    this.recorder = null;
  }

  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL('../worklet/chroma-processor.js', import.meta.url));
    this.node = new AudioWorkletNode(ctx, 'chroma-console', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });
    this.inBus = ctx.createGain();
    this.inBus.connect(this.node);
    this.out = ctx.createGain();
    this.node.connect(this.out);
    this.out.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;
    this.out.connect(this.analyser);
    this.recDest = ctx.createMediaStreamDestination();
    this.out.connect(this.recDest);
    this.node.port.onmessage = (e) => { if (e.data.type === 'meter' && this.onMeter) this.onMeter(e.data); };
    if (ctx.state === 'suspended') await ctx.resume();
  }

  send(msg) { if (this.node) this.node.port.postMessage(msg); }

  stopSource() {
    if (this.src) {
      try { if (this.src.stop) this.src.stop(); } catch { /* already stopped */ }
      this.src.disconnect();
      this.src = null;
    }
    if (this.mic) { this.mic.getTracks().forEach((t) => t.stop()); this.mic = null; }
  }

  playBuffer(buf) {
    this.stopSource();
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.connect(this.inBus);
    s.start();
    this.src = s;
  }

  useDemo(kind) {
    if (!this.buffers[kind]) this.buffers[kind] = kind === 'drums' ? makeDrums(this.ctx) : makeGuitar(this.ctx);
    this.playBuffer(this.buffers[kind]);
  }

  async useFile(file) {
    const data = await file.arrayBuffer();
    const buf = await this.ctx.decodeAudioData(data);
    this.buffers.file = buf;
    this.playBuffer(buf);
  }

  async useMic() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.stopSource();
    const s = this.ctx.createMediaStreamSource(stream);
    s.connect(this.inBus);
    this.src = s;
    this.mic = stream;
  }

  startRecording() {
    const chunks = [];
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
    const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(this.recDest.stream, mimeType ? { mimeType } : undefined);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    this.recorder = { rec, chunks };
  }

  stopRecording() {
    return new Promise((resolve) => {
      const { rec, chunks } = this.recorder;
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      rec.stop();
      this.recorder = null;
    });
  }
}

/* ------------------------------------------------------------------ */
/* Built-in demo material, synthesised so the app works without a mic */
/* ------------------------------------------------------------------ */

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Karplus-Strong plucked string, added into `out` (wraps around for seamless loops)
function pluck(out, sr, start, freq, vel, decay = 0.9965) {
  const N = Math.max(2, Math.round(sr / freq));
  const buf = new Float32Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) { lp += 0.5 * ((Math.random() * 2 - 1) - lp); buf[i] = lp * vel; }
  const total = Math.floor(sr * 3.2);
  let idx = 0;
  for (let t = 0; t < total; t++) {
    const cur = buf[idx];
    const nxt = buf[(idx + 1) % N];
    buf[idx] = 0.5 * (cur + nxt) * decay;
    out[(start + t) % out.length] += cur;
    idx = (idx + 1) % N;
  }
}

function makeGuitar(ctx) {
  const sr = ctx.sampleRate, bpm = 84, eighth = 60 / bpm / 2;
  const chords = [
    [45, 52, 57, 60, 64, 69], // Am
    [41, 48, 53, 57, 60, 65], // F
    [48, 52, 55, 60, 64, 67], // C
    [43, 50, 55, 59, 62, 67], // G
  ];
  const pattern = [0, 3, 4, 5, 4, 3, 2, 4];
  const len = Math.round(chords.length * 8 * eighth * sr);
  const out = new Float32Array(len);
  chords.forEach((ch, c) => {
    pattern.forEach((note, k) => {
      const start = Math.round((c * 8 + k) * eighth * sr);
      pluck(out, sr, start, mtof(ch[note]), k === 0 ? 0.55 : 0.38 + Math.random() * 0.08);
      if (k === 0) pluck(out, sr, start, mtof(ch[0]), 0.5, 0.998);
    });
  });
  return toBuffer(ctx, out, 0.5);
}

function makeDrums(ctx) {
  const sr = ctx.sampleRate, bpm = 92, six = 60 / bpm / 4;
  const steps = 32;
  const len = Math.round(steps * six * sr);
  const out = new Float32Array(len);
  const kick = [0, 6, 10, 16, 22, 26, 27];
  const snare = [4, 12, 20, 28];
  const add = (start, n, fn) => { for (let t = 0; t < n; t++) out[(start + t) % len] += fn(t / sr); };
  for (let s = 0; s < steps; s++) {
    const st = Math.round(s * six * sr);
    if (kick.includes(s)) {
      let ph = 0;
      add(st, Math.floor(0.45 * sr), (t) => { ph += (45 + 110 * Math.exp(-t * 30)) / sr; return Math.sin(2 * Math.PI * ph) * Math.exp(-t * 7) * 0.9; });
    }
    if (snare.includes(s)) {
      let lp = 0;
      add(st, Math.floor(0.3 * sr), (t) => {
        const n = Math.random() * 2 - 1; lp += 0.6 * (n - lp);
        return (n - lp) * Math.exp(-t * 16) * 0.5 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 25) * 0.35;
      });
    }
    // hats on every 16th, accents on 8ths
    let prev = 0;
    const vel = s % 2 ? 0.07 : 0.14;
    add(st, Math.floor(0.06 * sr), (t) => { const n = Math.random() * 2 - 1; const h = n - prev; prev = n; return h * Math.exp(-t * 70) * vel; });
  }
  return toBuffer(ctx, out, 0.6);
}

function toBuffer(ctx, data, target) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  const g = peak > 0 ? target / peak : 1;
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) ch[i] = data[i] * g;
  return buf;
}
