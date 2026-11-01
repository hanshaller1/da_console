// Audio plumbing: AudioContext, the DSP worklet, input sources and output recording.

// the lowest slider position (-48 dB and below) means silence
const dbToGain = (db) => (db <= -48 ? 0 : Math.pow(10, db / 20));

export class Engine {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.src = null;
    this.mic = null;
    this.onMeter = null;
    this.buffers = {};
    this.recorder = null;
    this.inputNodes = [];
    this.inChannels = 0;
    this.inGainDb = 0;   // trim in front of the pedal
    this.outGainDb = 0;  // listening volume, speakers only
  }

  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Dieser Browser unterstützt kein Web Audio');
    const ctx = new AC({ latencyHint: 'interactive' });
    // resume while we are still inside the click handler; after the first
    // await some browsers no longer count it as a user gesture
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      if (!ctx.audioWorklet) {
        throw new Error(window.isSecureContext === false
          ? 'AudioWorklet gibt es nur über https:// oder localhost'
          : 'Dieser Browser unterstützt kein AudioWorklet (Chrome, Edge, Firefox oder Safari ab 14.1 nehmen)');
      }
      // a bundled single-file build passes the worklet in as a blob: URL
      const url = window.__CHROMA_WORKLET_URL || new URL('../worklet/chroma-processor.js', import.meta.url);
      await ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(ctx, 'chroma-console', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
    } catch (err) {
      // do not leak one AudioContext per failed attempt
      ctx.close().catch(() => {});
      throw err;
    }
    this.ctx = ctx;
    this.inBus = ctx.createGain();
    this.inBus.gain.value = dbToGain(this.inGainDb);
    this.inBus.connect(this.node);
    this.out = ctx.createGain();
    this.node.connect(this.out);
    // volume sits only on the way to the speakers: recording and scope keep the pedal level
    this.vol = ctx.createGain();
    this.vol.gain.value = dbToGain(this.outGainDb);
    this.out.connect(this.vol);
    this.vol.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;
    this.out.connect(this.analyser);
    this.recDest = ctx.createMediaStreamDestination();
    this.out.connect(this.recDest);
    this.node.port.onmessage = (e) => { if (e.data.type === 'meter' && this.onMeter) this.onMeter(e.data); };
  }

  // Mobile browsers suspend or "interrupt" the context (calls, app switch).
  // Called on every user interaction so the pedal comes back by itself.
  wake() {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  }

  setInputGain(db) {
    this.inGainDb = db;
    if (this.inBus) this.inBus.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.02);
  }

  setOutputGain(db) {
    this.outGainDb = db;
    if (this.vol) this.vol.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.02);
  }

  send(msg) { if (this.node) this.node.port.postMessage(msg); }

  stopSource() {
    if (this.src) {
      try { if (this.src.stop) this.src.stop(); } catch { /* already stopped */ }
      this.src.disconnect();
      this.src = null;
    }
    this.inputNodes.forEach((n) => n.disconnect());
    this.inputNodes = [];
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

  // Live input from any audio input the browser sees: audio interface,
  // USB devices such as an Elektron box, built-in mic. deviceId '' = default.
  async useInput(deviceId, channels) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(window.isSecureContext === false ? 'Live-Eingang gibt es nur über https:// oder localhost' : 'Dieser Browser erlaubt keinen Audio-Eingang');
    }
    // no voice processing, ask for a stereo pair (browsers capture mono otherwise)
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, latency: { ideal: 0 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      // a remembered device that is unplugged now: fall back to the default one
      if (!deviceId || (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError')) throw err;
      delete audio.deviceId;
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    }
    let src;
    try {
      src = this.ctx.createMediaStreamSource(stream);
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw err;
    }
    this.stopSource();
    this.src = src;
    this.mic = stream;
    const track = stream.getAudioTracks()[0];
    const s = track && track.getSettings ? track.getSettings() : {};
    this.inChannels = s.channelCount || 0;
    this.routeInput(channels);
    return { deviceId: s.deviceId || '', label: (track && track.label) || '', channels: this.inChannels, fallback: !!deviceId && s.deviceId !== deviceId };
  }

  // Which input channels feed the pedal: 'stereo' (1+2), 'left' (1), 'right' (2), 'sum' (1+2 mono)
  routeInput(mode) {
    if (!this.mic || !this.src) return;
    this.inputNodes.forEach((n) => n.disconnect());
    this.inputNodes = [];
    this.src.disconnect();
    if (mode === 'right' && this.inChannels === 1) mode = 'left'; // mono device: there is no channel 2
    if (mode === 'left' || mode === 'right') {
      const sp = this.ctx.createChannelSplitter(2);
      this.src.connect(sp);
      sp.connect(this.inBus, mode === 'left' ? 0 : 1); // mono into the worklet is spread to both sides
      this.inputNodes.push(sp);
    } else if (mode === 'sum') {
      const g = this.ctx.createGain();
      g.channelCount = 1; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
      this.src.connect(g);
      g.connect(this.inBus);
      this.inputNodes.push(g);
    } else {
      this.src.connect(this.inBus);
    }
  }

  get canChooseOutput() { return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype; }

  // Output device (Chrome/Edge 110+). '' = system default.
  async setOutput(deviceId) {
    if (!this.ctx || !this.canChooseOutput) return;
    await this.ctx.setSinkId(deviceId || '');
  }

  // Rough round-trip estimate in ms, or null if the browser does not say
  latencyMs() {
    const ctx = this.ctx;
    if (!ctx || typeof ctx.baseLatency !== 'number') return null;
    const track = this.mic && this.mic.getAudioTracks()[0];
    const inLat = track && track.getSettings && typeof track.getSettings().latency === 'number' ? track.getSettings().latency : 0;
    return Math.round((ctx.baseLatency + (ctx.outputLatency || 0) + inLat + 128 / ctx.sampleRate) * 1000);
  }

  startRecording() {
    if (!window.MediaRecorder || !this.recDest) throw new Error('Dieser Browser kann keine Audio-Aufnahmen erstellen');
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
