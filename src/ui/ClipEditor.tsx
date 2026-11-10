import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { ALT_PADS, KIT_PADS } from '../domain/catalog';
import { CLIP_BAR_OPTIONS, SIXTEENTH, TICKS_PER_BAR, TPQ } from '../domain/constants';
import { inScale, keyLabel, noteName, snapToScale } from '../domain/music';
import { effectiveDrums, effectivePitched, instancesOfClip, makeUnique, uid } from '../domain/ops';
import { nearestGrid } from '../domain/quantize';
import type { Clip, ClipBars, DrumClip, PitchedClip, PitchedEvent, Project, Track } from '../domain/types';
import { store, useStore } from '../state/store';
import { Segmented, Slider, useMediaQuery } from './widgets';

function QuantizeBar({ clip }: { clip: Clip }) {
  const s = clip.quantize.strength;
  const [adv, setAdv] = useState(false);
  const set = (fn: (c: Clip) => void, coalesce?: string) => store.commit((d) => fn(d.clips[clip.id]), { coalesce });
  return (
    <div className="editor-row">
      <span className="muted small">Timing</span>
      <Segmented
        small
        label="Timing correction"
        value={s === 0 ? 'off' : s === 0.5 ? 'gentle' : s === 1 ? 'tight' : 'custom'}
        onChange={(v) => set((c) => void (c.quantize.strength = v === 'off' ? 0 : v === 'gentle' ? 0.5 : 1))}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'gentle', label: 'Gentle' },
          { value: 'tight', label: 'Tight' },
          ...(s !== 0 && s !== 0.5 && s !== 1 ? [{ value: 'custom' as const, label: `${Math.round(s * 100)}%` }] : []),
        ]}
      />
      <button className="btn small" onClick={() => setAdv(!adv)} aria-expanded={adv}>
        {adv ? 'Less' : 'More'}
      </button>
      {adv && (
        <>
          <Slider label="Strength" value={Math.round(s * 100)} min={0} max={100} step={5} format={(v) => `${v}%`} onChange={(v) => set((c) => void (c.quantize.strength = v / 100), `qs:${clip.id}`)} />
          <Segmented
            small
            label="Grid"
            value={clip.quantize.gridTicks}
            onChange={(g) => set((c) => void (c.quantize.gridTicks = g))}
            options={[
              { value: SIXTEENTH, label: '1/16' },
              { value: SIXTEENTH * 2, label: '1/8' },
              { value: TPQ, label: '1/4' },
            ]}
          />
          <button
            className="btn small"
            title="Restore the performance exactly as played or detected"
            onClick={() =>
              set((c) => {
                c.editedEvents = JSON.parse(JSON.stringify(c.rawEvents));
                c.quantize.strength = 0;
              })
            }
          >
            Restore original
          </button>
        </>
      )}
    </div>
  );
}

