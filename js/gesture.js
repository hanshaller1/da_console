// GESTURE: records knob movements and loops them like automation.
// The first recording defines the loop length; later recordings overdub
// (they replace only the tracks of the knobs you touched).

export class Gesture {
  constructor() {
    this.tracks = new Map(); // param -> [{t, v}]
    this.length = 0;
    this.recording = false;
    this.playing = false;
    this.playStart = 0;
    this.speed = 1;
    this.held = new Set();
    this.recTracks = null;
    this.newLoop = false;
  }

  get hasData() { return this.tracks.size > 0; }

  startRec(now) {
    this.recording = true;
    this.recStart = now;
    this.newLoop = !this.playing;
    if (this.newLoop) this.tracks.clear();
    this.recTracks = new Map();
  }

  pos(now) {
    if (!this.length) return 0;
    const p = ((now - this.playStart) * this.speed) % this.length;
    return p < 0 ? p + this.length : p;
  }

  record(param, v, now) {
    if (!this.recording) return;
    const t = this.newLoop ? now - this.recStart : this.pos(now);
    if (!this.recTracks.has(param)) this.recTracks.set(param, []);
    this.recTracks.get(param).push({ t, v });
  }

  stopRec(now) {
    if (!this.recording) return;
    this.recording = false;
    if (this.newLoop) {
      this.length = Math.max(0.25, now - this.recStart);
      this.playStart = now;
    }
    for (const [param, ev] of this.recTracks) {
      ev.sort((a, b) => a.t - b.t);
      this.tracks.set(param, ev);
    }
    this.recTracks = null;
    this.playing = this.tracks.size > 0;
  }

  clear() {
    this.tracks.clear();
    this.playing = false;
    this.recording = false;
    this.length = 0;
  }

  // values for all tracked params at time `now` (skips knobs held by the user)
  values(now) {
    const out = {};
    if (!this.playing || (this.recording && this.newLoop)) return out;
    const p = this.pos(now);
    for (const [param, ev] of this.tracks) {
      if (this.held.has(param) || !ev.length) continue;
      let v = ev[ev.length - 1].v; // before first event: wrap from end of loop
      for (let i = 0; i < ev.length; i++) { if (ev[i].t <= p) v = ev[i].v; else break; }
      out[param] = v;
    }
    return out;
  }

  serialize() {
    if (!this.hasData) return null;
    return { length: this.length, speed: this.speed, tracks: Object.fromEntries(this.tracks) };
  }

  load(data, now) {
    this.clear();
    if (!data || !data.tracks) return;
    this.length = data.length;
    this.speed = data.speed || 1;
    for (const [k, ev] of Object.entries(data.tracks)) this.tracks.set(k, ev);
    this.playing = this.tracks.size > 0;
    this.playStart = now;
  }
}
