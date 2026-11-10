// Synthesized drum kits. Generated locally (no third-party samples), so there are no
// redistribution concerns; both kits render identically live and offline.

import { noiseBuffer } from './instruments';

export interface DrumHit {
  stop(when?: number): void;
}

type Ctx = BaseAudioContext;

function tone(ctx: Ctx, out: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, sweep: number, level: number, decay: number): AudioScheduledSourceNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + sweep);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(level, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + decay + 0.02);
  return o;
}

function noise(ctx: Ctx, out: AudioNode, t: number, filterType: BiquadFilterType, freq: number, q: number, level: number, decay: number, offset = 0): { src: AudioBufferSourceNode; gain: GainNode } {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(level, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  src.connect(f).connect(g).connect(out);
  src.start(t, offset);
  src.stop(t + decay + 0.02);
  return { src, gain: g };
}

function metal(ctx: Ctx, out: AudioNode, t: number, base: number, level: number, decay: number): { stop: (w: number) => void } {
  // Inharmonic square cluster through a highpass — classic cymbal/hat synthesis.
  const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(level, t + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  hp.connect(g).connect(out);
  const oscs = ratios.map((r) => {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = base * r;
    o.connect(hp);
    o.start(t);
    o.stop(t + decay + 0.02);
    return o;
  });
  return {
    stop(w: number) {
      g.gain.cancelScheduledValues(w);
      g.gain.setTargetAtTime(0.0001, w, 0.008);
      oscs.forEach((o) => {
        try { o.stop(w + 0.05); } catch { /* noop */ }
      });
    },
  };
}

type HitFn = (ctx: Ctx, out: AudioNode, t: number, v: number) => DrumHit | void;

const studio: Record<string, HitFn> = {
  kick: (c, o, t, v) => { tone(c, o, t, 'sine', 150, 48, 0.12, 0.9 * v, 0.45); noise(c, o, t, 'lowpass', 2500, 0.7, 0.12 * v, 0.02); },
  snare: (c, o, t, v) => { tone(c, o, t, 'triangle', 240, 180, 0.05, 0.35 * v, 0.12); noise(c, o, t, 'bandpass', 3200, 0.6, 0.55 * v, 0.2, 0.3); },
  chh: (c, o, t, v) => { const m = metal(c, o, t, 40, 0.18 * v, 0.06); noise(c, o, t, 'highpass', 9000, 0.5, 0.12 * v, 0.05, 0.6); return { stop: (w = t) => m.stop(w) }; },
  ohh: (c, o, t, v) => { const m = metal(c, o, t, 40, 0.16 * v, 0.5); const n = noise(c, o, t, 'highpass', 8000, 0.5, 0.1 * v, 0.45, 0.7); return { stop: (w = t) => { m.stop(w); n.gain.gain.cancelScheduledValues(w); n.gain.gain.setTargetAtTime(0.0001, w, 0.008); } }; },
  tomL: (c, o, t, v) => { tone(c, o, t, 'sine', 140, 90, 0.2, 0.7 * v, 0.45); noise(c, o, t, 'lowpass', 1200, 0.5, 0.06 * v, 0.05); },
  tomH: (c, o, t, v) => { tone(c, o, t, 'sine', 220, 150, 0.18, 0.65 * v, 0.35); noise(c, o, t, 'lowpass', 1800, 0.5, 0.06 * v, 0.05); },
  crash: (c, o, t, v) => { metal(c, o, t, 52, 0.12 * v, 1.6); noise(c, o, t, 'highpass', 5000, 0.4, 0.22 * v, 1.6, 0.2); },
  clap: (c, o, t, v) => { for (let i = 0; i < 3; i++) noise(c, o, t + i * 0.011, 'bandpass', 1400, 1.2, 0.5 * v, 0.03, 0.1 * i); noise(c, o, t + 0.033, 'bandpass', 1300, 1, 0.45 * v, 0.2, 0.5); },
  rim: (c, o, t, v) => { tone(c, o, t, 'square', 1700, 1600, 0.01, 0.2 * v, 0.03); noise(c, o, t, 'bandpass', 4000, 2, 0.2 * v, 0.02); },
  cowbell: (c, o, t, v) => { const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 800; bp.Q.value = 2; bp.connect(o); tone(c, bp, t, 'square', 540, 540, 0.01, 0.35 * v, 0.3); tone(c, bp, t, 'square', 800, 800, 0.01, 0.35 * v, 0.3); },
  shaker: (c, o, t, v) => { noise(c, o, t, 'highpass', 6000, 0.8, 0.22 * v, 0.07, 0.9); },
  congaL: (c, o, t, v) => { tone(c, o, t, 'sine', 230, 190, 0.05, 0.6 * v, 0.3); },
  congaH: (c, o, t, v) => { tone(c, o, t, 'sine', 340, 300, 0.04, 0.55 * v, 0.22); },
  ride: (c, o, t, v) => { metal(c, o, t, 70, 0.08 * v, 1.2); tone(c, o, t, 'sine', 3200, 3200, 0.01, 0.05 * v, 0.8); },
  snap: (c, o, t, v) => { noise(c, o, t, 'bandpass', 2200, 3, 0.7 * v, 0.06, 1.1); },
  tomF: (c, o, t, v) => { tone(c, o, t, 'sine', 110, 70, 0.25, 0.75 * v, 0.55); noise(c, o, t, 'lowpass', 900, 0.5, 0.06 * v, 0.05); },
};

const electro: Record<string, HitFn> = {
  ...studio,
  kick: (c, o, t, v) => { tone(c, o, t, 'sine', 120, 42, 0.25, 1.0 * v, 0.9); tone(c, o, t, 'triangle', 600, 60, 0.02, 0.2 * v, 0.03); },
  snare: (c, o, t, v) => { tone(c, o, t, 'triangle', 200, 160, 0.03, 0.3 * v, 0.1); noise(c, o, t, 'highpass', 1800, 0.7, 0.5 * v, 0.18, 0.4); },
  chh: (c, o, t, v) => { const m = metal(c, o, t, 46, 0.2 * v, 0.045); return { stop: (w = t) => m.stop(w) }; },
  ohh: (c, o, t, v) => { const m = metal(c, o, t, 46, 0.18 * v, 0.35); return { stop: (w = t) => m.stop(w) }; },
  tomL: (c, o, t, v) => { tone(c, o, t, 'sine', 120, 70, 0.3, 0.8 * v, 0.5); },
  tomH: (c, o, t, v) => { tone(c, o, t, 'sine', 200, 120, 0.25, 0.75 * v, 0.4); },
  clap: (c, o, t, v) => { for (let i = 0; i < 4; i++) noise(c, o, t + i * 0.009, 'bandpass', 1100, 1.5, 0.5 * v, 0.025, 0.2 * i); noise(c, o, t + 0.036, 'bandpass', 1000, 1.2, 0.45 * v, 0.25, 0.6); },
};

const KITS: Record<string, Record<string, HitFn>> = { 'kit-studio': studio, 'kit-electro': electro };

/** Tracks open hats per output so closed hats (and new open hats) choke them. */
const openHats = new WeakMap<AudioNode, DrumHit>();

export function playDrum(ctx: Ctx, out: AudioNode, kitId: string, padId: string, t: number, velocity: number): void {
  const kit = KITS[kitId] ?? studio;
  const fn = kit[padId];
  if (!fn) return;
  if (padId === 'chh' || padId === 'ohh') {
    const prev = openHats.get(out);
    if (prev) {
      prev.stop(t);
      openHats.delete(out);
    }
  }
  const v = Math.max(0.05, Math.min(1, velocity / 127));
  const hit = fn(ctx, out, t, v);
  if (padId === 'ohh' && hit) openHats.set(out, hit);
}
