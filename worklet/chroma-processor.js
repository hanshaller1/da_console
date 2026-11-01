/*
 * Chroma Console Web – DSP engine
 * ---------------------------------------------------------------
 * Runs inside an AudioWorklet. Everything (20 effects, module
 * routing, capture looper, mix stage) is computed per sample in JS.
 * The file is self-contained so it can also be loaded in Node for
 * the offline stability test in /test.
 */

/* global sampleRate, registerProcessor, AudioWorkletProcessor */
const SR = typeof sampleRate !== 'undefined' ? sampleRate : 48000;
const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const db2g = (db) => Math.pow(10, db / 20);
const expMap = (v, lo, hi) => lo * Math.pow(hi / lo, v);
// rational tanh approximation, exact 1 at |x| >= 3
const softclip = (x) => (x > 3 ? 1 : x < -3 ? -1 : (x * (27 + x * x)) / (27 + 9 * x * x));
const hann = (p) => 0.5 - 0.5 * Math.cos(TAU * p);

/* ---------------------------------------------------------------- */
/* Building blocks                                                   */
/* ---------------------------------------------------------------- */

class Delay {
  constructor(len) {
    let n = 1;
    while (n < len + 4) n <<= 1;
    this.b = new Float32Array(n);
    this.m = n - 1;
    this.w = 0;
    this.max = n - 3;
  }
  push(x) {
    this.b[this.w] = x;
    this.w = (this.w + 1) & this.m;
  }
  // d >= 1 : 1 = most recent sample
  tap(d) {
    if (d < 1) d = 1;
    else if (d > this.max) d = this.max;
    const p = this.w - d;
    const i = Math.floor(p);
    const f = p - i;
    const a = this.b[i & this.m];
    return a + (this.b[(i + 1) & this.m] - a) * f;
  }
  clear() {
    this.b.fill(0);
  }
}

class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }
  set(type, f, q = 0.707, db = 0) {
    const w0 = (TAU * clamp(f, 10, SR * 0.48)) / SR;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const A = Math.pow(10, db / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lp': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'hp': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'bp': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
      case 'peak': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
      case 'ls': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
        a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s;
        break;
      }
      case 'hs': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
        a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s;
        break;
      }
      default: b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  p(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = this.z2 = 0; }
}
const biq2 = () => [new Biquad(), new Biquad()];
const set2 = (pair, ...args) => { pair[0].set(...args); pair[1].set(...args); };
const reset2 = (pair) => { pair[0].reset(); pair[1].reset(); };

class LP1 {
  constructor(f = 1000) { this.y = 0; this.setF(f); }
  setF(f) { this.a = 1 - Math.exp((-TAU * f) / SR); }
  p(x) { return (this.y += this.a * (x - this.y)); }
}

// Topology-preserving state variable filter
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.bp = 0; this.hp = 0; this.set(1000, 0.7); }
  set(f, q) {
    const g = Math.tan((Math.PI * clamp(f, 10, SR * 0.45)) / SR);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  p(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = x - this.k * v1 - v2;
    return v1;
  }
  reset() { this.ic1 = this.ic2 = 0; }
}

// smooth random walk in [-1, 1]
class Wander {
  constructor(rate = 0.3) { this.v = 0; this.t = 0; this.cnt = 0; this.rate = rate; }
  next() {
    if (--this.cnt <= 0) {
      this.t = Math.random() * 2 - 1;
      this.cnt = (SR / this.rate) * (0.5 + Math.random());
    }
    this.v += (this.t - this.v) * ((this.rate * 4) / SR);
    return this.v;
  }
}

class Allpass {
  constructor(len, g) { this.d = new Delay(len + 2); this.len = len; this.g = g; }
  p(x) {
    const v = this.d.tap(this.len);
    const w = x + this.g * v;
    this.d.push(w);
    return v - this.g * w;
  }
  clear() { this.d.clear(); }
}

/* ---------------------------------------------------------------- */
/* CHARACTER                                                         */
/* ---------------------------------------------------------------- */

class Drive {
  constructor() { this.hp = biq2(); this.mid = biq2(); this.lp = biq2(); this.last = -1; }
  reset() { reset2(this.hp); reset2(this.mid); reset2(this.lp); }
  process(L, R, n, p) {
    const a = p.amount;
    if (Math.abs(a - this.last) > 1e-3) {
      this.last = a;
      set2(this.hp, 'hp', 70, 0.7);
      set2(this.mid, 'peak', 720, 0.8, a * 8);
      set2(this.lp, 'lp', 11000 - a * 6500, 0.7);
    }
    const g = 1 + a * a * 45, c = 1 / (1 + a * 2.4);
    for (let ch = 0; ch < 2; ch++) {
      const X = ch ? R : L, hp = this.hp[ch], mid = this.mid[ch], lp = this.lp[ch];
      for (let i = 0; i < n; i++) {
        const x = mid.p(hp.p(X[i])) * g;
        const y = x >= 0 ? softclip(x) : softclip(x * 1.25) * 0.8;
        X[i] = lp.p(y) * c;
      }
    }
  }
}

class Sweeten {
  constructor() { this.env = 0; this.ls = biq2(); this.pk = biq2(); this.hs = biq2(); this.last = -1; }
  reset() { this.env = 0; reset2(this.ls); reset2(this.pk); reset2(this.hs); }
  process(L, R, n, p) {
    const a = p.amount;
    if (Math.abs(a - this.last) > 1e-3) {
      this.last = a;
      set2(this.ls, 'ls', 140, 0.707, a * 4);
      set2(this.pk, 'peak', 2600, 0.7, a * 4.5);
      set2(this.hs, 'hs', 9000, 0.707, a * 3);
    }
    const th = db2g(-14 - a * 16), makeup = db2g(a * 9);
    const att = 1 - Math.exp(-1 / (0.004 * SR)), rel = 1 - Math.exp(-1 / (0.15 * SR));
    const drive = 1 + a * 1.6;
    for (let i = 0; i < n; i++) {
      const lvl = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env += (lvl > this.env ? att : rel) * (lvl - this.env);
      const gr = this.env > th ? Math.pow(th / this.env, 0.66) : 1;
      const g = gr * makeup;
      let l = this.hs[0].p(this.pk[0].p(this.ls[0].p(L[i] * g)));
      let r = this.hs[1].p(this.pk[1].p(this.ls[1].p(R[i] * g)));
      L[i] = softclip(l * drive) / drive * 1.05;
      R[i] = softclip(r * drive) / drive * 1.05;
    }
  }
}

