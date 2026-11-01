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
console.log(failures ? `\n${failures} FAILURES` : '\nAll DSP checks passed.');
process.exit(failures ? 1 : 0);
