// Pure project operations. Mutators take an immer draft (or a plain object) and mutate it.
// Functions returning a string return a user-facing error message instead of applying the change.

import { instrument, KIT_PADS } from './catalog';
import { DEFAULT_BPM, MAX_SCENES, MAX_SONG_TICKS, MAX_TRACKS, SIXTEENTH, TICKS_PER_BAR, TRACK_COLORS } from './constants';
import { quantizeDrums, quantizePitched } from './quantize';
import {
  SCHEMA_VERSION,
  type ArrangementInstance,
  type Clip,
  type ClipBars,
  type DrumEvent,
  type PitchedEvent,
  type Project,
  type Scene,
  type Track,
} from './types';

export function uid(prefix = ''): string {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return prefix + r[0].toString(36) + r[1].toString(36);
}

export type TrackPreset = 'drums' | 'keys' | 'bass' | 'synth' | 'hum';
export const TRACK_PRESETS: Record<TrackPreset, { name: string; instrumentId: string; icon: string }> = {
  drums: { name: 'Drums', instrumentId: 'kit-studio', icon: '◉' },
  keys: { name: 'Keys', instrumentId: 'piano', icon: '▥' },
  bass: { name: 'Bass', instrumentId: 'bass', icon: '◢' },
  synth: { name: 'Synth', instrumentId: 'pluck', icon: '∿' },
  hum: { name: 'Hummed melody', instrumentId: 'warm', icon: '◡' },
};

export function newTrack(p: Project, preset: TrackPreset): Track {
  const def = TRACK_PRESETS[preset];
  const inst = instrument(def.instrumentId);
  const used = new Set(Object.values(p.tracks).map((t) => t.color));
  const color = TRACK_COLORS.find((c) => !used.has(c)) ?? TRACK_COLORS[p.trackIds.length % TRACK_COLORS.length];
  const sameName = Object.values(p.tracks).filter((t) => t.name.startsWith(def.name)).length;
  return {
    id: uid('t'),
    type: inst.kind,
    instrumentId: inst.id,
    instrumentVersion: inst.version,
    name: sameName ? `${def.name} ${sameName + 1}` : def.name,
    color,
    icon: def.icon,
    gainDb: inst.defaults.gainDb,
    pan: 0,
    mute: false,
    solo: false,
    effects: { tone: inst.defaults.tone, space: inst.defaults.space },
  };
}

export function emptyProject(title = 'Untitled sketch'): Project {
  const now = Date.now();
  const scene: Scene = { id: uid('s'), name: 'Scene A', durationBars: 4, clipByTrackId: {} };
  return {
    id: uid('p'),
    schemaVersion: SCHEMA_VERSION,
    title,
    createdAt: now,
    updatedAt: now,
    bpm: DEFAULT_BPM,
    meter: '4/4',
    trackIds: [],
    tracks: {},
    clips: {},
    sceneIds: [scene.id],
    scenes: { [scene.id]: scene },
    arrangement: [],
    takes: {},
    assetManifest: [],
    settings: { countInBars: 1, metronome: true, recordingOffsetMs: 0 },
  };
}

export function addTrack(p: Project, preset: TrackPreset): string | Track {
  if (p.trackIds.length >= MAX_TRACKS) return `A sketch can have up to ${MAX_TRACKS} tracks.`;
  const t = newTrack(p, preset);
  p.tracks[t.id] = t;
  p.trackIds.push(t.id);
  return t;
}

export function removeTrack(p: Project, trackId: string): void {
  p.trackIds = p.trackIds.filter((id) => id !== trackId);
  delete p.tracks[trackId];
  for (const s of Object.values(p.scenes)) delete s.clipByTrackId[trackId];
  p.arrangement = p.arrangement.filter((a) => a.trackId !== trackId);
  for (const [id, c] of Object.entries(p.clips)) if (c.trackId === trackId) delete p.clips[id];
}

export function moveTrack(p: Project, trackId: string, dir: -1 | 1): void {
  const i = p.trackIds.indexOf(trackId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= p.trackIds.length) return;
  [p.trackIds[i], p.trackIds[j]] = [p.trackIds[j], p.trackIds[i]];
}

