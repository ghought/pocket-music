import { useState } from 'react';
import { engine } from '../audio/engine';
import { CLIP_BAR_OPTIONS, MAX_SONG_BARS, TICKS_PER_BAR } from '../domain/constants';
import {
  addScene,
  addSceneToSong,
  deleteInstance,
  deleteScene,
  duplicateInstance,
  duplicateScene,
  instancesOfClip,
  makeUnique,
  moveInstance,
  moveScene,
  moveTrack,
  newClip,
  resizeInstance,
  songEndTick,
} from '../domain/ops';
import type { ClipBars, Project, Scene } from '../domain/types';
import { store, useStore } from '../state/store';
import { ClipMini } from './ClipMini';
import { Confirm, Segmented, useMediaQuery, useRaf } from './widgets';

export function ArrangeView({ project }: { project: Project }) {
  const mode = useStore((s) => s.arrangeMode);
  const source = useStore((s) => s.engine.source);
  return (
    <div className="arrange">
      <div className="arrange-head">
        <Segmented
          label="Arrange view"
          value={mode}
          onChange={(v) => store.set({ arrangeMode: v })}
          options={[
            { value: 'clips', label: 'Clips' },
            { value: 'song', label: 'Song' },
          ]}
        />
        <div className="row gap center-v">
          <span className="muted small">Plays:</span>
          <Segmented
            small
            label="Playback source"
            value={source}
            onChange={(v) => store.setSource(v)}
            options={[
              { value: 'scene', label: 'Scene' },
              { value: 'song', label: 'Song' },
            ]}
          />
        </div>
      </div>
      {mode === 'clips' ? <ClipsView project={project} /> : <SongView project={project} />}
    </div>
  );
}

function SceneLaunch({ scene }: { scene: Scene }) {
  const st = useStore((s) => s.engine);
  const playing = st.source === 'scene' && st.sceneId === scene.id && st.state !== 'stopped' && st.state !== 'suspended';
  const queued = st.queuedSceneId === scene.id;
  return (
    <button
      className={`btn launch ${playing ? 'playing' : ''} ${queued ? 'queued' : ''}`}
      onClick={() => {
        if (st.source !== 'scene') store.setSource('scene');
        void engine.launchScene(scene.id);
      }}
      aria-label={queued ? `${scene.name} queued for next bar — tap to cancel` : playing ? `${scene.name} playing` : `Launch ${scene.name}`}
      title={queued ? 'Starts at the next bar — tap to cancel' : undefined}
    >
      {queued ? '◷' : playing ? '▶︎' : '▷'}
    </button>
  );
}

function SceneActions({ scene, project }: { scene: Scene; project: Project }) {
  const [confirm, setConfirm] = useState(false);
  const idx = project.sceneIds.indexOf(scene.id);
  return (
    <div className="scene-actions">
      <input
        className="title-input small"
        aria-label="Scene name"
        value={scene.name}
        onChange={(e) =>
          store.commit((d) => {
            d.scenes[scene.id].name = e.target.value.slice(0, 30);
          }, { coalesce: `sname:${scene.id}` })
        }
      />
      <Segmented
        small
        label="Scene length (bars)"
        value={scene.durationBars}
        onChange={(b) =>
          store.commit((d) => {
            d.scenes[scene.id].durationBars = b as ClipBars;
          })
        }
        options={CLIP_BAR_OPTIONS.map((b) => ({ value: b, label: `${b}` }))}
      />
      <span className="muted small">bars</span>
      <div className="row gap wrap">
        <button
          className="btn small"
          onClick={() => {
            let id = '';
            store.commit((d) => {
              const s = duplicateScene(d, scene.id);
              if (typeof s === 'string') return s;
              id = s.id;
            });
            if (id) {
              store.selectScene(id);
              store.toast('Variation created — its clips are independent copies.');
            }
          }}
        >
          Duplicate
        </button>
        <button
          className="btn small primary"
          onClick={() => {
            if (store.commit((d) => addSceneToSong(d, scene.id))) store.toast(`${scene.name} added to the end of the song.`);
          }}
        >
          Add to song
        </button>
        <button className="btn small" disabled={idx <= 0} onClick={() => store.commit((d) => moveScene(d, scene.id, -1))} aria-label="Move scene left">
          ◀
        </button>
        <button className="btn small" disabled={idx >= project.sceneIds.length - 1} onClick={() => store.commit((d) => moveScene(d, scene.id, 1))} aria-label="Move scene right">
          ▶
        </button>
        <button className="btn small danger" disabled={project.sceneIds.length <= 1} onClick={() => setConfirm(true)}>
          Delete
        </button>
      </div>
      {confirm && (
        <Confirm
          text={`Delete ${scene.name}? Its clips stay in the clip list and the song is unchanged. You can undo this.`}
          confirmLabel="Delete scene"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            store.commit((d) => deleteScene(d, scene.id));
          }}
        />
      )}
    </div>
  );
}

