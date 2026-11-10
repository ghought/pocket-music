// Instrument voices built from Web Audio nodes. The same code runs on the live AudioContext
// and on the OfflineAudioContext used for export, so export sounds like playback.

import { midiToHz } from '../domain/music';

export interface Voice {
  /** Release at audio time `when` (defaults to now). */
  release(when?: number): void;
  /** Hard stop (stuck-note recovery). */
  kill(): void;
  endTime: number;
}

// Deterministic noise so live and offline renders match.
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (b) return b;
  b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = 0x2545f491;
  for (let i = 0; i < d.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    d[i] = ((s >>> 0) / 0xffffffff) * 2 - 1;
  }
  noiseCache.set(ctx, b);
  return b;
}

function env(param: AudioParam, t: number, peak: number, a: number, d: number, s: number) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0.0001, t);
  param.linearRampToValueAtTime(peak, t + a);
  param.setTargetAtTime(Math.max(0.0001, peak * s), t + a, d / 3);
}

function releaseParam(param: AudioParam, when: number, r: number) {
  // cancelAndHoldAtTime is not on every browser; approximate with setTargetAtTime from current.
  const anyParam = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (anyParam.cancelAndHoldAtTime) anyParam.cancelAndHoldAtTime(when);
  else param.cancelScheduledValues(when);
  param.setTargetAtTime(0.0001, when, r / 4);
}

type Builder = (ctx: BaseAudioContext, out: AudioNode, t: number, midi: number, vel: number) => Voice;

const piano: Builder = (ctx, out, t, midi, vel) => {
  const f = midiToHz(midi);
  const amp = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(16000, f * 10 + 1500 * (vel / 127)), t);
  lp.frequency.setTargetAtTime(f * 3 + 400, t, 0.4);
  lp.connect(amp).connect(out);
  const peak = 0.22 * (0.35 + 0.65 * (vel / 127));
  // Decay time shortens for higher notes like a struck string.
  const decay = 2.6 * Math.pow(0.5, (midi - 48) / 24);
  amp.gain.setValueAtTime(0.0001, t);
  amp.gain.linearRampToValueAtTime(peak, t + 0.004);
  amp.gain.setTargetAtTime(peak * 0.25, t + 0.004, decay * 0.15);
  amp.gain.setTargetAtTime(0.0001, t + 0.3, decay);
  const partials: [number, number, OscillatorType, number][] = [
    [1, 1, 'triangle', 0],
    [2, 0.35, 'sine', 3],
    [3, 0.12, 'sine', -4],
    [1, 0.4, 'sine', 6],
  ];
  const oscs = partials.map(([mul, g, type, cents]) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f * mul;
    o.detune.value = cents;
    const gg = ctx.createGain();
    gg.gain.value = g;
    o.connect(gg).connect(lp);
    o.start(t);
    return o;
  });
  // Hammer click
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const ng = ctx.createGain();
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = Math.min(8000, f * 4);
  ng.gain.setValueAtTime(0.05 * (vel / 127), t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  n.connect(bp).connect(ng).connect(out);
  n.start(t, Math.random() * 0 + (midi % 7) * 0.1);
  n.stop(t + 0.05);
  let endTime = t + 0.3 + decay * 5;
  oscs.forEach((o) => o.stop(endTime));
  return {
    get endTime() {
      return endTime;
    },
    release(when = ctx.currentTime) {
      releaseParam(amp.gain, Math.max(when, t + 0.005), 0.35);
      endTime = Math.min(endTime, Math.max(when, t) + 0.6);
      oscs.forEach((o) => o.stop(endTime));
    },
    kill() {
      amp.gain.cancelScheduledValues(0);
      amp.gain.value = 0;
      oscs.forEach((o) => {
        try { o.stop(); } catch { /* already stopped */ }
      });
    },
  };
};

function subtractive(opts: { types: OscillatorType[]; detune: number[]; a: number; d: number; s: number; r: number; cutoffMul: number; envAmt: number; fd: number; q: number; level: number; sub?: number }): Builder {
  return (ctx, out, t, midi, vel) => {
    const f = midiToHz(midi);
    const amp = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = opts.q;
    const base = Math.min(18000, f * opts.cutoffMul + 200);
    const peakCut = Math.min(18000, base + opts.envAmt * (0.4 + 0.6 * (vel / 127)));
    lp.frequency.setValueAtTime(peakCut, t);
    lp.frequency.setTargetAtTime(base, t, opts.fd);
    lp.connect(amp).connect(out);
    const peak = opts.level * (0.4 + 0.6 * (vel / 127));
    env(amp.gain, t, peak, opts.a, opts.d, opts.s);
    const oscs = opts.types.map((type, i) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = opts.detune[i] ?? 0;
      const g = ctx.createGain();
      g.gain.value = 1 / opts.types.length;
      o.connect(g).connect(lp);
      o.start(t);
      return o;
    });
    if (opts.sub) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f / 2;
      const g = ctx.createGain();
      g.gain.value = opts.sub;
      o.connect(g).connect(amp);
      o.start(t);
      oscs.push(o);
    }
    let endTime = Infinity;
    const self: Voice = {
      get endTime() {
        return endTime;
      },
      release(when = ctx.currentTime) {
        const w = Math.max(when, t + 0.003);
        releaseParam(amp.gain, w, opts.r);
        endTime = w + opts.r * 1.5 + 0.05;
        oscs.forEach((o) => o.stop(endTime));
      },
      kill() {
        amp.gain.cancelScheduledValues(0);
        amp.gain.value = 0;
        oscs.forEach((o) => {
          try { o.stop(); } catch { /* already stopped */ }
        });
      },
    };
    if (opts.s <= 0.001) {
      // Percussive patches end on their own.
      endTime = t + opts.a + opts.d * 2 + 0.1;
      oscs.forEach((o) => o.stop(endTime));
    }
    return self;
  };
}

const BUILDERS: Record<string, Builder> = {
  piano,
  warm: subtractive({ types: ['sawtooth', 'sawtooth', 'triangle'], detune: [-9, 8, 0], a: 0.04, d: 0.6, s: 0.7, r: 0.45, cutoffMul: 3, envAmt: 2200, fd: 0.35, q: 0.8, level: 0.2 }),
  pluck: subtractive({ types: ['square', 'sawtooth'], detune: [-4, 5], a: 0.003, d: 0.55, s: 0, r: 0.2, cutoffMul: 1.6, envAmt: 5000, fd: 0.08, q: 2, level: 0.22 }),
  bass: subtractive({ types: ['sawtooth', 'square'], detune: [0, -6], a: 0.005, d: 0.3, s: 0.75, r: 0.08, cutoffMul: 2.2, envAmt: 900, fd: 0.12, q: 1.5, level: 0.32, sub: 0.7 }),
};

export function playPitched(ctx: BaseAudioContext, out: AudioNode, instrumentId: string, t: number, midi: number, vel: number): Voice {
  const b = BUILDERS[instrumentId] ?? BUILDERS.warm;
  return b(ctx, out, t, midi, vel);
}
