// Monophonic hum transcription: YIN pitch tracking + conservative note segmentation.
// Pure and synchronous so it runs in a Worker and in unit tests.

export const ANALYSIS_RATE = 16000;
const HOP = 160; // 10 ms
const WIN = 512; // 32 ms
const MIN_HZ = 65;
const MAX_HZ = 1100;
const YIN_THRESHOLD = 0.15;

export interface Frame {
  time: number;
  midi: number | null; // fractional MIDI, null when unvoiced
  aperiodicity: number;
  rms: number;
}

export interface DetectedNote {
  startSeconds: number;
  durationSeconds: number;
  midi: number;
  velocity: number;
  uncertain: boolean;
}

export interface TranscribeResult {
  notes: DetectedNote[];
  frames: number;
  voicedFrames: number;
  peakRms: number;
}

/** Linear-interpolating resample to the analysis rate (with a simple box pre-filter). */
export function resample(input: Float32Array, fromRate: number, toRate = ANALYSIS_RATE): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  const box = Math.max(1, Math.floor(ratio));
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    let acc = 0;
    let n = 0;
    for (let k = 0; k < box && i0 + k < input.length; k++) {
      acc += input[i0 + k];
      n++;
    }
    out[i] = n ? acc / n : 0;
  }
  return out;
}

export function yinFrames(x: Float32Array, sr = ANALYSIS_RATE, isCancelled?: () => boolean): Frame[] {
  const tauMin = Math.floor(sr / MAX_HZ);
  const tauMax = Math.ceil(sr / MIN_HZ);
  const frames: Frame[] = [];
  const d = new Float32Array(tauMax + 1);
  for (let start = 0; start + WIN + tauMax < x.length; start += HOP) {
    if (isCancelled && frames.length % 200 === 0 && isCancelled()) throw new Error('cancelled');
    let energy = 0;
    for (let i = 0; i < WIN; i++) energy += x[start + i] * x[start + i];
    const rms = Math.sqrt(energy / WIN);
    // Difference function
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < WIN; i++) {
        const diff = x[start + i] - x[start + i + tau];
        s += diff * diff;
      }
      d[tau] = s;
    }
    // Cumulative mean normalized difference
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    let tauEst = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < YIN_THRESHOLD) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    let ap = 1;
    if (tauEst < 0) {
      // Fall back to the global minimum, flagged by its aperiodicity.
      let best = tauMin;
      for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < d[best]) best = tau;
      tauEst = best;
    }
    ap = d[tauEst];
    // Parabolic interpolation
    let betterTau = tauEst;
    if (tauEst > 1 && tauEst < tauMax) {
      const s0 = d[tauEst - 1];
      const s1 = d[tauEst];
      const s2 = d[tauEst + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) betterTau = tauEst + (s2 - s0) / denom;
    }
    const hz = sr / betterTau;
    const midi = 69 + 12 * Math.log2(hz / 440);
    frames.push({ time: (start + WIN / 2) / sr, midi: Number.isFinite(midi) ? midi : null, aperiodicity: ap, rms });
  }
  return frames;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Segment frames into notes. Conservative: drops short fragments, folds isolated octave jumps. */
