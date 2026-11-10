// An original demo sketch composed for this app (not based on any existing song).
import { TICKS_PER_BAR, TPQ, SIXTEENTH } from './constants';
import { diatonicTriad } from './music';
import { addSceneToSong, addTrack, duplicateScene, emptyProject, ensureSceneClip, uid } from './ops';
import type { DrumEvent, PitchedEvent, Project, Track } from './types';

const n = (startTick: number, durationTicks: number, midiPitch: number, velocity = 96): PitchedEvent => ({ id: uid('n'), startTick, durationTicks, midiPitch, velocity });
const h = (step: number, padId: string, velocity = 100): DrumEvent => ({ id: uid('d'), startTick: step * SIXTEENTH, padId, velocity });

export function buildDemoProject(): Project {
  const p = emptyProject('Demo — Night Bus');
  p.bpm = 92;
  p.keyRoot = 9; // A
  p.keyMode = 'minor';
  const sceneA = p.scenes[p.sceneIds[0]];
  const drums = addTrack(p, 'drums') as Track;
  const bass = addTrack(p, 'bass') as Track;
  const keys = addTrack(p, 'keys') as Track;
  keys.instrumentId = 'warm';
  keys.name = 'Pads';
  const lead = addTrack(p, 'synth') as Track;
  lead.name = 'Lead';

  // Drums: 4 bars of a laid-back groove.
  const d = ensureSceneClip(p, sceneA.id, drums.id);
  const dEvents: DrumEvent[] = [];
  for (let bar = 0; bar < 4; bar++) {
    const o = bar * 16;
    dEvents.push(h(o + 0, 'kick', 112), h(o + 7, 'kick', 90), h(o + 10, 'kick', 104));
    dEvents.push(h(o + 4, 'snare', 108), h(o + 12, 'snare', 110));
    for (let s = 0; s < 16; s += 2) dEvents.push(h(o + s, s % 4 === 0 ? 'chh' : 'chh', s % 4 === 0 ? 92 : 70));
    if (bar === 3) dEvents.push(h(o + 14, 'ohh', 88), h(o + 15, 'snare', 72));
  }
  d.rawEvents = dEvents;
  d.editedEvents = dEvents.map((e) => ({ ...e }));
  d.name = 'Groove';

  // Chords: i – VI – III – VII in A minor.
  const prog = [0, 5, 2, 6];
  const k = ensureSceneClip(p, sceneA.id, keys.id);
  const kEvents: PitchedEvent[] = [];
  const b = ensureSceneClip(p, sceneA.id, bass.id);
  const bEvents: PitchedEvent[] = [];
  prog.forEach((deg, bar) => {
    const chord = diatonicTriad(9, 'minor', deg, 48);
    for (const m of chord.notes) kEvents.push(n(bar * TICKS_PER_BAR, TICKS_PER_BAR - 60, m, 78));
    const root = chord.notes[0] - 24;
    bEvents.push(n(bar * TICKS_PER_BAR, TPQ * 1.5, root, 104));
    bEvents.push(n(bar * TICKS_PER_BAR + TPQ * 1.5, TPQ / 2, root, 88));
    bEvents.push(n(bar * TICKS_PER_BAR + TPQ * 2.5, TPQ, root + 12, 92));
    bEvents.push(n(bar * TICKS_PER_BAR + TPQ * 3.5, TPQ / 2, root + 7, 84));
  });
  k.rawEvents = kEvents;
  k.editedEvents = kEvents.map((e) => ({ ...e }));
  k.name = 'Chords';
  b.rawEvents = bEvents;
  b.editedEvents = bEvents.map((e) => ({ ...e }));
  b.name = 'Bassline';

  // Lead: a short original motif.
  const motif: [number, number, number][] = [
    [0, 1, 76], [1, 0.5, 74], [1.5, 1.5, 72], [3, 1, 69],
    [4, 1.5, 72], [5.5, 0.5, 74], [6, 2, 76],
    [8, 1, 79], [9, 1, 76], [10, 1, 74], [11, 1, 72],
    [12, 1.5, 74], [13.5, 0.5, 72], [14, 2, 71],
  ];
  const l = ensureSceneClip(p, sceneA.id, lead.id);
  const lEvents = motif.map(([beat, len, m]) => n(beat * TPQ, len * TPQ - 40, m, 92));
  l.rawEvents = lEvents;
  l.editedEvents = lEvents.map((e) => ({ ...e }));
  l.name = 'Motif';

  // Scene B: variation without the lead, busier hats.
  const sceneB = duplicateScene(p, sceneA.id);
  if (typeof sceneB !== 'string') {
    delete sceneB.clipByTrackId[lead.id];
    const dc = p.clips[sceneB.clipByTrackId[drums.id]!];
    if (dc.kind === 'drum') {
      const extra: DrumEvent[] = [];
      for (let s = 1; s < 64; s += 2) extra.push(h(s, 'shaker', 64));
      dc.rawEvents = [...dc.rawEvents, ...extra];
      dc.editedEvents = dc.rawEvents.map((e) => ({ ...e }));
    }
    addSceneToSong(p, sceneA.id);
    addSceneToSong(p, sceneB.id);
    addSceneToSong(p, sceneA.id);
  }
  return p;
}
