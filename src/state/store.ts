// Application store: project state with undo, autosave, transport/recording orchestration,
// and the hum capture → analysis workflow. React subscribes via useStore().

import { produce } from 'immer';
import { useSyncExternalStore } from 'react';
import { engine, type EngineStatus, type PerformEvent } from '../audio/engine';
import { MicCapture, MicError } from '../audio/mic';
import { encodeWav, decodeWav } from '../audio/wav';
import { instrument } from '../domain/catalog';
import { barsToSeconds, clampBpm, MAX_TAKE_SECONDS, secondsToTicks, TICKS_PER_BAR, TPQ, CLIP_BAR_OPTIONS } from '../domain/constants';
import { buildDemoProject } from '../domain/demo';
import { addTrack, emptyProject, ensureSceneClip, newClip, uid, type TrackPreset } from '../domain/ops';
import type { Clip, ClipBars, DrumEvent, PitchedClip, PitchedEvent, Project, ProjectSummary, SourceTake } from '../domain/types';
import * as db from '../persist/db';
import { startTranscription, type TranscribeJob } from '../transcribe/client';
import type { DetectedNote } from '../transcribe/pitch';

export type View = 'play' | 'arrange';
export type PlayMode = 'keys' | 'scale' | 'chords' | 'hum';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
export type Sheet = null | 'mix' | 'export' | 'key' | 'addTrack' | 'settings' | 'trackMenu' | 'projectMenu';

export type HumPhase = 'idle' | 'requesting' | 'countin' | 'recording' | 'saving' | 'analyzing' | 'review' | 'empty' | 'error';

export interface HumState {
  phase: HumPhase;
  mode: 'bars' | 'free';
  bars: ClipBars;
  error?: string;
  takeId?: string;
  clipId?: string;
  startedAt?: number; // ctx time of capture start
  stopAt?: number; // ctx time capture auto-stops
  analysisMs?: number;
  outside?: number; // notes outside the clip
}

export interface TakeChoice {
  trackId: string;
  sceneId: string;
  newClipId: string;
  previousClipId: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

export interface AppState {
  screen: 'home' | 'project';
  projects: ProjectSummary[];
  project: Project | null;
  readOnly: boolean;
  saveStatus: SaveStatus;
  saveError: string | null;
  persistent: boolean | null;
  view: View;
  arrangeMode: 'clips' | 'song';
  sheet: Sheet;
  selectedTrackId: string | null;
  selectedSceneId: string | null;
  editingClipId: string | null;
  selectedInstanceId: string | null;
  overlapId: string | null;
  playMode: Record<string, PlayMode>;
  drumSurface: 'kit' | 'pads';
  octave: Record<string, number>;
  showLabels: boolean;
  sustain: boolean;
  engine: EngineStatus;
  canUndo: boolean;
  canRedo: boolean;
  toast: Toast | null;
  hum: HumState;
  takeChoice: TakeChoice | null;
  recordingTrackId: string | null;
  tempoNotice: boolean;
  booting: boolean;
}

type Listener = () => void;

const initial: AppState = {
  screen: 'home',
  projects: [],
  project: null,
  readOnly: false,
  saveStatus: 'idle',
  saveError: null,
  persistent: null,
  view: 'play',
  arrangeMode: 'clips',
  sheet: null,
  selectedTrackId: null,
  selectedSceneId: null,
  editingClipId: null,
  selectedInstanceId: null,
  overlapId: null,
  playMode: {},
  drumSurface: 'kit',
  octave: {},
  showLabels: true,
  sustain: false,
  engine: engine.status,
  canUndo: false,
  canRedo: false,
  toast: null,
  hum: { phase: 'idle', mode: 'bars', bars: 4 },
  takeChoice: null,
  recordingTrackId: null,
  tempoNotice: false,
  booting: true,
};

const UNDO_LIMIT = 100;

class Store {
  state: AppState = initial;
  private listeners = new Set<Listener>();
  private undo: { project: Project; key?: string; at: number }[] = [];
  private redo: Project[] = [];
  private saveTimer: number | null = null;
  private saving = false;
  private dirty = false;
  private lockRelease: (() => void) | null = null;
  private mic: MicCapture | null = null;
  private humJob: TranscribeJob | null = null;
  private humTimer: number | null = null;
  private recHeld = new Map<string, { tick: number; midi: number; vel: number }>();
  private recTake: PitchedEvent[] = [];
  private recKey = '';
  private toastSeq = 0;

