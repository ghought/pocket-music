// Mixer graph shared by live playback and offline export.

import type { Project, Track } from '../domain/types';

export interface TrackStrip {
  input: GainNode;
  tone: BiquadFilterNode;
  presence: BiquadFilterNode;
  pan: StereoPannerNode;
  fader: GainNode;
  send: GainNode;
}

export interface MixGraph {
  ctx: BaseAudioContext;
  strips: Map<string, TrackStrip>;
  masterIn: GainNode;
  analyser?: AnalyserNode;
  output: AudioNode;
  sync(p: Project, smooth?: boolean): void;
}

/** Deterministic stereo reverb impulse. */
function impulse(ctx: BaseAudioContext, seconds = 2.2, decay = 3): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let s = 0x9e3779b9 ^ (ch * 0x85ebca6b);
    for (let i = 0; i < len; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const r = ((s >>> 0) / 0xffffffff) * 2 - 1;
      d[i] = r * Math.pow(1 - i / len, decay) * (i < ctx.sampleRate * 0.01 ? i / (ctx.sampleRate * 0.01) : 1);
    }
  }
  return b;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function trackAudible(p: Project, t: Track): boolean {
  const anySolo = p.trackIds.some((id) => p.tracks[id]?.solo);
  return anySolo ? t.solo : !t.mute;
}

export function buildGraph(ctx: BaseAudioContext, destination: AudioNode, withAnalyser: boolean): MixGraph {
  const masterIn = ctx.createGain();
  masterIn.gain.value = 0.8;
  // Gentle glue compressor, then a fast safety limiter. Output protection, not mastering.
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -14;
  glue.knee.value = 10;
  glue.ratio.value = 2.5;
  glue.attack.value = 0.01;
  glue.release.value = 0.2;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.08;
  const out = ctx.createGain();
  out.gain.value = 0.9;
  masterIn.connect(glue).connect(limiter).connect(out).connect(destination);
  let analyser: AnalyserNode | undefined;
  if (withAnalyser) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    out.connect(analyser);
  }
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx);
  const reverbReturn = ctx.createGain();
  reverbReturn.gain.value = 0.55;
  reverb.connect(reverbReturn).connect(masterIn);

  const strips = new Map<string, TrackStrip>();

  function makeStrip(): TrackStrip {
    const input = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 0.5;
    const presence = ctx.createBiquadFilter();
    presence.type = 'highshelf';
    presence.frequency.value = 3500;
    const pan = ctx.createStereoPanner();
    const fader = ctx.createGain();
    const send = ctx.createGain();
    input.connect(tone).connect(presence).connect(pan).connect(fader).connect(masterIn);
    fader.connect(send).connect(reverb);
    return { input, tone, presence, pan, fader, send };
  }

  const set = (param: AudioParam, v: number, smooth: boolean) => {
    if (smooth && 'currentTime' in ctx) param.setTargetAtTime(v, ctx.currentTime, 0.02);
    else param.value = v;
  };

  return {
    ctx,
    strips,
    masterIn,
    analyser,
    output: out,
    sync(p, smooth = true) {
      for (const id of p.trackIds) {
        const t = p.tracks[id];
        let s = strips.get(id);
        if (!s) {
          s = makeStrip();
          strips.set(id, s);
        }
        // Tone macro: 0 → dark (lowpass 900 Hz), 0.5 → open, 1 → open + presence lift.
        const tn = t.effects.tone;
        const cutoff = tn >= 0.5 ? 20000 : 900 * Math.pow(20000 / 900, tn / 0.5);
        set(s.tone.frequency, cutoff, smooth);
        set(s.presence.gain, tn > 0.5 ? (tn - 0.5) * 2 * 6 : 0, smooth);
        set(s.pan.pan, t.pan, smooth);
        set(s.fader.gain, trackAudible(p, t) ? dbToGain(t.gainDb) : 0, smooth);
        set(s.send.gain, t.effects.space * 0.6, smooth);
      }
      for (const [id, s] of strips) {
        if (!p.tracks[id]) {
          s.fader.gain.value = 0;
          s.input.disconnect();
          strips.delete(id);
        }
      }
    },
  };
}
