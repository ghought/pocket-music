import { describe, expect, it } from 'vitest';
import { transcribe } from './pitch';

const SR = 48000;
const hz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Hum-like test tone: fundamental + harmonics, soft attack/release, optional vibrato. */
function phrase(notes: [number, number, number][], total: number, noise = 0): Float32Array {
  const out = new Float32Array(Math.floor(total * SR));
  let seed = 12345;
  for (const [midi, start, dur] of notes) {
    const f = hz(midi);
    const s0 = Math.floor(start * SR);
    const n = Math.floor(dur * SR);
    let phase = 0;
    for (let i = 0; i < n && s0 + i < out.length; i++) {
      const t = i / SR;
      const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t);
      phase += (2 * Math.PI * f * vib) / SR;
      const env = Math.min(1, t / 0.03, (dur - t) / 0.04);
      out[s0 + i] += 0.3 * env * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase));
    }
  }
  if (noise) {
    for (let i = 0; i < out.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out[i] += noise * ((seed / 0x7fffffff) * 2 - 1);
    }
  }
  return out;
}

describe('hum transcription', () => {
  it('detects a clean four-note phrase with exact pitches and onsets', () => {
    const spec: [number, number, number][] = [
      [60, 0.2, 0.45],
      [62, 0.75, 0.45],
      [64, 1.3, 0.45],
      [67, 1.85, 0.8],
    ];
    const r = transcribe(phrase(spec, 3), SR);
    expect(r.notes.map((n) => n.midi)).toEqual([60, 62, 64, 67]);
    r.notes.forEach((n, i) => expect(Math.abs(n.startSeconds - spec[i][1])).toBeLessThan(0.06));
  });

  it('handles legato pitch changes without gaps', () => {
    const r = transcribe(phrase([[57, 0.1, 0.5], [59, 0.6, 0.5], [62, 1.1, 0.6]], 2), SR);
    expect(r.notes.map((n) => n.midi)).toEqual([57, 59, 62]);
  });

  it('returns no notes for silence and does not invent a melody', () => {
    const r = transcribe(new Float32Array(SR * 2), SR);
    expect(r.notes).toHaveLength(0);
  });

  it('returns no notes for low-level white noise', () => {
    const r = transcribe(phrase([], 2, 0.05), SR);
    expect(r.notes.length).toBeLessThanOrEqual(1);
  });

  it('copes with mild background noise', () => {
    const r = transcribe(phrase([[65, 0.2, 0.5], [69, 0.8, 0.5]], 1.6, 0.01), SR);
    expect(r.notes.map((n) => n.midi)).toEqual([65, 69]);
  });
});
