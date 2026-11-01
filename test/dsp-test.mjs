// Offline stability test for the DSP engine: runs every effect of every
// module with several input signals and checks for NaN / runaway output.
// Usage: node test/dsp-test.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../worklet/chroma-processor.js'), 'utf8');
const SR = 48000;
const ctx = {
  sampleRate: SR, Math, Float32Array, Float64Array, Object, Array, Number,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
  registerProcessor: () => {},
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { ChromaProcessor } = ctx.__chroma;

const MODS = [
  ['Drive', 'Sweeten', 'Fuzz', 'Howl', 'Swell'],
  ['Doubler', 'Vibrato', 'Phaser', 'Tremolo', 'Pitch'],
  ['Cascade', 'Reels', 'Space', 'Collage', 'Reverse'],
  ['Filter', 'Squash', 'Cassette', 'Broken', 'Interference'],
];

function signal(kind, t) {
  if (kind === 'pluck') { const ph = t % 0.5; return Math.sin(2 * Math.PI * 220 * t) * Math.exp(-ph * 6) * 0.5; }
  if (kind === 'noise') return (Math.random() * 2 - 1) * 0.3;
  if (kind === 'loud') return Math.sign(Math.sin(2 * Math.PI * 110 * t)) * 1.0;
  return 0;
}

let failures = 0;
const N = 128;
function run(setup, seconds, kind) {
  const p = new ChromaProcessor();
  setup(p);
  const inL = new Float32Array(N), out = [new Float32Array(N), new Float32Array(N)];
  let peak = 0, sumsq = 0, count = 0, t = 0;
  const blocks = Math.floor((seconds * SR) / N);
  const t0 = performance.now();
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < N; i++, t += 1 / SR) inL[i] = signal(kind, t);
    p.process([[inL]], [out]);
    for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) {
      const v = out[c][i];
      if (!Number.isFinite(v)) return { bad: true };
      const a = Math.abs(v); if (a > peak) peak = a; sumsq += v * v; count++;
    }
  }
  const ms = performance.now() - t0;
  return { peak, rms: Math.sqrt(sumsq / count), rt: (seconds * 1000) / ms };
}

for (let m = 0; m < 4; m++) {
  for (let e = 0; e < 5; e++) {
    for (const extreme of [0, 1]) {
      for (const kind of ['pluck', 'noise', 'loud']) {
        const r = run((p) => {
          for (let k = 0; k < 4; k++) p.mods[k].bypassed = k !== m;
          p.mods[m].sel = e;
          if (extreme) {
            for (const key of Object.keys(p.P)) p.P[key] = p.S[key] = 1;
          }
        }, 3, kind);
        const name = `${MODS[m][e]}${extreme ? ' (all knobs max)' : ''} [${kind}]`;
        if (r.bad || r.peak > 1.0) { failures++; console.log('FAIL', name, r); }
        else if (kind === 'pluck') console.log(`ok   ${name.padEnd(36)} peak ${r.peak.toFixed(2)}  rms ${r.rms.toFixed(3)}  ${r.rt.toFixed(0)}x realtime`);
      }
    }
  }
}
// full chain, all modules on, random settings
for (let trial = 0; trial < 20; trial++) {
  const r = run((p) => {
    for (let k = 0; k < 4; k++) p.mods[k].sel = Math.floor(Math.random() * 5);
    for (const key of Object.keys(p.P)) p.P[key] = p.S[key] = Math.random();
    p.order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
  }, 2, trial % 2 ? 'noise' : 'pluck');
  if (r.bad || r.peak > 1.0) { failures++; console.log('FAIL chain trial', trial, r); }
  else if (trial === 0) console.log(`ok   full chain random x20 (first: ${r.rt.toFixed(0)}x realtime)`);
}
/* ---------- regression checks for engine robustness ---------- */

function render(p, seconds, kind) {
  const inL = new Float32Array(N), out = [new Float32Array(N), new Float32Array(N)];
  let peak = 0, sumsq = 0, count = 0, finite = true, t = 0;
  for (let b = 0; b < Math.floor((seconds * SR) / N); b++) {
    for (let i = 0; i < N; i++, t += 1 / SR) inL[i] = signal(kind, t);
    p.process([[inL]], [out]);
    for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) {
      const v = out[c][i];
      if (!Number.isFinite(v)) finite = false;
      peak = Math.max(peak, Math.abs(v)); sumsq += v * v; count++;
    }
  }
  return { peak, rms: Math.sqrt(sumsq / Math.max(1, count)), finite };
}
function check(name, ok, detail = '') {
  if (ok) console.log(`ok   ${name}`);
  else { failures++; console.log('FAIL', name, detail); }
}

