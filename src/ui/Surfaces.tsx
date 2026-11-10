import { useEffect, useMemo, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { instrument } from '../domain/catalog';
import { diatonicTriad, keyLabel, NOTE_NAMES, noteName, scaleNotes, suggestKey } from '../domain/music';
import type { KeyMode, Project, Track } from '../domain/types';
import { store, useStore } from '../state/store';
import { usePointerSurface } from './pointerNotes';
import { isTypingTarget, useElementWidth } from './widgets';

const BLACK = new Set([1, 3, 6, 8, 10]);
const KEYMAP = 'awsedftgyhujkolp;'; // desktop: two-row piano mapping

function vel(): number {
  return 100;
}

/** Hook: desktop keyboard → notes (semitone offset from base). */
function useComputerKeys(trackId: string, notesFor: (idx: number) => number[] | null, rootEl: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const held = new Map<string, string[]>();
    const down = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'x') {
        store.shiftOctave(trackId, k === 'z' ? -1 : 1);
        return;
      }
      const idx = KEYMAP.indexOf(k);
      if (idx < 0 || held.has(k)) return;
      const notes = notesFor(idx);
      if (!notes) return;
      engine.unlock();
      const keys = notes.map((m) => `kb:${k}:${m}`);
      notes.forEach((m, i) => {
        engine.noteOn(trackId, m, vel(), keys[i]);
        rootEl.current?.querySelector(`[data-note="${m}"]`)?.classList.add('active');
      });
      held.set(k, keys);
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const keys = held.get(k);
      if (!keys) return;
      held.delete(k);
      keys.forEach((key) => {
        engine.noteOff(trackId, key, store.state.sustain);
        const m = key.split(':')[2];
        rootEl.current?.querySelector(`[data-note="${m}"]`)?.classList.remove('active');
      });
    };
    const blur = () => {
      for (const [, keys] of held) keys.forEach((key) => engine.noteOff(trackId, key));
      held.clear();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      blur();
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [trackId, notesFor, rootEl]);
}

export function Keyboard({ track }: { track: Track }) {
  const base = useStore(() => store.octaveFor(track.id));
  const labels = useStore((s) => s.showLabels);
  const sustain = useStore((s) => s.sustain);
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const whiteCount = Math.max(7, Math.min(22, Math.floor((width || 360) / 50)));
  const start = base - (base % 12); // start on a C
  const keys = useMemo(() => {
    const whites: number[] = [];
    const blacks: { midi: number; pos: number }[] = [];
    let m = start;
    while (whites.length < whiteCount) {
      if (BLACK.has(m % 12)) blacks.push({ midi: m, pos: whites.length });
      else whites.push(m);
      m++;
    }
    return { whites, blacks };
  }, [start, whiteCount]);
  const ref = usePointerSurface({
    attr: 'data-note',
    glide: true,
    down: (n, pid) => engine.noteOn(track.id, Number(n), vel(), `p${pid}:${n}`),
    up: (n, pid) => engine.noteOff(track.id, `p${pid}:${n}`, store.state.sustain),
  });
  const notesFor = useMemo(() => (idx: number) => [start + idx], [start]);
  useComputerKeys(track.id, notesFor, ref);
  return (
    <div className="surface-col">
      <div className="surface-tools">
        <button className="btn" onClick={() => store.shiftOctave(track.id, -1)} aria-label="Octave down">
          Oct −
        </button>
        <span className="mono">{noteName(start)}</span>
        <button className="btn" onClick={() => store.shiftOctave(track.id, 1)} aria-label="Octave up">
          Oct +
        </button>
        <button className={`btn ${sustain ? 'lit' : ''}`} aria-pressed={sustain} onClick={() => store.set({ sustain: !sustain })}>
          Sustain
        </button>
        <button className={`btn ${labels ? 'lit' : ''}`} aria-pressed={labels} onClick={() => store.set({ showLabels: !labels })}>
          Labels
        </button>
      </div>
      <div className="keyboard-wrap" ref={wrapRef}>
        <div className="keyboard perform" ref={ref} style={{ ['--whites' as string]: whiteCount, ['--track' as string]: track.color }}>
          {keys.whites.map((m) => (
            <div key={m} className="wkey" data-note={m} role="button" aria-label={noteName(m)}>
              {labels && <span>{noteName(m)}</span>}
            </div>
          ))}
          {keys.blacks.map(({ midi, pos }) => (
            <div key={midi} className="bkey" data-note={midi} role="button" aria-label={noteName(midi)} style={{ left: `calc(${pos} * 100% / var(--whites) - 100% / var(--whites) * 0.31)` }}>
              {labels && <span>{NOTE_NAMES[midi % 12]}</span>}
            </div>
          ))}
        </div>
      </div>
      <p className="hint desktop-only">Computer keys: A W S E D F T G Y H U J K · Z/X octave</p>
    </div>
  );
}

function KeyNeeded({ purpose, project }: { purpose: string; project: Project }) {
  const [root, setRoot] = useState<number>(0);
  const [mode, setMode] = useState<KeyMode>('major');
  const pitches = useMemo(() => Object.values(project.clips).flatMap((c) => (c.kind === 'pitched' ? c.editedEvents.map((e) => e.midiPitch) : [])), [project]);
  const sug = suggestKey(pitches);
  return (
    <div className="key-needed card">
      <h3>Choose a key</h3>
      <p className="muted">{purpose}</p>
      <div className="root-grid">
        {NOTE_NAMES.map((n, i) => (
          <button key={n} className={`btn ${root === i ? 'lit' : ''}`} onClick={() => setRoot(i)}>
            {n}
          </button>
        ))}
      </div>
      <div className="row gap">
        <button className={`btn ${mode === 'major' ? 'lit' : ''}`} onClick={() => setMode('major')}>
          Major
        </button>
        <button className={`btn ${mode === 'minor' ? 'lit' : ''}`} onClick={() => setMode('minor')}>
          Minor
        </button>
        <button
          className="btn primary"
          onClick={() =>
            store.commit((d) => {
              d.keyRoot = root;
              d.keyMode = mode;
            })
          }
        >
          Use {NOTE_NAMES[root]} {mode}
        </button>
      </div>
      {sug && (
        <p className="muted small">
          Suggestion from your notes: <button className="link" onClick={() => { setRoot(sug.root); setMode(sug.mode); }}>{keyLabel(sug.root, sug.mode)}</button> (a guess — you decide)
        </p>
      )}
    </div>
  );
}