export function newClip(p: Project, trackId: string, bars: ClipBars, name?: string): Clip {
  const t = p.tracks[trackId];
  const count = Object.values(p.clips).filter((c) => c.trackId === trackId).length;
  const base = {
    id: uid('c'),
    trackId,
    name: name ?? `${t.name} ${count + 1}`,
    lengthTicks: bars * TICKS_PER_BAR,
    quantize: { gridTicks: SIXTEENTH, strength: 0.5 },
  };
  const clip: Clip = t.type === 'drum' ? { ...base, kind: 'drum', rawEvents: [], editedEvents: [] } : { ...base, kind: 'pitched', rawEvents: [], editedEvents: [] };
  p.clips[clip.id] = clip;
  return clip;
}

/** Ensure the scene has a clip for this track, creating an empty one sized to the scene. */
export function ensureSceneClip(p: Project, sceneId: string, trackId: string): Clip {
  const scene = p.scenes[sceneId];
  const existing = scene.clipByTrackId[trackId];
  if (existing && p.clips[existing]) return p.clips[existing];
  const clip = newClip(p, trackId, scene.durationBars);
  scene.clipByTrackId[trackId] = clip.id;
  return clip;
}

export function effectivePitched(clip: Clip & { kind: 'pitched' }): PitchedEvent[] {
  return quantizePitched(clip.editedEvents, clip.quantize, clip.lengthTicks);
}
export function effectiveDrums(clip: Clip & { kind: 'drum' }): DrumEvent[] {
  return quantizeDrums(clip.editedEvents, clip.quantize, clip.lengthTicks);
}

export function cloneClip(p: Project, clipId: string, nameSuffix = ' copy'): Clip {
  const src = p.clips[clipId];
  const copy = JSON.parse(JSON.stringify(src)) as Clip;
  copy.id = uid('c');
  copy.name = src.name + nameSuffix;
  p.clips[copy.id] = copy;
  return copy;
}

// ---------- Scenes ----------

const SCENE_LETTERS = 'ABCDEFGH';
function nextSceneName(p: Project, base?: string): string {
  const names = new Set(Object.values(p.scenes).map((s) => s.name));
  if (base) {
    for (let i = 2; i < 20; i++) {
      const n = `${base} v${i}`;
      if (!names.has(n)) return n;
    }
  }
  for (const l of SCENE_LETTERS) if (!names.has(`Scene ${l}`)) return `Scene ${l}`;
  return `Scene ${p.sceneIds.length + 1}`;
}

export function addScene(p: Project): string | Scene {
  if (p.sceneIds.length >= MAX_SCENES) return `A sketch can have up to ${MAX_SCENES} scenes.`;
  const s: Scene = { id: uid('s'), name: nextSceneName(p), durationBars: 4, clipByTrackId: {} };
  p.scenes[s.id] = s;
  p.sceneIds.push(s.id);
  return s;
}

/** Duplicate creates independent copies of every clip so edits to the variant never alter the original. */
export function duplicateScene(p: Project, sceneId: string): string | Scene {
  if (p.sceneIds.length >= MAX_SCENES) return `A sketch can have up to ${MAX_SCENES} scenes.`;
  const src = p.scenes[sceneId];
  const baseName = src.name.replace(/ v\d+$/, '');
  const s: Scene = { id: uid('s'), name: nextSceneName(p, baseName), durationBars: src.durationBars, clipByTrackId: {} };
  for (const [trackId, clipId] of Object.entries(src.clipByTrackId)) {
    if (!clipId || !p.clips[clipId]) continue;
    const copy = cloneClip(p, clipId, '');
    copy.name = `${p.clips[clipId].name.replace(/ \(.*\)$/, '')} (${s.name})`;
    s.clipByTrackId[trackId] = copy.id;
  }
  p.scenes[s.id] = s;
  p.sceneIds.splice(p.sceneIds.indexOf(sceneId) + 1, 0, s.id);
  return s;
}

export function deleteScene(p: Project, sceneId: string): string | void {
  if (p.sceneIds.length <= 1) return 'A sketch needs at least one scene.';
  p.sceneIds = p.sceneIds.filter((id) => id !== sceneId);
  delete p.scenes[sceneId];
}

export function moveScene(p: Project, sceneId: string, dir: -1 | 1): void {
  const i = p.sceneIds.indexOf(sceneId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= p.sceneIds.length) return;
  [p.sceneIds[i], p.sceneIds[j]] = [p.sceneIds[j], p.sceneIds[i]];
}

// ---------- Song arrangement ----------

