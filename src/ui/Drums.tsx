import { useEffect, useRef } from 'react';
import { engine } from '../audio/engine';
import { ALL_PADS, ALT_PADS, KIT_PADS, pad } from '../domain/catalog';
import type { Track } from '../domain/types';
import { store, useStore } from '../state/store';
import { flash, usePointerSurface } from './pointerNotes';
import { isTypingTarget, Segmented } from './widgets';

function useDrumKeys(trackId: string, root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const p = ALL_PADS.find((x) => x.key === e.key.toLowerCase());
      if (!p) return;
      engine.unlock();
      // Shift = accent.
      engine.hit(trackId, p.id, e.shiftKey ? 127 : p.velocity);
      flash(root.current?.querySelector(`[data-pad="${p.id}"]`));
      e.preventDefault();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [trackId, root]);
}

export function DrumSurface({ track }: { track: Track }) {
  const surface = useStore((s) => s.drumSurface);
  const ref = usePointerSurface({
    attr: 'data-pad',
    glide: false,
    down: (id) => engine.hit(track.id, id, pad(id)?.velocity ?? 100),
    up: () => {},
  });
  useDrumKeys(track.id, ref);
  return (
    <div className="surface-col">
      <div className="surface-tools">
        <Segmented
          label="Drum surface"
          value={surface}
          onChange={(v) => store.set({ drumSurface: v })}
          options={[
            { value: 'kit', label: 'Kit' },
            { value: 'pads', label: 'Pads' },
          ]}
        />
        <span className="muted small desktop-only">Keys A–K kit, Q–I alternates, Shift = accent</span>
      </div>
      {surface === 'kit' ? (
        <div className="kit perform" ref={ref}>
          {KIT_PADS.map((p) => (
            <div key={p.id} className={`zone zone-${p.id}`} data-pad={p.id} role="button" aria-label={p.label}>
              <span>{p.label}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="pad-grid drums perform" ref={ref}>
          {[...KIT_PADS, ...ALT_PADS].map((p, i) => (
            <div key={p.id} className={`pad drum-pad ${i < 8 ? 'main' : 'alt'}`} data-pad={p.id} role="button" aria-label={p.label}>
              <strong>{p.short}</strong>
              <span>{p.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function useStableRef<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}
