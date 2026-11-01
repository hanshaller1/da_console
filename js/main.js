import { MODULES, KNOBS, DEFAULTS, PARAM_MODULE, CALIBRATION, describe, invExp } from './meta.js';
import { Engine } from './engine.js';
import { Knob } from './knob.js';
import { Gesture } from './gesture.js';
import { loadAll, saveAll, resetFactory, slotName, SLOTS } from './presets.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const now = () => performance.now() / 1000;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const engine = new Engine();
const gesture = new Gesture();
const state = {
  on: false,
  params: { ...DEFAULTS },
  effects: [0, 0, 2, 0],
  bypassed: [false, false, false, false],
  order: [0, 1, 2, 3],
  captureRoute: 'post',
  bypass: false,
  shift: false,
  setup: null, // array of picked modules while in FX SETUP
  calibration: 2,
  source: null,
  bank: 0,
  slot: 0,
  cap: { state: 'idle', len: 0, pos: 0, short: false },
  taps: [],
  bpm: null,
  level: 0,
};
let presets = loadAll();

/* ------------------------------------------------------------------ */
/* Info strip                                                          */
/* ------------------------------------------------------------------ */

let infoTimer = null;
function info(main, sub = '', sticky = false) {
  $('#infoMain').textContent = main;
  $('#infoSub').textContent = sub;
  clearTimeout(infoTimer);
  if (!sticky) infoTimer = setTimeout(idleInfo, 3500);
}
function idleInfo() {
  if (!state.on) return;
  if (state.setup) return info('FX SETUP', `Modul-Taster in neuer Reihenfolge drücken (${state.setup.length}/4)`, true);
  if (gesture.recording) return info('GESTURE ● REC', 'Knöpfe bewegen – C+D stoppt die Aufnahme', true);
  const p = presets[state.slot];
  const names = state.order.map((m) => MODULES[m].effects[state.effects[m]].name).join(' → ');
  info(p ? `${slotName(state.slot)} · ${p.name}` : 'Chroma Console', names, true);
}

/* ------------------------------------------------------------------ */
/* Build the pedal                                                     */
/* ------------------------------------------------------------------ */

const knobs = [];
function buildPedal() {
  const cols = $('#columns');
  for (let c = 0; c < 4; c++) {
    const col = document.createElement('div');
    col.className = 'col';
    col.dataset.m = c;
    for (let r = 0; r < 2; r++) {
      const def = KNOBS.find((k) => k.col === c && k.row === r);
      const slot = document.createElement('div');
      slot.className = 'kslot';
      const el = document.createElement('div');
      slot.appendChild(el);
      const lab = document.createElement('div');
      lab.className = 'klabel';
      lab.innerHTML = `<span class="p">${def.label}</span><span class="s">${def.sub}</span>`;
      slot.appendChild(lab);
      col.appendChild(slot);
      const knob = new Knob(el, {
        onInput: (v) => setParam(activeParam(def), v, true),
        onGrab: () => { gesture.held.add(activeParam(def)); showParam(activeParam(def)); },
        onRelease: () => gesture.held.delete(activeParam(def)),
        onReset: () => { const p = activeParam(def); knob.set(DEFAULTS[p]); setParam(p, DEFAULTS[p], true); },
      });
      knob.def = def;
      knobs.push(knob);
    }
    const mod = document.createElement('div');
    mod.className = 'mod';
    mod.innerHTML = `
      <button class="modbtn" data-m="${c}" aria-label="${MODULES[c].name}"><span class="mod-led"></span><span class="mod-key">${MODULES[c].key}</span></button>
      <div class="mod-name">${MODULES[c].name}</div>
      <div class="mod-fx"></div>
      <div class="dots">${MODULES[c].effects.map((e, i) => `<i data-i="${i}" title="${e.name}"></i>`).join('')}</div>`;
    col.appendChild(mod);
    cols.appendChild(col);
  }
}
const activeParam = (def) => (state.shift ? def.s : def.p);

/* ------------------------------------------------------------------ */
/* Parameters                                                          */
/* ------------------------------------------------------------------ */

function setParam(p, v, fromUser) {
  state.params[p] = v;
  engine.send({ type: 'params', data: { [p]: v } });
  if (fromUser) {
    if (gesture.recording) gesture.record(p, v, now());
    showParam(p);
  }
}

