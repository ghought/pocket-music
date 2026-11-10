// Live audio engine: one AudioContext, look-ahead scheduler against audio time,
// immediate-response live voices, scene launching, and performance capture hooks.

import { instrument } from '../domain/catalog';
import { TICKS_PER_BAR, TPQ, ticksToSeconds } from '../domain/constants';
import { songEndTick } from '../domain/ops';
import type { Project } from '../domain/types';
import { playDrum } from './drums';
import { buildGraph, type MixGraph } from './graph';
import { playPitched, type Voice } from './instruments';
import { expandScene, expandSong, type SeqEvent } from './sequence';

export type TransportState = 'stopped' | 'countin' | 'playing' | 'recording' | 'suspended';
export type PlaySource = 'scene' | 'song';

export type PerformEvent =
  | { type: 'noteOn'; trackId: string; key: string; midi: number; vel: number; time: number }
  | { type: 'noteOff'; trackId: string; key: string; midi: number; time: number }
  | { type: 'hit'; trackId: string; padId: string; vel: number; time: number };

export interface EngineStatus {
  state: TransportState;
  source: PlaySource;
  sceneId: string | null;
  queuedSceneId: string | null;
  ready: boolean;
}

const LOOKAHEAD = 0.1;
const POLL_MS = 25;
const MAX_POLY = 8;

interface LiveVoice {
  key: string;
  midi: number;
  voice: Voice;
  started: number;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  graph: MixGraph | null = null;
  private project: Project | null = null;
  private listeners = new Set<(s: EngineStatus) => void>();
  status: EngineStatus = { state: 'stopped', source: 'scene', sceneId: null, queuedSceneId: null, ready: false };

  // transport timeline
  private startTime = 0; // ctx time of abs tick 0
  private scheduledUntil = 0; // abs tick
  private segStart = 0; // abs tick where current scene segment began
  private launchAt: number | null = null; // abs tick for queued scene
  private timer: number | null = null;
  private runBuses = new Map<string, GainNode>();
  private clickBus: GainNode | null = null;
  private seqMono = new Map<string, Voice>();
  private seqVoices: Voice[] = [];
  recording = false;
  clickWhilePlaying = false;
  /** Track whose scheduled clip is muted while a new take is captured for it. */
  private silentTrackId: string | null = null;
  countInBars = 0;
  /** Called on every live performance event (used for recording). */
  onPerform: ((e: PerformEvent) => void) | null = null;
  onInterrupted: (() => void) | null = null;

  // live voices
  private live = new Map<string, LiveVoice[]>(); // trackId → voices (poly)
  private monoHeld = new Map<string, { key: string; midi: number; vel: number }[]>();
  private monoVoice = new Map<string, LiveVoice>();