{ // garbage parameter values must not reach the DSP
  const p = new ChromaProcessor();
  p.msg({ type: 'params', data: { tilt: 'abc', charAmount: NaN, movRate: null, difTime: Infinity, sens: 7, bogus: 1, constructor: 1 } });
  const r = render(p, 0.5, 'pluck');
  check('invalid params are ignored or clamped', r.finite && r.rms > 0.01 && p.P.tilt === 0.5 && p.P.sens === 1 && !('bogus' in p.P), JSON.stringify(p.P));
}
{ // malformed control messages must not throw or corrupt the routing
  const p = new ChromaProcessor();
  let threw = false;
  try {
    p.msg({ type: 'select', module: 7, effect: 1 });
    p.msg({ type: 'select', module: 0, effect: 9 });
    p.msg({ type: 'moduleBypass', module: '__proto__', on: true });
    p.msg({ type: 'order', order: [0, 0, 0, 0] });
    p.msg({ type: 'inputGain', value: 'loud' });
    p.msg(null);
  } catch (e) { threw = e; }
  const r = render(p, 0.3, 'pluck');
  check('malformed messages are rejected', !threw && r.finite && p.order.join() === '0,1,2,3' && p.inGain === 1 && Object.getPrototypeOf(p.mods).bypassed === undefined, threw);
}
{ // a NaN inside a filter must not mute the pedal forever
  const p = new ChromaProcessor();
  render(p, 0.2, 'pluck');
  p.mods[0].ls[0].z1 = NaN;
  render(p, 0.05, 'pluck');
  const r = render(p, 0.5, 'pluck');
  check('engine recovers from an internal NaN', r.finite && r.rms > 0.01, r);
}
{ // stopping Capture while it is still recording
  const p = new ChromaProcessor();
  p.msg({ type: 'captureRoute', pre: true }); // pre-FX: a NaN here would poison every module
  p.msg({ type: 'capture', action: 'rec' });
  render(p, 0.5, 'pluck');
  p.msg({ type: 'capture', action: 'play' });
  render(p, 0.3, 'pluck');
  p.msg({ type: 'capture', action: 'rec' }); // re-capture while the loop plays …
  p.msg({ type: 'capture', action: 'stop' }); // … and stop before a single sample was written
  const r = render(p, 0.3, 'pluck');
  p.msg({ type: 'capture', action: 'rec' });
  render(p, 0.3, 'pluck');
  p.msg({ type: 'capture', action: 'stop' });
  const r1 = render(p, 0.3, 'pluck');
  p.msg({ type: 'capture', action: 'rec' });
  render(p, 0.5, 'pluck');
  p.msg({ type: 'capture', action: 'play' });
  const r2 = render(p, 0.5, 'silence');
  check('Capture stop during recording is clean', r.finite && r.rms > 0.01 && r1.finite && r1.rms > 0.01 && p.cap.state === 'play' && r2.finite && r2.rms > 0.01, { r, r1, r2, state: p.cap.state });
}
{ // Vibrato at full depth and drift must never read at the write head
  const p = new ChromaProcessor();
  for (let k = 0; k < 4; k++) p.mods[k].bypassed = k !== 1;
  p.mods[1].sel = 1;
  for (const key of ['movAmount', 'movDrift', 'movRate']) p.P[key] = p.S[key] = 1;
  const dly = p.mods[1].fx[1].d[0], tap = dly.tap.bind(dly);
  let minD = Infinity;
  dly.tap = (d) => { if (d < minD) minD = d; return tap(d); };
  render(p, 4, 'pluck');
  check(`Vibrato delay stays above the write head (min ${minD.toFixed(1)} samples)`, minD > 2, minD);
}
{ // a delay that was bypassed must not replay old echoes when switched back on
  const p = new ChromaProcessor();
  for (let k = 0; k < 4; k++) p.mods[k].bypassed = k !== 2;
  p.mods[2].sel = 0; // Cascade
  p.P.difAmount = p.S.difAmount = 0.9;
  render(p, 1, 'loud');
  p.msg({ type: 'moduleBypass', module: 2, on: true });
  render(p, 0.3, 'silence');
  p.msg({ type: 'moduleBypass', module: 2, on: false });
  const r = render(p, 1.5, 'silence');
  check('re-enabled delay starts clean', r.peak < 1e-3, r);
}

console.log(failures ? `\n${failures} FAILURES` : '\nAll DSP checks passed.');
process.exit(failures ? 1 : 0);