function showParam(p) {
  const [label, val] = describe(p, state.params[p], state.effects);
  const m = PARAM_MODULE[p];
  const where = m === null ? 'GLOBAL' : `${MODULES[m].name} · ${MODULES[m].effects[state.effects[m]].name}`;
  info(`${label}  ${val}`, where);
}

function syncKnobs() {
  for (const k of knobs) {
    const p = activeParam(k.def);
    k.set(state.params[p]);
    k.el.setAttribute('aria-label', describe(p, state.params[p], state.effects).join(' '));
  }
}

function sendAll() {
  engine.send({ type: 'params', data: { ...state.params } });
  state.effects.forEach((e, m) => engine.send({ type: 'select', module: m, effect: e }));
  state.bypassed.forEach((b, m) => engine.send({ type: 'moduleBypass', module: m, on: b }));
  engine.send({ type: 'order', order: state.order });
  engine.send({ type: 'bypass', on: state.bypass });
  engine.send({ type: 'captureRoute', pre: state.captureRoute === 'pre' });
  engine.send({ type: 'inputGain', value: CALIBRATION[state.calibration].gain });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render() {
  const pedal = $('#pedal');
  pedal.classList.toggle('shift', state.shift);
  pedal.classList.toggle('setup', !!state.setup);
  pedal.classList.toggle('bypassed', state.bypass);
  $('#modeShift').classList.toggle('on', state.shift);
  $('#modeSetup').classList.toggle('on', !!state.setup);
  $('#modeGesture').classList.toggle('on', gesture.playing || gesture.recording);
  $('#modeGesture').classList.toggle('rec', gesture.recording);
  $('#ledBypass').classList.toggle('on', !state.bypass);

  $$('.col').forEach((col, m) => {
    const fx = MODULES[m].effects[state.effects[m]];
    col.style.setProperty('--fx', fx.color);
    col.classList.toggle('off', state.bypassed[m]);
    $('.mod-fx', col).textContent = fx.name;
    $$('.dots i', col).forEach((d, i) => d.classList.toggle('on', i === state.effects[m]));
    const btn = $('.modbtn', col);
    const pick = state.setup ? state.setup.indexOf(m) : -1;
    btn.dataset.pick = pick >= 0 ? pick + 1 : '';
  });

  const order = $('#order');
  order.innerHTML = state.order.map((m, i) => {
    const fx = MODULES[m].effects[state.effects[m]];
    return `${i ? '<span class="arrow">→</span>' : ''}<span class="chip${state.bypassed[m] ? ' off' : ''}" style="--fx:${fx.color}">${MODULES[m].name.slice(0, 4)} · ${fx.name}</span>`;
  }).join('');

  $$('#sources button').forEach((b) => b.classList.toggle('on', b.dataset.src === state.source));
  $$('#calib button').forEach((b) => b.classList.toggle('on', +b.dataset.level === state.calibration));
  $('#calibHint').textContent = `Stufe ${CALIBRATION[state.calibration].label}: ${CALIBRATION[state.calibration].desc}`;
  $$('#capRoute button').forEach((b) => b.classList.toggle('on', b.dataset.route === state.captureRoute));
  $$('#banks button').forEach((b) => b.classList.toggle('on', +b.dataset.bank === state.bank));
  renderPresets();
  syncKnobs();
}

function renderPresets() {
  const grid = $('#presetGrid');
  const start = state.bank * 40;
  let html = '';
  for (let i = start; i < start + 40; i++) {
    const p = presets[i];
    html += `<button class="pslot${p ? ' filled' : ''}${i === state.slot ? ' sel' : ''}" data-slot="${i}" title="${p ? p.name : 'leer'}">
      <span>${slotName(i)}</span><em>${p ? escapeHtml(p.name) : '·'}</em></button>`;
  }
  grid.innerHTML = html;
  const cur = presets[state.slot];
  if (document.activeElement !== $('#presetName')) $('#presetName').value = cur ? cur.name : '';
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------------------ */
/* Module buttons (with pedal-style combos)                            */
/* ------------------------------------------------------------------ */

const held = new Map();
const COMBOS = { '0,1': 'shift', '2,3': 'gesture', '0,3': 'setup', '1,2': 'save' };

function modDown(m) {
  if (held.has(m)) return;
  if (held.size === 1) {
    const [other] = held.keys();
    const key = [other, m].sort().join(',');
    const o = held.get(other);
    clearTimeout(o.timer);
    o.combo = true;
    held.set(m, { combo: true });
    if (COMBOS[key]) combo(COMBOS[key]);
    return;
  }
  const entry = { combo: false, long: false };
  entry.timer = setTimeout(() => { if (!entry.combo) { entry.long = true; toggleModuleBypass(m); } }, 550);
  held.set(m, entry);
  $(`.modbtn[data-m="${m}"]`).classList.add('down');
}

function modUp(m) {
  const e = held.get(m);
  $(`.modbtn[data-m="${m}"]`).classList.remove('down');
  if (!e) return;
  held.delete(m);
  clearTimeout(e.timer);
  if (!e.combo && !e.long) modPress(m);
}

function modPress(m) {
  if (state.setup) {
    if (!state.setup.includes(m)) state.setup.push(m);
    if (state.setup.length === 4) {
      state.order = state.setup;
      state.setup = null;
      engine.send({ type: 'order', order: state.order });
      info('FX SETUP fertig', state.order.map((k) => MODULES[k].name).join(' → '));
    } else idleInfo();
    render();
    return;
  }
  state.effects[m] = (state.effects[m] + 1) % 5;
  if (state.bypassed[m]) { state.bypassed[m] = false; engine.send({ type: 'moduleBypass', module: m, on: false }); }
  engine.send({ type: 'select', module: m, effect: state.effects[m] });
  const fx = MODULES[m].effects[state.effects[m]];
  info(`${MODULES[m].name} → ${fx.name}`, fx.desc);
  render();
}

function toggleModuleBypass(m) {
  state.bypassed[m] = !state.bypassed[m];
  engine.send({ type: 'moduleBypass', module: m, on: state.bypassed[m] });
  info(`${MODULES[m].name} ${state.bypassed[m] ? 'aus' : 'an'}`, state.bypassed[m] ? 'Modul ist überbrückt (gedrückt halten zum Einschalten)' : MODULES[m].effects[state.effects[m]].name);
  render();
}

function combo(name) {
  switch (name) {
    case 'shift':
      state.shift = !state.shift;
      info(state.shift ? 'SHIFT an' : 'SHIFT aus', state.shift ? 'Knöpfe steuern jetzt die grauen Zweitfunktionen' : 'Knöpfe steuern die Hauptfunktionen');
      break;
    case 'gesture': toggleGesture(); break;
    case 'setup':
      if (state.setup) { state.setup = null; info('FX SETUP abgebrochen'); }
      else { state.setup = []; idleInfo(); }
      break;
    case 'save': savePreset(); break;
  }
  render();
}

function toggleGesture() {
  const t = now();
  if (gesture.recording) {
    gesture.stopRec(t);
    info('GESTURE ▶', gesture.playing ? `Schleife ${gesture.length.toFixed(1)} s · lange drücken löscht` : 'Nichts aufgenommen');
  } else {
    gesture.startRec(t);
    idleInfo();
  }
  render();
}

function clearGesture() {
  gesture.clear();
  info('GESTURE gelöscht');
  render();
}

/* ------------------------------------------------------------------ */
/* Footswitches                                                        */
/* ------------------------------------------------------------------ */

function bypassPress() {
  state.bypass = !state.bypass;
  engine.send({ type: 'bypass', on: state.bypass });
  info(state.bypass ? 'BYPASS' : 'EFFEKT AN', state.bypass ? 'Trockenes Signal' : '');
  render();
}

function openPresets() {
  const panel = $('#presetPanel');
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  panel.classList.remove('flash'); void panel.offsetWidth; panel.classList.add('flash');
  info('PRESETS', 'Slot anklicken zum Laden');
}

let capHolding = false;
function tapDown() {
  capHolding = false;
  clearTimeout(tapDown.t);
  tapDown.t = setTimeout(() => {
    capHolding = true;
    engine.send({ type: 'capture', action: 'rec' });
    info('CAPTURE ● REC', 'Loslassen startet den Loop (max. 30 s)', true);
  }, 420);
}
function tapUp() {
  clearTimeout(tapDown.t);
  if (capHolding) {
    capHolding = false;
    engine.send({ type: 'capture', action: 'play' });
    info('CAPTURE ▶', 'Tippen stoppt den Loop');
    return;
  }
  if (state.cap.state === 'play' || state.cap.state === 'rec') {
    engine.send({ type: 'capture', action: 'stop' });
    info('CAPTURE ■', 'Loop gelöscht');
    return;
  }
  tapTempo();
}

function tapTempo() {
  const t = now();
  state.taps = state.taps.filter((x) => t - x < 2.5);
  state.taps.push(t);
  if (state.taps.length < 2) { info('TAP', 'weiter tippen…'); return; }
  const d = state.taps.slice(1).map((x, i) => x - state.taps[i]);
  const beat = d.reduce((a, b) => a + b, 0) / d.length;
  state.bpm = 60 / beat;
  // Movement: one cycle per beat (not for Pitch, where RATE is the mix)
  if (MODULES[1].effects[state.effects[1]].name !== 'Pitch') {
    const target = MODULES[1].effects[state.effects[1]].name === 'Doubler' ? 1 / beat / 0.18 : 1 / beat;
    setParam('movRate', clamp01(invExp(target, 0.05, 14)), false);
  }
  // Diffusion: delay time = beat (or half beat if too long)
  const dfx = MODULES[2].effects[state.effects[2]].name;
  let sec = beat; while (sec > 1.45) sec /= 2;
  if (dfx === 'Cascade' || dfx === 'Reels') setParam('difTime', clamp01(invExp(sec, 0.04, 1.5)), false);
  if (dfx === 'Reverse') setParam('difTime', clamp01(invExp(Math.max(0.1, sec), 0.1, 1.5)), false);
  if (dfx === 'Collage') setParam('difTime', clamp01(invExp(Math.max(0.06, sec / 2), 0.06, 1.6)), false);
  gesture.speed = 1;
  syncKnobs();
  info(`TAP ${Math.round(state.bpm)} BPM`, 'RATE und TIME synchronisiert');
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

function snapshot(name) {
  return {
    name,
    params: { ...state.params },
    effects: [...state.effects],
    bypassed: [...state.bypassed],
    order: [...state.order],
    captureRoute: state.captureRoute,
    gesture: gesture.serialize(),
  };
}

function loadPreset(i) {
  const p = presets[i];
  state.slot = i;
  if (!p) { render(); info(`${slotName(i)} ist leer`, 'Mit „Speichern“ (B+C) hier ablegen'); return; }
  state.params = { ...DEFAULTS, ...p.params };
  state.effects = [...p.effects];
  state.bypassed = [...(p.bypassed || [false, false, false, false])];
  state.order = [...(p.order || [0, 1, 2, 3])];
  state.captureRoute = p.captureRoute || 'post';
  state.setup = null;
  gesture.load(p.gesture, now());
  sendAll();
  render();
  info(`${slotName(i)} · ${p.name}`, state.order.map((m) => MODULES[m].effects[state.effects[m]].name).join(' → '));
}

function savePreset() {
  const name = ($('#presetName').value || '').trim() || (presets[state.slot] && presets[state.slot].name) || `Preset ${slotName(state.slot)}`;
  presets[state.slot] = snapshot(name);
  saveAll(presets);
  renderPresets();
  info(`Gespeichert: ${slotName(state.slot)}`, name);
}

/* ------------------------------------------------------------------ */
/* Visuals: living artwork + scope                                     */
/* ------------------------------------------------------------------ */

const art = $('#art'), actx = art.getContext('2d');
const scope = $('#scope'), sctx = scope.getContext('2d');
const blobs = [0, 1, 2, 3].map((i) => ({ x: 0.15 + i * 0.23, y: 0.35 + (i % 2) * 0.3, vx: (Math.random() - 0.5) * 0.02, vy: (Math.random() - 0.5) * 0.02, r: 0.35 }));
let scopeData = null;

function fitCanvas(c) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
}

function drawArt(dt) {
  fitCanvas(art);
  const w = art.width, h = art.height;
  actx.globalCompositeOperation = 'source-over';
  actx.fillStyle = '#12142a';
  actx.fillRect(0, 0, w, h);
  actx.globalCompositeOperation = 'lighter';
  const lvl = state.bypass ? 0 : state.level;
  blobs.forEach((b, m) => {
    const speed = 0.4 + lvl * 3;
    b.x += b.vx * dt * speed; b.y += b.vy * dt * speed;
    if (b.x < 0.05 || b.x > 0.95) b.vx *= -1;
    if (b.y < 0.05 || b.y > 0.95) b.vy *= -1;
    const off = state.bypassed[m];
    const color = MODULES[m].effects[state.effects[m]].color;
    const r = Math.max(w, h) * (b.r + lvl * 0.15);
    const g = actx.createRadialGradient(b.x * w, b.y * h, 0, b.x * w, b.y * h, r);
    g.addColorStop(0, hexA(color, off ? 0.05 : 0.26 + lvl * 0.22));
    g.addColorStop(1, hexA(color, 0));
    actx.fillStyle = g;
    actx.fillRect(0, 0, w, h);
  });
}
const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

function drawScope() {
  fitCanvas(scope);
  const w = scope.width, h = scope.height;
  sctx.clearRect(0, 0, w, h);
  if (!engine.analyser) return;
  const an = engine.analyser;
  if (!scopeData) scopeData = { t: new Float32Array(an.fftSize), f: new Uint8Array(an.frequencyBinCount) };
  an.getByteFrequencyData(scopeData.f);
  const bins = 64;
  for (let i = 0; i < bins; i++) {
    const idx = Math.floor(Math.pow(i / bins, 2) * scopeData.f.length * 0.7);
    const v = scopeData.f[idx] / 255;
    const bw = w / bins;
    sctx.fillStyle = `hsla(${200 + i * 2.5}, 90%, 62%, 0.55)`;
    sctx.fillRect(i * bw, h - v * h, bw - 1, v * h);
  }
  an.getFloatTimeDomainData(scopeData.t);
  sctx.strokeStyle = 'rgba(255,255,255,0.9)';
  sctx.lineWidth = Math.max(1, w / 400);
  sctx.beginPath();
  for (let i = 0; i < scopeData.t.length; i += 2) {
    const x = (i / scopeData.t.length) * w, y = h / 2 - scopeData.t[i] * h * 0.45;
    i ? sctx.lineTo(x, y) : sctx.moveTo(x, y);
  }
  sctx.stroke();
}

let last = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  // gesture playback
  const vals = gesture.values(now());
  let changed = false;
  for (const [p, v] of Object.entries(vals)) {
    if (Math.abs(state.params[p] - v) > 1e-4) { setParam(p, v, false); changed = true; }
  }
  if (changed) syncKnobs();
  drawArt(dt);
  drawScope();
  // tap LED blink
  const tapLed = $('#ledTap');
  const cs = state.cap.state;
  tapLed.className = 'foot-led';
  if (cs === 'rec') tapLed.classList.add('rec');
  else if (cs === 'play') tapLed.classList.add(state.cap.short ? 'loop-short' : 'loop-long');
  else if (state.bpm && state.on) {
    const beat = 60 / state.bpm;
    if ((now() % beat) / beat < 0.18) tapLed.classList.add('beat');
  }
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Meters, calibration, capture status                                 */
/* ------------------------------------------------------------------ */

let calibrating = null;
engine.onMeter = (m) => {
  const toW = (v) => `${Math.min(100, Math.max(0, (20 * Math.log10(v + 1e-6) + 48) / 48 * 100))}%`;
  $('#meterIn').style.width = toW(m.in);
  $('#meterOut').style.width = toW(m.out);
  state.level += (Math.min(1, m.out * 1.6) - state.level) * 0.2;
  if (calibrating) calibrating.peak = Math.max(calibrating.peak, m.in / CALIBRATION[state.calibration].gain);
  const prev = state.cap.state;
  state.cap = m.cap;
  if (prev !== m.cap.state || m.cap.state !== 'idle') renderCapture();
};

function renderCapture() {
  const c = state.cap, el = $('#capState');
  if (c.state === 'rec') el.textContent = `● Aufnahme … ${c.len.toFixed(1)} s`;
  else if (c.state === 'play') el.textContent = `▶ Loop ${c.len.toFixed(1)} s ${c.short ? '(kurz: überlappendes Pad)' : '(Looper)'} · ${Math.round(c.pos * 100)} %`;
  else el.textContent = 'Leer. TAP gedrückt halten (oder Leertaste), um aufzunehmen.';
}

function autoCalibrate() {
  calibrating = { peak: 0 };
  info('KALIBRIERUNG', 'Spiel ein paar Akkorde in normaler Lautstärke … (4 s)', true);
  setTimeout(() => {
    const raw = calibrating.peak;
    calibrating = null;
    if (raw < 0.002) { info('KALIBRIERUNG', 'Kein Signal erkannt'); return; }
    let best = 0, bestErr = Infinity;
    CALIBRATION.forEach((c, i) => {
      const err = Math.abs(Math.log((raw * c.gain) / 0.5));
      if (err < bestErr) { bestErr = err; best = i; }
    });
    state.calibration = best;
    engine.send({ type: 'inputGain', value: CALIBRATION[best].gain });
    render();
    info(`KALIBRIERT: Stufe ${best + 1}`, CALIBRATION[best].desc);
  }, 4000);
}

/* ------------------------------------------------------------------ */
/* Sources & power                                                     */
/* ------------------------------------------------------------------ */

async function setSource(src) {
  if (!state.on) return;
  try {
    if (src === 'guitar' || src === 'drums') engine.useDemo(src);
    else if (src === 'mic') { await engine.useMic(); info('MIKRO / LINE-IN aktiv', 'Kopfhörer benutzen! Danach am besten „Auto“-Kalibrierung.'); }
    else if (src === 'file') { $('#fileInput').click(); return; }
    else engine.stopSource();
    state.source = src;
    render();
  } catch (err) {
    info('Eingang nicht verfügbar', err.message || String(err));
  }
}

async function powerOn() {
  const btn = $('#powerBtn');
  btn.disabled = true;
  btn.textContent = 'Starte …';
  try {
    await engine.init();
    state.on = true;
    $('#power').classList.add('hidden');
    sendAll();
    engine.useDemo('guitar');
    state.source = 'guitar';
    loadPreset(state.slot);
    render();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '⏻ Einschalten';
    info('Audio-Start fehlgeschlagen', `${err.message || err}. Die App muss über http(s) laufen, nicht als file://.`, true);
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function wire() {
  $('#powerBtn').addEventListener('click', powerOn);

  $$('.modbtn').forEach((b) => {
    const m = +b.dataset.m;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); modDown(m); });
    b.addEventListener('pointerup', () => modUp(m));
    b.addEventListener('pointercancel', () => modUp(m));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  $$('.combo').forEach((b) => {
    if (b.dataset.combo === 'gesture') {
      let t = null, long = false;
      b.addEventListener('pointerdown', () => { long = false; t = setTimeout(() => { long = true; clearGesture(); }, 700); });
      b.addEventListener('pointerup', () => { clearTimeout(t); if (!long) combo('gesture'); });
      b.addEventListener('pointerleave', () => clearTimeout(t));
    } else b.addEventListener('click', () => combo(b.dataset.combo));
  });

  const fsB = $('#fsBypass');
  let bT = null, bLong = false;
  fsB.addEventListener('pointerdown', (e) => { e.preventDefault(); bLong = false; fsB.classList.add('down'); bT = setTimeout(() => { bLong = true; openPresets(); }, 600); });
  fsB.addEventListener('pointerup', () => { fsB.classList.remove('down'); clearTimeout(bT); if (!bLong) bypassPress(); });
  fsB.addEventListener('pointerleave', () => { fsB.classList.remove('down'); clearTimeout(bT); });

  const fsT = $('#fsTap');
  let tDown = false;
  fsT.addEventListener('pointerdown', (e) => { e.preventDefault(); fsT.setPointerCapture(e.pointerId); tDown = true; fsT.classList.add('down'); tapDown(); });
  const tEnd = () => { if (!tDown) return; tDown = false; fsT.classList.remove('down'); tapUp(); };
  fsT.addEventListener('pointerup', tEnd);
  fsT.addEventListener('pointercancel', tEnd);

  $$('#sources button').forEach((b) => b.addEventListener('click', () => setSource(b.dataset.src)));
  $('#fileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      await engine.useFile(f);
      state.source = 'file';
      info('DATEI', f.name);
      render();
    } catch (err) { info('Datei nicht lesbar', err.message || String(err)); }
    e.target.value = '';
  });

  const calib = $('#calib');
  calib.innerHTML = CALIBRATION.map((c, i) => `<button data-level="${i}" title="${c.desc}">${c.label}</button>`).join('') + '<button data-auto="1">Auto</button>';
  $$('button', calib).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.auto) { autoCalibrate(); return; }
    state.calibration = +b.dataset.level;
    engine.send({ type: 'inputGain', value: CALIBRATION[state.calibration].gain });
    render();
  }));

  $$('#capRoute button').forEach((b) => b.addEventListener('click', () => {
    state.captureRoute = b.dataset.route;
    engine.send({ type: 'captureRoute', pre: state.captureRoute === 'pre' });
    render();
  }));

  $$('#banks button').forEach((b) => b.addEventListener('click', () => { state.bank = +b.dataset.bank; renderPresets(); render(); }));
  $('#presetGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.pslot');
    if (b) loadPreset(+b.dataset.slot);
  });
  $('#presetSave').addEventListener('click', savePreset);
  $('#presetName').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePreset(); });
  $('#presetDelete').addEventListener('click', () => {
    if (!presets[state.slot]) return;
    if (!confirm(`${slotName(state.slot)} „${presets[state.slot].name}“ löschen?`)) return;
    presets[state.slot] = null; saveAll(presets); renderPresets();
  });
  $('#presetFactory').addEventListener('click', () => {
    if (!confirm('Alle Presets durch die Werkspresets ersetzen?')) return;
    presets = resetFactory(); renderPresets();
  });
  $('#presetExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'chroma-console-web', presets }, null, 1)], { type: 'application/json' });
    download(blob, 'chroma-console-presets.json');
  });
  $('#presetImport').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : data.presets;
      if (!Array.isArray(list)) throw new Error('Unbekanntes Format');
      presets = new Array(SLOTS).fill(null).map((_, i) => list[i] || null);
      saveAll(presets); renderPresets();
      info('Presets importiert', `${presets.filter(Boolean).length} Slots belegt`);
    } catch (err) { info('Import fehlgeschlagen', err.message); }
    e.target.value = '';
  });

  $('#recBtn').addEventListener('click', async () => {
    if (!state.on) return;
    const btn = $('#recBtn');
    if (!engine.recorder) {
      engine.startRecording();
      btn.textContent = '■ Aufnahme stoppen';
      btn.classList.add('rec');
      $('#recLink').hidden = true;
    } else {
      const blob = await engine.stopRecording();
      btn.textContent = '● Aufnahme starten';
      btn.classList.remove('rec');
      const link = $('#recLink');
      link.href = URL.createObjectURL(blob);
      link.download = `chroma-console-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'}`;
      link.hidden = false;
    }
  });

  // keyboard: 1-4 = module buttons (hold two for combos), space = TAP, b = BYPASS
  const keyMod = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3 };
  window.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }
    if (e.code in keyMod) { modDown(keyMod[e.code]); e.preventDefault(); }
    else if (e.code === 'Space') { e.preventDefault(); if (!state.on) return; $('#fsTap').classList.add('down'); tapDown(); }
    else if (e.code === 'KeyB') bypassPress();
    else if (e.code === 'KeyG') combo('gesture');
    else if (e.code === 'KeyS') combo('shift');
  });
  window.addEventListener('keyup', (e) => {
    if (e.code in keyMod) modUp(keyMod[e.code]);
    else if (e.code === 'Space' && state.on) { $('#fsTap').classList.remove('down'); tapUp(); }
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ------------------------------------------------------------------ */

buildPedal();
wire();
// show the first preset's settings on the (still silent) pedal
(() => {
  const p = presets[0];
  if (p) { state.params = { ...DEFAULTS, ...p.params }; state.effects = [...p.effects]; state.order = [...p.order]; }
})();
render();
requestAnimationFrame(frame);
