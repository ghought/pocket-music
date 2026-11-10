import { describe, expect, it } from 'vitest';
import { TICKS_PER_BAR } from '../domain/constants';
import { addSceneToSong, addTrack, emptyProject, ensureSceneClip } from '../domain/ops';
import type { Track } from '../domain/types';
import { expandScene, expandSong } from './sequence';

function setup() {
  const p = emptyProject();
  const keys = addTrack(p, 'keys') as Track;
  const drums = addTrack(p, 'drums') as Track;
  const sid = p.sceneIds[0];
  const kc = ensureSceneClip(p, sid, keys.id);
  const dc = ensureSceneClip(p, sid, drums.id);
  kc.lengthTicks = TICKS_PER_BAR; // 1-bar clip in 4-bar scene
  if (kc.kind === 'pitched') kc.editedEvents = [{ id: 'n', startTick: TICKS_PER_BAR - 480, durationTicks: 960, midiPitch: 60, velocity: 90 }];
  if (dc.kind === 'drum') dc.editedEvents = [{ id: 'k', startTick: 0, padId: 'kick', velocity: 100 }];
  kc.quantize.strength = 0;
  dc.quantize.strength = 0;
  return { p, sid, keys, drums };
}

describe('sequence expansion', () => {
  it('loops short clips to fill the scene and truncates notes at the loop end', () => {
    const { p, sid } = setup();
    const ev = expandScene(p, sid, 0, 4 * TICKS_PER_BAR).filter((e) => e.kind === 'note');
    expect(ev).toHaveLength(4);
    for (const e of ev) if (e.kind === 'note') expect(e.durTicks).toBe(480);
  });
  it('repeats the scene across loops without duplicates at boundaries', () => {
    const { p, sid } = setup();
    const a = expandScene(p, sid, 0, 4 * TICKS_PER_BAR);
    const b = expandScene(p, sid, 4 * TICKS_PER_BAR, 8 * TICKS_PER_BAR);
    const split = [...expandScene(p, sid, 0, 4000), ...expandScene(p, sid, 4000, 8 * TICKS_PER_BAR)];
    expect(split.length).toBe(a.length + b.length);
    expect(b[0].tick).toBe(4 * TICKS_PER_BAR);
  });
  it('song playback matches the scene it was built from', () => {
    const { p, sid } = setup();
    addSceneToSong(p, sid);
    const song = expandSong(p, 0, 4 * TICKS_PER_BAR).map((e) => `${e.kind}@${e.tick}`);
    const scene = expandScene(p, sid, 0, 4 * TICKS_PER_BAR).map((e) => `${e.kind}@${e.tick}`);
    expect(song.sort()).toEqual(scene.sort());
  });
});