class Fuzz {
  constructor() { this.hp = biq2(); this.lp = biq2(); this.dc = [0, 0, 0, 0]; this.last = -1; }
  reset() { reset2(this.hp); reset2(this.lp); this.dc.fill(0); }
  process(L, R, n, p) {
    const a = p.amount;
    if (Math.abs(a - this.last) > 1e-3) {
      this.last = a;
      set2(this.hp, 'hp', 110, 0.7);
      // "blown speaker" – the tone gets darker and boxier at the top end
      set2(this.lp, 'lp', 4200 - a * 2000, 0.9 + a * 0.6);
    }
    const g = 6 + a * a * 320, bias = 0.15 + a * 0.35;
    const sb = softclip(bias);
    for (let ch = 0; ch < 2; ch++) {
      const X = ch ? R : L, hp = this.hp[ch], lp = this.lp[ch];
      let x1 = this.dc[ch * 2], y1 = this.dc[ch * 2 + 1];
      for (let i = 0; i < n; i++) {
        const x = hp.p(X[i]) * g;
        let y = softclip(x + bias) - sb;
        y = clamp(y * 1.4, -0.9, 0.75);
        const d = y - x1 + 0.995 * y1; // DC blocker
        x1 = y; y1 = d;
        X[i] = lp.p(d) * 0.38;
      }
      this.dc[ch * 2] = x1; this.dc[ch * 2 + 1] = y1;
    }
  }
}

class Howl {
  constructor() { this.svf = [new SVF(), new SVF()]; this.env = 0; this.lp = biq2(); this.cnt = 0; set2(this.lp, 'lp', 5000); }
  reset() { this.svf[0].reset(); this.svf[1].reset(); this.env = 0; reset2(this.lp); }
  process(L, R, n, p) {
    const a = p.amount;
    const q = 3 + a * 14, gain = 12 + a * 90;
    const att = 1 - Math.exp(-1 / (0.002 * SR)), rel = 1 - Math.exp(-1 / (0.12 * SR));
    for (let i = 0; i < n; i++) {
      const lvl = Math.abs(L[i]) + Math.abs(R[i]);
      this.env += (lvl > this.env ? att : rel) * (lvl - this.env);
      if ((this.cnt++ & 15) === 0) {
        const f = 260 * Math.pow(2, clamp(this.env * 9, 0, 3.6));
        this.svf[0].set(f, q); this.svf[1].set(f * 1.04, q);
      }
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L;
        const s = softclip(X[i] * gain);
        const bp = this.svf[ch].p(s);
        X[i] = this.lp[ch].p(softclip(bp * 1.5 + s * 0.25)) * 0.42;
      }
    }
  }
}

class Swell {
  constructor() { this.reset(); }
  reset() { this.fast = 0; this.slow = 0; this.g = 1; this.mode = 0; this.hold = 0; }
  process(L, R, n, p) {
    const riseT = 0.06 + p.amount * p.amount * 3.2;
    const up = 1 / (riseT * SR), down = 1 / (0.006 * SR);
    const fa = 1 - Math.exp(-1 / (0.0015 * SR)), fr = 1 - Math.exp(-1 / (0.03 * SR));
    const sa = 1 - Math.exp(-1 / (0.06 * SR));
    for (let i = 0; i < n; i++) {
      const lvl = Math.abs(L[i]) + Math.abs(R[i]);
      this.fast += (lvl > this.fast ? fa : fr) * (lvl - this.fast);
      this.slow += sa * (this.fast - this.slow);
      if (this.hold > 0) this.hold--;
      else if (this.fast > 0.015 && this.fast > this.slow * 1.7) {
        this.mode = 1; // dip -> then rise
        this.hold = Math.floor(0.09 * SR);
      }
      if (this.mode === 1) {
        this.g -= down;
        if (this.g <= 0) { this.g = 0; this.mode = 2; }
      } else if (this.mode === 2) {
        this.g += up;
        if (this.g >= 1) { this.g = 1; this.mode = 0; }
      }
      const k = this.g * this.g * (3 - 2 * this.g);
      L[i] *= k; R[i] *= k;
    }
  }
}

/* ---------------------------------------------------------------- */
/* MOVEMENT                                                          */
/* ---------------------------------------------------------------- */

const rateHz = (r) => expMap(r, 0.05, 14);

class Doubler {
  constructor() { this.d = [new Delay(0.1 * SR), new Delay(0.1 * SR)]; this.ph = 0; this.w = new Wander(0.6); }
  reset() { this.d[0].clear(); this.d[1].clear(); }
  process(L, R, n, p) {
    const inc = (rateHz(p.rate) * 0.18) / SR;
    const depth = 0.0012 * SR * (0.25 + p.amount);
    const mix = p.amount;
    for (let i = 0; i < n; i++) {
      this.ph += inc; if (this.ph >= 1) this.ph -= 1;
      const wv = this.w.next() * (0.3 + p.drift * 2);
      const dl = 0.014 * SR + depth * (1 + Math.sin(TAU * this.ph) + wv);
      const dr = 0.022 * SR + depth * (1 + Math.sin(TAU * (this.ph + 0.37)) - wv);
      const xl = L[i], xr = R[i];
      const tl = this.d[0].tap(dl), tr = this.d[1].tap(dr);
      this.d[0].push(xl); this.d[1].push(xr);
      L[i] = xl * (1 - 0.35 * mix) + tr * 0.85 * mix;
      R[i] = xr * (1 - 0.35 * mix) + tl * 0.85 * mix;
    }
  }
}