export function songEndTick(p: Project): number {
  return p.arrangement.reduce((m, a) => Math.max(m, a.startTick + a.durationTicks), 0);
}

export function overlaps(p: Project, trackId: string, start: number, duration: number, ignoreId?: string): ArrangementInstance | undefined {
  return p.arrangement.find((a) => a.trackId === trackId && a.id !== ignoreId && start < a.startTick + a.durationTicks && a.startTick < start + duration);
}

/** Expand a scene into clip instances appended at the end of the song. */
export function addSceneToSong(p: Project, sceneId: string): string | void {
  const scene = p.scenes[sceneId];
  const sceneTicks = scene.durationBars * TICKS_PER_BAR;
  const at = songEndTick(p);
  if (at + sceneTicks > MAX_SONG_TICKS) return `The song is limited to 64 bars. ${scene.name} needs ${scene.durationBars} more.`;
  const entries = Object.entries(scene.clipByTrackId).filter(([t, c]) => c && p.clips[c] && p.tracks[t]);
  if (!entries.length) return `${scene.name} is empty — record or add a clip first.`;
  for (const [trackId, clipId] of entries) {
    const clip = p.clips[clipId!];
    // Short clips repeat as separate instances; long clips are cut to the scene length.
    for (let off = 0; off < sceneTicks; off += clip.lengthTicks) {
      p.arrangement.push({
        id: uid('a'),
        trackId,
        clipId: clip.id,
        startTick: at + off,
        durationTicks: Math.min(clip.lengthTicks, sceneTicks - off),
        sourceOffsetTicks: 0,
      });
    }
  }
}

export function moveInstance(p: Project, id: string, deltaBars: number): string | void {
  const a = p.arrangement.find((x) => x.id === id);
  if (!a) return;
  const start = a.startTick + deltaBars * TICKS_PER_BAR;
  if (start < 0) return 'Already at the start of the song.';
  if (start + a.durationTicks > MAX_SONG_TICKS) return 'The song is limited to 64 bars.';
  const hit = overlaps(p, a.trackId, start, a.durationTicks, a.id);
  if (hit) return `overlap:${hit.id}`;
  a.startTick = start;
}

export function resizeInstance(p: Project, id: string, deltaBars: number): string | void {
  const a = p.arrangement.find((x) => x.id === id);
  if (!a) return;
  // Snap to whole bars first, then resize.
  const bars = Math.max(1, Math.ceil(a.durationTicks / TICKS_PER_BAR) + deltaBars);
  const dur = bars * TICKS_PER_BAR;
  if (a.startTick + dur > MAX_SONG_TICKS) return 'The song is limited to 64 bars.';
  const hit = overlaps(p, a.trackId, a.startTick, dur, a.id);
  if (hit) return `overlap:${hit.id}`;
  a.durationTicks = dur;
}

export function duplicateInstance(p: Project, id: string): string | ArrangementInstance {
  const a = p.arrangement.find((x) => x.id === id);
  if (!a) return 'Not found';
  const start = a.startTick + a.durationTicks;
  if (start + a.durationTicks > MAX_SONG_TICKS) return 'The song is limited to 64 bars.';
  const hit = overlaps(p, a.trackId, start, a.durationTicks);
  if (hit) return `overlap:${hit.id}`;
  const copy = { ...a, id: uid('a'), startTick: start };
  p.arrangement.push(copy);
  return copy;
}

export function deleteInstance(p: Project, id: string): void {
  p.arrangement = p.arrangement.filter((a) => a.id !== id);
}

export function instancesOfClip(p: Project, clipId: string): ArrangementInstance[] {
  return p.arrangement.filter((a) => a.clipId === clipId);
}

/** Separate this instance from its shared source clip. */
export function makeUnique(p: Project, instanceId: string): Clip | undefined {
  const a = p.arrangement.find((x) => x.id === instanceId);
  if (!a) return;
  const copy = cloneClip(p, a.clipId, ' (unique)');
  a.clipId = copy.id;
  return copy;
}

/** Clips not referenced by any scene, arrangement instance — candidates for cleanup. */
export function referencedTakeIds(p: Project): Set<string> {
  const s = new Set<string>();
  for (const c of Object.values(p.clips)) if (c.kind === 'pitched' && c.sourceTakeId) s.add(c.sourceTakeId);
  return s;
}

export function defaultDrumPads() {
  return KIT_PADS;
}