export function ClipEditor({ clipId, project }: { clipId: string; project: Project }) {
  const clip = project.clips[clipId];
  const track = clip ? project.tracks[clip.trackId] : undefined;
  const selectedInstanceId = useStore((s) => s.selectedInstanceId);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.set({ editingClipId: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!clip || !track) return null;
  const uses = instancesOfClip(project, clip.id);
  const instance = selectedInstanceId ? project.arrangement.find((a) => a.id === selectedInstanceId && a.clipId === clip.id) : undefined;
  const bars = clip.lengthTicks / TICKS_PER_BAR;
  const setLength = (b: ClipBars) => {
    const len = b * TICKS_PER_BAR;
    const beyond = clip.editedEvents.filter((e) => e.startTick >= len).length + clip.rawEvents.filter((e) => e.startTick >= len).length;
    store.commit((d) => {
      const c = d.clips[clip.id];
      if (beyond) return `${beyond} event${beyond > 1 ? 's are' : ' is'} after bar ${b}. Delete or move them before shortening the clip.`;
      c.lengthTicks = len;
    });
  };
  return (
    <div className="editor-overlay" role="dialog" aria-modal="true" aria-label={`Edit ${clip.name}`} tabIndex={-1} ref={ref}>
      <div className="editor-head" style={{ ['--track' as string]: track.color }}>
        <span className="track-dot" />
        <input
          className="title-input"
          aria-label="Clip name"
          value={clip.name}
          onChange={(e) =>
            store.commit((d) => {
              d.clips[clip.id].name = e.target.value.slice(0, 60);
            }, { coalesce: `name:${clip.id}` })
          }
        />
        <Segmented small label="Clip length (bars)" value={bars as ClipBars} onChange={setLength} options={CLIP_BAR_OPTIONS.map((b) => ({ value: b, label: `${b} bar${b > 1 ? 's' : ''}` }))} />
        <button className="btn primary" onClick={() => store.set({ editingClipId: null })}>
          Done
        </button>
      </div>
      {uses.length > 0 && (
        <div className="editor-banner">
          🔗 Used {uses.length}× in the Song — edits here change every use.
          {instance && uses.length > 1 && (
            <button
              className="btn small"
              onClick={() => {
                let newId = '';
                store.commit((d) => {
                  const c = makeUnique(d, instance.id);
                  if (c) newId = c.id;
                });
                if (newId) store.set({ editingClipId: newId });
              }}
            >
              Make this one unique
            </button>
          )}
        </div>
      )}
      <QuantizeBar clip={clip} />
      {clip.kind === 'pitched' ? <PianoRoll clip={clip} track={track} project={project} /> : <StepEditor clip={clip} track={track} />}
    </div>
  );
}

// ---------------- Pitched note editor ----------------

type Drag = { mode: 'move' | 'resize'; id: string; x0: number; y0: number; dt: number; dp: number };

function PianoRoll({ clip, track, project }: { clip: PitchedClip; track: Track; project: Project }) {
  const phone = useMediaQuery('(max-width: 700px)');
  const [zoom, setZoom] = useState(phone ? 14 : 22); // px per 1/16
  const [grid, setGrid] = useState(SIXTEENTH);
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [scalePreview, setScalePreview] = useState(false);
  const lastLen = useRef(SIXTEENTH * 2);
  const rowH = 22;
  const eff = useMemo(() => effectivePitched(clip), [clip]);
  const effById = useMemo(() => new Map(eff.map((e) => [e.id, e])), [eff]);
  const pitches = eff.map((e) => e.midiPitch);
  const center = pitches.length ? Math.round((Math.min(...pitches) + Math.max(...pitches)) / 2) : store.octaveFor(track.id) + 7;
  const [range] = useState(() => {
    const lo = Math.min(center - 12, ...(pitches.length ? [Math.min(...pitches) - 4] : []));
    const hi = Math.max(center + 12, ...(pitches.length ? [Math.max(...pitches) + 4] : []));
    return { lo: Math.max(21, lo), hi: Math.min(108, hi) };
  });
  const rows = range.hi - range.lo + 1;
  const pxPerTick = zoom / SIXTEENTH;
  const width = clip.lengthTicks * pxPerTick;
  const hasKey = project.keyRoot !== undefined && !!project.keyMode;
  const take = clip.sourceTakeId ? project.takes[clip.sourceTakeId] : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Center the melody vertically on open.
    const el = scrollRef.current;
    if (el) el.scrollTop = (range.hi - center) * rowH - el.clientHeight / 2;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const corrections = useMemo(() => {
    if (!hasKey) return new Map<string, number>();
    const m = new Map<string, number>();
    for (const e of clip.editedEvents) {
      const s = snapToScale(e.midiPitch, project.keyRoot!, project.keyMode!);
      if (s !== e.midiPitch) m.set(e.id, s);
    }
    return m;
  }, [clip.editedEvents, hasKey, project.keyRoot, project.keyMode]);

  const edit = (fn: (evs: PitchedEvent[], c: PitchedClip) => void, coalesce?: string) =>
    store.commit((d) => {
      const c = d.clips[clip.id] as PitchedClip;
      fn(c.editedEvents, c);
    }, { coalesce });

  /** Set a note's position from its effective (displayed) location. */
  const placeAt = (ev: PitchedEvent, start: number, dur: number, pitch: number) => {
    ev.startTick = Math.max(0, Math.min(clip.lengthTicks - 1, start));
    ev.durationTicks = Math.max(1, Math.min(dur, clip.lengthTicks - ev.startTick));
    ev.midiPitch = Math.max(0, Math.min(127, pitch));
    ev.sourceSeconds = undefined;
    ev.uncertain = undefined;
  };

  const onGridDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const tick = Math.floor((e.clientX - r.left) / pxPerTick / grid) * grid;
    const pitch = range.hi - Math.floor((e.clientY - r.top) / rowH);
    if (tick < 0 || tick >= clip.lengthTicks) return;
    if (sel) {
      setSel(null); // first tap on empty space deselects
      return;
    }
    const id = uid('n');
    edit((evs) => void evs.push({ id, startTick: tick, durationTicks: Math.min(lastLen.current, clip.lengthTicks - tick), midiPitch: pitch, velocity: 96 }));
    setSel(id);
    engine.preview(track.id, pitch);
  };

  const onNoteDown = (e: React.PointerEvent, id: string, mode: 'move' | 'resize') => {
    e.stopPropagation();
    const ev = effById.get(id);
    if (!ev) return;
    if (sel !== id) {
      setSel(id);
      engine.preview(track.id, ev.midiPitch);
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ mode, id, x0: e.clientX, y0: e.clientY, dt: 0, dp: 0 });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const dt = Math.round((e.clientX - drag.x0) / pxPerTick / grid) * grid;
    const dp = drag.mode === 'move' ? -Math.round((e.clientY - drag.y0) / rowH) : 0;
    if (dt !== drag.dt || dp !== drag.dp) {
      if (dp !== drag.dp) {
        const ev = effById.get(drag.id);
        if (ev) engine.preview(track.id, ev.midiPitch + dp, 80, 0.15);
      }
      setDrag({ ...drag, dt, dp });
    }
  };
  const onUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.dt && !d.dp) return;
    const ev = effById.get(d.id);
    if (!ev) return;
    edit((evs) => {
      const target = evs.find((x) => x.id === d.id);
      if (!target) return;
      if (d.mode === 'move') placeAt(target, nearestGrid(ev.startTick, grid) + d.dt, ev.durationTicks, ev.midiPitch + d.dp);
      else {
        const dur = Math.max(grid, ev.durationTicks + d.dt);
        placeAt(target, ev.startTick, dur, ev.midiPitch);
        lastLen.current = dur;
      }
    });
  };

  const selEv = sel ? effById.get(sel) : undefined;
  const nudge = (dt: number, dp: number, dl = 0) => {
    if (!selEv) return;
    edit((evs) => {
      const t = evs.find((x) => x.id === selEv.id);
      if (!t) return;
      placeAt(t, selEv.startTick + dt, Math.max(grid, selEv.durationTicks + dl), selEv.midiPitch + dp);
    });
    if (dp) engine.preview(track.id, selEv.midiPitch + dp, 90, 0.2);
  };
  const del = () => {
    if (!sel) return;
    edit((evs) => {
      const i = evs.findIndex((x) => x.id === sel);
      if (i >= 0) evs.splice(i, 1);
    });
    setSel(null);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (!sel) return;
      const map: Record<string, () => void> = {
        Delete: del,
        Backspace: del,
        ArrowLeft: () => nudge(-grid, 0),
        ArrowRight: () => nudge(grid, 0),
        ArrowUp: () => nudge(0, e.shiftKey ? 12 : 1),
        ArrowDown: () => nudge(0, e.shiftKey ? -12 : -1),
      };
      const f = map[e.key];
      if (f) {
        e.preventDefault();
        f();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  return (
    <>
      <div className="editor-row">
        {take && (
          <button className="btn small" onClick={() => void store.playTake(take.id, clip.trimOriginSeconds ?? 0)}>
            ▶ Original take
          </button>
        )}
        <Segmented
          small
          label="Edit grid"
          value={grid}
          onChange={setGrid}
          options={[
            { value: SIXTEENTH, label: '1/16' },
            { value: SIXTEENTH * 2, label: '1/8' },
            { value: TPQ, label: '1/4' },
          ]}
        />
        <button className="btn small" onClick={() => setZoom(Math.max(8, zoom - 4))} aria-label="Zoom out">
          −
        </button>
        <button className="btn small" onClick={() => setZoom(Math.min(48, zoom + 4))} aria-label="Zoom in">
          +
        </button>
        {hasKey ? (
          corrections.size > 0 ? (
            <button className={`btn small ${scalePreview ? 'lit' : ''}`} onClick={() => setScalePreview(!scalePreview)}>
              Fit to {keyLabel(project.keyRoot, project.keyMode)}…
            </button>
          ) : (
            <span className="muted small">All notes in {keyLabel(project.keyRoot, project.keyMode)}</span>
          )
        ) : (
          <button className="btn small" onClick={() => store.openSheet('key')}>
            Set key for scale help
          </button>
        )}
      </div>
      {scalePreview && corrections.size > 0 && (
        <div className="editor-banner">
          {corrections.size} note{corrections.size > 1 ? 's' : ''} would move to the nearest note in {keyLabel(project.keyRoot, project.keyMode)} (shown outlined).
          <button
            className="btn small primary"
            onClick={() => {
              edit((evs) => evs.forEach((e) => corrections.has(e.id) && (e.midiPitch = corrections.get(e.id)!)));
              setScalePreview(false);
            }}
          >
            Apply
          </button>
          <button className="btn small" onClick={() => setScalePreview(false)}>
            Cancel
          </button>
        </div>
      )}
      <div className="roll-scroll" ref={scrollRef}>
        <div className="roll" style={{ height: rows * rowH }}>
          <div className="roll-keys">
            {Array.from({ length: rows }, (_, i) => {
              const m = range.hi - i;
              const out = hasKey && !inScale(m, project.keyRoot!, project.keyMode!);
              return (
                <div key={m} className={`roll-key ${[1, 3, 6, 8, 10].includes(m % 12) ? 'black' : ''} ${out ? 'out' : ''}`} style={{ height: rowH }} onPointerDown={() => engine.preview(track.id, m)}>
                  {m % 12 === 0 || rowH >= 20 ? noteName(m) : ''}
                </div>
              );
            })}
          </div>
          <div
            className="roll-grid"
            style={{ width, ['--px16' as string]: `${zoom}px`, ['--rowh' as string]: `${rowH}px`, ['--bar' as string]: `${zoom * 16}px`, ['--track' as string]: track.color }}
            onPointerDown={onGridDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => setDrag(null)}
          >
            {hasKey &&
              Array.from({ length: rows }, (_, i) => (!inScale(range.hi - i, project.keyRoot!, project.keyMode!) ? <div key={i} className="roll-out" style={{ top: i * rowH, height: rowH }} /> : null))}
            {eff.map((e) => {
              const isDrag = drag?.id === e.id;
              const start = isDrag && drag.mode === 'move' ? nearestGrid(e.startTick, grid) + drag.dt : e.startTick;
              const dur = isDrag && drag.mode === 'resize' ? Math.max(grid, e.durationTicks + drag.dt) : e.durationTicks;
              const pitch = isDrag ? e.midiPitch + drag.dp : e.midiPitch;
              if (pitch < range.lo || pitch > range.hi) return null;
              return (
                <div
                  key={e.id}
                  className={`note ${sel === e.id ? 'sel' : ''} ${e.uncertain ? 'uncertain' : ''} ${scalePreview && corrections.has(e.id) ? 'fix' : ''}`}
                  style={{ left: start * pxPerTick, top: (range.hi - pitch) * rowH + 1, width: Math.max(6, dur * pxPerTick - 1), height: rowH - 2, opacity: 0.45 + (e.velocity / 127) * 0.55 }}
                  onPointerDown={(ev) => onNoteDown(ev, e.id, 'move')}
                  role="button"
                  aria-label={`${noteName(e.midiPitch)} at beat ${(e.startTick / TPQ + 1).toFixed(2)}${e.uncertain ? ', uncertain pitch' : ''}`}
                >
                  {sel === e.id && <div className="note-handle" onPointerDown={(ev) => onNoteDown(ev, e.id, 'resize')} aria-label="Change length" />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="editor-row tools">
        {selEv ? (
          <>
            <span className="mono">{noteName(selEv.midiPitch)}</span>
            <button className="btn small" onClick={() => nudge(-grid, 0)} aria-label="Earlier">
              ◀
            </button>
            <button className="btn small" onClick={() => nudge(grid, 0)} aria-label="Later">
              ▶
            </button>
            <button className="btn small" onClick={() => nudge(0, 1)} aria-label="Up a semitone">
              ▲
            </button>
            <button className="btn small" onClick={() => nudge(0, -1)} aria-label="Down a semitone">
              ▼
            </button>
            <button className="btn small" onClick={() => nudge(0, 12)}>
              Oct+
            </button>
            <button className="btn small" onClick={() => nudge(0, -12)}>
              Oct−
            </button>
            <button className="btn small" onClick={() => nudge(0, 0, -grid)} aria-label="Shorter">
              Len−
            </button>
            <button className="btn small" onClick={() => nudge(0, 0, grid)} aria-label="Longer">
              Len+
            </button>
            <Slider
              label="Vel"
              value={selEv.velocity}
              min={1}
              max={127}
              step={1}
              onChange={(v) =>
                edit((evs) => {
                  const t = evs.find((x) => x.id === selEv.id);
                  if (t) t.velocity = v;
                }, `vel:${selEv.id}`)
              }
            />
            <button className="btn small danger" onClick={del}>
              Delete
            </button>
          </>
        ) : (
          <span className="muted small">Tap empty space to add a note · tap a note to select · drag a selected note to move · drag its edge to resize. Notes crossing the clip end are cut there with a short release (they don’t restart at the loop start).</span>
        )}
      </div>
    </>
  );
}

// ---------------- Drum step editor ----------------

function StepEditor({ clip, track }: { clip: DrumClip; track: Track }) {
  const [page, setPage] = useState(0);
  const [accent, setAccent] = useState(false);
  const usesAlt = clip.editedEvents.some((e) => ALT_PADS.some((p) => p.id === e.padId));
  const [showAlt, setShowAlt] = useState(usesAlt);
  const bars = clip.lengthTicks / TICKS_PER_BAR;
  const eff = useMemo(() => effectiveDrums(clip), [clip]);
  const pads = showAlt ? [...KIT_PADS, ...ALT_PADS] : KIT_PADS;
  const grid = new Map<string, { vel: number; ids: string[] }>();
  // Map edited events to the step their effective (quantized) time lands on.
  const effById = new Map(eff.map((e) => [e.id, e]));
  for (const e of clip.editedEvents) {
    const ef = effById.get(e.id) ?? e;
    const step = Math.round(ef.startTick / SIXTEENTH);
    const k = `${e.padId}:${step}`;
    const cur = grid.get(k) ?? { vel: 0, ids: [] };
    cur.vel = Math.max(cur.vel, e.velocity);
    cur.ids.push(e.id);
    grid.set(k, cur);
  }
  const toggle = (padId: string, step: number) => {
    const k = `${padId}:${step}`;
    const cur = grid.get(k);
    store.commit((d) => {
      const c = d.clips[clip.id] as DrumClip;
      if (cur && accent) {
        const next = cur.vel < 90 ? 100 : cur.vel < 120 ? 127 : 70;
        c.editedEvents.forEach((e) => cur.ids.includes(e.id) && (e.velocity = next));
      } else if (cur) {
        c.editedEvents = c.editedEvents.filter((e) => !cur.ids.includes(e.id));
      } else {
        c.editedEvents.push({ id: uid('d'), startTick: step * SIXTEENTH, padId, velocity: KIT_PADS.concat(ALT_PADS).find((p) => p.id === padId)?.velocity ?? 100 });
      }
    });
    if (!cur) engine.previewHit(track.id, padId);
  };
  return (
    <>
      <div className="editor-row">
        {bars > 1 && (
          <>
            <button className="btn small" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous bar">
              ◀
            </button>
            <span className="mono">
              Bar {page + 1}/{bars}
            </span>
            <button className="btn small" disabled={page >= bars - 1} onClick={() => setPage(page + 1)} aria-label="Next bar">
              ▶
            </button>
          </>
        )}
        <button className={`btn small ${accent ? 'lit' : ''}`} aria-pressed={accent} onClick={() => setAccent(!accent)}>
          Accent mode
        </button>
        <button className={`btn small ${showAlt ? 'lit' : ''}`} aria-pressed={showAlt} onClick={() => setShowAlt(!showAlt)}>
          Alternate hits
        </button>
        <button
          className="btn small danger"
          onClick={() =>
            store.commit((d) => {
              (d.clips[clip.id] as DrumClip).editedEvents = [];
            })
          }
        >
          Clear
        </button>
      </div>
      <div className="steps-scroll">
        <div className="steps" style={{ ['--track' as string]: track.color }}>
          {pads.map((p) => (
            <div className="step-row" key={p.id}>
              <button className="step-label" onClick={() => engine.previewHit(track.id, p.id)}>
                {p.label}
              </button>
              {Array.from({ length: 16 }, (_, i) => {
                const step = page * 16 + i;
                const cell = grid.get(`${p.id}:${step}`);
                return (
                  <button
                    key={i}
                    className={`step ${cell ? 'on' : ''} ${i % 4 === 0 ? 'beat' : ''}`}
                    style={cell ? { opacity: 0.35 + (cell.vel / 127) * 0.65 } : undefined}
                    onClick={() => toggle(p.id, step)}
                    aria-label={`${p.label} step ${i + 1}${cell ? `, on, velocity ${cell.vel}` : ', off'}`}
                    aria-pressed={!!cell}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="muted small editor-row">Tap a step to add or remove a hit. In Accent mode, tapping a hit cycles soft → normal → accent. Clear can be undone.</p>
    </>
  );
}
