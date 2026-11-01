// 80 preset slots (bank A + bank B, 40 each) stored in localStorage.

import { DEFAULTS } from './meta.js';

const KEY = 'chroma-console-web.presets.v1';
export const SLOTS = 80;
export const slotName = (i) => `${i < 40 ? 'A' : 'B'}${(i % 40) + 1}`;

const P = (o) => Object.assign({}, DEFAULTS, o);

// effects: [character, movement, diffusion, texture] effect indices
export const FACTORY = [
  {
    name: 'Erste Farbe',
    effects: [0, 0, 2, 0], order: [0, 1, 2, 3],
    params: P({ charAmount: 0.3, movAmount: 0.35, movRate: 0.35, difTime: 0.45, difAmount: 0.45, difVolume: 0.55, texAmount: 0.5 }),
  },
  {
    name: 'Kassettenschlaf',
    effects: [1, 1, 2, 2], order: [0, 1, 2, 3],
    params: P({ charAmount: 0.5, tilt: 0.38, movRate: 0.3, movAmount: 0.25, movDrift: 0.4, difTime: 0.75, difAmount: 0.7, difVolume: 0.62, texAmount: 0.55 }),
  },
  {
    name: 'Fuzz-Kathedrale',
    effects: [2, 2, 2, 1], order: [0, 1, 2, 3],
    params: P({ charAmount: 0.7, tilt: 0.55, movRate: 0.25, movAmount: 0.7, difTime: 0.9, difAmount: 0.88, difVolume: 0.65, texAmount: 0.35, output: 0.65 }),
  },
  {
    name: 'Zerbrochener Funk',
    effects: [3, 3, 1, 3], order: [0, 1, 2, 3],
    params: P({ charAmount: 0.55, movRate: 0.62, movAmount: 0.55, difTime: 0.42, difAmount: 0.4, difDrift: 0.5, texAmount: 0.45 }),
  },
  {
    name: 'Collage-Garten',
    effects: [4, 4, 3, 0], order: [0, 1, 2, 3],
    params: P({ charAmount: 0.35, movAmount: 1, movRate: 0.35, difTime: 0.55, difAmount: 0.6, difDrift: 0.45, difVolume: 0.75, texAmount: 0.38 }),
  },
  {
    name: 'Rückwärtsträume',
    effects: [1, 1, 4, 2], order: [0, 1, 2, 3],
    params: P({ charAmount: 0.4, movRate: 0.25, movAmount: 0.3, difTime: 0.6, difAmount: 0.45, difVolume: 0.7, texAmount: 0.35, mix: 0.8 }),
  },
  {
    name: 'Funkstörung',
    effects: [0, 4, 0, 4], order: [3, 0, 1, 2],
    params: P({ charAmount: 0.5, movAmount: 0, movRate: 0.45, difTime: 0.5, difAmount: 0.78, difDrift: 0.6, texAmount: 0.45 }),
  },
  {
    name: 'Ambient-Wolke',
    effects: [4, 0, 2, 0], order: [0, 1, 2, 3],
    params: P({ charAmount: 0.45, movAmount: 0.6, movRate: 0.2, difTime: 1, difAmount: 0.95, difVolume: 0.8, difDrift: 0.6, texAmount: 0.3 }),
  },
  {
    name: 'Tremolo-Strand',
    effects: [1, 3, 1, 2], order: [0, 1, 2, 3],
    params: P({ charAmount: 0.35, movRate: 0.55, movAmount: 0.65, movDrift: 0.5, difTime: 0.55, difAmount: 0.35, texAmount: 0.3 }),
  },
  {
    name: 'Diffusion zuerst',
    effects: [2, 2, 3, 0], order: [2, 0, 1, 3],
    params: P({ charAmount: 0.6, movRate: 0.3, movAmount: 0.5, difTime: 0.4, difAmount: 0.7, difDrift: 0.8, texAmount: 0.3 }),
  },
].map((p) => Object.assign({ bypassed: [false, false, false, false], captureRoute: 'post', gesture: null }, p));

export function loadAll() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { data = null; }
  if (!Array.isArray(data) || data.length !== SLOTS) {
    data = new Array(SLOTS).fill(null);
    FACTORY.forEach((p, i) => { data[i] = structuredClone(p); });
    saveAll(data);
  }
  return data;
}

export function saveAll(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
}

export function resetFactory() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return loadAll();
}