class Vibrato {
  constructor() { this.d = [new Delay(0.03 * SR), new Delay(0.03 * SR)]; this.ph = 0; this.w = new Wander(0.5); }
  reset() { this.d[0].clear(); this.d[1].clear(); }
  process(L, R, n, p) {
    const inc = rateHz(p.rate) / SR;
    const depth = 0.0045 * SR * p.amount;
    for (let i = 0; i < n; i++) {
      const wv = this.w.next() * p.drift;
      this.ph += inc * (1 + wv * 0.6); if (this.ph >= 1) this.ph -= 1;
      const m = Math.sin(TAU * this.ph);
      const d = 0.006 * SR + depth * m + depth * 0.5 * wv;
      const l = this.d[0].tap(d), r = this.d[1].tap(d);
      this.d[0].push(L[i]); this.d[1].push(R[i]);
      L[i] = l; R[i] = r;
    }
  }
}

class Phaser {
  constructor() { this.z = [new Float64Array(6), new Float64Array(6)]; this.fb = [0, 0]; this.ph = 0; this.a = [0, 0]; this.w = new Wander(0.25); }
  reset() { this.z[0].fill(0); this.z[1].fill(0); this.fb = [0, 0]; }
  process(L, R, n, p) {
    const inc = rateHz(p.rate) / SR;
    const range = 2 + 3.5 * p.amount;
    const feedback = 0.2 + 0.5 * p.amount;
    for (let i = 0; i < n; i++) {
      const wv = this.w.next() * p.drift;
      this.ph += inc * (1 + wv * 0.7); if (this.ph >= 1) this.ph -= 1;
      if ((i & 7) === 0) {
        for (let ch = 0; ch < 2; ch++) {
          const lfo = 0.5 - 0.5 * Math.cos(TAU * (this.ph + ch * 0.25));
          const fc = Math.min(180 * Math.pow(2, lfo * range), SR * 0.4);
          const t = Math.tan((Math.PI * fc) / SR);
          this.a[ch] = (t - 1) / (t + 1);
        }
      }
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L, z = this.z[ch], a = this.a[ch];
        const x = X[i];
        let y = x + this.fb[ch] * feedback;
        for (let k = 0; k < 6; k++) {
          const v = a * y + z[k];
          z[k] = y - a * v;
          y = v;
        }
        this.fb[ch] = softclip(y);
        X[i] = 0.5 * (x + y) * 1.2;
      }
    }
  }
}

class Tremolo {
  constructor() { this.ph = 0; }
  reset() {}
  process(L, R, n, p) {
    const inc = rateHz(p.rate) / SR;
    const depth = p.amount;
    const off = p.drift * 0.5; // drift spreads the phase -> auto-pan at max
    for (let i = 0; i < n; i++) {
      this.ph += inc; if (this.ph >= 1) this.ph -= 1;
      // slightly squared-off sine
      const sl = softclip(2.2 * Math.sin(TAU * this.ph)) * 0.5 + 0.5;
      const sr = softclip(2.2 * Math.sin(TAU * (this.ph + off))) * 0.5 + 0.5;
      L[i] *= 1 - depth * sl;
      R[i] *= 1 - depth * sr;
    }
  }
}

class Pitch {
  constructor() { this.d = [new Delay(0.2 * SR), new Delay(0.2 * SR)]; this.ph = 0; this.w = new Wander(0.4); this.W = 0.07 * SR; }
  reset() { this.d[0].clear(); this.d[1].clear(); }
  static semis(a) { return Math.round(-12 + 24 * a); }
  process(L, R, n, p) {
    const semis = Pitch.semis(p.amount);
    const mix = p.rate;
    const W = this.W;
    for (let i = 0; i < n; i++) {
      const s = semis + this.w.next() * p.drift * 0.35;
      const ratio = Math.pow(2, s / 12);
      this.ph += (1 - ratio) / W;
      this.ph -= Math.floor(this.ph);
      const pa = this.ph, pb = (this.ph + 0.5) % 1;
      const ga = hann(pa), gb = hann(pb);
      const da = pa * W + 2, dbb = pb * W + 2;
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L, d = this.d[ch];
        const x = X[i];
        d.push(x);
        const y = d.tap(da) * ga + d.tap(dbb) * gb;
        X[i] = x * (1 - mix) + y * mix;
      }
    }
  }
}

/* ---------------------------------------------------------------- */
/* DIFFUSION  (wet only – the module adds the dry signal)            */
/* ---------------------------------------------------------------- */

const delayTime = (t) => expMap(t, 0.04, 1.5);

class Cascade {
  constructor() {
    this.wetOnly = true;
    this.d = [new Delay(1.6 * SR), new Delay(1.6 * SR)];
    this.ds = 0.3 * SR;
    this.lp = [new LP1(3000), new LP1(3000)];
    this.hp = [new LP1(90), new LP1(90)];
    this.w = new Wander(0.35); this.ph = 0;
  }
  reset() { this.d[0].clear(); this.d[1].clear(); this.lp[0].y = this.lp[1].y = this.hp[0].y = this.hp[1].y = 0; }
  process(L, R, n, p) {
    const target = delayTime(p.time) * SR;
    const fb = p.amount * 1.06;
    const cut = 4800 - p.time * 3000;
    this.lp[0].setF(cut); this.lp[1].setF(cut * 0.95);
    for (let i = 0; i < n; i++) {
      this.ds += (target - this.ds) * 0.00012; // BBD clock glide
      this.ph += 0.6 / SR; if (this.ph >= 1) this.ph -= 1;
      const mod = 1 + 0.0006 * Math.sin(TAU * this.ph * 7) + p.drift * (0.006 * Math.sin(TAU * this.ph) + 0.004 * this.w.next());
      const yl = this.d[0].tap(this.ds * mod), yr = this.d[1].tap(this.ds * mod * 0.985);
      for (let ch = 0; ch < 2; ch++) {
        const y = ch ? yr : yl;
        const f = this.lp[ch].p(y);
        const h = f - this.hp[ch].p(f);
        this.d[ch].push(softclip((ch ? R : L)[i] * 0.9 + h * fb));
      }
      L[i] = yl; R[i] = yr;
    }
  }
}

