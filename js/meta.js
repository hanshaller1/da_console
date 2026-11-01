// Static description of the pedal: modules, effects, knobs and value formatting.
// The mappings here mirror the DSP in worklet/chroma-processor.js.

export const expMap = (v, lo, hi) => lo * Math.pow(hi / lo, v);
export const invExp = (x, lo, hi) => Math.log(x / lo) / Math.log(hi / lo);
const volDb = (v) => (v <= 0.001 ? '-∞ dB' : `${(20 * Math.log10((v * 1.4) ** 2)).toFixed(1)} dB`);
const pct = (v) => `${Math.round(v * 100)} %`;
const ms = (s) => (s >= 1 ? `${s.toFixed(2)} s` : `${Math.round(s * 1000)} ms`);
const hz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : f >= 10 ? `${Math.round(f)} Hz` : `${f.toFixed(2)} Hz`);

export const MODULES = [
  {
    id: 'character', name: 'CHARACTER', key: 'A',
    effects: [
      { name: 'Drive', color: '#ff9330', desc: 'Röhrenartiger Overdrive mit Mitten-Sweetspot' },
      { name: 'Sweeten', color: '#ffe15a', desc: 'Preamp: EQ, Kompression, sanfte Sättigung' },
      { name: 'Fuzz', color: '#ff3b4a', desc: 'Vintage-Fuzz bis „Blown Speaker“' },
      { name: 'Howl', color: '#ff5fd2', desc: 'Resonanter Filter-Fuzz, der dem Anschlag folgt' },
      { name: 'Swell', color: '#f4f1ff', desc: 'Automatische Volume-Swells (Anschlag wird ausgeblendet)' },
    ],
  },
  {
    id: 'movement', name: 'MOVEMENT', key: 'B',
    effects: [
      { name: 'Doubler', color: '#3fe0d0', desc: 'Stereo-Double-Tracking' },
      { name: 'Vibrato', color: '#8c6bff', desc: 'Üppige Tonhöhenmodulation' },
      { name: 'Phaser', color: '#34e36a', desc: 'Sechsstufiger Vintage-Phaser' },
      { name: 'Tremolo', color: '#ffcf33', desc: 'Pulsierende Lautstärkemodulation, Drift = Autopan' },
      { name: 'Pitch', color: '#ff4d8d', desc: 'Pitch-Shifter von −12 bis +12 Halbtönen' },
    ],
  },
  {
    id: 'diffusion', name: 'DIFFUSION', key: 'C',
    effects: [
      { name: 'Cascade', color: '#ff7a45', desc: 'Analoges Eimerketten-(BBD)-Delay' },
      { name: 'Reels', color: '#ffb547', desc: 'Bandecho mit Wow & Flutter und zweitem Kopf' },
      { name: 'Space', color: '#45b8ff', desc: 'Hall von engen Kammern bis zu endlosen Wolken' },
      { name: 'Collage', color: '#b6ff4d', desc: 'Spontanes, granulares Looping-Delay' },
      { name: 'Reverse', color: '#d77bff', desc: 'Rückwärts-Delay' },
    ],
  },
  {
    id: 'texture', name: 'TEXTURE', key: 'D',
    effects: [
      { name: 'Filter', color: '#2de6ff', desc: 'DJ-Filter: links Tiefpass, rechts Hochpass' },
      { name: 'Squash', color: '#ff4f4f', desc: 'Brutale Kompression mit Overdrive' },
      { name: 'Cassette', color: '#ffd84d', desc: 'Kassettenrekorder: Leiern, Rauschen, Aussetzer' },
      { name: 'Broken', color: '#5cf2a0', desc: 'Periodische Pitch-Einbrüche, AM und FM' },
      { name: 'Interference', color: '#e64dff', desc: 'Bitcrush, Funkstörungen, zerfallende Schichten' },
    ],
  },
];

export const DEFAULTS = {
  tilt: 0.5, sens: 0.5, charAmount: 0.35, charVolume: 0.714,
  movRate: 0.4, movDrift: 0.15, movAmount: 0.45, movVolume: 0.714,
  difTime: 0.45, difDrift: 0.2, difAmount: 0.4, difVolume: 0.6,
  texAmount: 0.5, texVolume: 0.714,
  mix: 1, output: 0.714,
};

