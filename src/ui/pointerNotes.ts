// Multitouch performance surface handling: separate pointer identities, pointer capture,
// glide between keys, and guaranteed release on up / cancel / lost capture / unmount.

import { useEffect, useRef } from 'react';

export interface SurfaceHandlers {
  /** Element attribute holding the target id (e.g. data-note="60"). */
  attr: string;
  down(target: string, pointerId: number, el: HTMLElement): void;
  up(target: string, pointerId: number, el: HTMLElement | null): void;
  /** Allow sliding from one target to the next (keys) — drums don't glide. */
  glide?: boolean;
}

export function usePointerSurface(h: SurfaceHandlers) {
  const ref = useRef<HTMLDivElement>(null);
  const handlers = useRef(h);
  handlers.current = h;
  const active = useRef(new Map<number, { target: string; el: HTMLElement }>());

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const findTarget = (x: number, y: number): HTMLElement | null => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const t = el?.closest(`[${handlers.current.attr}]`) as HTMLElement | null;
      return t && root.contains(t) ? t : null;
    };
    const release = (pid: number) => {
      const cur = active.current.get(pid);
      if (!cur) return;
      active.current.delete(pid);
      cur.el.classList.remove('active');
      handlers.current.up(cur.target, pid, cur.el);
    };
    const press = (pid: number, el: HTMLElement) => {
      const target = el.getAttribute(handlers.current.attr)!;
      active.current.set(pid, { target, el });
      el.classList.add('active');
      handlers.current.down(target, pid, el);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button > 0) return;
      const el = (e.target as HTMLElement).closest(`[${handlers.current.attr}]`) as HTMLElement | null;
      if (!el || !root.contains(el) || el.hasAttribute('disabled')) return;
      e.preventDefault();
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      release(e.pointerId);
      press(e.pointerId, el);
    };
    const onMove = (e: PointerEvent) => {
      if (!handlers.current.glide) return;
      const cur = active.current.get(e.pointerId);
      if (!cur) return;
      const el = findTarget(e.clientX, e.clientY);
      if (!el) {
        // Moving off the keys releases the note.
        release(e.pointerId);
        return;
      }
      if (el !== cur.el) {
        release(e.pointerId);
        press(e.pointerId, el);
      }
    };
    const onUp = (e: PointerEvent) => release(e.pointerId);
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onUp);
    root.addEventListener('lostpointercapture', onUp);
    const releaseAll = () => [...active.current.keys()].forEach(release);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', releaseAll);
    const ctx = (e: Event) => e.preventDefault();
    root.addEventListener('contextmenu', ctx);
    return () => {
      releaseAll();
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onUp);
      root.removeEventListener('lostpointercapture', onUp);
      root.removeEventListener('contextmenu', ctx);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', releaseAll);
    };
  }, []);
  return ref;
}

/** Flash an element's pressed state (for keyboard-triggered hits). */
export function flash(el: Element | null | undefined) {
  if (!el) return;
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 110);
}
