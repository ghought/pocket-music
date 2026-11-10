import { useEffect, useRef, useState, type ReactNode } from 'react';

export function Sheet({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label, small }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string; small?: boolean }) {
  return (
    <div className={`segmented ${small ? 'small' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} title={o.title}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Knob with an accessible slider underneath: vertical drag, arrow keys, or the visible value field.
 * No circular dragging required.
 */
export function Knob({ label, value, min, max, step, onChange, format, color }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string; color?: string }) {
  const start = useRef<{ y: number; v: number } | null>(null);
  const frac = (value - min) / (max - min);
  const angle = -135 + frac * 270;
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <div className="knob-wrap">
      <div
        className="knob"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format ? format(value) : String(value)}
        style={{ ['--knob-color' as string]: color ?? 'var(--accent)', ['--angle' as string]: `${angle}deg`, ['--frac' as string]: frac }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          start.current = { y: e.clientY, v: value };
        }}
        onPointerMove={(e) => {
          if (!start.current) return;
          const dy = start.current.y - e.clientY;
          onChange(clamp(start.current.v + (dy / 150) * (max - min)));
        }}
        onPointerUp={() => (start.current = null)}
        onPointerCancel={() => (start.current = null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(clamp(value + step));
          else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(clamp(value - step));
          else return;
          e.preventDefault();
        }}
      >
        <div className="knob-cap">
          <div className="knob-pointer" />
        </div>
      </div>
      <div className="knob-label">{label}</div>
      <div className="knob-value">{format ? format(value) : value}</div>
    </div>
  );
}

export function Slider({ label, value, min, max, step, onChange, format, vertical }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string; vertical?: boolean }) {
  return (
    <label className={`slider ${vertical ? 'vertical' : ''}`}>
      <span className="slider-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-valuetext={format ? format(value) : undefined} />
      <span className="slider-value">{format ? format(value) : value}</span>
    </label>
  );
}

export function Confirm({ text, confirmLabel, onConfirm, onCancel, danger }: { text: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void; danger?: boolean }) {
  return (
    <Sheet title="Are you sure?" onClose={onCancel}>
      <p>{text}</p>
      <div className="row gap end">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Sheet>
  );
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}

export function useRaf(fn: () => void, active = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const loop = () => {
      ref.current();
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [active]);
}

export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}
