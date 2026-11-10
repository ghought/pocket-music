// Serializable musical data. All musical time is integer ticks (960 per quarter note).
// Original source audio timing stays in seconds.

export const SCHEMA_VERSION = 1;

export type KeyMode = 'major' | 'minor';
export type TrackType = 'pitched' | 'drum';
export type ClipBars = 1 | 2 | 4 | 8;

export interface QuantizeSettings {
  /** Grid in ticks (240 = 1/16 note). */
  gridTicks: number;
  /** 0..1 correction strength. 0 = original timing. */
  strength: number;
}

export interface EffectParameters {
  /** 0..1, 0.5 neutral. Lower = darker, higher = brighter. */
  tone: number;
  /** 0..1 reverb send. */
  space: number;
}

export interface PitchedEvent {
  id: string;
  startTick: number;
  durationTicks: number;
  midiPitch: number;
  velocity: number; // 1..127
  sourceSeconds?: number;
  sourceDurationSeconds?: number;
  /** Set by the transcriber when pitch was unstable over the note. Never a fabricated percentage. */
  uncertain?: boolean;
}

export interface DrumEvent {
  id: string;
  startTick: number;
  padId: string;
  velocity: number;
}

export type ClipEvent = PitchedEvent | DrumEvent;

interface ClipBase {
  id: string;
  trackId: string;
  name: string;
  lengthTicks: number;
  quantize: QuantizeSettings;
}

export interface PitchedClip extends ClipBase {
  kind: 'pitched';
  /** Events exactly as performed or as detected by analysis. Never modified by edits or quantization. */
  rawEvents: PitchedEvent[];
  /** Editable working copy in unquantized time. Playback = quantize(editedEvents). */
  editedEvents: PitchedEvent[];
  sourceTakeId?: string;
  trimOriginSeconds?: number;
}

export interface DrumClip extends ClipBase {
  kind: 'drum';
  rawEvents: DrumEvent[];
  editedEvents: DrumEvent[];
}

export type Clip = PitchedClip | DrumClip;

export interface Track {
  id: string;
  type: TrackType;
  instrumentId: string;
  instrumentVersion: number;
  name: string;
  color: string;
  icon: string;
  gainDb: number;
  pan: number; // -1..1
  mute: boolean;
  solo: boolean;
  effects: EffectParameters;
}

export interface Scene {
  id: string;
  name: string;
  durationBars: ClipBars;
  clipByTrackId: Record<string, string | undefined>;
}

export interface ArrangementInstance {
  id: string;
  trackId: string;
  clipId: string;
  startTick: number;
  durationTicks: number;
  sourceOffsetTicks: 0;
}

export interface SourceTake {
  id: string;
  blobKey: string;
  mimeType: string;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  captureBpm: number | null;
  captureOffsetSeconds: number;
  incomplete: boolean;
  createdAt: number;
}

export interface AssetManifestEntry {
  id: string;
  kind: 'take';
  version: number;
  hash: string;
  byteLength: number;
  localBlobKey: string;
  licenseReference: string;
}

export interface Project {
  id: string;
  schemaVersion: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  bpm: number;
  meter: '4/4';
  keyRoot?: number; // 0..11 pitch class
  keyMode?: KeyMode;
  trackIds: string[];
  tracks: Record<string, Track>;
  clips: Record<string, Clip>;
  sceneIds: string[];
  scenes: Record<string, Scene>;
  arrangement: ArrangementInstance[];
  takes: Record<string, SourceTake>;
  assetManifest: AssetManifestEntry[];
  /** Small per-project preferences. */
  settings: { countInBars: 0 | 1; metronome: boolean; recordingOffsetMs: number };
}

export interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: number;
  trackCount: number;
  bpm: number;
}
