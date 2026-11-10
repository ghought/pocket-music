import type { DrumEvent, PitchedEvent, QuantizeSettings } from './types';

/**
 * Nearest grid onset. Ties resolve toward the earlier grid point.
 */
export function nearestGrid(tick: number, grid: number): number {
  const lower = Math.floor(tick / grid) * grid;
  const upper = lower + grid;
  return tick - lower <= upper - tick ? lower : upper;
}

/** effective = raw + strength × (nearestGrid − raw), clamped into [0, lengthTicks-1]. */
export function quantizeTick(raw: number, q: QuantizeSettings, lengthTicks: number): number {
  const s = Math.min(1, Math.max(0, q.strength));
  const target = nearestGrid(raw, q.gridTicks);
  const eff = Math.round(raw + s * (target - raw));
  return Math.min(Math.max(0, eff), Math.max(0, lengthTicks - 1));
}

export function quantizePitched(events: PitchedEvent[], q: QuantizeSettings, lengthTicks: number): PitchedEvent[] {
  return events
    .map((e) => {
      const start = quantizeTick(e.startTick, q, lengthTicks);
      // Quantize the end too, so lengths tighten with the grid, but keep >= 1 tick.
      const rawEnd = e.startTick + e.durationTicks;
      const endTarget = nearestGrid(rawEnd, q.gridTicks);
      const s = Math.min(1, Math.max(0, q.strength));
      let end = Math.round(rawEnd + s * (endTarget - rawEnd));
      end = Math.min(end, lengthTicks);
      const duration = Math.max(1, end - start);
      return { ...e, startTick: start, durationTicks: Math.min(duration, Math.max(1, lengthTicks - start)) };
    })
    .sort((a, b) => a.startTick - b.startTick || a.midiPitch - b.midiPitch);
}

/** Drum hits on the same pad that land on the same tick merge, keeping the higher velocity. */
export function quantizeDrums(events: DrumEvent[], q: QuantizeSettings, lengthTicks: number): DrumEvent[] {
  const byKey = new Map<string, DrumEvent>();
  for (const e of events) {
    const start = quantizeTick(e.startTick, q, lengthTicks);
    const key = `${e.padId}@${start}`;
    const prev = byKey.get(key);
    if (!prev || e.velocity > prev.velocity || (e.velocity === prev.velocity && e.id < prev.id)) {
      byKey.set(key, { ...e, startTick: start });
    }
  }
  return [...byKey.values()].sort((a, b) => a.startTick - b.startTick || a.padId.localeCompare(b.padId));
}