function Slot({ project, scene, trackId }: { project: Project; scene: Scene; trackId: string }) {
  const track = project.tracks[trackId];
  const clipId = scene.clipByTrackId[trackId];
  const clip = clipId ? project.clips[clipId] : undefined;
  const options = Object.values(project.clips).filter((c) => c.trackId === trackId);
  return (
    <div className="slot" style={{ ['--track' as string]: track.color }}>
      <button
        className="slot-body"
        onClick={() => {
          store.selectTrack(trackId);
          if (clip) store.set({ editingClipId: clip.id, selectedInstanceId: null });
        }}
        aria-label={clip ? `Edit ${clip.name}` : `${track.name}: empty slot`}
      >
        {clip ? <ClipMini clip={clip} color={track.color} repeatTo={scene.durationBars * TICKS_PER_BAR} /> : <div className="mini empty">empty</div>}
      </button>
      <select
        aria-label={`Clip for ${track.name} in ${scene.name}`}
        value={clipId ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          store.commit((d) => {
            if (v === '__new') {
              const c = newClip(d, trackId, d.scenes[scene.id].durationBars);
              d.scenes[scene.id].clipByTrackId[trackId] = c.id;
            } else d.scenes[scene.id].clipByTrackId[trackId] = v || undefined;
          });
        }}
      >
        <option value="">— empty —</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.lengthTicks / TICKS_PER_BAR} bar)
          </option>
        ))}
        <option value="__new">+ New empty clip</option>
      </select>
    </div>
  );
}