class Reels {
  constructor() {
    this.wetOnly = true;
    this.d = [new Delay(3.1 * SR), new Delay(3.1 * SR)];
    this.ds = 0.3 * SR;
    this.lp = [new LP1(3500), new LP1(3500)];
    this.hp = [new LP1(150), new LP1(150)];
    this.w = new Wander(0.5); this.wow = 0; this.flt = 0;
  }
  reset() { this.d[0].clear(); this.d[1].clear(); this.lp[0].y = this.lp[1].y = this.hp[0].y = this.hp[1].y = 0; }
  process(L, R, n, p) {
    const target = delayTime(p.time) * SR;
    const fb = p.amount * 1.02;
    const head2 = clamp((p.amount - 0.35) * 1.6, 0, 0.7);
    const wd = 0.0015 + p.drift * 0.006, fd = 0.0004 + p.drift * 0.0012;
    for (let i = 0; i < n; i++) {
      this.ds += (target - this.ds) * 0.00005; // motor speed change
      this.wow += 0.55 / SR; if (this.wow >= 1) this.wow -= 1;
      this.flt += 6.3 / SR; if (this.flt >= 1) this.flt -= 1;
      const mod = 1 + wd * Math.sin(TAU * this.wow) + fd * Math.sin(TAU * this.flt) + wd * 0.5 * this.w.next();
      const d1 = this.ds * mod;
      const h1l = this.d[0].tap(d1), h1r = this.d[1].tap(d1 * 1.01);
      const h2l = this.d[0].tap(d1 * 2), h2r = this.d[1].tap(d1 * 2.01);
      for (let ch = 0; ch < 2; ch++) {
        const h = ch ? h1r : h1l;
        const f = this.lp[ch].p(h);
        const g = f - this.hp[ch].p(f);
        this.d[ch].push(softclip(((ch ? R : L)[i] + g * fb) * 1.2) / 1.2);
      }
      L[i] = h1l + h2r * head2;
      R[i] = h1r + h2l * head2;
    }
  }
}

const FDN_MS = [29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.7, 73.1];
class Space {
  constructor() {
    this.wetOnly = true;
    this.lines = FDN_MS.map((ms) => new Delay((ms / 1000) * SR * 2.9 + 64));
    this.damp = FDN_MS.map(() => new LP1(6500));
    this.ap = [4.7, 3.6, 12.7, 9.3].map((ms) => new Allpass(Math.round((ms / 1000) * SR), 0.65));
    this.o = new Float64Array(8);
    this.sz = 1; this.ph = 0;
    this.sign = [1, -1, 1, -1, -1, 1, -1, 1];
  }
  reset() { this.lines.forEach((l) => l.clear()); this.ap.forEach((a) => a.clear()); this.damp.forEach((d) => (d.y = 0)); }
  process(L, R, n, p) {
    const size = 0.35 + p.time * 2.4;
    const freeze = p.amount > 0.97;
    const rt = 0.4 + p.amount * p.amount * 22;
    const gains = new Float64Array(8);
    const base = FDN_MS.map((ms) => (ms / 1000) * SR);
    for (let k = 0; k < 8; k++) gains[k] = freeze ? 0.9995 : Math.pow(10, (-3 * base[k] * this.sz) / (rt * SR));
    const modA = 2 + p.drift * 14;
    const inGain = freeze ? 0.05 : 1;
    const o = this.o;
    for (let i = 0; i < n; i++) {
      this.sz += (size - this.sz) * 0.00008;
      this.ph += 0.45 / SR; if (this.ph >= 1) this.ph -= 1;
      let x = (L[i] + R[i]) * 0.5 * inGain;
      for (let a = 0; a < 4; a++) x = this.ap[a].p(x);
      for (let k = 0; k < 8; k++) {
        let d = base[k] * this.sz;
        if (k < 4) d += modA * Math.sin(TAU * (this.ph + k * 0.25));
        o[k] = this.damp[k].p(this.lines[k].tap(d));
      }
      const outL = (o[0] - o[2] + o[4] - o[6]) * 0.4;
      const outR = (o[1] - o[3] + o[5] - o[7]) * 0.4;
      // fast 8-point Hadamard
      for (let h = 1; h < 8; h <<= 1) {
        for (let s = 0; s < 8; s += h << 1) {
          for (let j = s; j < s + h; j++) {
            const u = o[j], v = o[j + h];
            o[j] = u + v; o[j + h] = u - v;
          }
        }
      }
      const norm = 0.35355339059327373;
      for (let k = 0; k < 8; k++) this.lines[k].push(x * this.sign[k] + o[k] * norm * gains[k]);
      L[i] = outL; R[i] = outR;
    }
  }
}

