export const TPQ = 960; // ticks per quarter note
export const BEATS_PER_BAR = 4;
export const TICKS_PER_BAR = TPQ * BEATS_PER_BAR;
export const SIXTEENTH = TPQ / 4;

export const MIN_BPM = 60;
export const MAX_BPM = 180;
export const DEFAULT_BPM = 100;
export const MAX_TRACKS = 8;
export const MAX_SCENES = 8;
export const MAX_SONG_BARS = 64;
export const MAX_SONG_TICKS = MAX_SONG_BARS * TICKS_PER_BAR;
export const CLIP_BAR_OPTIONS = [1, 2, 4, 8] as const;
export const MAX_TAKE_SECONDS = 20;

export const TRACK_COLORS = ['#ef7f5a', '#f2b84b', '#4fb3a5', '#6aa7e8', '#a88be0', '#9cc65a', '#e87fa6', '#d6b98c'];

export const QUANTIZE_PRESETS = { off: 0, gentle: 0.5, tight: 1 } as const;

export function ticksToSeconds(ticks: number, bpm: number): number {
  return (ticks / TPQ) * (60 / bpm);
}
export function secondsToTicks(seconds: number, bpm: number): number {
  return (seconds * bpm * TPQ) / 60;
}
export function barsToSeconds(bars: number, bpm: number): number {
  return ticksToSeconds(bars * TICKS_PER_BAR, bpm);
}
export function clampBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}
