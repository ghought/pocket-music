// Expands scenes and the song arrangement into flat, timed events for a tick window.
// Pure functions: shared by the live scheduler and offline export, and unit-tested.

import { effectiveDrums, effectivePitched } from '../domain/ops';
import { TICKS_PER_BAR } from '../domain/constants';
import type { Clip, Project } from '../domain/types';

export type SeqEvent =
  | { kind: 'note'; trackId: string; tick: number; durTicks: number; midi: number; vel: number }
  | { kind: 'hit'; trackId: string; tick: number; padId: string; vel: number };

/** Clip events within clip-local [from, to), clamped to `limit` (the clip's playable length here). */
function clipEvents(clip: Clip, trackId: string, from: number, to: number, offset: number, limit: number, out: SeqEvent[]) {
  if (clip.kind === 'drum') {
    for (const e of effectiveDrums(clip)) {
      if (e.startTick >= from && e.startTick < to && e.startTick < limit) out.push({ kind: 'hit', trackId, tick: offset + e.startTick, padId: e.padId, vel: e.velocity });
    }
  } else {
    for (const e of effectivePitched(clip)) {
      if (e.startTick >= from && e.startTick < to && e.startTick < limit) {
        // Notes crossing the loop/scene boundary are truncated there (never retriggered).
        const dur = Math.max(1, Math.min(e.durationTicks, limit - e.startTick));
        out.push({ kind: 'note', trackId, tick: offset + e.startTick, durTicks: dur, midi: e.midiPitch, vel: e.velocity });
      }
    }
  }
}

/**
 * Events for a looping scene in [from, to), ticks measured from the moment the scene started.
 * Shorter clips loop to fill the scene; longer clips are cut at the scene length.
 */
export function expandScene(p: Project, sceneId: string, from: number, to: number): SeqEvent[] {
  const scene = p.scenes[sceneId];
  if (!scene || to <= from) return [];
  const S = scene.durationBars * TICKS_PER_BAR;
  const out: SeqEvent[] = [];
  const firstLoop = Math.floor(from / S);
  const lastLoop = Math.floor((to - 1) / S);
  for (let k = firstLoop; k <= lastLoop; k++) {
    const loopStart = k * S;
    const a = Math.max(from, loopStart) - loopStart;
    const b = Math.min(to, loopStart + S) - loopStart;
    for (const trackId of p.trackIds) {
      const clipId = scene.clipByTrackId[trackId];
      const clip = clipId ? p.clips[clipId] : undefined;
      if (!clip) continue;
      const L = clip.lengthTicks;
      for (let rep = Math.floor(a / L); rep * L < b; rep++) {
        const repStart = rep * L;
        const limit = Math.min(L, S - repStart);
        clipEvents(clip, trackId, a - repStart, b - repStart, loopStart + repStart, limit, out);
      }
    }
  }
  return out.sort((x, y) => x.tick - y.tick);
}

/** Events in song ticks [from, to). Instances longer than their clip loop the clip. */
export function expandSong(p: Project, from: number, to: number): SeqEvent[] {
  const out: SeqEvent[] = [];
  for (const inst of p.arrangement) {
    const clip = p.clips[inst.clipId];
    if (!clip || !p.tracks[inst.trackId]) continue;
    const s = inst.startTick;
    const e = s + inst.durationTicks;
    if (e <= from || s >= to) continue;
    const L = clip.lengthTicks;
    const a = Math.max(from, s) - s;
    const b = Math.min(to, e) - s;
    for (let rep = Math.floor(a / L); rep * L < b; rep++) {
      const repStart = rep * L;
      const limit = Math.min(L, inst.durationTicks - repStart);
      clipEvents(clip, inst.trackId, a - repStart, b - repStart, s + repStart, limit, out);
    }
  }
  return out.sort((x, y) => x.tick - y.tick);
}
