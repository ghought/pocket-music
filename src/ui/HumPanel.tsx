import { useState } from 'react';
import { engine } from '../audio/engine';
import { PITCHED_INSTRUMENTS } from '../domain/catalog';
import { barsToSeconds, CLIP_BAR_OPTIONS, MAX_TAKE_SECONDS, TICKS_PER_BAR, TPQ } from '../domain/constants';
import type { ClipBars, PitchedClip, Project, Track } from '../domain/types';
import { store, useStore } from '../state/store';
import { ClipMini } from './ClipMini';
import { Segmented, useRaf } from './widgets';

function BeatLights() {
  const [beat, setBeat] = useState(-1);
  const [count, setCount] = useState(false);
  useRaf(() => {
    const pos = engine.position();
    if (!pos) return setBeat(-1);
    const b = Math.floor(pos.abs / TPQ);
    setCount(pos.abs < 0);
    setBeat(((b % 4) + 4) % 4);
  });
  return (
    <div className={`beat-lights ${count ? 'counting' : ''}`} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={i === beat ? 'on' : ''}>
          {i + 1}
        </span>
      ))}
    </div>
  );
}

function MicMeter() {
  const [lvl, setLvl] = useState(0);
  const [sec, setSec] = useState(0);
  useRaf(() => {
    setLvl(store.micLevel);
    setSec(store.micSeconds);
  });
  const pct = Math.min(100, Math.sqrt(lvl) * 220);
  return (
    <div className="mic-meter">
      <div className="meter" role="meter" aria-label="Input level" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`meter-fill ${pct > 92 ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="mono">
        {sec.toFixed(1)}s / {MAX_TAKE_SECONDS}s
      </span>
    </div>
  );
}

export function HumPanel({ track, project }: { track: Track; project: Project }) {
  const hum = useStore((s) => s.hum);
  const sceneId = useStore((s) => s.selectedSceneId)!;
  const scene = project.scenes[sceneId];
  const others = scene ? Object.entries(scene.clipByTrackId).filter(([t, c]) => t !== track.id && c && project.clips[c]?.editedEvents.length) : [];
  const secs = barsToSeconds(hum.bars, project.bpm);

  if (hum.phase === 'idle' || hum.phase === 'error') {
    return (
      <div className="hum card">
        <h3>Hum an idea</h3>
        <p className="muted">Hum or sing one clear note at a time — “da da da” works well. Your voice is kept as a reference and turned into editable notes.</p>
        <div className="row gap wrap">
          <Segmented
            label="Capture type"
            value={hum.mode}
            onChange={(mode) => store.setHum({ mode })}
            options={[
              { value: 'bars', label: 'In time' },
              { value: 'free', label: 'Free take' },
            ]}
          />
          {hum.mode === 'bars' && (
            <Segmented
              label="Bars"
              value={hum.bars}
              onChange={(b) => store.setHum({ bars: b as ClipBars })}
              options={CLIP_BAR_OPTIONS.map((b) => ({ value: b, label: `${b} bar${b > 1 ? 's' : ''}` }))}
            />
          )}
        </div>
        <p className="muted small">
          {hum.mode === 'bars'
            ? `${project.settings.countInBars ? 'One-bar count-in, then ' : ''}${hum.bars} bars at ${project.bpm} BPM (${secs.toFixed(1)}s). The beat is shown visually — no click while you hum.`
            : 'Record up to 20 seconds without the beat. Afterwards you set the tempo and fit it to a clip.'}
        </p>
        {hum.mode === 'bars' && secs > MAX_TAKE_SECONDS && <p className="warn">That is longer than 20 seconds. Choose fewer bars or a free take.</p>}
        {others.length > 0 && hum.mode === 'bars' && <p className="warn small">Other parts will play while you hum. Speaker sound can leak into the mic — wired headphones work best.</p>}
        {hum.phase === 'error' && <p className="error-text">{hum.error}</p>}
        <button className="btn rec big" onClick={() => void store.startHum()} disabled={hum.mode === 'bars' && secs > MAX_TAKE_SECONDS}>
          ● Record
        </button>
        {hum.phase === 'error' && hum.takeId && (
          <div className="row gap wrap">
            <button className="btn" onClick={() => void store.retryTakeSave()}>
              Retry saving take
            </button>
          </div>
        )}
      </div>
    );
  }

  if (hum.phase === 'requesting') {
    return (
      <div className="hum card center">
        <p>Waiting for microphone permission…</p>
        <button className="btn" onClick={() => store.cancelHum()}>
          Cancel
        </button>
      </div>
    );
  }

  if (hum.phase === 'countin' || hum.phase === 'recording') {
    return (
      <div className="hum card center recording">
        <div className="rec-label">{hum.phase === 'countin' ? 'Get ready…' : '● Recording'}</div>
        {hum.mode === 'bars' ? <BeatLights /> : null}
        <MicMeter />
        <div className="row gap">
          <button className="btn primary big" onClick={() => void store.stopHum()}>
            ■ Stop
          </button>
          <button className="btn" onClick={() => store.cancelHum()}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (hum.phase === 'saving' || hum.phase === 'analyzing') {
    return (
      <div className="hum card center">
        <div className="spinner" aria-hidden />
        <p>{hum.phase === 'saving' ? 'Saving your take…' : 'Listening for notes…'}</p>
        <p className="muted small">Your original recording is {hum.phase === 'saving' ? 'being' : 'already'} saved on this device.</p>
        {hum.phase === 'analyzing' && (
          <button className="btn" onClick={() => store.cancelHum()}>
            Cancel analysis
          </button>
        )}
      </div>
    );
  }

  if (hum.phase === 'empty') {
    return (
      <div className="hum card">
        <h3>No melody found</h3>
        <p>{hum.error}</p>
        <div className="row gap wrap">
          {hum.takeId && (
            <button className="btn" onClick={() => void store.playTake(hum.takeId!)}>
              ▶ Original take
            </button>
          )}
          {hum.takeId && (
            <button className="btn" onClick={() => void store.analyzeTake(hum.takeId!, track.id, sceneId, hum.mode === 'bars' ? hum.bars : null, 0)}>
              Analyze again
            </button>
          )}
          <button className="btn" onClick={() => store.manualEntryFromTake()}>
            Enter notes by hand
          </button>
          <button className="btn rec" onClick={() => store.setHum({ phase: 'idle' })}>
            Record again
          </button>
        </div>
      </div>
    );
  }

  // review
  const clip = hum.clipId ? (project.clips[hum.clipId] as PitchedClip | undefined) : undefined;
  if (!clip) {
    return (
      <div className="hum card">
        <button className="btn rec" onClick={() => store.setHum({ phase: 'idle' })}>
          Record a new take
        </button>
      </div>
    );
  }
  const take = clip.sourceTakeId ? project.takes[clip.sourceTakeId] : undefined;
  const strength = clip.quantize.strength;
  const trim = clip.trimOriginSeconds ?? 0;
  const bars = (clip.lengthTicks / TICKS_PER_BAR) as ClipBars;
  const inScene = scene?.clipByTrackId[track.id] === clip.id;
  return (
    <div className="hum card">
      <div className="row between">
        <h3>{clip.editedEvents.length} notes found</h3>
        {hum.analysisMs !== undefined && <span className="muted small">analyzed in {(hum.analysisMs / 1000).toFixed(1)}s</span>}
      </div>
      <div className="hum-mini" onClick={() => store.set({ editingClipId: clip.id })}>
        <ClipMini clip={clip} color={track.color} />
      </div>
      {clip.editedEvents.some((e) => e.uncertain) && <p className="muted small">Dashed notes were unsteady in pitch — check them in the editor.</p>}
      {take && (
        <div className="row gap wrap">
          <span className="tag">Original take — reference{take.incomplete ? ' (incomplete)' : ''}</span>
          <button className="btn" onClick={() => void store.playTake(take.id, trim)}>
            ▶ Original
          </button>
          <button
            className="btn"
            onClick={() => {
              store.stopTake();
              void store.togglePlay();
            }}
          >
            ▶ Instrument
          </button>
        </div>
      )}
      <div className="row gap wrap">
        <label className="field">
          <span>Sound</span>
          <select
            value={track.instrumentId}
            onChange={(e) =>
              store.commit((d) => {
                d.tracks[track.id].instrumentId = e.target.value;
              })
            }
          >
            {PITCHED_INSTRUMENTS.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>
        <Segmented
          label="Timing"
          value={strength === 0 ? 'off' : strength === 0.5 ? 'gentle' : strength === 1 ? 'tight' : 'custom'}
          onChange={(v) =>
            store.commit((d) => {
              d.clips[clip.id].quantize.strength = v === 'off' ? 0 : v === 'gentle' ? 0.5 : 1;
            })
          }
          options={[
            { value: 'off', label: 'As hummed' },
            { value: 'gentle', label: 'Gentle' },
            { value: 'tight', label: 'Tight' },
          ]}
        />
      </div>
      {take && (
        <div className="row gap wrap">
          <span className="muted small">Start point</span>
          <button className="btn" onClick={() => store.retrimHumClip(clip.id, trim - 0.05)} aria-label="Move start earlier by 50 ms">
            −50ms
          </button>
          <span className="mono">{trim.toFixed(2)}s</span>
          <button className="btn" onClick={() => store.retrimHumClip(clip.id, trim + 0.05)} aria-label="Move start later by 50 ms">
            +50ms
          </button>
          <Segmented small label="Clip length" value={bars} onChange={(b) => store.retrimHumClip(clip.id, trim, b as ClipBars)} options={CLIP_BAR_OPTIONS.map((b) => ({ value: b, label: `${b}` }))} />
          <span className="muted small">bars</span>
        </div>
      )}
      {!!hum.outside && <p className="warn small">{hum.outside} note{hum.outside > 1 ? 's' : ''} fall outside the clip. Choose a longer clip or move the start point — nothing is dropped from your take.</p>}
      {take?.captureBpm === null && <p className="muted small">Free take: set the tempo with Tap in the transport, then adjust the start point. Tempo was not detected automatically.</p>}
      {!inScene && <p className="muted small">This take is saved as “{clip.name}” but isn’t in the scene yet.</p>}
      <div className="row gap wrap">
        <button className="btn primary" onClick={() => store.set({ editingClipId: clip.id })}>
          Edit notes
        </button>
        {take && (
          <button className="btn" onClick={() => void store.analyzeTake(take.id, track.id, sceneId, bars, trim)}>
            Re-analyze
          </button>
        )}
        <button className="btn rec" onClick={() => store.setHum({ phase: 'idle' })}>
          New take
        </button>
        <button className="btn" onClick={() => store.setPlayMode(track.id, 'keys')}>
          Play keys
        </button>
      </div>
    </div>
  );
}
