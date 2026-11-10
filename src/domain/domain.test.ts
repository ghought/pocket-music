import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { SIXTEENTH, TICKS_PER_BAR } from './constants';
import { buildDemoProject } from './demo';
import { snapToScale, diatonicTriad } from './music';
import {
  addSceneToSong,
  addTrack,
  duplicateScene,
  duplicateInstance,
  effectivePitched,
  emptyProject,
  ensureSceneClip,
  makeUnique,
  moveInstance,
  resizeInstance,
} from './ops';
import { nearestGrid, quantizeDrums, quantizePitched, quantizeTick } from './quantize';
import type { DrumEvent, PitchedEvent, Project, Track } from './types';
import { validateProject, ValidationError } from './validate';

const q = (strength: number) => ({ gridTicks: SIXTEENTH, strength });

describe('quantize', () => {
  it('ties resolve to the earlier grid point', () => {
    expect(nearestGrid(120, 240)).toBe(0);
    expect(nearestGrid(121, 240)).toBe(240);
  });
  it('applies strength formula and Off restores raw timing', () => {
    expect(quantizeTick(100, q(0.5), TICKS_PER_BAR)).toBe(50);
    expect(quantizeTick(100, q(1), TICKS_PER_BAR)).toBe(0);
    expect(quantizeTick(100, q(0), TICKS_PER_BAR)).toBe(100);
  });
  it('clamps into clip bounds', () => {
    expect(quantizeTick(TICKS_PER_BAR - 10, q(1), TICKS_PER_BAR)).toBe(TICKS_PER_BAR - 1);
  });
  it('keeps notes at least one tick long and inside the clip', () => {
    const ev: PitchedEvent[] = [{ id: 'a', startTick: 230, durationTicks: 5, midiPitch: 60, velocity: 90 }];
    const [out] = quantizePitched(ev, q(1), TICKS_PER_BAR);
    expect(out.startTick).toBe(240);
    expect(out.durationTicks).toBeGreaterThanOrEqual(1);
  });
  it('merges drum hits on the same pad and tick keeping higher velocity', () => {
    const ev: DrumEvent[] = [
      { id: '1', startTick: 10, padId: 'kick', velocity: 80 },
      { id: '2', startTick: 0, padId: 'kick', velocity: 110 },
      { id: '3', startTick: 5, padId: 'snare', velocity: 90 },
    ];
    const out = quantizeDrums(ev, q(1), TICKS_PER_BAR);
    expect(out.filter((e) => e.padId === 'kick')).toHaveLength(1);
    expect(out.find((e) => e.padId === 'kick')!.velocity).toBe(110);
  });
});

describe('pitch helpers', () => {
  it('snaps equidistant notes downward', () => {
    // C major: C#(61) is equidistant from C(60) and D(62) → C.
    expect(snapToScale(61, 0, 'major')).toBe(60);
  });
  it('builds diatonic triads', () => {
    expect(diatonicTriad(0, 'major', 0).notes).toEqual([48, 52, 55]);
    expect(diatonicTriad(9, 'minor', 0).label).toBe('Am');
  });
});

function withTwoTracks(): { p: Project; drums: Track; keys: Track } {
  const p = emptyProject();
  const drums = addTrack(p, 'drums') as Track;
  const keys = addTrack(p, 'keys') as Track;
  return { p, drums, keys };
}

