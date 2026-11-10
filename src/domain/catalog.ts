// Instrument and pad catalog shared by UI, live engine, and offline export.

export interface InstrumentDef {
  id: string;
  version: number;
  name: string;
  kind: 'pitched' | 'drum';
  mono?: boolean;
  defaultOctave: number; // MIDI note of the leftmost key on the keyboard
  defaults: { gainDb: number; tone: number; space: number };
}

export const INSTRUMENTS: InstrumentDef[] = [
  { id: 'piano', version: 1, name: 'Piano', kind: 'pitched', defaultOctave: 60, defaults: { gainDb: -4, tone: 0.5, space: 0.25 } },
  { id: 'warm', version: 1, name: 'Warm Synth', kind: 'pitched', defaultOctave: 60, defaults: { gainDb: -7, tone: 0.5, space: 0.3 } },
  { id: 'pluck', version: 1, name: 'Pluck', kind: 'pitched', defaultOctave: 60, defaults: { gainDb: -6, tone: 0.55, space: 0.3 } },
  { id: 'bass', version: 1, name: 'Bass', kind: 'pitched', mono: true, defaultOctave: 36, defaults: { gainDb: -5, tone: 0.45, space: 0 } },
  { id: 'kit-studio', version: 1, name: 'Studio Kit', kind: 'drum', defaultOctave: 0, defaults: { gainDb: -3, tone: 0.5, space: 0.15 } },
  { id: 'kit-electro', version: 1, name: 'Electro Kit', kind: 'drum', defaultOctave: 0, defaults: { gainDb: -3, tone: 0.5, space: 0.1 } },
];

export function instrument(id: string): InstrumentDef {
  return INSTRUMENTS.find((i) => i.id === id) ?? INSTRUMENTS[0];
}
export const PITCHED_INSTRUMENTS = INSTRUMENTS.filter((i) => i.kind === 'pitched');
export const DRUM_KITS = INSTRUMENTS.filter((i) => i.kind === 'drum');

export interface PadDef {
  id: string;
  label: string;
  short: string;
  velocity: number;
  /** Desktop keyboard shortcut. */
  key: string;
}

/** The eight kit sounds (pad rows 1–2 and kit zones). */
export const KIT_PADS: PadDef[] = [
  { id: 'kick', label: 'Kick', short: 'KICK', velocity: 110, key: 'a' },
  { id: 'snare', label: 'Snare', short: 'SNR', velocity: 105, key: 's' },
  { id: 'chh', label: 'Closed hat', short: 'HAT', velocity: 90, key: 'd' },
  { id: 'ohh', label: 'Open hat', short: 'OPEN', velocity: 90, key: 'f' },
  { id: 'tomL', label: 'Low tom', short: 'LTOM', velocity: 100, key: 'g' },
  { id: 'tomH', label: 'High tom', short: 'HTOM', velocity: 100, key: 'h' },
  { id: 'crash', label: 'Crash', short: 'CRSH', velocity: 95, key: 'j' },
  { id: 'clap', label: 'Clap', short: 'CLAP', velocity: 100, key: 'k' },
];

/** Alternate hits on pad rows 3–4. */
export const ALT_PADS: PadDef[] = [
  { id: 'rim', label: 'Rim', short: 'RIM', velocity: 95, key: 'q' },
  { id: 'cowbell', label: 'Cowbell', short: 'BELL', velocity: 90, key: 'w' },
  { id: 'shaker', label: 'Shaker', short: 'SHKR', velocity: 85, key: 'e' },
  { id: 'congaL', label: 'Low conga', short: 'CNG L', velocity: 95, key: 'r' },
  { id: 'congaH', label: 'High conga', short: 'CNG H', velocity: 95, key: 't' },
  { id: 'ride', label: 'Ride', short: 'RIDE', velocity: 90, key: 'y' },
  { id: 'snap', label: 'Snap', short: 'SNAP', velocity: 95, key: 'u' },
  { id: 'tomF', label: 'Floor tom', short: 'FTOM', velocity: 100, key: 'i' },
];
export const ALL_PADS = [...KIT_PADS, ...ALT_PADS];
export function pad(id: string): PadDef | undefined {
  return ALL_PADS.find((p) => p.id === id);
}
