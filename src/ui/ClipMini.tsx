import { memo } from 'react';
import { ALL_PADS } from '../domain/catalog';
import { effectiveDrums, effectivePitched } from '../domain/ops';
import type { Clip } from '../domain/types';

/** Readable clip miniature. `repeatTo` draws the clip looped across a longer span (song blocks). */
export const ClipMini = memo(function ClipMini({ clip, color, repeatTo }: { clip: Clip; color: string; repeatTo?: number }) {
  const span = repeatTo ?? clip.lengthTicks;
  const reps = Math.ceil(span / clip.lengthTicks);
  if (clip.kind === 'pitched') {
    const ev = effectivePitched(clip);
    if (!ev.length) return <div className="mini empty">empty</div>;
    const lo = Math.min(...ev.map((e) => e.midiPitch)) - 1;
    const hi = Math.max(...ev.map((e) => e.midiPitch)) + 1;
    const range = Math.max(6, hi - lo);
    return (
      <svg className="mini" viewBox={`0 0 ${span} 100`} preserveAspectRatio="none" aria-hidden>
        {Array.from({ length: reps }, (_, r) =>
          ev.map((e) => {
            const x = r * clip.lengthTicks + e.startTick;
            if (x >= span) return null;
            return <rect key={`${r}-${e.id}`} x={x} y={100 - ((e.midiPitch - lo + 1) / (range + 1)) * 100} width={Math.max(30, Math.min(e.durationTicks, span - x))} height={100 / (range + 1) + 2} fill={color} opacity={r ? 0.6 : 1} rx={20} />;
          }),
        )}
      </svg>
    );
  }
  const ev = effectiveDrums(clip);
  if (!ev.length) return <div className="mini empty">empty</div>;
  const rows = ALL_PADS.map((p) => p.id);
  return (
    <svg className="mini" viewBox={`0 0 ${span} 100`} preserveAspectRatio="none" aria-hidden>
      {Array.from({ length: reps }, (_, r) =>
        ev.map((e) => {
          const x = r * clip.lengthTicks + e.startTick;
          if (x >= span) return null;
          const row = rows.indexOf(e.padId);
          return <rect key={`${r}-${e.id}`} x={x} y={(row / 16) * 100} width={60} height={100 / 16 + 1} fill={color} opacity={(e.velocity / 127) * (r ? 0.6 : 1)} />;
        }),
      )}
    </svg>
  );
});