class Collage {
  constructor() {
    this.wetOnly = true;
    this.N = 1 << 19; this.mask = this.N - 1;
    this.bl = new Float32Array(this.N); this.br = new Float32Array(this.N);
    this.w = 0; this.fl = 0; this.fr = 0;
    this.voices = [0, 1, 2].map((k) => ({ active: false, wait: Math.floor((0.2 + k * 0.35) * SR) }));
  }
  reset() {
    this.bl.fill(0); this.br.fill(0); this.fl = this.fr = 0;
    this.voices.forEach((v, k) => { v.active = false; v.wait = Math.floor((0.25 + k * 0.4) * SR); });
  }
  start(v, len, p) {
    v.len = Math.max(0.03 * SR, len * (0.5 + Math.random()));
    const look = Math.min(4 * SR, this.N / 2 - v.len * 3);
    v.s = this.w - v.len * 2 - Math.random() * look;
    const r = Math.random();
    const choices = [-1, 2, 0.5, -0.5, -2];
    v.speed = r < p.drift * 0.75 ? choices[Math.floor(Math.random() * choices.length)] : 1;
    v.reps = 1 + Math.floor(Math.random() * (1 + p.amount * 6));
    v.rep = 0; v.t = 0;
    v.pan = Math.random();
    v.active = true;
  }
  process(L, R, n, p) {
    const len = expMap(p.time, 0.06, 1.6) * SR;
    const fade = 0.012 * SR;
    const fb = p.amount * 0.45;
    for (let i = 0; i < n; i++) {
      this.bl[this.w & this.mask] = L[i] + this.fl * fb;
      this.br[this.w & this.mask] = R[i] + this.fr * fb;
      this.w++;
      if (this.w > 1e9) this.w -= this.N * 1000; // keep integer range safe
      let ol = 0, or = 0;
      for (const v of this.voices) {
        if (!v.active) {
          if (--v.wait <= 0) this.start(v, len, p);
          else continue;
        }
        const sp = Math.abs(v.speed);
        const prog = (v.t * sp) / v.len;
        if (prog >= 1) {
          v.rep++; v.t = 0;
          if (v.rep >= v.reps) {
            v.active = false;
            v.wait = Math.floor((0.03 + Math.random() * (1.15 - p.amount) * 1.6) * SR);
          }
          continue;
        }
        const pos = v.speed > 0 ? v.s + prog * v.len : v.s + (1 - prog) * v.len;
        const i0 = Math.floor(pos), f = pos - i0;
        const a = this.bl[i0 & this.mask], b = this.bl[(i0 + 1) & this.mask];
        const c = this.br[i0 & this.mask], d = this.br[(i0 + 1) & this.mask];
        const edge = Math.min(1, (prog * v.len) / fade, ((1 - prog) * v.len) / fade);
        const sl = (a + (b - a) * f) * edge, sr = (c + (d - c) * f) * edge;
        ol += sl * (1.2 - v.pan * 0.8);
        or += sr * (0.4 + v.pan * 0.8);
        v.t++;
      }
      this.fl = softclip(ol * 0.7); this.fr = softclip(or * 0.7);
      L[i] = this.fl; R[i] = this.fr;
    }
  }
}

class Reverse {
  constructor() {
    this.wetOnly = true;
    this.d = [new Delay(3.3 * SR), new Delay(3.3 * SR)];
    this.T = 0.4 * SR; this.ph = 0; this.w = new Wander(0.5);
  }
  reset() { this.d[0].clear(); this.d[1].clear(); this.ph = 0; }
  process(L, R, n, p) {
    const target = expMap(p.time, 0.1, 1.5) * SR;
    const fb = p.amount * 0.85;
    for (let i = 0; i < n; i++) {
      this.T += (target - this.T) * 0.00004;
      this.ph += 1 / this.T; if (this.ph >= 1) this.ph -= 1;
      const pa = this.ph, pb = (this.ph + 0.5) % 1;
      const wob = 1 + p.drift * 0.012 * this.w.next();
      const da = 2 * pa * this.T * wob + 1, dbb = 2 * pb * this.T * wob + 1;
      const ga = hann(pa), gb = hann(pb);
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L, d = this.d[ch];
        const y = d.tap(da) * ga + d.tap(dbb) * gb;
        d.push(softclip(X[i] + y * fb));
        X[i] = y;
      }
    }
  }
}

/* ---------------------------------------------------------------- */
/* TEXTURE                                                           */
/* ---------------------------------------------------------------- */

class Filter {
  constructor() { this.f = [new SVF(), new SVF()]; this.cnt = 0; this.fc = 1000; }
  reset() { this.f[0].reset(); this.f[1].reset(); }
  static describe(a) {
    if (a < 0.47) return { mode: 'LP', f: expMap(a / 0.47, 160, 20000) };
    if (a > 0.53) return { mode: 'HP', f: expMap((a - 0.53) / 0.47, 20, 5000) };
    return { mode: 'OFF', f: 0 };
  }
  process(L, R, n, p) {
    const { mode, f } = Filter.describe(p.amount);
    if (mode === 'OFF') return;
    const q = 1.4;
    for (let i = 0; i < n; i++) {
      if ((this.cnt++ & 15) === 0) {
        this.fc += (f - this.fc) * 0.3;
        this.f[0].set(this.fc, q); this.f[1].set(this.fc, q);
      }
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L, s = this.f[ch];
        s.p(X[i]);
        X[i] = mode === 'LP' ? s.lp : s.hp;
      }
    }
  }
}

class Squash {
  constructor() { this.env = 0; }
  reset() { this.env = 0; }
  process(L, R, n, p) {
    const a = p.amount;
    const th = db2g(-6 - a * 38);
    const makeup = db2g(a * 26);
    const att = 1 - Math.exp(-1 / (0.0006 * SR)), rel = 1 - Math.exp(-1 / (0.09 * SR));
    const drive = 1 + a * 2.5;
    for (let i = 0; i < n; i++) {
      const lvl = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      this.env += (lvl > this.env ? att : rel) * (lvl - this.env);
      const gr = this.env > th ? Math.pow(th / this.env, 0.92) : 1;
      const g = gr * makeup;
      L[i] = softclip(L[i] * g * drive) / Math.sqrt(drive);
      R[i] = softclip(R[i] * g * drive) / Math.sqrt(drive);
    }
  }
}