// Pedal layout: 4 columns, each with a top and a bottom knob.
// Every knob has a primary and a secondary (SHIFT) parameter.
export const KNOBS = [
  { col: 0, row: 0, p: 'tilt', s: 'sens', label: 'TILT', sub: 'SENSITIVITY' },
  { col: 1, row: 0, p: 'movRate', s: 'movDrift', label: 'RATE', sub: 'DRIFT' },
  { col: 2, row: 0, p: 'difTime', s: 'difDrift', label: 'TIME', sub: 'DRIFT' },
  { col: 3, row: 0, p: 'mix', s: 'output', label: 'MIX', sub: 'OUTPUT' },
  { col: 0, row: 1, p: 'charAmount', s: 'charVolume', label: 'AMOUNT', sub: 'EFFECT VOL' },
  { col: 1, row: 1, p: 'movAmount', s: 'movVolume', label: 'AMOUNT', sub: 'EFFECT VOL' },
  { col: 2, row: 1, p: 'difAmount', s: 'difVolume', label: 'AMOUNT', sub: 'EFFECT VOL' },
  { col: 3, row: 1, p: 'texAmount', s: 'texVolume', label: 'AMOUNT', sub: 'EFFECT VOL' },
];

export const PARAM_MODULE = {
  tilt: 0, sens: 0, charAmount: 0, charVolume: 0,
  movRate: 1, movDrift: 1, movAmount: 1, movVolume: 1,
  difTime: 2, difDrift: 2, difAmount: 2, difVolume: 2,
  texAmount: 3, texVolume: 3, mix: null, output: null,
};

export function filterDescribe(a) {
  if (a < 0.47) return { mode: 'LP', f: expMap(a / 0.47, 160, 20000) };
  if (a > 0.53) return { mode: 'HP', f: expMap((a - 0.53) / 0.47, 20, 5000) };
  return { mode: 'OFF', f: 0 };
}

// Returns [label, valueText] for a parameter given the active effects.
export function describe(param, v, effects) {
  const fx = (m) => MODULES[m].effects[effects[m]].name;
  switch (param) {
    case 'tilt': { const d = (v - 0.5) * 18; return ['TILT', `${d > 0 ? 'hell' : d < 0 ? 'dunkel' : 'neutral'} ${d >= 0 ? '+' : ''}${d.toFixed(1)} dB`]; }
    case 'sens': { const d = (v * 2 - 1) * 12; return ['SENSITIVITY', `${d >= 0 ? '+' : ''}${d.toFixed(1)} dB`]; }
    case 'charAmount': {
      if (fx(0) === 'Swell') return ['ATTACK', ms(0.06 + v * v * 3.2)];
      return [fx(0) === 'Sweeten' ? 'SWEETNESS' : 'GAIN', pct(v)];
    }
    case 'movRate':
      if (fx(1) === 'Pitch') return ['MIX', pct(v)];
      return ['RATE', hz(expMap(v, 0.05, 14) * (fx(1) === 'Doubler' ? 0.18 : 1))];
    case 'movAmount':
      if (fx(1) === 'Pitch') { const s = Math.round(-12 + 24 * v); return ['INTERVALL', `${s > 0 ? '+' : ''}${s} Halbtöne`]; }
      return [fx(1) === 'Doubler' ? 'MIX' : 'DEPTH', pct(v)];
    case 'difTime': {
      const f = fx(2);
      if (f === 'Space') return ['SIZE', `${(0.35 + v * 2.4).toFixed(2)}×`];
      if (f === 'Collage') return ['LOOP', ms(expMap(v, 0.06, 1.6))];
      if (f === 'Reverse') return ['TIME', ms(expMap(v, 0.1, 1.5))];
      return ['TIME', ms(expMap(v, 0.04, 1.5))];
    }
    case 'difAmount': {
      const f = fx(2);
      if (f === 'Space') return ['DECAY', v > 0.97 ? 'FREEZE' : `${(0.4 + v * v * 22).toFixed(1)} s`];
      if (f === 'Collage') return ['DENSITY', pct(v)];
      return ['FEEDBACK', pct(v)];
    }
    case 'texAmount': {
      if (fx(3) === 'Filter') { const d = filterDescribe(v); return ['FILTER', d.mode === 'OFF' ? 'offen' : `${d.mode === 'LP' ? 'Tiefpass' : 'Hochpass'} ${hz(d.f)}`]; }
      return ['AMOUNT', pct(v)];
    }
    case 'movDrift': case 'difDrift': return ['DRIFT', pct(v)];
    case 'charVolume': case 'movVolume': case 'texVolume': return ['EFFECT VOL', volDb(v)];
    case 'difVolume': return ['WET LEVEL', volDb(v)];
    case 'mix': return ['MIX', `${Math.round(Math.sin(v * Math.PI / 2) ** 2 * 100)} % Effekt`];
    case 'output': return ['OUTPUT', volDb(v)];
  }
  return [param, pct(v)];
}

export const CALIBRATION = [
  { gain: 4, label: '1', desc: 'Leise Gitarren/Bässe, Instrumenten-Synths' },
  { gain: 2, label: '2', desc: 'Typische Gitarren & Bässe, E-Piano' },
  { gain: 1, label: '3', desc: 'Heiße Pickups, die meisten Line-Signale' },
  { gain: 0.5, label: '4', desc: 'Sehr laute Line-Signale, Modular' },
];