  constructor() {
    engine.subscribe((s) => {
      engine.syncPending();
      this.set({ engine: s });
    });
    engine.onPerform = (e) => this.onPerform(e);
    engine.onInterrupted = () => this.onInterrupted();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          const active = this.state.engine.state !== 'stopped' || ['recording', 'countin'].includes(this.state.hum.phase);
          if (active) {
            this.onInterrupted();
            engine.stop();
          }
          void this.flushSave();
        }
      });
      window.addEventListener('pagehide', () => void this.flushSave());
      window.addEventListener('blur', () => engine.releaseAllLive());
    }
  }

  // ---------- plumbing ----------
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;
  set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
    const id = ++this.toastSeq;
    this.set({ toast: { id, text, kind, action } });
    setTimeout(() => {
      if (this.state.toast?.id === id) this.set({ toast: null });
    }, kind === 'error' ? 6000 : 3200);
  }

  // ---------- projects ----------
  async boot() {
    try {
      const projects = await db.listProjects();
      this.set({ projects, booting: false });
    } catch (e) {
      this.set({ booting: false, saveStatus: 'failed', saveError: (e as Error).message });
    }
  }

  async refreshProjects() {
    try {
      this.set({ projects: await db.listProjects() });
    } catch {
      /* listing failure is shown via saveStatus elsewhere */
    }
  }

  async createProject(path: 'hum' | 'drums' | 'keys') {
    engine.unlock();
    const p = emptyProject(path === 'hum' ? 'Hummed idea' : path === 'drums' ? 'Beat sketch' : 'Keys sketch');
    const t = addTrack(p, path === 'hum' ? 'hum' : path === 'drums' ? 'drums' : 'keys');
    if (typeof t === 'string') return;
    await this.openLoaded(p, { [t.id]: path === 'hum' ? 'hum' : 'keys' });
    this.set({ selectedTrackId: t.id, view: 'play' });
    this.scheduleSave(0);
    db.requestPersistence().then((persistent) => this.set({ persistent }));
  }

  async openDemo() {
    engine.unlock();
    const p = buildDemoProject();
    await this.openLoaded(p, {});
    this.set({ view: 'arrange', arrangeMode: 'song' });
    engine.setSource('song');
    this.scheduleSave(0);
  }

  async openProject(id: string) {
    engine.unlock();
    try {
      const p = await db.loadProject(id);
      if (!p) {
        this.toast('That project could not be found on this device.', 'error');
        return;
      }
      await this.openLoaded(p, {});
    } catch (e) {
      this.toast(`Could not open project: ${(e as Error).message}`, 'error');
    }
  }

  private async openLoaded(p: Project, playMode: Record<string, PlayMode>) {
    await this.closeProject(false);
    this.undo = [];
    this.redo = [];
    engine.setProject(p);
    engine.setSource('scene');
    engine.selectScene(p.sceneIds[0]);
    this.set({
      screen: 'project',
      project: p,
      selectedTrackId: p.trackIds[0] ?? null,
      selectedSceneId: p.sceneIds[0],
      editingClipId: null,
      selectedInstanceId: null,
      playMode,
      view: 'play',
      arrangeMode: 'clips',
      sheet: null,
      canUndo: false,
      canRedo: false,
      saveStatus: 'saved',
      saveError: null,
      hum: { phase: 'idle', mode: 'bars', bars: 4 },
      takeChoice: null,
      readOnly: false,
    });
    await this.acquireLock(p.id);
  }

  async closeProject(goHome = true) {
    engine.stop();
    this.cancelHum();
    await this.flushSave();
    const p = this.state.project;
    if (p && this.state.saveStatus === 'saved') {
      // Safe point: drop audio blobs no longer reachable from this project or its undo history.
      const keep = new Set<string>();
      for (const proj of [p, ...this.undo.map((u) => u.project), ...this.redo]) for (const t of Object.values(proj.takes)) keep.add(t.blobKey);
      db.cleanupAssets(p.id, keep).catch(() => {});
    }
    this.lockRelease?.();
    this.lockRelease = null;
    if (goHome) {
      this.set({ screen: 'home', project: null, sheet: null });
      await this.refreshProjects();
    }
  }

  // Second-tab protection via Web Locks; the other tab becomes read-only until takeover.
  private async acquireLock(projectId: string) {
    const locks = (navigator as any).locks;
    if (!locks) return;
    const name = `pocket-music-project-${projectId}`;
    await new Promise<void>((ready) => {
      locks
        .request(name, { ifAvailable: true }, (lock: unknown) => {
          if (!lock) {
            this.set({ readOnly: true });
            ready();
            return;
          }
          this.set({ readOnly: false });
          ready();
          return new Promise<void>((release) => (this.lockRelease = release));
        })
        .catch(() => {
          this.set({ readOnly: true });
          ready();
        });
    });
  }

  async takeOver() {
    const p = this.state.project;
    const locks = (navigator as any).locks;
    if (!p || !locks) return;
    const fresh = await db.loadProject(p.id);
    locks
      .request(`pocket-music-project-${p.id}`, { steal: true }, () => {
        this.set({ readOnly: false });
        return new Promise<void>((release) => (this.lockRelease = release));
      })
      .catch(() => {
        this.set({ readOnly: true });
        this.toast('Another tab took over editing. This tab is now read-only.', 'error');
      });
    if (fresh) {
      engine.setProject(fresh);
      this.set({ project: fresh });
    }
  }

  async deleteProject(id: string) {
    await db.deleteProject(id);
    await this.refreshProjects();
  }

  async duplicateProject(id: string) {
    const p = await db.loadProject(id);
    if (!p) return;
    const copy: Project = JSON.parse(JSON.stringify(p));
    copy.id = uid('p');
    copy.title = `${p.title} copy`;
    copy.createdAt = copy.updatedAt = Date.now();
    for (const take of Object.values(copy.takes)) {
      const blob = await db.getAsset(take.blobKey);
      const key = uid('blob');
      if (blob) await db.putAsset(key, blob, copy.id);
      take.blobKey = key;
    }
    await db.saveProject(copy);
    await this.refreshProjects();
  }

  async renameProject(id: string, title: string) {
    if (this.state.project?.id === id) {
      this.commit((d) => {
        d.title = title.slice(0, 80) || 'Untitled sketch';
      });
      return;
    }
    const p = await db.loadProject(id);
    if (!p) return;
    p.title = title.slice(0, 80) || 'Untitled sketch';
    p.updatedAt = Date.now();
    await db.saveProject(p);
    await this.refreshProjects();
  }

  async importProject(project: Project, takes: { blobKey: string; blob: Blob }[]) {
    for (const t of takes) await db.putAsset(t.blobKey, t.blob, project.id);
    await db.saveProject(project);
    await this.refreshProjects();
    await this.openLoaded(project, {});
  }

  // ---------- edits & undo ----------
  /**
   * Apply an undoable change. The mutator may return a string to reject the change with a message.
   * `coalesce` merges rapid consecutive changes (fader drags, a recording pass) into one undo step.
   */
  commit(fn: (d: Project) => void | string | unknown, opts: { coalesce?: string; silent?: boolean } = {}): boolean {
    const p = this.state.project;
    if (!p) return false;
    if (this.state.readOnly) {
      this.toast('This project is open in another tab. Take over editing to make changes.', 'error');
      return false;
    }
    let err: string | undefined;
    const next = produce(p, (d) => {
      const r = fn(d as Project);
      if (typeof r === 'string') err = r;
    });
    if (err) {
      if (err.startsWith('overlap:')) {
        this.set({ overlapId: err.slice(8) });
        setTimeout(() => this.set({ overlapId: null }), 1500);
        this.toast('A track can play one clip at a time — that spot is taken.', 'error');
      } else if (!opts.silent) this.toast(err, 'error');
      return false;
    }
    if (next === p) return true;
    const now = Date.now();
    const top = this.undo[this.undo.length - 1];
    if (!(opts.coalesce && top && top.key === opts.coalesce && now - top.at < 2000)) {
      this.undo.push({ project: p, key: opts.coalesce, at: now });
      if (this.undo.length > UNDO_LIMIT) this.undo.shift();
    } else top.at = now;
    this.redo = [];
    const stamped = produce(next, (d) => {
      d.updatedAt = now;
    });
    this.apply(stamped);
    return true;
  }

  private apply(p: Project) {
    engine.setProject(p);
    const patch: Partial<AppState> = { project: p, canUndo: this.undo.length > 0, canRedo: this.redo.length > 0 };
    if (this.state.selectedTrackId && !p.tracks[this.state.selectedTrackId]) patch.selectedTrackId = p.trackIds[0] ?? null;
    if (this.state.selectedSceneId && !p.scenes[this.state.selectedSceneId]) patch.selectedSceneId = p.sceneIds[0];
    if (this.state.editingClipId && !p.clips[this.state.editingClipId]) patch.editingClipId = null;
    this.set(patch);
    this.scheduleSave();
  }

  undoEdit() {
    const prev = this.undo.pop();
    if (!prev || !this.state.project) return;
    this.redo.push(this.state.project);
    this.apply(prev.project);
  }
  redoEdit() {
    const next = this.redo.pop();
    if (!next || !this.state.project) return;
    this.undo.push({ project: this.state.project, at: 0 });
    this.apply(next);
  }

  // ---------- autosave ----------
  scheduleSave(delay = 700) {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flushSave(), delay);
  }

  async flushSave(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const p = this.state.project;
    if (!p || !this.dirty || this.state.readOnly) return;
    if (this.saving) {
      this.scheduleSave(300);
      return;
    }
    this.saving = true;
    this.dirty = false;
    this.set({ saveStatus: 'saving' });
    try {
      await db.saveProject(p);
      // Only report Saved if nothing changed during the write.
      this.set({ saveStatus: this.dirty ? 'saving' : 'saved', saveError: null });
    } catch (e) {
      this.dirty = true;
      const msg = db.isQuotaError(e) ? 'This device is out of storage space for the browser.' : (e as Error).message || 'Unknown storage error.';
      this.set({ saveStatus: 'failed', saveError: msg });
    } finally {
      this.saving = false;
    }
  }

  retrySave() {
    this.dirty = true;
    void this.flushSave();
  }

  // ---------- selection / ui ----------
  selectTrack(id: string) {
    this.set({ selectedTrackId: id });
  }
  selectScene(id: string) {
    this.set({ selectedSceneId: id });
    engine.selectScene(id);
  }
  openSheet(sheet: Sheet) {
    this.set({ sheet });
  }
  playModeFor(trackId: string): PlayMode {
    const t = this.state.project?.tracks[trackId];
    return this.state.playMode[trackId] ?? (t?.instrumentId === 'bass' ? 'scale' : 'keys');
  }
  setPlayMode(trackId: string, mode: PlayMode) {
    this.set({ playMode: { ...this.state.playMode, [trackId]: mode } });
  }
  octaveFor(trackId: string): number {
    const t = this.state.project?.tracks[trackId];
    return this.state.octave[trackId] ?? (t ? instrument(t.instrumentId).defaultOctave : 60);
  }
  shiftOctave(trackId: string, d: number) {
    const o = Math.min(96, Math.max(24, this.octaveFor(trackId) + 12 * d));
    this.set({ octave: { ...this.state.octave, [trackId]: o } });
  }

  addTrack(preset: TrackPreset) {
    let newId = '';
    this.commit((d) => {
      const t = addTrack(d, preset);
      if (typeof t === 'string') return t;
      newId = t.id;
    });
    if (newId) {
      this.set({ selectedTrackId: newId, sheet: null, view: 'play', playMode: { ...this.state.playMode, [newId]: preset === 'hum' ? 'hum' : preset === 'bass' ? 'scale' : 'keys' } });
    }
  }

  // ---------- transport ----------
  setBpm(bpm: number) {
    const v = clampBpm(bpm);
    if (!this.state.project || v === this.state.project.bpm) return;
    const wasPlaying = this.state.engine.state !== 'stopped';
    if (wasPlaying) engine.stop();
    this.commit((d) => {
      d.bpm = v;
    }, { coalesce: 'bpm' });
    if (wasPlaying) {
      this.set({ tempoNotice: true });
      setTimeout(() => this.set({ tempoNotice: false }), 3500);
    }
  }

  async togglePlay() {
    await engine.ensure();
    if (this.state.engine.state !== 'stopped' && this.state.engine.state !== 'suspended') {
      this.stopTransport();
      return;
    }
    const p = this.state.project;
    if (!p) return;
    if (engine.status.source === 'song') {
      if (!p.arrangement.length) {
        this.toast('The song is empty. Add a scene to the song first, or switch playback to Scene.', 'error');
        return;
      }
      engine.clickWhilePlaying = false;
      await engine.start();
    } else {
      engine.clickWhilePlaying = false;
      await engine.launchScene(this.state.selectedSceneId ?? p.sceneIds[0]);
    }
  }

  stopTransport() {
    if (this.state.recordingTrackId) this.finishRecording();
    if (['countin', 'recording'].includes(this.state.hum.phase)) void this.stopHum();
    engine.stop();
  }

  stopAllSound() {
    if (this.state.recordingTrackId) this.finishRecording();
    engine.stopAllSound();
    this.toast('All sound stopped.');
  }

  setSource(src: 'scene' | 'song') {
    engine.setSource(src);
  }

  // ---------- instrument recording ----------
  async toggleRecord() {
    if (this.state.recordingTrackId) {
      this.finishRecording();
      engine.stop();
      return;
    }
    const p = this.state.project;
    const trackId = this.state.selectedTrackId;
    const sceneId = this.state.selectedSceneId;
    if (!p || !trackId || !sceneId || this.state.readOnly) return;
    if (this.playModeFor(trackId) === 'hum' && p.tracks[trackId].type === 'pitched') {
      void this.startHum();
      return;
    }
    await engine.ensure();
    if (engine.status.source !== 'scene') engine.setSource('scene');
    // Make sure there's a clip to record into (drum overdub) — pitched takes get a fresh clip later.
    if (p.tracks[trackId].type === 'drum') this.commit((d) => void ensureSceneClip(d, sceneId, trackId));
    this.recKey = uid('rec');
    this.recTake = [];
    this.recHeld.clear();
    engine.recording = true;
    engine.clickWhilePlaying = this.state.project!.settings.metronome;
    this.set({ recordingTrackId: trackId, view: 'play' });
    const playing = this.state.engine.state === 'playing';
    if (playing && engine.status.sceneId === sceneId) return; // punch in
    engine.stop();
    engine.recording = true;
    engine.selectScene(sceneId);
    engine.setSilentTrack(p.tracks[trackId].type === 'pitched' ? trackId : null);
    const ok = await engine.start({ countInBars: p.settings.countInBars });
    if (!ok) {
      engine.recording = false;
      this.set({ recordingTrackId: null });
    }
  }

  /** Called with every live performance event while the engine is running. */
  private onPerform(e: PerformEvent) {
    const trackId = this.state.recordingTrackId;
    const p = this.state.project;
    if (!trackId || !p || e.trackId !== trackId || !engine.recording) return;
    const sceneId = engine.status.sceneId ?? this.state.selectedSceneId!;
    const scene = p.scenes[sceneId];
    const sceneLen = scene.durationBars * TICKS_PER_BAR;
    const offset = (p.settings.recordingOffsetMs / 1000) * (p.bpm / 60) * TPQ;
    let tick = engine.sceneTickAt(e.time) - offset;
    if (tick < 0) {
      // A hit just before the downbeat counts as the downbeat; earlier count-in taps are ignored.
      if (tick > -TPQ / 2) tick = 0;
      else if (e.type !== 'noteOff') return;
    }
    if (e.type === 'hit') {
      const clipId = scene.clipByTrackId[trackId];
      const clip = clipId ? p.clips[clipId] : undefined;
      if (!clip || clip.kind !== 'drum') return;
      const local = Math.round(tick) % clip.lengthTicks;
      const ev: DrumEvent = { id: uid('d'), startTick: local, padId: e.padId, velocity: e.vel };
      this.commit((d) => {
        const c = d.clips[clip.id] as Clip;
        if (c.kind !== 'drum') return;
        c.rawEvents.push(ev);
        c.editedEvents.push({ ...ev });
      }, { coalesce: this.recKey });
      return;
    }
    if (e.type === 'noteOn') {
      this.recHeld.set(e.key, { tick: Math.max(0, tick), midi: e.midi, vel: e.vel });
      return;
    }
    const held = this.recHeld.get(e.key);
    if (!held) return;
    this.recHeld.delete(e.key);
    const start = Math.round(held.tick);
    const local = start % sceneLen;
    const dur = Math.max(30, Math.round(tick - held.tick));
    this.recTake.push({ id: uid('n'), startTick: local, durationTicks: Math.min(dur, sceneLen - local), midiPitch: held.midi, velocity: held.vel });
  }

  finishRecording() {
    const trackId = this.state.recordingTrackId;
    const sceneId = engine.status.sceneId ?? this.state.selectedSceneId;
    engine.recording = false;
    engine.setSilentTrack(null);
    engine.clickWhilePlaying = false;
    this.set({ recordingTrackId: null });
    const p = this.state.project;
    if (!p || !trackId || !sceneId) return;
    // Close any held notes at "now".
    const nowTick = engine.ctx ? engine.sceneTickAt(engine.ctx.currentTime) : 0;
    const sceneLen = p.scenes[sceneId].durationBars * TICKS_PER_BAR;
    for (const h of this.recHeld.values()) {
      const local = Math.round(h.tick) % sceneLen;
      this.recTake.push({ id: uid('n'), startTick: local, durationTicks: Math.max(30, Math.min(Math.round(nowTick - h.tick), sceneLen - local)), midiPitch: h.midi, velocity: h.vel });
    }
    this.recHeld.clear();
    if (p.tracks[trackId].type !== 'pitched') return;
    if (!this.recTake.length) {
      this.toast('No notes were recorded.');
      return;
    }
    const events = this.recTake;
    this.recTake = [];
    this.installPitchedTake(trackId, sceneId, (d) => {
      const scene = d.scenes[sceneId];
      const bars = scene.durationBars;
      const c = newClip(d, trackId, bars) as PitchedClip;
      c.rawEvents = events;
      c.editedEvents = events.map((e) => ({ ...e }));
      return c;
    });
  }

  /** Put a new pitched take into the scene slot, or ask Replace/Keep when one exists. Nothing is erased. */
  private installPitchedTake(trackId: string, sceneId: string, make: (d: Project) => Clip) {
    let newId = '';
    let prevId = '';
    this.commit((d) => {
      const c = make(d);
      newId = c.id;
      const prev = d.scenes[sceneId].clipByTrackId[trackId];
      const prevClip = prev ? d.clips[prev] : undefined;
      if (prevClip && prevClip.editedEvents.length > 0) prevId = prev!;
      else d.scenes[sceneId].clipByTrackId[trackId] = c.id;
    });
    if (prevId) this.set({ takeChoice: { trackId, sceneId, newClipId: newId, previousClipId: prevId } });
    return newId;
  }

  resolveTakeChoice(replace: boolean) {
    const tc = this.state.takeChoice;
    if (!tc) return;
    if (replace)
      this.commit((d) => {
        d.scenes[tc.sceneId].clipByTrackId[tc.trackId] = tc.newClipId;
      });
    this.set({ takeChoice: null });
    this.toast(replace ? 'New take is in the scene. The previous take is kept in the clip list.' : 'Kept the previous take. The new take is saved in the clip list.');
  }

  // ---------- hum workflow ----------
  setHum(patch: Partial<HumState>) {
    this.set({ hum: { ...this.state.hum, ...patch } });
  }

  async startHum() {
    const p = this.state.project;
    const trackId = this.state.selectedTrackId;
    const sceneId = this.state.selectedSceneId;
    if (!p || !trackId || !sceneId || this.state.readOnly) return;
    const ctx = await engine.ensure();
    const { mode, bars } = this.state.hum;
    if (mode === 'bars' && barsToSeconds(bars, p.bpm) > MAX_TAKE_SECONDS) {
      this.setHum({ phase: 'error', error: `${bars} bars at ${p.bpm} BPM is longer than the 20-second limit. Choose fewer bars, a faster tempo, or a free take.` });
      return;
    }
    this.setHum({ phase: 'requesting', error: undefined, takeId: undefined, clipId: undefined });
    try {
      this.mic = await MicCapture.open(ctx);
    } catch (e) {
      this.setHum({ phase: 'error', error: e instanceof MicError ? e.message : 'Could not start the microphone.' });
      return;
    }
    this.mic.onLimit = () => void this.stopHum();
    if (mode === 'free') {
      engine.stop();
      this.mic.start();
      this.setHum({ phase: 'recording', startedAt: ctx.currentTime, stopAt: ctx.currentTime + MAX_TAKE_SECONDS });
      return;
    }
    // Bar-synced take: count-in (audible clicks), then capture with a visual beat and no click.
    if (engine.status.source !== 'scene') engine.setSource('scene');
    engine.stop();
    engine.selectScene(sceneId);
    engine.clickWhilePlaying = false;
    engine.setSilentTrack(trackId);
    this.mic.start();
    const countIn = p.settings.countInBars;
    await engine.start({ countInBars: countIn });
    const downbeat = engine.timeOfTick(0);
    const stopAt = downbeat + barsToSeconds(bars, p.bpm);
    this.setHum({ phase: countIn ? 'countin' : 'recording', startedAt: downbeat, stopAt });
    const tick = () => {
      if (!['countin', 'recording'].includes(this.state.hum.phase)) return;
      const now = ctx.currentTime;
      if (this.state.hum.phase === 'countin' && now >= downbeat) this.setHum({ phase: 'recording' });
      if (now >= stopAt) void this.stopHum();
      else this.humTimer = window.setTimeout(tick, 30);
    };
    tick();
  }

  cancelHum() {
    if (this.humTimer) clearTimeout(this.humTimer);
    this.humJob?.cancel();
    this.humJob = null;
    if (this.mic) {
      this.mic.close();
      this.mic = null;
      engine.setSilentTrack(null);
      engine.stop();
    }
    if (this.state.hum.phase !== 'idle') this.setHum({ phase: 'idle', error: undefined });
  }

  get micLevel(): number {
    return this.mic?.level ?? 0;
  }
  get micSeconds(): number {
    return this.mic?.seconds ?? 0;
  }

  async stopHum(incomplete = false) {
    if (!this.mic) return;
    if (this.humTimer) clearTimeout(this.humTimer);
    const p = this.state.project!;
    const trackId = this.state.selectedTrackId!;
    const sceneId = this.state.selectedSceneId!;
    const { mode, bars } = this.state.hum;
    const cap = this.mic.stop();
    this.mic.close();
    this.mic = null;
    const downbeat = mode === 'bars' ? engine.timeOfTick(0) : cap.startTime;
    engine.setSilentTrack(null);
    engine.stop();
    if (cap.samples.length < cap.sampleRate * 0.3) {
      this.setHum({ phase: 'error', error: 'The recording was too short. Tap Record and hum for a few seconds.' });
      return;
    }
    // 1) Preserve the take immediately, before analysis.
    this.setHum({ phase: 'saving' });
    const takeId = uid('take');
    const blobKey = uid('blob');
    const blob = new Blob([encodeWav([cap.samples], cap.sampleRate)], { type: 'audio/wav' });
    const take: SourceTake = {
      id: takeId,
      blobKey,
      mimeType: 'audio/wav',
      sampleRate: cap.sampleRate,
      channels: 1,
      durationSeconds: cap.samples.length / cap.sampleRate,
      captureBpm: mode === 'bars' ? p.bpm : null,
      captureOffsetSeconds: cap.startTime - downbeat,
      incomplete,
      createdAt: Date.now(),
    };
    this.humAudio = { takeId, samples: cap.samples, sampleRate: cap.sampleRate };
    try {
      await db.putAsset(blobKey, blob, p.id);
    } catch (e) {
      this.setHum({ phase: 'error', error: `Your take is still in memory but could not be saved: ${db.isQuotaError(e) ? 'storage is full' : (e as Error).message}. Free space or export a backup, then retry.`, takeId });
      this.pendingTakeBlob = { blobKey, blob, take };
      return;
    }
    this.commit((d) => {
      d.takes[takeId] = take;
    });
    void this.flushSave();
    // Default trim: bar-synced → the downbeat (+ manual latency offset); free → first sound.
    const trim = mode === 'bars' ? downbeat - cap.startTime + p.settings.recordingOffsetMs / 1000 : 0;
    await this.analyzeTake(takeId, trackId, sceneId, mode === 'bars' ? bars : null, trim);
  }

  private humAudio: { takeId: string; samples: Float32Array; sampleRate: number } | null = null;
  private pendingTakeBlob: { blobKey: string; blob: Blob; take: SourceTake } | null = null;

  async retryTakeSave() {
    const pt = this.pendingTakeBlob;
    if (!pt || !this.state.project) return;
    try {
      await db.putAsset(pt.blobKey, pt.blob, this.state.project.id);
      this.pendingTakeBlob = null;
      this.commit((d) => {
        d.takes[pt.take.id] = pt.take;
      });
      await this.analyzeTake(pt.take.id, this.state.selectedTrackId!, this.state.selectedSceneId!, this.state.hum.mode === 'bars' ? this.state.hum.bars : null, 0);
    } catch (e) {
      this.toast(`Still can't save: ${(e as Error).message}`, 'error');
    }
  }

  async loadTakeSamples(takeId: string): Promise<{ samples: Float32Array; sampleRate: number } | null> {
    if (this.humAudio?.takeId === takeId) return this.humAudio;
    const take = this.state.project?.takes[takeId];
    if (!take) return null;
    const blob = await db.getAsset(take.blobKey);
    if (!blob) return null;
    const wav = decodeWav(await blob.arrayBuffer());
    this.humAudio = { takeId, samples: wav.channels[0], sampleRate: wav.sampleRate };
    return this.humAudio;
  }

  /** Analyze (or re-analyze) a stored take into a NEW clip. Previous clips/edits are never overwritten. */
  async analyzeTake(takeId: string, trackId: string, sceneId: string, bars: ClipBars | null, trimSeconds: number) {
    const audio = await this.loadTakeSamples(takeId);
    if (!audio) {
      this.setHum({ phase: 'error', error: 'The original take could not be loaded from this device.' });
      return;
    }
    this.setHum({ phase: 'analyzing', takeId });
    const job = startTranscription(audio.samples, audio.sampleRate);
    this.humJob = job;
    let res;
    try {
      res = await job.promise;
    } catch (e) {
      this.humJob = null;
      if ((e as Error).message === 'cancelled') {
        this.setHum({ phase: 'empty', error: 'Analysis cancelled. Your recording is saved.', takeId });
        return;
      }
      this.setHum({ phase: 'error', error: `Analysis failed: ${(e as Error).message}. Your recording is saved — you can retry or enter notes by hand.`, takeId });
      return;
    }
    this.humJob = null;
    const notes = res.result.notes;
    this.commit((d) => {
      const t = d.takes[takeId];
      if (t) (t as SourceTake & { analysis?: DetectedNote[] }).analysis = notes;
    }, { coalesce: `take:${takeId}` });
    if (!notes.length) {
      this.setHum({ phase: 'empty', error: 'No clear notes were found. Hum distinct notes a little louder in a quieter spot. Your recording is saved.', takeId, analysisMs: res.ms });
      return;
    }
    const p = this.state.project!;
    // Free takes: trim to first sound, fit to the smallest clip that holds everything.
    let trim = trimSeconds;
    if (bars === null) trim = Math.max(0, notes[0].startSeconds - 0.02);
    const spanTicks = secondsToTicks(notes[notes.length - 1].startSeconds + notes[notes.length - 1].durationSeconds - trim, p.bpm);
    const fitBars = bars ?? ((CLIP_BAR_OPTIONS.find((b) => b * TICKS_PER_BAR >= spanTicks) ?? 8) as ClipBars);
    const { events, outside } = notesToEvents(notes, trim, p.bpm, fitBars * TICKS_PER_BAR);
    const clipId = this.installPitchedTake(trackId, sceneId, (d) => {
      const c = newClip(d, trackId, fitBars, `Hum ${Object.keys(d.takes).length}`) as PitchedClip;
      c.rawEvents = events;
      c.editedEvents = events.map((e) => ({ ...e }));
      c.sourceTakeId = takeId;
      c.trimOriginSeconds = trim;
      c.quantize.strength = 0.5;
      if (d.scenes[sceneId].durationBars < fitBars) d.scenes[sceneId].durationBars = fitBars;
      return c;
    });
    this.set({ editingClipId: null });
    this.setHum({ phase: 'review', takeId, clipId, analysisMs: res.ms, outside });
  }

  /** Re-derive a hum clip from its take's analysis with a new trim origin and/or length. */
  retrimHumClip(clipId: string, trimSeconds: number, bars?: ClipBars) {
    const p = this.state.project;
    const c = p?.clips[clipId];
    if (!p || !c || c.kind !== 'pitched' || !c.sourceTakeId) return;
    const take = p.takes[c.sourceTakeId] as SourceTake & { analysis?: DetectedNote[] };
    if (!take?.analysis) return;
    const len = (bars ?? c.lengthTicks / TICKS_PER_BAR) * TICKS_PER_BAR;
    const { events, outside } = notesToEvents(take.analysis, Math.max(0, trimSeconds), p.bpm, len);
    this.commit((d) => {
      const cc = d.clips[clipId] as PitchedClip;
      cc.rawEvents = events;
      cc.editedEvents = events.map((e) => ({ ...e }));
      cc.trimOriginSeconds = Math.max(0, trimSeconds);
      cc.lengthTicks = len;
      for (const s of Object.values(d.scenes)) if (s.clipByTrackId[cc.trackId] === clipId && s.durationBars * TICKS_PER_BAR < len) s.durationBars = (len / TICKS_PER_BAR) as ClipBars;
    });
    this.setHum({ outside });
  }

  manualEntryFromTake() {
    const { takeId } = this.state.hum;
    const trackId = this.state.selectedTrackId!;
    const sceneId = this.state.selectedSceneId!;
    const clipId = this.installPitchedTake(trackId, sceneId, (d) => {
      const c = newClip(d, trackId, d.scenes[sceneId].durationBars, 'Hand-entered melody') as PitchedClip;
      if (takeId) c.sourceTakeId = takeId;
      c.trimOriginSeconds = 0;
      return c;
    });
    this.setHum({ phase: 'review', clipId });
    this.set({ editingClipId: clipId });
  }

  private onInterrupted() {
    if (['recording', 'countin'].includes(this.state.hum.phase) && this.mic) {
      void this.stopHum(true);
      this.toast('Recording was interrupted. The partial take was kept and marked incomplete.', 'error');
    }
    if (this.state.recordingTrackId) this.finishRecording();
  }

  // ---------- original take audition ----------
  private takeSource: AudioBufferSourceNode | null = null;
  async playTake(takeId: string, fromSeconds = 0) {
    const ctx = await engine.ensure();
    const audio = await this.loadTakeSamples(takeId);
    if (!audio) return;
    this.stopTake();
    const buf = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
    buf.copyToChannel(audio.samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination); // reference only — never routed into the mix or export
    src.start(ctx.currentTime + 0.02, Math.max(0, fromSeconds));
    src.onended = () => {
      if (this.takeSource === src) this.takeSource = null;
    };
    this.takeSource = src;
  }
  stopTake() {
    try {
      this.takeSource?.stop();
    } catch {
      /* noop */
    }
    this.takeSource = null;
  }
}

export function notesToEvents(notes: DetectedNote[], trimSeconds: number, bpm: number, lengthTicks: number): { events: PitchedEvent[]; outside: number } {
  const events: PitchedEvent[] = [];
  let outside = 0;
  for (const n of notes) {
    let start = Math.round(secondsToTicks(n.startSeconds - trimSeconds, bpm));
    if (start < 0 && start > -TPQ / 8) start = 0;
    if (start < 0 || start >= lengthTicks) {
      outside++;
      continue;
    }
    const dur = Math.max(1, Math.min(Math.round(secondsToTicks(n.durationSeconds, bpm)), lengthTicks - start));
    events.push({
      id: uid('n'),
      startTick: start,
      durationTicks: dur,
      midiPitch: Math.min(127, Math.max(0, n.midi)),
      velocity: n.velocity,
      sourceSeconds: n.startSeconds,
      sourceDurationSeconds: n.durationSeconds,
      uncertain: n.uncertain || undefined,
    });
  }
  return { events, outside };
}

export const store = new Store();

export function useStore<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.state), () => sel(store.state));
}
