import type { KeyMode } from './types';

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const MINOR = [0, 2, 3, 5, 7, 8, 10];

export function noteName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
export function keyLabel(root?: number, mode?: KeyMode): string {
  if (root === undefined || !mode) return 'No key';
  return `${NOTE_NAMES[root]} ${mode}`;
}
export function scaleIntervals(mode: KeyMode): number[] {
  return mode === 'major' ? MAJOR : MINOR;
}
export function inScale(midi: number, root: number, mode: KeyMode): boolean {
  const pc = (((midi - root) % 12) + 12) % 12;
  return scaleIntervals(mode).includes(pc);
}

/** Snap to nearest scale tone; equidistant resolves downward. */
export function snapToScale(midi: number, root: number, mode: KeyMode): number {
  if (inScale(midi, root, mode)) return midi;
  for (let d = 1; d < 12; d++) {
    if (inScale(midi - d, root, mode)) return midi - d; // down checked first → ties go down
    if (inScale(midi + d, root, mode)) return midi + d;
  }
  return midi;
}

/** Scale notes from a starting MIDI note upward, count notes. */
export function scaleNotes(root: number, mode: KeyMode, fromMidi: number, count: number): number[] {
  const out: number[] = [];
  let m = fromMidi;
  while (!inScale(m, root, mode)) m++;
  while (out.length < count) {
    if (inScale(m, root, mode)) out.push(m);
    m++;
  }
  return out;
}

const ROMAN_MAJOR = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
const ROMAN_MINOR = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'];

/** Diatonic root-position triads for degrees 0..6. */
export function diatonicTriad(root: number, mode: KeyMode, degree: number, baseOctaveMidi = 48): { notes: number[]; label: string; roman: string } {
  const iv = scaleIntervals(mode);
  const pick = (d: number) => {
    const oct = Math.floor(d / 7);
    return baseOctaveMidi + root + iv[d % 7] + 12 * oct;
  };
  const notes = [pick(degree), pick(degree + 2), pick(degree + 4)];
  const rootName = NOTE_NAMES[(root + iv[degree]) % 12];
  const third = notes[1] - notes[0];
  const fifth = notes[2] - notes[0];
  const quality = third === 4 ? '' : fifth === 6 ? 'dim' : 'm';
  return { notes, label: `${rootName}${quality}`, roman: (mode === 'major' ? ROMAN_MAJOR : ROMAN_MINOR)[degree] };
}

/** Optional key suggestion from a set of pitches (labelled as a suggestion in the UI). */
export function suggestKey(pitches: number[]): { root: number; mode: KeyMode } | null {
  if (pitches.length < 3) return null;
  let best: { root: number; mode: KeyMode; score: number } | null = null;
  for (const mode of ['major', 'minor'] as KeyMode[]) {
    for (let root = 0; root < 12; root++) {
      let score = 0;
      for (const p of pitches) score += inScale(p, root, mode) ? 1 : -1;
      if (pitches.length && ((pitches[pitches.length - 1] - root) % 12 + 12) % 12 === 0) score += 0.5;
      if (!best || score > best.score) best = { root, mode, score };
    }
  }
  return best ? { root: best.root, mode: best.mode } : null;
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}