export function ScalePads({ track, project }: { track: Track; project: Project }) {
  const base = useStore(() => store.octaveFor(track.id));
  const labels = useStore((s) => s.showLabels);
  const [chromatic, setChromatic] = useState(false);
  const hasKey = project.keyRoot !== undefined && !!project.keyMode;
  const isBass = instrument(track.instrumentId).mono;
  const notes = useMemo(() => {
    if (!hasKey || chromatic) return Array.from({ length: 16 }, (_, i) => base + i);
    return scaleNotes(project.keyRoot!, project.keyMode!, base, 16);
  }, [hasKey, chromatic, base, project.keyRoot, project.keyMode]);
  const ref = usePointerSurface({
    attr: 'data-note',
    glide: true,
    down: (n, pid) => engine.noteOn(track.id, Number(n), vel(), `p${pid}:${n}`),
    up: (n, pid) => engine.noteOff(track.id, `p${pid}:${n}`),
  });
  const notesFor = useMemo(() => (idx: number) => (notes[idx] !== undefined ? [notes[idx]] : null), [notes]);
  useComputerKeys(track.id, notesFor, ref);
  if (!hasKey && !chromatic) {
    return (
      <div className="surface-col">
        <KeyNeeded project={project} purpose={`Guided pads show only notes in your key${isBass ? ' in a bass-friendly register' : ''}. Pick one, or play every note.`} />
        <button className="btn" onClick={() => setChromatic(true)}>
          Play chromatic (all notes)
        </button>
      </div>
    );
  }
  const root = project.keyRoot ?? 0;
  return (
    <div className="surface-col">
      <div className="surface-tools">
        <button className="btn" onClick={() => store.shiftOctave(track.id, -1)}>
          Oct −
        </button>
        <span className="mono">{hasKey && !chromatic ? keyLabel(project.keyRoot, project.keyMode) : 'Chromatic'}</span>
        <button className="btn" onClick={() => store.shiftOctave(track.id, 1)}>
          Oct +
        </button>
        {hasKey && (
          <button className={`btn ${chromatic ? 'lit' : ''}`} aria-pressed={chromatic} onClick={() => setChromatic(!chromatic)}>
            Chromatic
          </button>
        )}
      </div>
      <div className="pad-grid perform" ref={ref} style={{ ['--track' as string]: track.color }}>
        {notes.map((m) => {
          // Bottom-left is the lowest note, like a hardware pad grid.
          return (
            <div key={m} className={`pad note-pad ${(m - root) % 12 === 0 ? 'root' : ''}`} data-note={m} role="button" aria-label={noteName(m)}>
              {labels && <span>{noteName(m)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ChordPads({ track, project }: { track: Track; project: Project }) {
  const base = useStore(() => store.octaveFor(track.id));
  const hasKey = project.keyRoot !== undefined && !!project.keyMode;
  const chords = useMemo(() => {
    if (!hasKey) return [];
    const octaveBase = base - (base % 12) - 12;
    const list = Array.from({ length: 7 }, (_, d) => diatonicTriad(project.keyRoot!, project.keyMode!, d, octaveBase + 12));
    const top = diatonicTriad(project.keyRoot!, project.keyMode!, 0, octaveBase + 24);
    return [...list, { ...top, roman: list[0].roman + '′' }];
  }, [hasKey, base, project.keyRoot, project.keyMode]);
  const ref = usePointerSurface({
    attr: 'data-chord',
    glide: false,
    down: (idx, pid) => chords[Number(idx)]?.notes.forEach((m) => engine.noteOn(track.id, m, 92, `p${pid}:c${idx}:${m}`)),
    up: (idx, pid) => chords[Number(idx)]?.notes.forEach((m) => engine.noteOff(track.id, `p${pid}:c${idx}:${m}`, store.state.sustain)),
  });
  const notesFor = useMemo(() => (idx: number) => chords[idx]?.notes ?? null, [chords]);
  useComputerKeys(track.id, notesFor, ref);
  if (!hasKey) return <KeyNeeded project={project} purpose="Chord pads play the chords that belong to a key. Choose the root and major or minor." />;
  return (
    <div className="surface-col">
      <div className="surface-tools">
        <button className="btn" onClick={() => store.shiftOctave(track.id, -1)}>
          Oct −
        </button>
        <span className="mono">{keyLabel(project.keyRoot, project.keyMode)}</span>
        <button className="btn" onClick={() => store.shiftOctave(track.id, 1)}>
          Oct +
        </button>
        {instrument(track.instrumentId).mono && <span className="muted small">Bass is monophonic — chords play their last note.</span>}
      </div>
      <div className="pad-grid chords perform" ref={ref} style={{ ['--track' as string]: track.color }}>
        {chords.map((c, i) => (
          <div key={i} className="pad chord-pad" data-chord={i} role="button" aria-label={`${c.label} chord`}>
            <strong>{c.label}</strong>
            <span>{c.roman}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function useKeyboardFocusRef() {
  return useRef<HTMLDivElement>(null);
}
