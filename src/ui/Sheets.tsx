import { useEffect, useRef, useState } from 'react';
import { engine } from '../audio/engine';
import { renderLengthTicks, renderProject, RenderCancelled, sanitizeFilename, TAIL_SECONDS, type RenderResult } from '../audio/render';
import { DRUM_KITS, instrument, PITCHED_INSTRUMENTS } from '../domain/catalog';
import { MAX_TRACKS, ticksToSeconds } from '../domain/constants';
import { keyLabel, NOTE_NAMES, suggestKey } from '../domain/music';
import { removeTrack, TRACK_PRESETS, type TrackPreset } from '../domain/ops';
import type { KeyMode, Project } from '../domain/types';
import * as db from '../persist/db';
import { buildBackup } from '../persist/backup';
import { store, useStore } from '../state/store';
import { Confirm, Knob, Segmented, Sheet, Slider, useRaf } from './widgets';

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function MasterMeter() {
  const [lvl, setLvl] = useState({ peak: 0, clip: false });
  const clipHold = useRef(0);
  useRaf(() => {
    const m = engine.masterLevel();
    if (m.clip) clipHold.current = performance.now();
    setLvl(m);
  });
  const clipping = performance.now() - clipHold.current < 1500;
  return (
    <div className="master">
      <span className="muted small">Master</span>
      <div className="meter" role="meter" aria-label="Master output level" aria-valuenow={Math.round(lvl.peak * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="meter-fill" style={{ width: `${Math.min(100, lvl.peak * 100)}%` }} />
      </div>
      <span className={`clip-led ${clipping ? 'on' : ''}`} aria-label={clipping ? 'Clipping' : 'No clipping'}>
        CLIP
      </span>
    </div>
  );
}

export function MixSheet({ project }: { project: Project }) {
  const c = (id: string, key: string, fn: (t: Project['tracks'][string]) => void) =>
    store.commit((d) => fn(d.tracks[id]), { coalesce: `mix:${id}:${key}` });
  return (
    <Sheet title="Mix" onClose={() => store.openSheet(null)} wide>
      <MasterMeter />
      <div className="mixer">
        {project.trackIds.map((id) => {
          const t = project.tracks[id];
          return (
            <div key={id} className="strip" style={{ ['--track' as string]: t.color }}>
              <div className="strip-name">
                <span className="track-dot" /> {t.name}
              </div>
              <div className="row gap">
                <button className={`btn small ${t.mute ? 'lit warn-lit' : ''}`} aria-pressed={t.mute} onClick={() => c(id, 'mute', (x) => void (x.mute = !x.mute))}>
                  Mute
                </button>
                <button className={`btn small ${t.solo ? 'lit' : ''}`} aria-pressed={t.solo} onClick={() => c(id, 'solo', (x) => void (x.solo = !x.solo))}>
                  Solo
                </button>
              </div>
              <Slider label="Level" value={t.gainDb} min={-40} max={6} step={0.5} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`} onChange={(v) => c(id, 'gain', (x) => void (x.gainDb = v))} />
              <Slider label="Pan" value={t.pan} min={-1} max={1} step={0.05} format={(v) => (Math.abs(v) < 0.03 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} onChange={(v) => c(id, 'pan', (x) => void (x.pan = v))} />
              <div className="row gap">
                <Knob label="Tone" value={t.effects.tone} min={0} max={1} step={0.05} color={t.color} format={(v) => (v < 0.45 ? 'Dark' : v > 0.55 ? 'Bright' : 'Neutral')} onChange={(v) => c(id, 'tone', (x) => void (x.effects.tone = v))} />
                <Knob label="Space" value={t.effects.space} min={0} max={1} step={0.05} color={t.color} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => c(id, 'space', (x) => void (x.effects.space = v))} />
              </div>
            </div>
          );
        })}
      </div>
      <p className="muted small">Levels are curated per instrument and a gentle safety limiter protects the output. This is not mastering.</p>
    </Sheet>
  );
}

type ExportState = { phase: 'idle' } | { phase: 'rendering'; progress: number } | { phase: 'done'; result: RenderResult; filename: string } | { phase: 'error'; message: string };

export function ExportSheet({ project }: { project: Project }) {
  const selectedScene = useStore((s) => s.selectedSceneId) ?? project.sceneIds[0];
  const [source, setSource] = useState<'song' | 'scene'>(project.arrangement.length ? 'song' : 'scene');
  const [sceneId, setSceneId] = useState(selectedScene);
  const [st, setSt] = useState<ExportState>({ phase: 'idle' });
  const [backupBusy, setBackupBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const ticks = renderLengthTicks(project, { source, sceneId });
  const secs = ticksToSeconds(ticks, project.bpm);
  const songEmpty = project.arrangement.length === 0;

  const doExport = async () => {
    engine.stop();
    abort.current = new AbortController();
    setSt({ phase: 'rendering', progress: 0 });
    try {
      const result = await renderProject(project, { source, sceneId }, (f) => setSt({ phase: 'rendering', progress: f }), abort.current.signal);
      const name = `${sanitizeFilename(project.title)}${source === 'scene' ? `-${sanitizeFilename(project.scenes[sceneId]?.name ?? 'scene')}` : ''}.wav`;
      setSt({ phase: 'done', result, filename: name });
    } catch (e) {
      if (e instanceof RenderCancelled) setSt({ phase: 'idle' });
      else setSt({ phase: 'error', message: (e as Error).message || 'Export failed.' });
    }
  };
  const canShare = st.phase === 'done' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File([st.result.wav], st.filename, { type: 'audio/wav' })] });

  return (
    <Sheet title="Export" onClose={() => store.openSheet(null)}>
      <h3>Audio (WAV)</h3>
      <Segmented
        label="Export source"
        value={source}
        onChange={setSource}
        options={[
          { value: 'song', label: 'Song' },
          { value: 'scene', label: 'One scene' },
        ]}
      />
      {source === 'song' && songEmpty && (
        <p className="warn">
          The song is empty.{' '}
          <button className="link" onClick={() => setSource('scene')}>
            Export a scene instead
          </button>
        </p>
      )}
      {source === 'scene' && (
        <select value={sceneId} onChange={(e) => setSceneId(e.target.value)} aria-label="Scene to export">
          {project.sceneIds.map((id) => (
            <option key={id} value={id}>
              {project.scenes[id].name}
            </option>
          ))}
        </select>
      )}
      <p className="muted small">
        {secs.toFixed(1)}s of music + {TAIL_SECONDS}s effect tail · stereo · 44.1 kHz · 16-bit. Respects mute/solo and effects. Excludes the click and original voice takes.
      </p>
      {st.phase === 'idle' || st.phase === 'error' ? (
        <>
          {st.phase === 'error' && <p className="error-text">{st.message}</p>}
          <button className="btn primary big" disabled={ticks <= 0} onClick={() => void doExport()}>
            {st.phase === 'error' ? 'Try again' : 'Export WAV'}
          </button>
        </>
      ) : st.phase === 'rendering' ? (
        <div className="row gap center-v">
          <div className="meter grow" role="progressbar" aria-valuenow={Math.round(st.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Export progress">
            <div className="meter-fill" style={{ width: `${st.progress * 100}%` }} />
          </div>
          <button className="btn" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="card">
          <p>
            ✓ <strong>{st.filename}</strong> — {(st.result.wav.size / 1024 / 1024).toFixed(1)} MB, verified (peak {(20 * Math.log10(st.result.check.peak || 1e-9)).toFixed(1)} dBFS).
          </p>
          <div className="row gap wrap">
            <button className="btn primary" onClick={() => download(st.result.wav, st.filename)}>
              Download
            </button>
            {canShare && (
              <button
                className="btn"
                onClick={() => {
                  if (st.phase !== 'done') return;
                  navigator.share({ files: [new File([st.result.wav], st.filename, { type: 'audio/wav' })], title: project.title }).catch(() => {});
                }}
              >
                Share…
              </button>
            )}
            <button className="btn" onClick={() => setSt({ phase: 'idle' })}>
              Export another
            </button>
          </div>
        </div>
      )}
      <hr />
      <h3>Project backup</h3>
      <p className="muted small">Projects are saved in this browser on this device. Browsers can clear storage, so keep a backup (.zip with your notes and original voice takes). Import it from the home screen.</p>
      <button
        className="btn"
        disabled={backupBusy}
        onClick={async () => {
          setBackupBusy(true);
          try {
            const zip = await buildBackup(project, db.getAsset);
            download(zip, `${sanitizeFilename(project.title)}.pocketmusic.zip`);
          } catch (e) {
            store.toast(`Backup failed: ${(e as Error).message}`, 'error');
          } finally {
            setBackupBusy(false);
          }
        }}
      >
        {backupBusy ? 'Preparing…' : 'Download backup'}
      </button>
    </Sheet>
  );
}

export function KeySheet({ project }: { project: Project }) {
  const [root, setRoot] = useState<number | undefined>(project.keyRoot);
  const [mode, setMode] = useState<KeyMode>(project.keyMode ?? 'major');
  const pitches = Object.values(project.clips).flatMap((c) => (c.kind === 'pitched' ? c.editedEvents.map((e) => e.midiPitch) : []));
  const sug = suggestKey(pitches);
  return (
    <Sheet title="Key" onClose={() => store.openSheet(null)}>
      <p className="muted small">The key powers scale pads, chord pads, and the optional “fit to key” in the editor. Changing it never rewrites existing notes.</p>
      <div className="root-grid">
        {NOTE_NAMES.map((n, i) => (
          <button key={n} className={`btn ${root === i ? 'lit' : ''}`} onClick={() => setRoot(i)}>
            {n}
          </button>
        ))}
      </div>
      <Segmented
        label="Mode"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'major', label: 'Major' },
          { value: 'minor', label: 'Minor' },
        ]}
      />
      {sug && (
        <p className="small">
          Suggestion from your notes:{' '}
          <button className="link" onClick={() => { setRoot(sug.root); setMode(sug.mode); }}>
            {keyLabel(sug.root, sug.mode)}
          </button>{' '}
          <span className="muted">(a guess, not detected for certain)</span>
        </p>
      )}
      <div className="row gap end">
        <button
          className="btn"
          onClick={() => {
            store.commit((d) => {
              d.keyRoot = undefined;
              d.keyMode = undefined;
            });
            store.openSheet(null);
          }}
        >
          No key
        </button>
        <button
          className="btn primary"
          disabled={root === undefined}
          onClick={() => {
            store.commit((d) => {
              d.keyRoot = root;
              d.keyMode = mode;
            });
            store.openSheet(null);
          }}
        >
          Set {root !== undefined ? keyLabel(root, mode) : 'key'}
        </button>
      </div>
    </Sheet>
  );
}

export function AddTrackSheet({ project }: { project: Project }) {
  const full = project.trackIds.length >= MAX_TRACKS;
  return (
    <Sheet title="Add a track" onClose={() => store.openSheet(null)}>
      {full && <p className="warn">This sketch already has {MAX_TRACKS} tracks, the maximum.</p>}
      <div className="preset-grid">
        {(Object.keys(TRACK_PRESETS) as TrackPreset[]).map((k) => (
          <button key={k} className="btn preset" disabled={full} onClick={() => store.addTrack(k)}>
            <span className="preset-icon">{TRACK_PRESETS[k].icon}</span>
            <strong>{TRACK_PRESETS[k].name}</strong>
            <span className="muted small">{instrument(TRACK_PRESETS[k].instrumentId).name}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

export function TrackSheet({ project }: { project: Project }) {
  const id = useStore((s) => s.selectedTrackId);
  const [confirm, setConfirm] = useState(false);
  const t = id ? project.tracks[id] : undefined;
  if (!t) return null;
  const options = t.type === 'drum' ? DRUM_KITS : PITCHED_INSTRUMENTS;
  return (
    <Sheet title="Track" onClose={() => store.openSheet(null)}>
      <label className="field">
        <span>Name</span>
        <input
          value={t.name}
          onChange={(e) =>
            store.commit((d) => {
              d.tracks[t.id].name = e.target.value.slice(0, 24);
            }, { coalesce: `tname:${t.id}` })
          }
        />
      </label>
      <label className="field">
        <span>Sound</span>
        <select
          value={t.instrumentId}
          onChange={(e) =>
            store.commit((d) => {
              const inst = instrument(e.target.value);
              d.tracks[t.id].instrumentId = inst.id;
              d.tracks[t.id].instrumentVersion = inst.version;
            })
          }
        >
          {options.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">Changing the sound never changes the notes.</p>
      <button className="btn danger" onClick={() => setConfirm(true)}>
        Delete track
      </button>
      {confirm && (
        <Confirm
          text={`Delete “${t.name}” and its clips? You can undo this.`}
          confirmLabel="Delete track"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            store.commit((d) => removeTrack(d, t.id));
            store.openSheet(null);
          }}
        />
      )}
    </Sheet>
  );
}

export function SettingsSheet({ project }: { project: Project }) {
  const persistent = useStore((s) => s.persistent);
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    db.storageEstimate().then(setEst);
  }, []);
  const set = (fn: (d: Project) => void) => store.commit(fn);
  return (
    <Sheet title="Settings" onClose={() => store.openSheet(null)}>
      <div className="field">
        <span>Count-in before recording</span>
        <Segmented
          label="Count-in"
          value={project.settings.countInBars}
          onChange={(v) => set((d) => void (d.settings.countInBars = v))}
          options={[
            { value: 0, label: 'Off' },
            { value: 1, label: '1 bar' },
          ]}
        />
      </div>
      <div className="field">
        <span>Metronome while recording instruments</span>
        <Segmented
          label="Metronome"
          value={project.settings.metronome ? 'on' : 'off'}
          onChange={(v) => set((d) => void (d.settings.metronome = v === 'on'))}
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
        />
        <span className="muted small">Hum takes never click while you sing. The click is never exported.</span>
      </div>
      <Slider
        label="Recording offset"
        value={project.settings.recordingOffsetMs}
        min={-150}
        max={250}
        step={5}
        format={(v) => `${v} ms`}
        onChange={(v) => store.commit((d) => void (d.settings.recordingOffsetMs = v), { coalesce: 'recoffset' })}
      />
      <p className="muted small">If recorded notes land consistently late, raise this. Bluetooth headphones add a lot of delay; wired headphones work best.</p>
      <hr />
      <p className="small">
        Storage: {persistent === true ? 'persistent (the browser agreed not to clear it automatically)' : 'best-effort — the browser may clear it under pressure'}.{' '}
        {est && `${(est.usage / 1024 / 1024).toFixed(1)} MB used.`}
      </p>
      <button className="btn" onClick={() => db.requestPersistence().then((p) => store.set({ persistent: p }))}>
        Ask browser to keep my projects
      </button>
      <hr />
      <button className="btn danger" onClick={() => store.stopAllSound()}>
        Stop all sound
      </button>
    </Sheet>
  );
}

export function TakeChoiceSheet() {
  const tc = useStore((s) => s.takeChoice);
  const project = useStore((s) => s.project);
  if (!tc || !project) return null;
  return (
    <Sheet title="New take recorded" onClose={() => store.resolveTakeChoice(false)}>
      <p>
        This scene already has “{project.clips[tc.previousClipId]?.name}”. Use the new take “{project.clips[tc.newClipId]?.name}” instead? Both are kept either way — switch any time from the clip list.
      </p>
      <div className="row gap end">
        <button className="btn" onClick={() => store.resolveTakeChoice(false)}>
          Keep previous
        </button>
        <button className="btn primary" onClick={() => store.resolveTakeChoice(true)}>
          Use new take
        </button>
      </div>
    </Sheet>
  );
}