function ClipsView({ project }: { project: Project }) {
  const wide = useMediaQuery('(min-width: 900px)');
  const selectedSceneId = useStore((s) => s.selectedSceneId) ?? project.sceneIds[0];
  const scene = project.scenes[selectedSceneId] ?? project.scenes[project.sceneIds[0]];
  const addSceneBtn = (
    <button
      className="btn small"
      disabled={project.sceneIds.length >= 8}
      title={project.sceneIds.length >= 8 ? 'Up to 8 scenes' : undefined}
      onClick={() => {
        let id = '';
        store.commit((d) => {
          const s = addScene(d);
          if (typeof s === 'string') return s;
          id = s.id;
        });
        if (id) store.selectScene(id);
      }}
    >
      + Scene
    </button>
  );
  if (!project.trackIds.length) return <p className="muted pad">Add a track to start.</p>;
  if (wide) {
    return (
      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th />
              {project.sceneIds.map((sid) => (
                <th key={sid} className={sid === scene.id ? 'sel' : ''}>
                  <div className="row gap center-v">
                    <SceneLaunch scene={project.scenes[sid]} />
                    <button className="link" onClick={() => store.selectScene(sid)}>
                      {project.scenes[sid].name}
                    </button>
                  </div>
                </th>
              ))}
              <th>{addSceneBtn}</th>
            </tr>
          </thead>
          <tbody>
            {project.trackIds.map((tid) => (
              <tr key={tid}>
                <th className="track-head" style={{ ['--track' as string]: project.tracks[tid].color }}>
                  <span className="track-dot" /> {project.tracks[tid].icon} {project.tracks[tid].name}
                </th>
                {project.sceneIds.map((sid) => (
                  <td key={sid} className={sid === scene.id ? 'sel' : ''}>
                    <Slot project={project} scene={project.scenes[sid]} trackId={tid} />
                  </td>
                ))}
                <td />
              </tr>
            ))}
          </tbody>
        </table>
        <SceneActions scene={scene} project={project} />
      </div>
    );
  }
  return (
    <div className="scene-phone">
      <div className="scene-tabs" role="tablist">
        {project.sceneIds.map((sid) => (
          <button key={sid} role="tab" aria-selected={sid === scene.id} className={sid === scene.id ? 'on' : ''} onClick={() => store.selectScene(sid)}>
            {project.scenes[sid].name}
          </button>
        ))}
        {addSceneBtn}
      </div>
      <div className="row gap center-v">
        <SceneLaunch scene={scene} />
        <SceneActions scene={scene} project={project} />
      </div>
      <div className="slots">
        {project.trackIds.map((tid) => (
          <div key={tid} className="slot-row">
            <div className="slot-track" style={{ ['--track' as string]: project.tracks[tid].color }}>
              <span className="track-dot" />
              <span>{project.tracks[tid].name}</span>
            </div>
            <Slot project={project} scene={scene} trackId={tid} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Playhead({ pxPerTick, project }: { pxPerTick: number; project: Project }) {
  const [x, setX] = useState<number | null>(null);
  const st = useStore((s) => s.engine);
  useRaf(() => {
    const p = engine.position();
    setX(p && st.source === 'song' && p.abs >= 0 ? p.abs * pxPerTick : null);
  }, st.state !== 'stopped');
  if (x === null || st.state === 'stopped') return null;
  void project;
  return <div className="playhead" style={{ transform: `translateX(${x}px)` }} />;
}

function SongView({ project }: { project: Project }) {
  const phone = useMediaQuery('(max-width: 700px)');
  const [barPx, setBarPx] = useState(phone ? 36 : 56);
  const selId = useStore((s) => s.selectedInstanceId);
  const overlapId = useStore((s) => s.overlapId);
  const end = songEndTick(project);
  const bars = Math.max(16, Math.ceil(end / TICKS_PER_BAR) + 4);
  const shownBars = Math.min(MAX_SONG_BARS, bars);
  const pxPerTick = barPx / TICKS_PER_BAR;
  const sel = project.arrangement.find((a) => a.id === selId);
  const selClip = sel ? project.clips[sel.clipId] : undefined;
  const shared = sel ? instancesOfClip(project, sel.clipId).length : 0;
  const run = (fn: Parameters<typeof store.commit>[0]) => store.commit(fn);
  return (
    <div className="song">
      <div className="row gap wrap song-add">
        <span className="muted small">Add to song:</span>
        {project.sceneIds.map((sid) => (
          <button key={sid} className="btn small" onClick={() => run((d) => addSceneToSong(d, sid))}>
            + {project.scenes[sid].name}
          </button>
        ))}
        <span className="muted small">
          {Math.ceil(end / TICKS_PER_BAR)}/{MAX_SONG_BARS} bars
        </span>
        <button className="btn small" onClick={() => setBarPx(Math.max(20, barPx - 10))} aria-label="Zoom out">
          −
        </button>
        <button className="btn small" onClick={() => setBarPx(Math.min(120, barPx + 10))} aria-label="Zoom in">
          +
        </button>
      </div>
      {project.arrangement.length === 0 && <p className="muted pad">The song is empty. Add a scene above — each scene becomes clip blocks you can move, repeat, and resize.</p>}
      <div className="timeline-scroll">
        <div className="timeline" style={{ width: 120 + shownBars * barPx }}>
          <div className="ruler" style={{ marginLeft: 120 }}>
            {Array.from({ length: shownBars }, (_, b) => (
              <div key={b} className="ruler-bar" style={{ width: barPx }}>
                {b + 1}
              </div>
            ))}
          </div>
          {project.trackIds.map((tid, i) => {
            const t = project.tracks[tid];
            return (
              <div key={tid} className="lane" style={{ ['--track' as string]: t.color }}>
                <div className="lane-head">
                  <span className="track-dot" />
                  <span className="lane-name">{t.name}</span>
                  <button className="btn tiny" disabled={i === 0} onClick={() => run((d) => moveTrack(d, tid, -1))} aria-label={`Move ${t.name} up`}>
                    ▲
                  </button>
                  <button className="btn tiny" disabled={i === project.trackIds.length - 1} onClick={() => run((d) => moveTrack(d, tid, 1))} aria-label={`Move ${t.name} down`}>
                    ▼
                  </button>
                </div>
                <div className="lane-body" style={{ width: shownBars * barPx, ['--barpx' as string]: `${barPx}px` }} onClick={(e) => e.target === e.currentTarget && store.set({ selectedInstanceId: null })}>
                  {project.arrangement
                    .filter((a) => a.trackId === tid)
                    .map((a) => {
                      const c = project.clips[a.clipId];
                      const linked = instancesOfClip(project, a.clipId).length > 1;
                      return (
                        <button
                          key={a.id}
                          className={`block ${a.id === selId ? 'sel' : ''} ${a.id === overlapId ? 'conflict' : ''}`}
                          style={{ left: a.startTick * pxPerTick, width: a.durationTicks * pxPerTick - 2 }}
                          onClick={() => store.set({ selectedInstanceId: a.id, selectedTrackId: tid })}
                          onDoubleClick={() => store.set({ editingClipId: a.clipId, selectedInstanceId: a.id })}
                          aria-label={`${c?.name ?? 'clip'} at bar ${a.startTick / TICKS_PER_BAR + 1}, ${a.durationTicks / TICKS_PER_BAR} bars${linked ? ', linked' : ''}`}
                        >
                          {c && <ClipMini clip={c} color={t.color} repeatTo={a.durationTicks} />}
                          <span className="block-name">
                            {linked ? '🔗 ' : ''}
                            {c?.name}
                          </span>
                        </button>
                      );
                    })}
                </div>
              </div>
            );
          })}
          <div className="playhead-layer" style={{ left: 120 }}>
            <Playhead pxPerTick={pxPerTick} project={project} />
          </div>
        </div>
      </div>
      {sel && selClip && (
        <div className="song-tools">
          <strong>{selClip.name}</strong>
          <span className="muted small">
            bar {sel.startTick / TICKS_PER_BAR + 1} · {sel.durationTicks / TICKS_PER_BAR} bars{shared > 1 ? ` · linked ×${shared}` : ''}
          </span>
          <div className="row gap wrap">
            <button className="btn small" onClick={() => run((d) => moveInstance(d, sel.id, -1))} aria-label="Move one bar earlier">
              ◀ Move
            </button>
            <button className="btn small" onClick={() => run((d) => moveInstance(d, sel.id, 1))} aria-label="Move one bar later">
              Move ▶
            </button>
            <button className="btn small" onClick={() => run((d) => resizeInstance(d, sel.id, -1))} aria-label="One bar shorter">
              Len −
            </button>
            <button className="btn small" onClick={() => run((d) => resizeInstance(d, sel.id, 1))} aria-label="One bar longer (loops the clip)">
              Len +
            </button>
            <button
              className="btn small"
              onClick={() => {
                let id = '';
                run((d) => {
                  const r = duplicateInstance(d, sel.id);
                  if (typeof r === 'string') return r;
                  id = r.id;
                });
                if (id) store.set({ selectedInstanceId: id });
              }}
            >
              Duplicate
            </button>
            <button className="btn small" onClick={() => store.set({ editingClipId: sel.clipId })}>
              Edit
            </button>
            {shared > 1 && (
              <button className="btn small" onClick={() => run((d) => void makeUnique(d, sel.id))}>
                Make unique
              </button>
            )}
            <button
              className="btn small danger"
              onClick={() => {
                run((d) => deleteInstance(d, sel.id));
                store.set({ selectedInstanceId: null });
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