  subscribe(fn: (s: EngineStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(patch: Partial<EngineStatus>) {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  /** Create/resume the context. Must be called from a user gesture the first time. */
  async ensure(): Promise<AudioContext> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext = window.AudioContext ?? (window as any).webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.graph = buildGraph(this.ctx, this.ctx.destination, true);
      if (this.project) this.graph.sync(this.project, false);
      this.ctx.addEventListener('statechange', () => {
        const st = this.ctx!.state as string;
        if (st !== 'running' && this.status.state !== 'stopped') {
          this.stop();
          this.emit({ state: 'suspended' });
          this.onInterrupted?.();
        } else if (st === 'running' && this.status.state === 'suspended') {
          this.emit({ state: 'stopped' });
        }
      });
      this.emit({ ready: true });
    }
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* resume can reject without a gesture; the UI shows a resume action */
      }
    }
    return this.ctx;
  }

  /** Synchronous unlock for pointerdown handlers (resume promise kicked off, sound starts as soon as running). */
  unlock(): void {
    if (!this.ctx || this.ctx.state !== 'running') void this.ensure();
  }

  setProject(p: Project): void {
    const prev = this.project;
    this.project = p;
    this.graph?.sync(p);
    if (prev && prev.bpm !== p.bpm && this.status.state !== 'stopped') this.stop();
  }

  get bpm(): number {
    return this.project?.bpm ?? 100;
  }
  private get spt(): number {
    return ticksToSeconds(1, this.bpm);
  }

  // ---------------- live playing ----------------

  private strip(trackId: string): AudioNode | null {
    return this.graph?.strips.get(trackId)?.input ?? null;
  }

  noteOn(trackId: string, midi: number, vel: number, key: string): void {
    const ctx = this.ctx;
    const p = this.project;
    if (!ctx || !p || ctx.state !== 'running') {
      this.unlock();
      if (!ctx || ctx.state !== 'running') return;
    }
    const t = p!.tracks[trackId];
    const out = this.strip(trackId);
    if (!t || !out) return;
    const now = ctx!.currentTime;
    const def = instrument(t.instrumentId);
    this.onPerform?.({ type: 'noteOn', trackId, key, midi, vel, time: now });
    if (def.mono) {
      const held = this.monoHeld.get(trackId) ?? [];
      held.push({ key, midi, vel });
      this.monoHeld.set(trackId, held);
      const cur = this.monoVoice.get(trackId);
      cur?.voice.release(now);
      const v = playPitched(ctx!, out, t.instrumentId, now, midi, vel);
      this.monoVoice.set(trackId, { key, midi, voice: v, started: now });
      return;
    }
    const list = this.live.get(trackId) ?? [];
    while (list.length >= MAX_POLY) list.shift()!.voice.release(now);
    list.push({ key, midi, voice: playPitched(ctx!, out, t.instrumentId, now, midi, vel), started: now });
    this.live.set(trackId, list);
  }

  noteOff(trackId: string, key: string, sustain = false): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const t = this.project?.tracks[trackId];
    if (t && instrument(t.instrumentId).mono) {
      const held = (this.monoHeld.get(trackId) ?? []).filter((h) => h.key !== key);
      this.monoHeld.set(trackId, held);
      const cur = this.monoVoice.get(trackId);
      const released = cur && cur.key === key;
      const midi = cur?.midi ?? 0;
      if (released) this.onPerform?.({ type: 'noteOff', trackId, key, midi, time: now });
      if (released) {
        cur!.voice.release(now);
        this.monoVoice.delete(trackId);
        // Last-note priority: fall back to the most recent still-held key.
        const back = held[held.length - 1];
        const out = this.strip(trackId);
        if (back && out) {
          this.onPerform?.({ type: 'noteOn', trackId, key: back.key, midi: back.midi, vel: back.vel, time: now });
          this.monoVoice.set(trackId, { key: back.key, midi: back.midi, voice: playPitched(ctx, out, t.instrumentId, now, back.midi, back.vel), started: now });
        }
      }
      return;
    }
    const list = this.live.get(trackId) ?? [];
    const idx = list.findIndex((v) => v.key === key);
    if (idx < 0) return;
    const [v] = list.splice(idx, 1);
    this.onPerform?.({ type: 'noteOff', trackId, key, midi: v.midi, time: now });
    if (sustain) {
      v.voice.release(now + 2.5);
    } else v.voice.release(now);
  }

  hit(trackId: string, padId: string, vel: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') {
      this.unlock();
      return;
    }
    const t = this.project?.tracks[trackId];
    const out = this.strip(trackId);
    if (!t || !out) return;
    const now = ctx.currentTime;
    this.onPerform?.({ type: 'hit', trackId, padId, vel, time: now });
    playDrum(ctx, out, t.instrumentId, padId, now, vel);
  }

  /** Audition a single note (editor taps, previews). */
  preview(trackId: string, midi: number, vel = 96, seconds = 0.35): void {
    const ctx = this.ctx;
    const t = this.project?.tracks[trackId];
    const out = this.strip(trackId);
    if (!ctx || !t || !out) return;
    const v = playPitched(ctx, out, t.instrumentId, ctx.currentTime, midi, vel);
    v.release(ctx.currentTime + seconds);
  }
  previewHit(trackId: string, padId: string, vel = 100): void {
    const ctx = this.ctx;
    const t = this.project?.tracks[trackId];
    const out = this.strip(trackId);
    if (!ctx || !t || !out) return;
    playDrum(ctx, out, t.instrumentId, padId, ctx.currentTime, vel);
  }

  releaseAllLive(): void {
    const now = this.ctx?.currentTime ?? 0;
    for (const list of this.live.values()) list.forEach((v) => v.voice.release(now));
    this.live.clear();
    for (const v of this.monoVoice.values()) v.voice.release(now);
    this.monoVoice.clear();
    this.monoHeld.clear();
  }

  /** Accessible panic: hard-stop everything. */
  stopAllSound(): void {
    this.stop();
    for (const list of this.live.values()) list.forEach((v) => v.voice.kill());
    for (const v of this.monoVoice.values()) v.voice.kill();
    this.live.clear();
    this.monoVoice.clear();
    this.monoHeld.clear();
  }

  // ---------------- transport ----------------

  setSource(src: PlaySource): void {
    if (this.status.state !== 'stopped') this.stop();
    this.emit({ source: src });
  }

  selectScene(sceneId: string): void {
    if (this.status.state === 'stopped') this.emit({ sceneId, queuedSceneId: null });
  }

  /** From stopped: start now. While playing: queue for the next bar; tapping again cancels. */
  async launchScene(sceneId: string): Promise<void> {
    if (this.status.state === 'stopped' || this.status.state === 'suspended') {
      this.emit({ source: 'scene', sceneId });
      await this.start();
      return;
    }
    if (this.status.source !== 'scene') return;
    if (this.status.queuedSceneId === sceneId || (this.status.sceneId === sceneId && this.launchAt === null && !this.status.queuedSceneId)) {
      this.cancelQueued();
      return;
    }
    const abs = this.absTickNow();
    // Next bar boundary relative to the timeline; must not be already scheduled.
    let at = Math.ceil(Math.max(abs, 0) / TICKS_PER_BAR) * TICKS_PER_BAR;
    if (at < this.scheduledUntil) at = Math.ceil(this.scheduledUntil / TICKS_PER_BAR) * TICKS_PER_BAR;
    this.launchAt = at;
    this.emit({ queuedSceneId: sceneId });
  }

  cancelQueued(): void {
    this.launchAt = null;
    this.emit({ queuedSceneId: null });
  }

  setSilentTrack(id: string | null): void {
    this.silentTrackId = id;
  }

  /** ctx time of an abs tick on the current timeline. */
  timeOfTick(tick: number): number {
    return this.startTime + tick * this.spt;
  }

  absTickNow(): number {
    if (!this.ctx) return 0;
    return (this.ctx.currentTime - this.startTime) / this.spt;
  }

  /** Abs tick at a given ctx time (for recording). */
  tickAt(time: number): number {
    return (time - this.startTime) / this.spt;
  }
  /** Tick within the current scene segment at a ctx time. */
  sceneTickAt(time: number): number {
    return this.tickAt(time) - this.segStart;
  }

  /** Visual position (compensates for output latency). */
  position(): { abs: number; local: number; length: number } | null {
    if (!this.ctx || this.status.state === 'stopped' || this.status.state === 'suspended') return null;
    const lat = (this.ctx as any).outputLatency || this.ctx.baseLatency || 0;
    const abs = (this.ctx.currentTime - lat - this.startTime) / this.spt;
    if (this.status.source === 'song') return { abs, local: abs, length: songEndTick(this.project!) };
    const scene = this.project?.scenes[this.status.sceneId ?? ''];
    const len = (scene?.durationBars ?? 4) * TICKS_PER_BAR;
    const local = abs - this.segStart;
    return { abs, local: local < 0 ? local : local % len, length: len };
  }

  async start(opts: { countInBars?: number; atSceneStart?: boolean } = {}): Promise<boolean> {
    const ctx = await this.ensure();
    const p = this.project;
    if (!p || ctx.state !== 'running') return false;
    if (this.status.state !== 'stopped' && this.status.state !== 'suspended') this.stop();
    if (this.status.source === 'song' && p.arrangement.length === 0) return false;
    if (this.status.source === 'scene' && (!this.status.sceneId || !p.scenes[this.status.sceneId])) {
      this.emit({ sceneId: p.sceneIds[0] });
    }
    const countIn = opts.countInBars ?? 0;
    this.countInBars = countIn;
    const t0 = ctx.currentTime + 0.06;
    this.startTime = t0 + ticksToSeconds(countIn * TICKS_PER_BAR, p.bpm);
    this.scheduledUntil = -countIn * TICKS_PER_BAR;
    this.segStart = 0;
    this.launchAt = null;
    this.pendingScene = null;
    this.seqMono.clear();
    this.seqVoices = [];
    this.makeBuses();
    this.emit({ state: countIn > 0 ? 'countin' : this.recording ? 'recording' : 'playing', queuedSceneId: null });
    this.poll();
    this.timer = window.setInterval(() => this.poll(), POLL_MS);
    return true;
  }

  private makeBuses() {
    const ctx = this.ctx!;
    this.runBuses.clear();
    for (const [id, s] of this.graph!.strips) {
      const g = ctx.createGain();
      g.connect(s.input);
      this.runBuses.set(id, g);
    }
    this.clickBus = ctx.createGain();
    this.clickBus.gain.value = 0.35;
    this.clickBus.connect(ctx.destination);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const ctx = this.ctx;
    if (ctx) {
      const now = ctx.currentTime;
      // Silence everything already scheduled by fading and disconnecting the run buses.
      for (const g of [...this.runBuses.values(), ...(this.clickBus ? [this.clickBus] : [])]) {
        g.gain.cancelScheduledValues(now);
        g.gain.setTargetAtTime(0, now, 0.01);
        setTimeout(() => g.disconnect(), 120);
      }
      for (const v of this.seqVoices) v.release(now);
    }
    this.runBuses.clear();
    this.clickBus = null;
    this.seqVoices = [];
    this.seqMono.clear();
    this.launchAt = null;
    this.pendingScene = null;
    this.recording = false;
    this.releaseAllLive();
    if (this.status.state !== 'stopped') this.emit({ state: this.status.state === 'suspended' ? 'suspended' : 'stopped', queuedSceneId: null });
  }

  private poll() {
    const ctx = this.ctx;
    const p = this.project;
    if (!ctx || !p) return;
    const now = ctx.currentTime;
    const abs = (now - this.startTime) / this.spt;
    if (this.status.state === 'countin' && abs >= 0) this.emit({ state: this.recording ? 'recording' : 'playing' });
    if (this.status.state === 'playing' && this.recording) this.emit({ state: 'recording' });
    const horizon = (now + LOOKAHEAD - this.startTime) / this.spt;
    const from = this.scheduledUntil;
    const to = Math.max(from, horizon);
    if (to <= from) return;

    // Clicks: count-in always; during play when metronome is on.
    for (let b = Math.ceil(from / TPQ) * TPQ; b < to; b += TPQ) {
      if (b < 0 || this.clickWhilePlaying) this.click(this.startTime + b * this.spt, ((b % TICKS_PER_BAR) + TICKS_PER_BAR) % TICKS_PER_BAR === 0);
    }
    const a = Math.max(0, from);
    if (to > a) {
      if (this.status.source === 'song') {
        const end = songEndTick(p);
        this.scheduleEvents(expandSong(p, a, Math.min(to, end)), 0);
        if (a >= end && now > this.startTime + end * this.spt + 0.05) {
          this.scheduledUntil = to;
          this.stop();
          return;
        }
      } else {
        let segFrom = a;
        if (this.launchAt !== null && this.status.queuedSceneId && this.launchAt < to) {
          const sw = Math.max(this.launchAt, a);
          if (sw > a && this.status.sceneId) this.scheduleEvents(expandScene(p, this.status.sceneId, a - this.segStart, sw - this.segStart), this.segStart);
          this.segStart = sw;
          segFrom = sw;
          const next = this.status.queuedSceneId;
          this.launchAt = null;
          // Status flips when the launch is actually audible-ish (scheduled); good enough for UI.
          setTimeout(() => this.emit({ sceneId: next, queuedSceneId: null }), Math.max(0, (this.startTime + sw * this.spt - now) * 1000));
          this.pendingScene = next;
        }
        const sid = this.pendingScene ?? this.status.sceneId;
        if (sid) this.scheduleEvents(expandScene(p, sid, segFrom - this.segStart, to - this.segStart), this.segStart);
      }
    }
    this.scheduledUntil = to;
    // Drop finished sequence voices.
    if (this.seqVoices.length > 256) this.seqVoices = this.seqVoices.filter((v) => v.endTime > now);
  }
  private pendingScene: string | null = null;

  private scheduleEvents(events: SeqEvent[], offset: number) {
    const ctx = this.ctx!;
    const p = this.project!;
    for (const e of events) {
      if (e.trackId === this.silentTrackId) continue;
      const bus = this.runBuses.get(e.trackId) ?? this.ensureBus(e.trackId);
      const t = p.tracks[e.trackId];
      if (!bus || !t) continue;
      const when = this.startTime + (e.tick + offset) * this.spt;
      if (when < ctx.currentTime - 0.01) continue;
      if (e.kind === 'hit') playDrum(ctx, bus, t.instrumentId, e.padId, when, e.vel);
      else {
        const v = playPitched(ctx, bus, t.instrumentId, when, e.midi, e.vel);
        v.release(when + e.durTicks * this.spt);
        if (instrument(t.instrumentId).mono) {
          this.seqMono.get(e.trackId)?.release(when);
          this.seqMono.set(e.trackId, v);
        }
        this.seqVoices.push(v);
      }
    }
  }

  private ensureBus(trackId: string): GainNode | undefined {
    const s = this.graph?.strips.get(trackId);
    if (!s || !this.ctx) return;
    const g = this.ctx.createGain();
    g.connect(s.input);
    this.runBuses.set(trackId, g);
    return g;
  }

  private click(when: number, accent: boolean) {
    const ctx = this.ctx!;
    if (!this.clickBus) return;
    const o = ctx.createOscillator();
    o.frequency.value = accent ? 1760 : 1175;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(accent ? 0.9 : 0.55, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g).connect(this.clickBus);
    o.start(when);
    o.stop(when + 0.06);
  }

  /** Called by UI when the pending scene switch has become current. */
  syncPending(): void {
    if (this.pendingScene && this.status.sceneId === this.pendingScene) this.pendingScene = null;
  }

  masterLevel(): { peak: number; clip: boolean } {
    const an = this.graph?.analyser;
    if (!an) return { peak: 0, clip: false };
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    return { peak, clip: peak >= 0.99 };
  }
}

export const engine = new AudioEngine();
