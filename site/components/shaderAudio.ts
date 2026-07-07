/**
 * Generative WebAudio layer that mirrors the ShaderGuide physics — and is
 * deliberately PLAYABLE: pitch is positional, not random. The viewport is a
 * 2D keyboard — 10 pentatonic columns on X (low left, high right) and 3
 * octave rows on Y (high top, low bottom):
 *  - clicks pluck the note under the cursor; the burst sparks carry that
 *    same note and re-ring it when they arrive at a target,
 *  - dragging horizontally plays a scale run, vertically an octave arpeggio,
 *  - a drag DEFINES A CHORD: root from where the drag started, top voice
 *    from where it released. The release strums it, each launched spark
 *    carries one chord tone and rings it on landing, and when the whole
 *    volley has arrived the chord replays as reverb-washed celebration bells,
 *  - the ambient drone swells with cursor energy and target proximity,
 *    staying near-silent at rest.
 *
 * Starts muted; the AudioContext is only created on first unmute (a user
 * gesture), so there are no autoplay violations.
 */

const SCALE = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99];
const PENTA = 5; // notes per octave in SCALE (it spans two octaves)

// ---- proximity groove: one bar per chord, 16th-note grid ----
// Chill dubstep: 140 BPM in HALF-TIME (feels like 70) — kick on 1 with a
// syncopated ghost kick, one heavy snare on beat 3, sub bass on a 3-3-2
// tresillo so the whole thing thumps instead of bounces.
export const BPM = 140;
// Traditional dubstep minor progression i-i-VI-VII (two bars on the tonic
// keeps the focus on the groove; no major-III brightness)
const CHORDS = [
  [220.0, 261.63, 329.63],  // Am  (A3 C4 E4)
  [220.0, 261.63, 329.63],  // Am  (hold the tonic — groove first)
  [174.61, 220.0, 261.63],  // F   (F3 A3 C4)
  [196.0, 246.94, 293.66],  // G   (G3 B3 D4)
];
// A2 A2 F2 G2 — an octave above the "true" roots so small speakers can
// actually reproduce the fundamentals (a real sub layer rides below them)
const BASS_ROOTS = [55.0, 55.0, 43.65, 49.0]; // A1 A1 F1 G1 — sub-bass register

// ---- groove styles: which tune plays depends on which button you're
// approaching. Same BPM, same chords — genuinely different drums and bass.
// kick/snare/hat are 16-step velocity rows; bass is 8 eighth-note
// multipliers of the bar's sub root (0 = rest); gate is a 16-step chop mask.
interface GrooveStyle {
  kick: number[];
  snare: number[];
  hat: number[];
  bass: number[];
  gate: number[];
}
const GROOVES: Record<string, GrooveStyle> = {
  // npm install (and the page default): half-time dubstep — kick on the 1
  // with a syncopated ghost, ONE heavy snare on beat 3, sparse offbeat
  // hats, 3-3-2 tresillo sub bass, rolling tresillo gate
  install: {
    kick:  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, .8, 0, 0, 0, 0, 0],
    snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    hat:   [0, 0, .55, 0, 0, 0, .9, 0, 0, 0, .55, 0, 0, 0, .55, 0],
    bass:  [1, 0, 0, 1, 0, 0, 1, 0],
    gate:  [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0],
  },
  // workshop: double-time breaks — backbeat snares on 2 AND 4, a
  // syncopated kick pair, rolling 16th hats, a walking octave bassline
  // that climbs root-fifth-octave, straight offbeat gate chops
  workshop: {
    kick:  [1, 0, 0, 0, 0, 0, .7, 0, 0, 0, 1, 0, 0, .5, 0, 0],
    snare: [0, 0, 0, 0, .9, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    hat:   [.55, .3, .55, .3, .55, .3, .9, .3, .55, .3, .55, .3, .55, .3, .9, .45],
    bass:  [1, 1, 1.5, 0, 2, 0, 1.5, 1],
    gate:  [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
  },
};

export const NOTE_COLUMNS = SCALE.length;
export const NOTE_ROWS = 3;

/** Quantize a 0..1 horizontal position to a scale index. */
const colIndex = (x01: number) =>
  Math.max(0, Math.min(SCALE.length - 1, Math.floor(x01 * SCALE.length)));

/** Quantize a 0..1 vertical position to an octave multiplier (top = high). */
const octaveFor = (y01: number) => {
  const row = Math.max(0, Math.min(NOTE_ROWS - 1, Math.floor(y01 * NOTE_ROWS)));
  return row === 0 ? 2 : row === 1 ? 1 : 0.5;
};

/** 2D position → frequency: column picks the note, row picks the octave. */
const noteFor = (x01: number, y01: number) => SCALE[colIndex(x01)] * octaveFor(y01);

interface NoteOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  decay?: number;
  delay?: number;
  /** 0..1 send into the reverb bus (celebration space). */
  wet?: number;
}

class ShaderAudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private droneFilter: BiquadFilterNode | null = null;
  private droneGain: GainNode | null = null;
  private slingOsc: OscillatorNode | null = null;
  private slingOsc2: OscillatorNode | null = null;
  private slingFilt: BiquadFilterNode | null = null;
  private slingGain: GainNode | null = null;
  private creakOsc: OscillatorNode | null = null;
  private creakGain: GainNode | null = null;
  private holdOsc: OscillatorNode | null = null;
  private holdOsc2: OscillatorNode | null = null;
  private holdFilt: BiquadFilterNode | null = null;
  private holdGain: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private padGains: GainNode[] = [];
  private padOscs: OscillatorNode[] = [];
  private gateOscs: OscillatorNode[] = [];
  private gateGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private nextStep = 0;   // ctx time of the next 16th
  private stepIdx = 0;    // 0..15 within the bar
  private grooveStyle = 'install';  // active arrangement (per-target tune)
  private pendingStyle = 'install'; // adopted at the next bar line
  private barChord = 3;   // progression slot; first bar advance lands on Am
  private grooveKick = 0; // kick level last scheduled (for beatPulse)
  private lastKickAt = 0;
  private prevKickAt = 0;
  private hitQueue: { t: number; type: 'kick' | 'snare' }[] = [];
  private boostUntil = 0; // copy-payoff: groove forced to full until this time
  private muted = true;
  private lastTick = 0;

  get isMuted() {
    return this.muted;
  }

  /** Flips mute state; returns the new muted value. */
  toggle(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (!m) {
      this.ensure();
      const ctx = this.ctx!;
      if (ctx.state === 'suspended') void ctx.resume();
      this.master!.gain.cancelScheduledValues(ctx.currentTime);
      this.master!.gain.setTargetAtTime(1, ctx.currentTime, 0.4);
    } else if (this.ctx && this.master) {
      this.stopSling();
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.12);
    }
  }

  /** The rAF loop stops on hidden tabs, so sustained oscillators (pads,
   * drone, gate) would hum forever at their last gain — fade the master
   * out on hide and back in on return. */
  private onVisibility = () => {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    if (document.hidden) {
      this.stopSling();
      this.stopHold();
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(0, t, 0.1);
    } else if (!this.muted) {
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(1, t, 0.4);
    }
  };

  private ensure() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    document.addEventListener('visibilitychange', this.onVisibility);

    // Reverb bus: generated exponential-decay noise impulse (no assets).
    const irLen = Math.floor(ctx.sampleRate * 1.8);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.4);
      }
    }
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = ir;
    const wetMaster = ctx.createGain();
    wetMaster.gain.value = 0.6;
    this.reverb.connect(wetMaster);
    wetMaster.connect(this.master);

    // Ambient drone: detuned triangles through a slowly breathing lowpass.
    // Near-silent at rest; tick() swells it with cursor energy + proximity.
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 300;
    this.droneFilter.Q.value = 0.8;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.006;
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.master);
    for (const f of [55, 110.6, 165.2]) { // A1 + slightly detuned A2/E3
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.connect(this.droneFilter);
      o.start();
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 90;
    lfo.connect(lfoGain);
    lfoGain.connect(this.droneFilter.frequency);
    lfo.start();

    // Proximity pads: sustained chord tones that tick() fades in one by one
    // as the cursor approaches a target; the scheduler retunes them each bar
    // to follow the Am-F-C-G progression.
    this.padOscs = [];
    this.padGains = CHORDS[0].map(f => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(this.master!);
      o.start();
      this.padOscs.push(o);
      return g;
    });

    // Gated chord layer: the same triad through a hard rhythmic gate and a
    // rounder filter — the classic chopped trance-pad, opened at high prox.
    const gateFilter = ctx.createBiquadFilter();
    gateFilter.type = 'lowpass';
    gateFilter.frequency.value = 1400;
    this.gateGain = ctx.createGain();
    this.gateGain.gain.value = 0;
    this.gateGain.connect(gateFilter);
    gateFilter.connect(this.master);
    this.gateOscs = CHORDS[0].map(f => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(this.gateGain!);
      o.start();
      return o;
    });

    // Shared noise buffer for the snare / hat.
    const nLen = Math.floor(ctx.sampleRate * 0.3);
    this.noiseBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nLen; i++) nd[i] = Math.random() * 2 - 1;
  }

  private ready() {
    return !this.muted && !!this.ctx && !!this.master;
  }

  private note(freq: number, opts: NoteOpts = {}) {
    if (!this.ready()) return;
    const { type = 'triangle', gain = 0.12, attack = 0.005, decay = 0.5, delay = 0, wet = 0 } = opts;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0004, t0 + attack + decay);
    o.connect(g);
    g.connect(this.master!);
    if (wet > 0 && this.reverb) {
      const w = ctx.createGain();
      w.gain.value = wet;
      g.connect(w);
      w.connect(this.reverb);
    }
    o.start(t0);
    o.stop(t0 + attack + decay + 0.05);
  }

  /** The 2D note at a viewport position (for tagging carrier sparks). */
  noteAt(x01: number, y01: number) {
    return noteFor(x01, y01);
  }

  /**
   * Build a chord from a drag: root note+octave from the start point, top
   * voice reaching toward the end point, tones sampled across the span.
   * Deterministic — the same drag always plays the same chord.
   */
  chordFrom(x0: number, y0: number, x1: number, y1: number, size: number): number[] {
    const a = colIndex(x0);
    const b = colIndex(x1);
    const lo = Math.min(a, b);
    const span = Math.max(Math.abs(b - a), size - 1);
    const rootOct = octaveFor(y0);
    const topOct = octaveFor(y1);
    const freqs: number[] = [];
    for (let k = 0; k < size; k++) {
      let idx = lo + Math.round((span * k) / (size - 1));
      let oct = k === size - 1 ? topOct : rootOct;
      while (idx >= SCALE.length) {
        idx -= PENTA; // wrap up an octave (same pitch class)
        oct *= 2;
      }
      freqs.push(SCALE[idx] * oct);
    }
    return freqs;
  }

  /** Nearest current-chord tone to the position's own note (searched across
   * octaves), so clicks and landings always harmonize with the groove and
   * with whatever rings against the target. */
  chordToneAt(x01: number, y01: number, octave = 1): number {
    const pos = noteFor(x01, y01);
    const ch = this.currentChord();
    let best = ch[0];
    let bd = Infinity;
    for (const f of ch) {
      for (const m of [0.5, 1, 2, 4]) {
        const d = Math.abs(Math.log2(pos / (f * m)));
        if (d < bd) { bd = d; best = f * m; }
      }
    }
    return best * octave;
  }

  /** Click burst → pluck a tone RELATIVE to the target harmony: light
   * clicks take the chord tone nearest the cursor, power-charged clicks
   * (octave < 1) answer with the chord ROOT dropped low. Returns the
   * sounded frequency so the burst's dots can carry it to the target. */
  pluck(x01: number, y01: number, octave = 1): number {
    const f = (octave < 1 ? this.currentChord()[0] : this.chordToneAt(x01, y01)) * octave;
    const heavy = octave < 1 ? 1.4 : 1; // charged clicks land harder
    this.note(f, { gain: 0.14 * heavy, decay: 0.6 * heavy });
    this.note(f * 2, { type: 'sine', gain: 0.05 * heavy, decay: 0.35 });
    // charged release detonates: descending sub boom scaled by the charge
    if (octave < 1 && this.ready()) {
      const ctx = this.ctx!;
      const t = ctx.currentTime;
      const depth = 1 - octave; // 0.5 or 0.75
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(95, t);
      o.frequency.exponentialRampToValueAtTime(34, t + 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.42 * depth, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
      o.connect(g);
      g.connect(this.master!);
      o.start(t);
      o.stop(t + 1);
    }
    return f;
  }

  /** Drag crossing a column/row boundary → a quick, quiet glissando pluck. */
  gliss(x01: number, y01: number) {
    this.note(noteFor(x01, y01), { gain: 0.06, decay: 0.22 });
  }

  /** Untagged spark landing → the chord tone nearest the target, an octave
   * up — the same harmony the clicks that launched it were plucked from. */
  chime(x01: number, y01: number) {
    if (!this.ready()) return;
    const f = this.chordToneAt(x01, y01, 2);
    this.note(f, { type: 'sine', gain: 0.05, decay: 0.9 });
    this.note(f * 1.005, { type: 'sine', gain: 0.028, decay: 1.2 });
  }

  /** A carrier spark landing → ring the exact tone it was launched with. */
  ringNote(freq: number) {
    this.note(freq * 2, { type: 'sine', gain: 0.045, decay: 0.8, wet: 0.25 });
  }

  /** Click-on-target "data zap": a fast descending square-wave blip run. */
  zap(x01: number, y01: number) {
    const f = noteFor(x01, y01) * 2;
    [1.0, 0.667, 0.5].forEach((m, i) =>
      this.note(f * m, { type: 'square', gain: 0.045, decay: 0.11, delay: i * 0.045 }));
  }

  /** A pitch-swept voice (portamento) — used by the target signatures. */
  private sweep(f0: number, f1: number, opts: {
    type?: OscillatorType; gain?: number; dur?: number; delay?: number; wet?: number;
  } = {}) {
    if (!this.ready()) return;
    const { type = 'sine', gain = 0.06, dur = 0.3, delay = 0, wet = 0 } = opts;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + dur + 0.08);
    o.connect(g);
    g.connect(this.master!);
    if (wet > 0 && this.reverb) {
      const w = ctx.createGain();
      w.gain.value = wet;
      g.connect(w);
      w.connect(this.reverb);
    }
    o.start(t0);
    o.stop(t0 + dur + 0.15);
  }

  /** Every button answers a click with its own SONG — a full one-bar
   * arrangement (its own drums, its own bassline, its own beat, its own
   * lead) scheduled on the groove's 16th-note grid at the SAME tempo and
   * over the SAME chord the bar is playing, so every song fits the track
   * while sounding like a different band. */
  targetHit(name: string, x01: number, y01: number) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const step = 60 / BPM / 4;
    const chord = this.currentChord();
    const root = BASS_ROOTS[Math.max(0, this.barChord)];
    // snap onto the shared 16th grid when the groove is running
    let t0 = ctx.currentTime + 0.03;
    if (this.nextStep > ctx.currentTime && this.nextStep < ctx.currentTime + 0.4) {
      t0 = this.nextStep;
    }
    const at = (s: number) => t0 + s * step;

    // song spec: [step, velocity] drums, [step, bass-root mult] bass,
    // [step, chord-index, octave-mult, opts] lead notes
    const play = (song: {
      kick?: [number, number][];
      snare?: [number, number][];
      hat?: [number, number][];
      bass?: [number, number][];
      lead?: [number, number, number, NoteOpts?][];
    }) => {
      for (const [s, lv] of song.kick ?? []) this.kick(at(s), lv);
      for (const [s, lv] of song.snare ?? []) this.snare(at(s), lv);
      for (const [s, lv] of song.hat ?? []) this.hat(at(s), lv);
      for (const [s, m] of song.bass ?? []) this.bass(at(s), root * m, 0.8);
      for (const [s, ci, oct, opts] of song.lead ?? []) {
        this.note(chord[ci % chord.length] * oct, {
          gain: 0.04, decay: 0.18, ...opts, delay: at(s) - ctx.currentTime,
        });
      }
    };

    switch (name) {
      case 'install':
        // TECHNO: four-on-the-floor kicks, offbeat hats, octave-pumping
        // 8th bass, chiptune square arp riding on top — no snare at all
        play({
          kick: [[0, 0.9], [4, 0.9], [8, 0.9], [12, 0.9]],
          hat: [[2, 0.8], [6, 0.8], [10, 0.8], [14, 0.8]],
          bass: [[0, 1], [2, 2], [4, 1], [6, 2], [8, 1], [10, 2], [12, 1], [14, 2]],
          lead: [0, 2, 4, 6, 8, 10, 12, 14].map((s, i) =>
            [s, i, 4, { type: 'square', gain: 0.028, decay: 0.08 }] as [number, number, number, NoteOpts]),
        });
        break;
      case 'workshop':
        // DRUM & BASS ANTHEM: breakbeat kicks (1 and the and-of-3), double
        // snares, rolling 16th hats, tresillo bass, brass chord stabs
        play({
          kick: [[0, 1], [10, 0.85]],
          snare: [[4, 0.8], [12, 0.9]],
          hat: Array.from({ length: 16 }, (_, s) => [s, s % 2 === 0 ? 0.5 : 0.25] as [number, number]),
          bass: [[0, 1], [3, 1], [6, 1], [8, 1], [11, 1.5], [14, 1]],
          lead: ([0, 6, 11] as const).flatMap(s =>
            [0, 1, 2].map(ci =>
              [s, ci, 2, { type: 'sawtooth', gain: 0.03, decay: 0.16, wet: 0.3 }] as [number, number, number, NoteOpts])),
        });
        break;
      case 'agent-first-link':
        // DUB REGGAE: one-drop (kick + snare together on beat 3), skank
        // chord chops on the offbeats, deep lazy bass, sine echo on top
        play({
          kick: [[8, 0.95]],
          snare: [[8, 0.5]],
          hat: [[2, 0.5], [6, 0.5], [10, 0.5], [14, 0.5]],
          bass: [[0, 1], [6, 1], [8, 1], [12, 1.5]],
          lead: ([2, 6, 10, 14] as const).flatMap(s =>
            [0, 1, 2].map(ci =>
              [s, ci, 2, { type: 'triangle', gain: 0.022, decay: 0.09 }] as [number, number, number, NoteOpts]))
            .concat([[0, 2, 4, { type: 'sine', gain: 0.045, decay: 0.9, wet: 0.7 }]]),
        });
        break;
      case 'setup-prompt':
        // LO-FI BOOM-BAP: lazy kick pair, soft backbeat snares, sparse
        // swung hats, two long mellow bass notes, music-box bells drifting
        play({
          kick: [[0, 0.8], [7, 0.6]],
          snare: [[4, 0.55], [12, 0.6]],
          hat: [[2, 0.5], [6, 0.7], [10, 0.5], [14, 0.7]],
          bass: [[0, 1], [8, 1]],
          lead: [
            [0, 2, 4, { type: 'sine', gain: 0.055, decay: 1.0, wet: 0.6 }],
            [4, 1, 4, { type: 'sine', gain: 0.05, decay: 1.0, wet: 0.6 }],
            [8, 0, 4, { type: 'sine', gain: 0.05, decay: 1.0, wet: 0.6 }],
            [12, 1, 4, { type: 'sine', gain: 0.05, decay: 1.2, wet: 0.7 }],
          ],
        });
        break;
      case 'skill-install':
        // ARCADE CHIPTUNE: straight rock beat under a frantic 16th-note
        // square-wave run that climbs an octave halfway through the bar
        play({
          kick: [[0, 0.85], [8, 0.85]],
          snare: [[4, 0.7], [12, 0.7]],
          hat: Array.from({ length: 8 }, (_, i) => [i * 2, 0.35] as [number, number]),
          bass: Array.from({ length: 8 }, (_, i) => [i * 2, i % 2 ? 2 : 1] as [number, number]),
          lead: Array.from({ length: 12 }, (_, i) =>
            [i, i, i < 6 ? 2 : 4, { type: 'square', gain: 0.026, decay: 0.07 }] as [number, number, number, NoteOpts])
            .concat([[12, 0, 8, { type: 'square', gain: 0.04, decay: 0.4, wet: 0.4 }]]),
        });
        break;
      default:
        // anything unnamed keeps the classic data zap
        this.zap(x01, y01);
    }
  }

  /** Closing a shift-click shape → an arpeggio of its vertices' notes. */
  arpeggio(freqs: number[]) {
    freqs.slice(0, 8).forEach((f, i) =>
      this.note(f, { gain: 0.09, decay: 0.6, delay: i * 0.07, wet: 0.4 }));
  }

  /** A spark striking one of the name's letter bumpers → that letter's own
   * note. The letters are keys on a glockenspiel laid over "John Lindquist":
   * index 0 (the J) is the tonic A3 and each letter to the right steps up
   * the same A-minor pentatonic the groove's chords live in, wrapping past
   * the SCALE table an octave at a time — so dots skittering across the
   * name play an in-key run, and any letter always harmonizes with the bar. */
  letterPing(i: number) {
    if (!this.ready()) return;
    let idx = Math.max(0, i);
    let oct = 1;
    while (idx >= SCALE.length) {
      idx -= PENTA; // wrap up an octave (same pitch class)
      oct *= 2;
    }
    const f = SCALE[idx] * oct;
    this.note(f, { type: 'triangle', gain: 0.055, decay: 0.4, wet: 0.2 });
    this.note(f * 2, { type: 'sine', gain: 0.022, decay: 0.6, wet: 0.3 });
  }

  /** A spark striking a drawn wall → the wall twangs like a string. */
  twang(freq: number) {
    this.note(freq, { type: 'triangle', gain: 0.05, decay: 0.5, wet: 0.2 });
    this.note(freq * 2.01, { type: 'sine', gain: 0.02, decay: 0.3, wet: 0.2 });
  }

  /** While a still click is held: a dark rumble that swells with the
   * charge — and past half power it turns MEAN: a detuned twin saw starts
   * beating against the first, the filter grinds open, and by full charge
   * it's an aggressive snarling saw. Call with 0 to stop. */
  holdCharge(p: number) {
    if (!this.ctx || this.muted || p <= 0.01) {
      this.stopHold();
      return;
    }
    const ctx = this.ctx;
    if (!this.holdOsc) {
      this.holdOsc = ctx.createOscillator();
      this.holdOsc.type = 'sawtooth';
      this.holdOsc2 = ctx.createOscillator();
      this.holdOsc2.type = 'sawtooth';
      this.holdGain = ctx.createGain();
      this.holdGain.gain.value = 0;
      this.holdFilt = ctx.createBiquadFilter();
      this.holdFilt.type = 'lowpass';
      this.holdFilt.frequency.value = 240;
      this.holdFilt.Q.value = 4;
      this.holdOsc.connect(this.holdFilt);
      this.holdOsc2.connect(this.holdFilt);
      this.holdFilt.connect(this.holdGain);
      this.holdGain.connect(this.master!);
      this.holdOsc.start();
      this.holdOsc2.start();
    }
    const t = ctx.currentTime;
    // low growl sliding up with a nervous flutter as it nears full power
    const flutter = p > 0.6 ? Math.sin(t * 30) * 4 * (p - 0.6) : 0;
    const f = 44 + p * 52 + flutter;
    this.holdOsc.frequency.setTargetAtTime(f, t, 0.05);
    // the grind: the twin saw detunes further with charge, so the beat
    // frequency climbs from a slow throb to a harsh buzz
    this.holdOsc2!.frequency.setTargetAtTime(f * (1.004 + p * 0.03) + p * 6, t, 0.05);
    // the snarl: the resonant filter tears open with charge²
    this.holdFilt!.frequency.setTargetAtTime(240 + p * p * 2400, t, 0.08);
    this.holdGain!.gain.setTargetAtTime(p * (0.11 + p * 0.09), t, 0.08);
  }

  private stopHold() {
    if (!this.holdOsc || !this.ctx) return;
    const o = this.holdOsc;
    const o2 = this.holdOsc2;
    const g = this.holdGain!;
    this.holdOsc = null;
    this.holdOsc2 = null;
    this.holdFilt = null;
    this.holdGain = null;
    g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    o.stop(this.ctx.currentTime + 0.25);
    o2?.stop(this.ctx.currentTime + 0.25);
  }

  /** While a rubber sheet (eggo / name) is being pulled: a rubbery creak
   * whose pitch and bite rise with the stretch — a thin, tense triangle
   * with a slow wow so it sounds elastic, not electronic. Call 0 to stop. */
  stretchCreak(p: number) {
    if (!this.ctx || this.muted || p <= 0.02) {
      this.stopCreak();
      return;
    }
    const ctx = this.ctx;
    if (!this.creakOsc) {
      this.creakOsc = ctx.createOscillator();
      this.creakOsc.type = 'triangle';
      this.creakGain = ctx.createGain();
      this.creakGain.gain.value = 0;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 700;
      bp.Q.value = 3;
      this.creakOsc.connect(bp);
      bp.connect(this.creakGain);
      this.creakGain.connect(this.master!);
      this.creakOsc.start();
    }
    const t = ctx.currentTime;
    const wow = Math.sin(t * 13) * (6 + p * 18); // elastic wobble
    this.creakOsc.frequency.setTargetAtTime(140 + p * 260 + wow, t, 0.04);
    this.creakGain!.gain.setTargetAtTime(0.02 + p * 0.05, t, 0.06);
  }

  private stopCreak() {
    if (!this.creakOsc || !this.ctx) return;
    const o = this.creakOsc;
    const g = this.creakGain!;
    this.creakOsc = null;
    this.creakGain = null;
    g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    o.stop(this.ctx.currentTime + 0.2);
  }

  /** A rubber sheet released after a stretch: an elastic SNAP — a bright
   * noise crack into a fast pitch-drop thwang, harder with the stretch. */
  snapBack(p: number) {
    this.stopCreak();
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    // the crack: a few ms of bright noise
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.09 + p * 0.1, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
    src.connect(hp);
    hp.connect(ng);
    ng.connect(this.master!);
    src.start(t);
    src.stop(t + 0.06);
    // the thwang: pitch dives like a snapped band, deeper when pulled far
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(420 - p * 120, t);
    o.frequency.exponentialRampToValueAtTime(120 - p * 40, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.1 + p * 0.08, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + 0.34);
  }

  /** Generic sequencer for the easter-egg layer: schedule a list of tones
   * with per-note timing/timbre. Every egg composes its own jingle. */
  playNotes(seq: { f: number; at?: number; type?: OscillatorType; gain?: number; decay?: number; wet?: number }[]) {
    for (const n of seq) {
      this.note(n.f, { type: n.type, gain: n.gain ?? 0.06, decay: n.decay ?? 0.4, delay: n.at ?? 0, wet: n.wet ?? 0 });
    }
  }

  /** Filtered-noise sweep (wind / thunder-tail / elevator whoosh). */
  whoosh(f0: number, f1: number, dur = 0.5, gain = 0.1) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(Math.max(40, f0), t);
    bp.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + Math.min(0.06, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** A deep sine detonation — pitch dives into the sub register. */
  subBoom(depth = 1) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70 + depth * 20, t);
    o.frequency.exponentialRampToValueAtTime(26, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.4 * depth, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + 1);
  }

  /** Pointer-down ignition: a soft rising blip that says "the charge has
   * begun" — shared by click-hold and click-drag, which both start here. */
  ignite() {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(230, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
    o.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + 0.2);
  }

  /** Mascot boop: a soft sine blip that dips and bounces back — the sound
   * of a finger pressing into something squishy. */
  boop() {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(340, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.09);
    o.frequency.exponentialRampToValueAtTime(235, t + 0.17);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.15, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + 0.28);
  }

  /** Every pixel monster owns one scale degree — its voice, from spawn
   * chirp to capture fanfare, so each creature is musically recognizable. */
  private monsterNote(seed: number) {
    return SCALE[Math.floor(seed * 9973) % SCALE.length];
  }

  /** A pixel monster materializes: a three-blip 8-bit teleport shimmer
   * climbing to the creature's identity note. */
  monsterSpawn(seed: number) {
    const f = this.monsterNote(seed);
    this.playNotes([
      { f, type: 'square', gain: 0.018, decay: 0.07 },
      { f: f * 1.5, at: 0.07, type: 'square', gain: 0.018, decay: 0.07 },
      { f: f * 2, at: 0.14, type: 'square', gain: 0.022, decay: 0.35, wet: 0.5 },
    ]);
  }

  /** A wandering monster's idle voice: a tiny two-blip chirp on its
   * identity note — some creatures chirp up, some down. */
  monsterChirp(seed: number) {
    const idx = Math.floor(seed * 9973) % SCALE.length;
    const f = SCALE[idx] * 2;
    const f2 = SCALE[seed > 0.5 ? Math.min(idx + 1, SCALE.length - 1) : Math.max(idx - 1, 0)] * 2;
    this.playNotes([
      { f, type: 'square', gain: 0.014, decay: 0.05 },
      { f: f2, at: 0.09, type: 'square', gain: 0.012, decay: 0.09, wet: 0.25 },
    ]);
  }

  /** The gate snaps shut on a monster: an 8-bit capture fanfare — a fast
   * pentatonic run up to the creature's note two octaves out, then a
   * reverb-washed bloom as it dissolves into light. */
  monsterCaught(seed: number) {
    const base = Math.floor(seed * 9973) % PENTA;
    const run = [SCALE[base], SCALE[base + 2], SCALE[base + 4], SCALE[base] * 4];
    this.playNotes([
      ...run.map((f, i) => ({
        f, at: i * 0.06, type: 'square' as OscillatorType, gain: 0.035, decay: 0.14,
      })),
      { f: run[3], at: 0.3, type: 'sine', gain: 0.045, decay: 1.2, wet: 0.8 },
      { f: run[3] * 1.5, at: 0.4, type: 'sine', gain: 0.032, decay: 1.4, wet: 0.8 },
    ]);
  }

  /** A monster escapes before the gate finds it: a falling zip into a
   * downward whoosh — gone. */
  monsterFlee(seed: number) {
    const f = this.monsterNote(seed) * 2;
    this.playNotes([
      { f, type: 'square', gain: 0.016, decay: 0.06 },
      { f: f * 0.75, at: 0.07, type: 'square', gain: 0.014, decay: 0.06 },
      { f: f * 0.5, at: 0.14, type: 'square', gain: 0.012, decay: 0.12, wet: 0.3 },
    ]);
    this.whoosh(1200, 160, 0.3, 0.04);
  }

  /** While the slingshot stretches: the SAME power-up voice as the held
   * click — twin detuned saws grinding harder as the charge builds, a
   * resonant filter tearing open with charge² — but pitched to the drag
   * anchor's note so the stretch still tunes itself to the chord it will
   * strum. Call with 0 to stop. */
  slingCharge(c: number, root = 220) {
    if (!this.ctx || this.muted || c <= 0.02) {
      this.stopSling();
      return;
    }
    const ctx = this.ctx;
    if (!this.slingOsc) {
      this.slingOsc = ctx.createOscillator();
      this.slingOsc.type = 'sawtooth';
      this.slingOsc2 = ctx.createOscillator();
      this.slingOsc2.type = 'sawtooth';
      this.slingGain = ctx.createGain();
      this.slingGain.gain.value = 0;
      this.slingFilt = ctx.createBiquadFilter();
      this.slingFilt.type = 'lowpass';
      this.slingFilt.frequency.value = 240;
      this.slingFilt.Q.value = 4;
      this.slingOsc.connect(this.slingFilt);
      this.slingOsc2.connect(this.slingFilt);
      this.slingFilt.connect(this.slingGain);
      this.slingGain.connect(this.master!);
      this.slingOsc.start();
      this.slingOsc2.start();
    }
    const t = ctx.currentTime;
    // growl register (root/4 -> root/2 as the pull deepens), same nervous
    // flutter near full power as the held click
    const flutter = c > 0.6 ? Math.sin(t * 30) * 4 * (c - 0.6) : 0;
    const f = root * 0.25 * (1 + 0.9 * c) + flutter;
    this.slingOsc.frequency.setTargetAtTime(f, t, 0.03);
    this.slingOsc2!.frequency.setTargetAtTime(f * (1.004 + c * 0.03) + c * 6, t, 0.03);
    this.slingFilt!.frequency.setTargetAtTime(240 + c * c * 2400, t, 0.08);
    this.slingGain!.gain.setTargetAtTime(c * (0.09 + c * 0.08), t, 0.05);
  }

  private stopSling() {
    if (!this.slingOsc || !this.ctx) return;
    const o = this.slingOsc;
    const o2 = this.slingOsc2;
    const g = this.slingGain!;
    this.slingOsc = null;
    this.slingOsc2 = null;
    this.slingFilt = null;
    this.slingGain = null;
    g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.04);
    o.stop(this.ctx.currentTime + 0.3);
    o2?.stop(this.ctx.currentTime + 0.3);
  }

  /** Slingshot release → filtered-noise whoosh + a strum of the drag chord. */
  slingRelease(c: number, freqs: number[]) {
    this.stopSling();
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dur = 0.5;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(400 + c * 1400, ctx.currentTime);
    bp.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.value = 0.05 + c * 0.1;
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master!);
    src.start();

    // strum tightens with power: a lazy arpeggio when flicked gently, a
    // near-simultaneous chord slam at full stretch
    const strumGap = 0.095 - c * 0.07;
    freqs.forEach((f, i) =>
      this.note(f, { gain: 0.1 + c * 0.06, decay: 0.7 + c * 0.4, delay: i * strumGap, wet: 0.15 + c * 0.15 }));
  }

  /**
   * The whole volley arrived → replay the chord as celebration: glassy
   * bell tones washed in reverb, arpeggiated then struck together.
   */
  celebrate(freqs: number[]) {
    if (!this.ready()) return;
    freqs.forEach((f, i) => {
      this.note(f * 2, { type: 'sine', gain: 0.06, decay: 1.6, delay: i * 0.07, wet: 0.9 });
      this.note(f * 3, { type: 'sine', gain: 0.02, decay: 1.0, delay: i * 0.07, wet: 0.9 });
    });
    const together = freqs.length * 0.07 + 0.22;
    freqs.forEach(f =>
      this.note(f * 2, { type: 'sine', gain: 0.045, decay: 2.2, delay: together, wet: 1 }));
  }

  // ---- proximity groove: kick / snare / hat scheduled on the audio clock ----

  private kick(t: number, lv: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    // deeper, rounder dubstep kick: short click into a long low tail
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.14);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.34 * lv, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    o.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + 0.3);
  }

  private snare(t: number, lv: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1600;
    const g = ctx.createGain();
    // half-time = one snare per bar, so it gets to be big
    g.gain.setValueAtTime(0.17 * lv, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.master!);
    src.start(t);
    src.stop(t + 0.26);
    this.note(170, { type: 'sine', gain: 0.06 * lv, decay: 0.12, delay: t - ctx.currentTime });
  }

  private hat(t: number, lv: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05 * lv, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.master!);
    src.start(t);
    src.stop(t + 0.08);
  }

  private bass(t: number, freq: number, lv: number) {
    const ctx = this.ctx!;
    // saw through a lowpass carries the pitch on laptop speakers...
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.24 * lv, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.48);
    o.connect(lp);
    lp.connect(g);
    g.connect(this.master!);
    o.start(t);
    o.stop(t + 0.52);
    // ...and a pure sine sub thumps on real speakers. Below ~60Hz the
    // root already IS sub territory — halving again would be subsonic,
    // so the sine reinforces the root instead.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq < 60 ? freq : freq * 0.5;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(0.16 * lv, t + 0.01);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    sub.connect(sg);
    sg.connect(this.master!);
    sub.start(t);
    sub.stop(t + 0.5);
  }

  /**
   * Keep a 16th-note grid running at BPM; layers fade in with proximity.
   * One bar per chord: pads + gate retune at every bar line.
   */
  private scheduleGroove(prox: number) {
    const ctx = this.ctx!;
    const step16 = 60 / BPM / 4;
    if (this.nextStep < ctx.currentTime) this.nextStep = ctx.currentTime + 0.05;
    const lvl = (from: number, to: number) =>
      Math.max(0, Math.min(1, (prox - from) / (to - from)));
    while (this.nextStep < ctx.currentTime + 0.35) {
      const t = this.nextStep;
      const s = this.stepIdx;
      const kickLv = lvl(0.3, 0.9);
      const bassLv = lvl(0.45, 0.95);
      const snareLv = lvl(0.55, 1.0);
      const gateLv = lvl(0.65, 1.0);
      const hatLv = lvl(0.75, 1.0);

      if (s === 0) {
        // bar line: advance the progression, retune pads + gate oscillators,
        // and adopt the pending groove style (musical style switches)
        this.grooveStyle = this.pendingStyle;
        this.barChord = (this.barChord + 1) % CHORDS.length;
        const ch = CHORDS[this.barChord];
        this.padOscs.forEach((o, i) => o.frequency.setTargetAtTime(ch[i], t, 0.06));
        this.gateOscs.forEach((o, i) => o.frequency.setTargetAtTime(ch[i], t, 0.02));
      }
      const st = GROOVES[this.grooveStyle] ?? GROOVES.install;
      const kv = st.kick[s];
      if (kv > 0) {
        this.grooveKick = kickLv;
        if (kickLv > 0.02) {
          this.kick(t, kickLv * kv);
          this.prevKickAt = this.lastKickAt;
          this.lastKickAt = t;
          if (this.hitQueue.length < 32) this.hitQueue.push({ t, type: 'kick' });
        }
      }
      const sv = st.snare[s];
      if (sv > 0 && snareLv > 0.02) {
        this.snare(t, snareLv * sv);
        if (this.hitQueue.length < 32) this.hitQueue.push({ t, type: 'snare' });
      }
      const hv = st.hat[s];
      if (hv > 0 && hatLv > 0.02) this.hat(t, hatLv * hv);
      if (s % 2 === 0 && bassLv > 0.02) {
        const mult = st.bass[s / 2];
        if (mult > 0) this.bass(t, BASS_ROOTS[this.barChord] * mult, bassLv);
      }
      if (this.gateGain && gateLv > 0.02 && st.gate[s]) {
        // chopped chord: softer open, longer hold — chill, not trancey
        const g = this.gateGain.gain;
        const peak = 0.04 * gateLv;
        g.setValueAtTime(0.0001, t);
        g.linearRampToValueAtTime(peak, t + 0.02);
        g.setValueAtTime(peak, t + step16 * 0.6);
        g.linearRampToValueAtTime(0.0001, t + step16 * 0.9);
      }
      this.stepIdx = (s + 1) % 16;
      this.nextStep += step16;
    }
  }

  /**
   * Drum hits whose scheduled time has arrived — the shader turns each into
   * a ripple from the grooving target (kick = crest-led, snare = trough-led).
   */
  consumeHits(): ('kick' | 'snare')[] {
    if (!this.ctx) return [];
    const now = this.ctx.currentTime;
    const due: ('kick' | 'snare')[] = [];
    this.hitQueue = this.hitQueue.filter(h => {
      if (h.t <= now) {
        if (now - h.t < 0.5) due.push(h.type); // drop stale hits silently
        return false;
      }
      return true;
    });
    return due;
  }

  /** The chord the current bar is playing (for payoff spark tagging). */
  currentChord(): number[] {
    return CHORDS[Math.max(0, this.barChord)];
  }

  /** Which button's tune the approach-groove should play. Applied at the
   * next bar line so the switch stays musical. Unknown names fall back to
   * the default (install) arrangement. */
  setGrooveStyle(name: string) {
    this.pendingStyle = GROOVES[name] ? name : 'install';
  }

  /**
   * The copy-button payoff: a sidechain duck into a sub boom, crash splash,
   * and a reverb-drenched stab of the current chord — then the whole
   * arrangement runs at full intensity for ~8s regardless of proximity,
   * deconstructing as the boost decays.
   */
  payoff() {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    this.boostUntil = t + 8;

    // sidechain dip for impact
    this.master!.gain.cancelScheduledValues(t);
    this.master!.gain.setValueAtTime(1, t);
    this.master!.gain.linearRampToValueAtTime(0.25, t + 0.03);
    this.master!.gain.linearRampToValueAtTime(1, t + 0.22);

    // sub boom
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, t + 0.03);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t + 0.03);
    g.gain.linearRampToValueAtTime(0.45, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(g);
    g.connect(this.master!);
    o.start(t + 0.03);
    o.stop(t + 1);

    // crash splash
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.16, t + 0.03);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    src.connect(hp);
    hp.connect(cg);
    cg.connect(this.master!);
    if (this.reverb) {
      const w = ctx.createGain();
      w.gain.value = 0.5;
      cg.connect(w);
      w.connect(this.reverb);
    }
    src.start(t + 0.03);
    src.stop(t + 1.5);

    // triumphant chord stab, drenched in reverb
    const chord = this.currentChord();
    chord.forEach((f, i) => {
      this.note(f * 2, { type: 'sine', gain: 0.09, decay: 2.4, delay: 0.06 + i * 0.04, wet: 1 });
      this.note(f, { gain: 0.07, decay: 1.2, delay: 0.06 + i * 0.04, wet: 0.5 });
    });
  }

  /**
   * 0..1 pulse synced to the kick, decaying over the beat — lets the shader
   * throb the target halo in time with the drums. 0 when the groove is off.
   */
  beatPulse(): number {
    if (!this.ready() || this.grooveKick <= 0.02 || !this.ctx) return 0;
    const now = this.ctx.currentTime;
    const kt = this.lastKickAt <= now ? this.lastKickAt : this.prevKickAt;
    if (kt <= 0) return 0;
    const phase = (now - kt) / (60 / BPM);
    if (phase < 0 || phase > 1) return 0;
    return this.grooveKick * Math.max(0, 1 - phase * 2.2);
  }

  /**
   * Per-frame, throttled. `speed` (css px/s) opens the drone filter and
   * `drive` (0..1, cursor energy + target proximity) swells its volume.
   * `prox` (0..1, proximity alone) builds the arrangement: chord pad tones
   * fade in one by one, then a four-on-the-floor kick, bassline, backbeat
   * snare, gated chords, and off-beat hats — hovering a guide target plays
   * the full track over the Am-F-C-G progression.
   */
  tick(speed: number, drive: number, prox: number) {
    if (!this.ready() || !this.droneFilter || !this.droneGain) return;
    const now = performance.now();
    if (now - this.lastTick < 120) return;
    this.lastTick = now;
    const t = this.ctx!.currentTime;
    // copy payoff overrides proximity: full arrangement, decaying over 8s
    const boost = this.boostUntil > t ? (this.boostUntil - t) / 8 : 0;
    prox = Math.max(prox, boost);
    drive = Math.max(drive, boost);
    const cutoff = 240 + Math.min(1800, speed) * 0.8 + drive * 500;
    this.droneFilter.frequency.setTargetAtTime(cutoff, t, 0.25);
    // The hum is a bed, not a lead: swell shallower than any music layer
    // (pads peak at 0.035) and duck it as the arrangement builds so the
    // groove reads over the drone instead of under it near a button.
    const duck = 1 - prox * 0.75;
    this.droneGain.gain.setTargetAtTime((0.006 + drive * 0.026) * duck, t, 0.3);

    const thresholds = [0.15, 0.45, 0.7];
    this.padGains.forEach((g, i) => {
      const lv = Math.max(0, Math.min(1, (prox - thresholds[i]) / (1 - thresholds[i])));
      g.gain.setTargetAtTime(lv * 0.035, t, 0.8); // slow, pad-like fades
    });

    this.scheduleGroove(prox);
  }
}

export const shaderAudio = new ShaderAudioEngine();