export function segment(frames: Frame[]): TranscribeResult {
  const peakRms = frames.reduce((m, f) => Math.max(m, f.rms), 0);
  const gate = Math.max(0.006, peakRms * 0.08);
  const voiced = frames.map((f) => f.midi !== null && f.aperiodicity < 0.3 && f.rms > gate);
  const pitch = frames.map((f, i) => (voiced[i] ? f.midi! : NaN));

  // Median smoothing over voiced neighbours.
  const smooth = pitch.map((p, i) => {
    if (Number.isNaN(p)) return NaN;
    const win: number[] = [];
    for (let k = -2; k <= 2; k++) {
      const q = pitch[i + k];
      if (q !== undefined && !Number.isNaN(q)) win.push(q);
    }
    return median(win);
  });
  // Octave-jump correction: a frame ~12 st away from its local median folds back.
  for (let i = 0; i < smooth.length; i++) {
    if (Number.isNaN(smooth[i])) continue;
    const ctx: number[] = [];
    for (let k = -6; k <= 6; k++) {
      const q = smooth[i + k];
      if (k !== 0 && q !== undefined && !Number.isNaN(q)) ctx.push(q);
    }
    if (ctx.length < 4) continue;
    const m = median(ctx);
    const diff = smooth[i] - m;
    if (Math.abs(Math.abs(diff) - 12) < 1.2) smooth[i] -= 12 * Math.sign(diff);
  }

  const notes: DetectedNote[] = [];
  let cur: { start: number; pitches: number[]; rms: number[]; aps: number[] } | null = null;
  let devRun = 0;
  const flush = (endIdx: number) => {
    if (!cur) return;
    const startT = frames[cur.start].time - 0.016;
    const endT = frames[Math.min(endIdx, frames.length - 1)].time + 0.016;
    const dur = endT - startT;
    if (dur >= 0.07 && cur.pitches.length >= 5) {
      const m = median(cur.pitches);
      const midi = Math.round(m);
      const stable = cur.pitches.filter((p) => Math.abs(p - midi) <= 0.5).length / cur.pitches.length;
      const meanAp = cur.aps.reduce((a, b) => a + b, 0) / cur.aps.length;
      const loud = Math.max(...cur.rms) / Math.max(1e-6, peakRms);
      notes.push({
        startSeconds: Math.max(0, startT),
        durationSeconds: dur,
        midi,
        velocity: Math.round(64 + 50 * Math.min(1, loud)),
        uncertain: stable < 0.6 || meanAp > 0.2,
      });
    }
    cur = null;
  };
  for (let i = 0; i < frames.length; i++) {
    const p = smooth[i];
    if (Number.isNaN(p)) {
      flush(i - 1);
      devRun = 0;
      continue;
    }
    // Energy re-articulation: a dip then rise inside a voiced region starts a new note.
    const onset = cur && i > 2 && frames[i].rms > frames[i - 2].rms * 1.8 && frames[i - 2].rms < peakRms * 0.25;
    if (!cur || onset) {
      if (onset) flush(i - 1);
      cur = { start: i, pitches: [p], rms: [frames[i].rms], aps: [frames[i].aperiodicity] };
      devRun = 0;
      continue;
    }
    const ref = median(cur.pitches.slice(-8));
    if (Math.abs(p - ref) > 0.7) devRun++;
    else devRun = 0;
    if (devRun >= 4) {
      // Pitch change sustained for 40 ms → split; the deviating frames start the new note.
      const splitAt = i - devRun + 1;
      const keep = cur.pitches.length - (devRun - 1);
      cur.pitches = cur.pitches.slice(0, keep);
      cur.rms = cur.rms.slice(0, keep);
      cur.aps = cur.aps.slice(0, keep);
      flush(splitAt - 1);
      cur = { start: splitAt, pitches: smooth.slice(splitAt, i + 1), rms: frames.slice(splitAt, i + 1).map((f) => f.rms), aps: frames.slice(splitAt, i + 1).map((f) => f.aperiodicity) };
      devRun = 0;
      continue;
    }
    cur.pitches.push(p);
    cur.rms.push(frames[i].rms);
    cur.aps.push(frames[i].aperiodicity);
  }
  flush(frames.length - 1);

  // Merge same-pitch fragments separated by tiny gaps.
  const merged: DetectedNote[] = [];
  for (const n of notes) {
    const prev = merged[merged.length - 1];
    if (prev && prev.midi === n.midi && n.startSeconds - (prev.startSeconds + prev.durationSeconds) < 0.03) {
      prev.durationSeconds = n.startSeconds + n.durationSeconds - prev.startSeconds;
      prev.uncertain = prev.uncertain && n.uncertain;
    } else merged.push({ ...n });
  }
  return { notes: merged, frames: frames.length, voicedFrames: voiced.filter(Boolean).length, peakRms };
}

export function transcribe(samples: Float32Array, sampleRate: number, isCancelled?: () => boolean): TranscribeResult {
  const x = resample(samples, sampleRate);
  return segment(yinFrames(x, ANALYSIS_RATE, isCancelled));
}
