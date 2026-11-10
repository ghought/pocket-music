// Offline export: same instruments, mixer graph, and sequence expansion as live playback.

import { instrument } from '../domain/catalog';
import { TICKS_PER_BAR, ticksToSeconds } from '../domain/constants';
import { songEndTick } from '../domain/ops';
import type { Project } from '../domain/types';
import { playDrum } from './drums';
import { buildGraph } from './graph';
import { playPitched, type Voice } from './instruments';
import { expandScene, expandSong } from './sequence';
import { checkRender, encodeWav, type ExportCheck } from './wav';

export const EXPORT_SAMPLE_RATE = 44100;
export const TAIL_SECONDS = 2;

export interface RenderRequest {
  source: 'scene' | 'song';
  sceneId?: string;
}

export interface RenderResult {
  wav: Blob;
  musicalSeconds: number;
  tailSeconds: number;
  check: ExportCheck;
  channels: Float32Array[];
}

export class RenderCancelled extends Error {
  constructor() {
    super('Export cancelled');
  }
}

export function renderLengthTicks(p: Project, req: RenderRequest): number {
  if (req.source === 'song') return songEndTick(p);
  const s = p.scenes[req.sceneId ?? p.sceneIds[0]];
  return (s?.durationBars ?? 4) * TICKS_PER_BAR;
}

export async function renderProject(p: Project, req: RenderRequest, onProgress: (f: number) => void, signal: AbortSignal): Promise<RenderResult> {
  const ticks = renderLengthTicks(p, req);
  if (ticks <= 0) throw new Error('Nothing to export — the song is empty.');
  const musicalSeconds = ticksToSeconds(ticks, p.bpm);
  const total = musicalSeconds + TAIL_SECONDS;
  const frames = Math.ceil(total * EXPORT_SAMPLE_RATE);
  let ctx: OfflineAudioContext;
  try {
    ctx = new OfflineAudioContext(2, frames, EXPORT_SAMPLE_RATE);
  } catch (e) {
    throw new Error('Not enough memory to prepare the export. Try exporting a single scene.');
  }
  const graph = buildGraph(ctx, ctx.destination, false);
  graph.sync(p, false);

  const events = req.source === 'song' ? expandSong(p, 0, ticks) : expandScene(p, req.sceneId ?? p.sceneIds[0], 0, ticks);
  const spt = ticksToSeconds(1, p.bpm);
  const mono = new Map<string, Voice>();
  const start = 0.0;
  for (const e of events) {
    const t = p.tracks[e.trackId];
    const strip = graph.strips.get(e.trackId);
    if (!t || !strip) continue;
    const when = start + e.tick * spt;
    if (e.kind === 'hit') playDrum(ctx, strip.input, t.instrumentId, e.padId, when, e.vel);
    else {
      const v = playPitched(ctx, strip.input, t.instrumentId, when, e.midi, e.vel);
      v.release(when + e.durTicks * spt);
      if (instrument(t.instrumentId).mono) {
        mono.get(e.trackId)?.release(when);
        mono.set(e.trackId, v);
      }
    }
  }

  // Progress + cancellation via suspend checkpoints (where supported).
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
  };
  signal.addEventListener('abort', onAbort);
  const step = Math.max(0.5, total / 20);
  for (let t = step; t < total; t += step) {
    const at = t;
    try {
      ctx.suspend(at).then(() => {
        onProgress(at / total);
        if (!cancelled) ctx.resume();
      });
    } catch {
      break;
    }
  }
  const rendering = ctx.startRendering();
  const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
    rendering.then(resolve, reject);
    signal.addEventListener('abort', () => reject(new RenderCancelled()));
  });
  signal.removeEventListener('abort', onAbort);
  onProgress(1);

  const channels = [buffer.getChannelData(0).slice(), buffer.getChannelData(1).slice()];
  // Output protection: keep a little headroom if the limiter let a transient through.
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak > 0.97) {
    const g = 0.97 / peak;
    for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  }
  const check = checkRender(channels);
  if (!check.ok) throw new Error(`Export failed verification: ${check.problems.join(', ')}`);
  const wav = new Blob([encodeWav(channels, EXPORT_SAMPLE_RATE)], { type: 'audio/wav' });
  return { wav, musicalSeconds, tailSeconds: TAIL_SECONDS, check, channels };
}

export function sanitizeFilename(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return s || 'pocket-music-sketch';
}
