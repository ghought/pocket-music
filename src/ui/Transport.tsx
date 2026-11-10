import { useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { MAX_BPM, MIN_BPM, TICKS_PER_BAR, TPQ } from '../domain/constants';
import { store, useStore } from '../state/store';
import { useRaf } from './widgets';

function Position() {
  const [txt, setTxt] = useState('1.1');
  const [beat, setBeat] = useState(-1);
  useRaf(() => {
    const p = engine.position();
    if (!p) {
      setTxt('1.1');
      setBeat(-1);
      return;
    }
    const t = p.local;
    if (t < 0) {
      setTxt(`−${Math.ceil(-t / TPQ)}`);
      setBeat(Math.floor((t + TICKS_PER_BAR * 4) / TPQ) % 4);
      return;
    }
    const bar = Math.floor(t / TICKS_PER_BAR) + 1;
    const b = Math.floor((t % TICKS_PER_BAR) / TPQ);
    setTxt(`${bar}.${b + 1}`);
    setBeat(b);
  });
  return (
    <div className="position" aria-live="off">
      <span className="mono">{txt}</span>
      <div className="beat-dots" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={i === beat ? 'on' : ''} />
        ))}
      </div>
    </div>
  );
}

function Tempo() {
  const bpm = useStore((s) => s.project?.bpm ?? 100);
  const [edit, setEdit] = useState<string | null>(null);
  const taps = useRef<number[]>([]);
  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((t) => now - t < 2500), now].slice(-6);
    if (taps.current.length >= 3) {
      const iv = taps.current.slice(1).map((t, i) => t - taps.current[i]);
      const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
      store.setBpm(60000 / avg);
    }
  };
  return (
    <div className="tempo">
      {edit !== null ? (
        <input
          className="bpm-input"
          inputMode="numeric"
          autoFocus
          aria-label={`Tempo, ${MIN_BPM} to ${MAX_BPM} BPM`}
          value={edit}
          onChange={(e) => setEdit(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
          onBlur={() => {
            const n = Number(edit);
            if (n) store.setBpm(n);
            setEdit(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEdit(null);
          }}
        />
      ) : (
        <button className="bpm" onClick={() => setEdit(String(bpm))} aria-label={`Tempo ${bpm} BPM, tap to type`}>
          <strong>{bpm}</strong>
          <span>BPM</span>
        </button>
      )}
      <button className="btn tap" onClick={tap} aria-label="Tap tempo">
        TAP
      </button>
    </div>
  );
}

export function Transport() {
  const st = useStore((s) => s.engine);
  const recTrack = useStore((s) => s.recordingTrackId);
  const humPhase = useStore((s) => s.hum.phase);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const notice = useStore((s) => s.tempoNotice);
  const running = st.state !== 'stopped' && st.state !== 'suspended';
  const recording = !!recTrack || humPhase === 'recording' || humPhase === 'countin';
  return (
    <div className="transport">
      <button className={`btn transport-btn ${running ? 'lit' : ''}`} onClick={() => void store.togglePlay()} aria-label={running ? 'Stop' : `Play ${st.source}`}>
        {running ? '■' : '▶'}
      </button>
      <button className={`btn transport-btn rec ${recording ? 'recording' : ''}`} onClick={() => (recording && humPhase !== 'idle' && !recTrack ? void store.stopHum() : void store.toggleRecord())} aria-label={recording ? 'Stop recording' : 'Record selected track'}>
        ●
      </button>
      <Position />
      <Tempo />
      <div className="transport-right">
        <button className="btn icon" disabled={!canUndo} onClick={() => store.undoEdit()} aria-label="Undo">
          ↶
        </button>
        <button className="btn icon" disabled={!canRedo} onClick={() => store.redoEdit()} aria-label="Redo">
          ↷
        </button>
        <button className="btn icon panic" onClick={() => store.stopAllSound()} aria-label="Stop all sound" title="Stop all sound">
          ⏻
        </button>
      </div>
      {notice && <div className="inline-notice">Playback stopped to change tempo safely.</div>}
      {st.state === 'countin' && <div className="inline-notice">Count-in…</div>}
    </div>
  );
}