describe('scenes and arrangement', () => {
  it('duplicating a scene creates independent clip copies', () => {
    const { p, keys } = withTwoTracks();
    const sA = p.sceneIds[0];
    const clip = ensureSceneClip(p, sA, keys.id);
    if (clip.kind === 'pitched') clip.editedEvents.push({ id: 'n', startTick: 0, durationTicks: 480, midiPitch: 60, velocity: 90 });
    const next = produce(p, (d) => {
      const s = duplicateScene(d, sA);
      if (typeof s === 'string') throw new Error(s);
      const c = d.clips[s.clipByTrackId[keys.id]!];
      if (c.kind === 'pitched') c.editedEvents[0].midiPitch = 72;
    });
    const orig = next.clips[clip.id];
    expect(orig.kind === 'pitched' && orig.editedEvents[0].midiPitch).toBe(60);
    expect(next.sceneIds).toHaveLength(2);
  });

  it('adds scenes to the song, repeating short clips, and rejects overlaps', () => {
    const { p, drums } = withTwoTracks();
    const sA = p.sceneIds[0];
    const c = ensureSceneClip(p, sA, drums.id);
    c.lengthTicks = TICKS_PER_BAR; // 1-bar clip in a 4-bar scene
    addSceneToSong(p, sA);
    expect(p.arrangement).toHaveLength(4);
    expect(p.arrangement.map((a) => a.startTick)).toEqual([0, 1, 2, 3].map((b) => b * TICKS_PER_BAR));
    const err = moveInstance(p, p.arrangement[0].id, 1);
    expect(err).toMatch(/^overlap:/);
    expect(p.arrangement[0].startTick).toBe(0);
  });

  it('linked instances share edits; make unique isolates', () => {
    const { p, keys } = withTwoTracks();
    const sA = p.sceneIds[0];
    ensureSceneClip(p, sA, keys.id);
    addSceneToSong(p, sA);
    const dup = duplicateInstance(p, p.arrangement[0].id);
    expect(typeof dup).not.toBe('string');
    const [a, b] = p.arrangement;
    expect(a.clipId).toBe(b.clipId);
    const unique = makeUnique(p, b.id)!;
    expect(p.arrangement[1].clipId).toBe(unique.id);
    expect(p.arrangement[0].clipId).not.toBe(unique.id);
  });

  it('enforces the 64-bar limit', () => {
    const { p, keys } = withTwoTracks();
    const sA = p.sceneIds[0];
    ensureSceneClip(p, sA, keys.id);
    for (let i = 0; i < 16; i++) expect(addSceneToSong(p, sA)).toBeUndefined();
    expect(addSceneToSong(p, sA)).toMatch(/64 bars/);
    expect(resizeInstance(p, p.arrangement[p.arrangement.length - 1].id, 1)).toMatch(/64 bars/);
  });
});

describe('clip playback', () => {
  it('effective events come from edited events with quantize applied; raw untouched', () => {
    const { p, keys } = withTwoTracks();
    const c = ensureSceneClip(p, p.sceneIds[0], keys.id);
    if (c.kind !== 'pitched') throw new Error();
    c.rawEvents = [{ id: 'x', startTick: 100, durationTicks: 400, midiPitch: 60, velocity: 90 }];
    c.editedEvents = c.rawEvents.map((e) => ({ ...e }));
    c.quantize.strength = 1;
    expect(effectivePitched(c)[0].startTick).toBe(0);
    expect(c.rawEvents[0].startTick).toBe(100);
    c.quantize.strength = 0;
    expect(effectivePitched(c)[0].startTick).toBe(100);
  });
});

describe('serialization and validation', () => {
  it('round-trips the demo project through JSON', () => {
    const p = buildDemoProject();
    const back = validateProject(JSON.parse(JSON.stringify(p)));
    expect(back.arrangement.length).toBe(p.arrangement.length);
    expect(Object.keys(back.clips)).toEqual(Object.keys(p.clips));
  });
  it('rejects future schema versions', () => {
    const p = { ...buildDemoProject(), schemaVersion: 99 };
    expect(() => validateProject(p)).toThrow(ValidationError);
  });
  it('rejects dangling references and limit violations', () => {
    const p = buildDemoProject();
    const bad = JSON.parse(JSON.stringify(p));
    bad.arrangement[0].clipId = 'nope';
    expect(() => validateProject(bad)).toThrow(/missing clip/);
    const tooFast = { ...JSON.parse(JSON.stringify(p)), bpm: 400 };
    expect(() => validateProject(tooFast)).toThrow(/Tempo/);
  });
});