class Cassette {
  constructor() {
    this.d = [new Delay(0.06 * SR), new Delay(0.06 * SR)];
    this.lp = biq2(); this.hp = biq2(); this.hiss = new LP1(5000);
    this.wow = 0; this.flt = 0; this.w = new Wander(0.8);
    this.drop = 1; this.dropT = 1; this.dropCnt = SR; this.last = -1;
  }
  reset() { this.d[0].clear(); this.d[1].clear(); reset2(this.lp); reset2(this.hp); }
  process(L, R, n, p) {
    const a = p.amount;
    if (Math.abs(a - this.last) > 1e-3) {
      this.last = a;
      set2(this.lp, 'lp', 9500 - a * 6500, 0.8);
      set2(this.hp, 'hp', 60 + a * 80, 0.7);
    }
    const wd = (0.0004 + a * 0.0028) * SR, fd = (0.00005 + a * 0.0003) * SR;
    const noise = a * 0.012;
    for (let i = 0; i < n; i++) {
      this.wow += 0.45 / SR; if (this.wow >= 1) this.wow -= 1;
      this.flt += 8.5 / SR; if (this.flt >= 1) this.flt -= 1;
      const dd = 0.012 * SR + wd * (Math.sin(TAU * this.wow) + 0.5 * this.w.next()) + fd * Math.sin(TAU * this.flt);
      // dropouts
      if (--this.dropCnt <= 0) {
        if (this.dropT < 1) { this.dropT = 1; this.dropCnt = Math.floor((0.5 + Math.random() * 4) * SR); }
        else if (Math.random() < a * a) { this.dropT = 0.15 + Math.random() * 0.4; this.dropCnt = Math.floor((0.04 + Math.random() * 0.2) * SR); }
        else this.dropCnt = Math.floor(0.5 * SR);
      }
      this.drop += (this.dropT - this.drop) * 0.002;
      const hs = this.hiss.p(Math.random() * 2 - 1) * noise;
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L, d = this.d[ch];
        d.push(X[i]);
        let y = d.tap(dd + ch * 3);
        y = softclip(y * (1 + a)) / (1 + a * 0.6);
        y = this.lp[ch].p(this.hp[ch].p(y)) * this.drop + hs;
        X[i] = y;
      }
    }
  }
}

class Broken {
  constructor() {
    this.d = [new Delay(0.12 * SR), new Delay(0.12 * SR)];
    this.evt = -1; this.timer = SR; this.len = SR; this.depth = 0; this.am = 0;
  }
  reset() { this.d[0].clear(); this.d[1].clear(); this.evt = -1; this.timer = Math.floor(0.6 * SR); }
  process(L, R, n, p) {
    const a = p.amount;
    for (let i = 0; i < n; i++) {
      let env = 0;
      if (this.evt < 0) {
        if (--this.timer <= 0) {
          this.evt = 0;
          this.len = (0.25 + Math.random() * 0.55) * SR;
          this.depth = (0.012 + a * 0.06) * SR * (0.5 + Math.random() * 0.5);
        }
      } else {
        this.evt += 1 / this.len;
        if (this.evt >= 1) {
          this.evt = -1;
          this.timer = Math.floor((0.35 + Math.random() * 3.2 * (1.1 - a)) * SR);
        } else {
          env = this.evt < 0.6 ? Math.pow(this.evt / 0.6, 2) : 1 - (this.evt - 0.6) / 0.4;
        }
      }
      const e = this.depth * (0.5 - 0.5 * Math.cos(Math.PI * env));
      this.am += (14 + a * 10) / SR; if (this.am >= 1) this.am -= 1;
      const g = 1 - env * (0.25 + a * 0.55) * (0.5 + 0.5 * Math.sin(TAU * this.am));
      const dd = 0.004 * SR + e;
      for (let ch = 0; ch < 2; ch++) {
        const X = ch ? R : L, d = this.d[ch];
        d.push(X[i]);
        X[i] = d.tap(dd) * g;
      }
    }
  }
}

class Interference {
  constructor() {
    this.hold = [0, 0]; this.cnt = 0; this.burst = 0; this.bp = new Biquad().set('bp', 2400, 2);
    this.w = new Wander(0.7); this.tone = 0; this.toneF = 1500; this.click = 0;
  }
  reset() { this.burst = 0; this.bp.reset(); }
  process(L, R, n, p) {
    const a = p.amount;
    const div = 1 + Math.floor(a * a * 22);
    const q = Math.pow(2, 15 - a * 11.5);
    const burstDecay = Math.exp(-1 / (0.18 * SR));
    for (let i = 0; i < n; i++) {
      if (this.cnt++ % div === 0) {
        this.hold[0] = Math.round(L[i] * q) / q;
        this.hold[1] = Math.round(R[i] * q) / q;
      }
      if (Math.random() < (a * 1.6) / SR) { this.burst = 1; this.toneF = 700 + Math.random() * 2600; }
      this.burst *= burstDecay;
      this.tone += this.toneF * (1 - this.burst * 0.3) / SR; if (this.tone >= 1) this.tone -= 1;
      const nz = this.bp.p(Math.random() * 2 - 1);
      let crackle = 0;
      if (Math.random() < (a * 25) / SR) this.click = (Math.random() * 2 - 1) * 0.25;
      crackle = this.click; this.click *= 0.6;
      const dis = 1 - a * 0.75 * Math.max(0, this.w.next());
      const noise = (nz * 0.5 + Math.sin(TAU * this.tone) * 0.06) * this.burst * a + crackle * a;
      L[i] = this.hold[0] * dis + noise;
      R[i] = this.hold[1] * dis + noise * 0.9;
    }
  }
}

/* ---------------------------------------------------------------- */
/* Modules                                                           */
/* ---------------------------------------------------------------- */

const volGain = (v) => (v * 1.4) * (v * 1.4);

