import { CLIP_BAR_OPTIONS, MAX_BPM, MAX_SCENES, MAX_SONG_TICKS, MAX_TAKE_SECONDS, MAX_TRACKS, MIN_BPM, TICKS_PER_BAR } from './constants';
import { SCHEMA_VERSION, type Project } from './types';

export class ValidationError extends Error {}

type Migration = (p: any) => any;
/** migrations[n] upgrades schemaVersion n → n+1. */
const migrations: Record<number, Migration> = {};

export function migrate(raw: any): any {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Not a project file.');
  const v = raw.schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new ValidationError('Missing schema version.');
  if (v > SCHEMA_VERSION) throw new ValidationError(`This backup was made by a newer version (schema ${v}). This app supports up to schema ${SCHEMA_VERSION}.`);
  let p = raw;
  for (let n = v; n < SCHEMA_VERSION; n++) {
    const m = migrations[n];
    if (!m) throw new ValidationError(`No migration from schema ${n}.`);
    p = m(p);
    p.schemaVersion = n + 1;
  }
  return p;
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => Number.isInteger(x);

function req(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new ValidationError(msg);
}

/** Validate structure, references, and project limits. Throws ValidationError. */
export function validateProject(input: unknown): Project {
  const p = migrate(input) as Project;
  req(isStr(p.id) && isStr(p.title), 'Project id/title invalid.');
  req(isNum(p.bpm) && p.bpm >= MIN_BPM && p.bpm <= MAX_BPM, 'Tempo out of range.');
  req(p.meter === '4/4', 'Only 4/4 is supported.');
  req(p.keyRoot === undefined || (isInt(p.keyRoot) && p.keyRoot >= 0 && p.keyRoot < 12), 'Invalid key.');
  req(p.keyMode === undefined || p.keyMode === 'major' || p.keyMode === 'minor', 'Invalid key mode.');
  req(Array.isArray(p.trackIds) && p.trackIds.length <= MAX_TRACKS, `Up to ${MAX_TRACKS} tracks.`);
  req(Array.isArray(p.sceneIds) && p.sceneIds.length >= 1 && p.sceneIds.length <= MAX_SCENES, `1–${MAX_SCENES} scenes.`);
  req(p.tracks && typeof p.tracks === 'object' && p.clips && typeof p.clips === 'object', 'Missing tracks/clips.');
  for (const id of p.trackIds) {
    const t = p.tracks[id];
    req(t && t.id === id && (t.type === 'pitched' || t.type === 'drum'), `Bad track ${id}.`);
    req(isNum(t.gainDb) && isNum(t.pan) && t.pan >= -1 && t.pan <= 1, `Bad mix values on ${id}.`);
    req(t.effects && isNum(t.effects.tone) && isNum(t.effects.space), `Bad effects on ${id}.`);
  }
  req(Object.keys(p.tracks).length === p.trackIds.length, 'Track list mismatch.');
  for (const [id, c] of Object.entries(p.clips)) {
    req(c && c.id === id && p.tracks[c.trackId], `Clip ${id} references a missing track.`);
    req(isInt(c.lengthTicks) && CLIP_BAR_OPTIONS.includes((c.lengthTicks / TICKS_PER_BAR) as 1), `Clip ${id} has an unsupported length.`);
    req(c.kind === p.tracks[c.trackId].type, `Clip ${id} kind mismatch.`);
    req(Array.isArray(c.rawEvents) && Array.isArray(c.editedEvents), `Clip ${id} events missing.`);
    req(c.rawEvents.length + c.editedEvents.length < 20000, `Clip ${id} too large.`);
    for (const e of [...c.rawEvents, ...c.editedEvents] as any[]) {
      req(isNum(e.startTick) && e.startTick >= 0 && e.startTick < c.lengthTicks + 1, `Event outside clip ${id}.`);
      req(isNum(e.velocity) && e.velocity >= 1 && e.velocity <= 127, 'Bad velocity.');
      if (c.kind === 'pitched') req(isInt(e.midiPitch) && e.midiPitch >= 0 && e.midiPitch <= 127 && isNum(e.durationTicks) && e.durationTicks >= 1, 'Bad note.');
      else req(isStr(e.padId), 'Bad drum hit.');
    }
    req(c.quantize && isNum(c.quantize.gridTicks) && c.quantize.gridTicks > 0 && isNum(c.quantize.strength), 'Bad quantize.');
    if (c.kind === 'pitched' && c.sourceTakeId) req(p.takes?.[c.sourceTakeId], `Clip ${id} references a missing take.`);
  }
  for (const id of p.sceneIds) {
    const s = p.scenes[id];
    req(s && s.id === id && CLIP_BAR_OPTIONS.includes(s.durationBars), `Bad scene ${id}.`);
    for (const [t, c] of Object.entries(s.clipByTrackId)) {
      if (c === undefined || c === null) continue;
      req(p.tracks[t] && p.clips[c] && p.clips[c].trackId === t, `Scene ${s.name} references missing clip.`);
    }
  }
  req(Array.isArray(p.arrangement), 'Arrangement missing.');
  for (const a of p.arrangement) {
    req(p.tracks[a.trackId] && p.clips[a.clipId], 'Arrangement references missing clip.');
    req(isInt(a.startTick) && a.startTick >= 0 && isInt(a.durationTicks) && a.durationTicks > 0, 'Bad arrangement timing.');
    req(a.startTick + a.durationTicks <= MAX_SONG_TICKS, 'Song exceeds 64 bars.');
  }
  for (const t of Object.values(p.takes ?? {})) {
    req(isStr(t.blobKey) && isNum(t.durationSeconds) && t.durationSeconds <= MAX_TAKE_SECONDS + 0.5, 'Take too long or invalid.');
  }
  p.takes ??= {};
  p.assetManifest ??= [];
  p.settings ??= { countInBars: 1, metronome: true, recordingOffsetMs: 0 };
  return p;
}