class Module {
  constructor(effects) {
    this.fx = effects;
    this.sel = 0; this.pending = -1;
    this.sw = 1; this.byG = 1; this.bypassed = false;
    this.dl = new Float32Array(128); this.dr = new Float32Array(128);
    this.swStep = 1 / (0.015 * SR); this.byStep = 1 / (0.02 * SR);
  }
  select(i) { this.pending = i === this.sel ? -1 : i; }
  pre() {}
  post() {}
  process(L, R, n, p) {
    if (this.pending >= 0 && this.sw <= 0) {
      this.sel = this.pending; this.pending = -1;
      this.fx[this.sel].reset();
    }
    if (this.bypassed && this.byG <= 0 && this.pending < 0) return;
    if (this.dl.length < n) { this.dl = new Float32Array(n); this.dr = new Float32Array(n); }
    const dl = this.dl, dr = this.dr;
    dl.set(L.subarray(0, n)); dr.set(R.subarray(0, n));
    const fx = this.fx[this.sel];
    this.pre(L, R, n, p);
    fx.process(L, R, n, p);
    const g = volGain(p.vol);
    if (fx.wetOnly) {
      for (let i = 0; i < n; i++) { L[i] = dl[i] + L[i] * g; R[i] = dr[i] + R[i] * g; }
    } else {
      for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
    }
    this.post(L, R, n, p);
    const byT = this.bypassed ? 0 : 1;
    const swT = this.pending >= 0 ? 0 : 1;
    for (let i = 0; i < n; i++) {
      this.byG += clamp(byT - this.byG, -this.byStep, this.byStep);
      this.sw += clamp(swT - this.sw, -this.swStep, this.swStep);
      const k = this.byG * this.sw;
      if (k < 1) { L[i] = dl[i] + (L[i] - dl[i]) * k; R[i] = dr[i] + (R[i] - dr[i]) * k; }
    }
  }
}

class CharacterModule extends Module {
  constructor(effects) { super(effects); this.ls = biq2(); this.hs = biq2(); this.lt = -1; }
  pre(L, R, n, p) {
    // SENSITIVITY: how hard the instrument hits the saturation stage
    const g = Math.pow(4, p.sens * 2 - 1);
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
    this.comp = 1 / Math.sqrt(g);
  }
  post(L, R, n, p) {
    // TILT: tonal see-saw around ~800 Hz
    if (Math.abs(p.tilt - this.lt) > 1e-3) {
      this.lt = p.tilt;
      const t = (p.tilt - 0.5) * 2;
      set2(this.ls, 'ls', 380, 0.707, -t * 9);
      set2(this.hs, 'hs', 1700, 0.707, t * 9);
    }
    const c = this.comp;
    for (let i = 0; i < n; i++) {
      L[i] = this.hs[0].p(this.ls[0].p(L[i])) * c;
      R[i] = this.hs[1].p(this.ls[1].p(R[i])) * c;
    }
  }
}

/* ---------------------------------------------------------------- */
/* Capture looper                                                    */
/* ---------------------------------------------------------------- */

class Capture {
  constructor() {
    this.max = Math.floor(30 * SR);
    this.l = new Float32Array(this.max); this.r = new Float32Array(this.max);
    this.state = 'idle'; this.len = 0; this.pos = 0; this.short = false; this.gain = 0;
    this.fade = Math.floor(0.02 * SR);
  }
  rec() { this.state = 'rec'; this.len = 0; this.pos = 0; }
  play() {
    if (this.state !== 'rec') return;
    if (this.len < 0.08 * SR) { this.state = 'idle'; this.len = 0; return; }
    const f = Math.min(Math.floor(0.004 * SR), this.len >> 3);
    for (let i = 0; i < f; i++) {
      const g = i / f;
      this.l[i] *= g; this.r[i] *= g;
      this.l[this.len - 1 - i] *= g; this.r[this.len - 1 - i] *= g;
    }
    this.short = this.len < 2 * SR;
    this.state = 'play'; this.pos = 0;
  }
  stop() { this.state = 'stopping'; }
  write(L, R, n) {
    if (this.state !== 'rec') return;
    for (let i = 0; i < n && this.len < this.max; i++) { this.l[this.len] = L[i]; this.r[this.len] = R[i]; this.len++; }
    if (this.len >= this.max) this.play();
  }
  add(L, R, n) {
    if (this.state === 'idle' || this.state === 'rec') return;
    const len = this.len, fade = Math.min(this.fade, len >> 2);
    for (let i = 0; i < n; i++) {
      if (this.state === 'stopping') { this.gain -= 1 / (0.05 * SR); if (this.gain <= 0) { this.gain = 0; this.state = 'idle'; this.len = 0; return; } }
      else if (this.gain < 1) this.gain = Math.min(1, this.gain + 1 / (0.01 * SR));
      let yl, yr;
      if (this.short) {
        // two overlapping readers -> seamless pad
        const pa = this.pos / len, pb = (pa + 0.5) % 1;
        const ia = Math.floor(pa * len), ib = Math.floor(pb * len);
        const ga = hann(pa), gb = hann(pb);
        yl = this.l[ia] * ga + this.l[ib] * gb;
        yr = this.r[ia] * ga + this.r[ib] * gb;
        this.pos++; if (this.pos >= len) this.pos = 0;
      } else {
        const p = this.pos;
        yl = this.l[p]; yr = this.r[p];
        const xs = len - fade;
        if (p >= xs) {
          const k = (p - xs) / fade, j = p - xs;
          yl = yl * (1 - k) + this.l[j] * k;
          yr = yr * (1 - k) + this.r[j] * k;
        }
        this.pos++; if (this.pos >= len) this.pos = fade;
      }
      L[i] += yl * this.gain; R[i] += yr * this.gain;
    }
  }
}

/* ---------------------------------------------------------------- */
/* Processor                                                         */
/* ---------------------------------------------------------------- */

const DEFAULTS = {
  tilt: 0.5, sens: 0.5, charAmount: 0.35, charVolume: 0.714,
  movRate: 0.4, movDrift: 0.15, movAmount: 0.45, movVolume: 0.714,
  difTime: 0.45, difDrift: 0.2, difAmount: 0.4, difVolume: 0.6,
  texAmount: 0.5, texVolume: 0.714,
  mix: 1, output: 0.714,
};

class ChromaProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.P = Object.assign({}, DEFAULTS);
    this.S = Object.assign({}, DEFAULTS);
    this.mods = [
      new CharacterModule([new Drive(), new Sweeten(), new Fuzz(), new Howl(), new Swell()]),
      new Module([new Doubler(), new Vibrato(), new Phaser(), new Tremolo(), new Pitch()]),
      new Module([new Cascade(), new Reels(), new Space(), new Collage(), new Reverse()]),
      new Module([new Filter(), new Squash(), new Cassette(), new Broken(), new Interference()]),
    ];
    this.pc = { amount: 0, vol: 0, tilt: 0, sens: 0 };
    this.pm = { amount: 0, vol: 0, rate: 0, drift: 0 };
    this.pd = { amount: 0, vol: 0, time: 0, drift: 0 };
    this.pt = { amount: 0, vol: 0 };
    this.order = [0, 1, 2, 3];
    this.inGain = 1;
    this.bypass = false; this.byG = 1;
    this.cap = new Capture(); this.capPre = false;
    this.L = new Float32Array(128); this.R = new Float32Array(128);
    this.dL = new Float32Array(128); this.dR = new Float32Array(128);
    this.meterCnt = 0; this.pkIn = 0; this.pkOut = 0;
    this.port.onmessage = (e) => this.msg(e.data);
  }

  msg(m) {
    switch (m.type) {
      case 'params': Object.assign(this.P, m.data); break;
      case 'select': this.mods[m.module].select(m.effect); break;
      case 'moduleBypass': this.mods[m.module].bypassed = !!m.on; break;
      case 'order': if (Array.isArray(m.order) && m.order.length === 4) this.order = m.order.slice(); break;
      case 'bypass': this.bypass = !!m.on; break;
      case 'inputGain': this.inGain = m.value; break;
      case 'captureRoute': this.capPre = m.pre; break;
      case 'capture':
        if (m.action === 'rec') this.cap.rec();
        else if (m.action === 'play') this.cap.play();
        else if (m.action === 'stop') this.cap.stop();
        break;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const n = out[0].length;
    if (this.L.length < n) {
      this.L = new Float32Array(n); this.R = new Float32Array(n);
      this.dL = new Float32Array(n); this.dR = new Float32Array(n);
    }
    const L = this.L, R = this.R, dL = this.dL, dR = this.dR;
    const inp = inputs[0];
    const il = inp && inp[0] ? inp[0] : null;
    const ir = inp && inp[1] ? inp[1] : il;

    // parameter smoothing (per block)
    const P = this.P, S = this.S;
    for (const k in P) S[k] += (P[k] - S[k]) * 0.25;

    const pc = this.pc; pc.amount = S.charAmount; pc.vol = S.charVolume; pc.tilt = S.tilt; pc.sens = S.sens;
    const pm = this.pm; pm.amount = S.movAmount; pm.vol = S.movVolume; pm.rate = S.movRate; pm.drift = S.movDrift;
    const pd = this.pd; pd.amount = S.difAmount; pd.vol = S.difVolume; pd.time = S.difTime; pd.drift = S.difDrift;
    const pt = this.pt; pt.amount = S.texAmount; pt.vol = S.texVolume;
    const params = [pc, pm, pd, pt];

    const g = this.inGain;
    let pkIn = this.pkIn;
    for (let i = 0; i < n; i++) {
      const xl = il ? il[i] : 0, xr = ir ? ir[i] : 0;
      dL[i] = xl; dR[i] = xr;
      L[i] = xl * g; R[i] = xr * g;
      const a = Math.abs(L[i]); if (a > pkIn) pkIn = a;
    }
    this.pkIn = pkIn;

    if (this.capPre) { this.cap.write(L, R, n); this.cap.add(L, R, n); }
    for (let k = 0; k < 4; k++) {
      const m = this.order[k];
      this.mods[m].process(L, R, n, params[m]);
    }
    if (!this.capPre) { this.cap.write(L, R, n); this.cap.add(L, R, n); }

    const mixA = S.mix * Math.PI * 0.5;
    const wetG = Math.sin(mixA), dryG = Math.cos(mixA);
    const outG = volGain(S.output);
    const byT = this.bypass ? 0 : 1, byStep = 1 / (0.02 * SR);
    const ol = out[0], or = out[1] || out[0];
    let pkOut = this.pkOut;
    for (let i = 0; i < n; i++) {
      this.byG += clamp(byT - this.byG, -byStep, byStep);
      let yl = (dL[i] * g * dryG + L[i] * wetG) * outG;
      let yr = (dR[i] * g * dryG + R[i] * wetG) * outG;
      yl = dL[i] + (yl - dL[i]) * this.byG;
      yr = dR[i] + (yr - dR[i]) * this.byG;
      // safety limiter above -3 dBFS
      const al = Math.abs(yl), ar = Math.abs(yr);
      if (al > 0.7) yl = Math.sign(yl) * (0.7 + 0.29 * softclip((al - 0.7) / 0.29));
      if (ar > 0.7) yr = Math.sign(yr) * (0.7 + 0.29 * softclip((ar - 0.7) / 0.29));
      if (!(yl === yl)) yl = 0; // NaN guard
      if (!(yr === yr)) yr = 0;
      ol[i] = yl; if (or !== ol) or[i] = yr;
      const a = Math.max(al, ar); if (a > pkOut) pkOut = a;
    }
    this.pkOut = pkOut;

    if (++this.meterCnt >= 12) {
      this.meterCnt = 0;
      const cap = this.cap;
      this.port.postMessage({
        type: 'meter', in: this.pkIn, out: this.pkOut,
        cap: { state: cap.state, len: cap.len / SR, pos: cap.state === 'play' ? cap.pos / Math.max(1, cap.len) : 0, short: cap.short },
      });
      this.pkIn = 0; this.pkOut = 0;
    }
    return true;
  }
}

if (typeof registerProcessor === 'function') registerProcessor('chroma-console', ChromaProcessor);
if (typeof globalThis !== 'undefined') globalThis.__chroma = { ChromaProcessor, DEFAULTS, Pitch, Filter };
