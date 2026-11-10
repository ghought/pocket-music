import { engine } from '../audio/engine';
import { instrument } from '../domain/catalog';
import { keyLabel } from '../domain/music';
import type { Project, Track } from '../domain/types';
import { store, useStore, type PlayMode } from '../state/store';
import { ArrangeView } from './Arrange';
import { ClipEditor } from './ClipEditor';
import { DrumSurface } from './Drums';
import { HumPanel } from './HumPanel';
import { AddTrackSheet, ExportSheet, KeySheet, MixSheet, SettingsSheet, TakeChoiceSheet, TrackSheet } from './Sheets';
import { ChordPads, Keyboard, ScalePads } from './Surfaces';
import { Transport } from './Transport';
import { Segmented } from './widgets';

function SaveIndicator() {
  const s = useStore((x) => x.saveStatus);
  const err = useStore((x) => x.saveError);
  if (s === 'failed')
    return (
      <div className="save failed" role="alert">
        <span>Save failed{err ? `: ${err}` : ''}</span>
        <button className="btn small" onClick={() => store.retrySave()}>
          Retry
        </button>
        <button className="btn small" onClick={() => store.openSheet('export')}>
          Backup
        </button>
      </div>
    );
  return (
    <span className={`save ${s}`} aria-live="polite">
      {s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved on this device' : ''}
    </span>
  );
}

function TrackStrip({ project }: { project: Project }) {
  const sel = useStore((s) => s.selectedTrackId);
  const rec = useStore((s) => s.recordingTrackId);
  return (
    <nav className="track-strip" aria-label="Tracks">
      {project.trackIds.map((id) => {
        const t = project.tracks[id];
        return (
          <button
            key={id}
            className={`track-chip ${id === sel ? 'on' : ''} ${rec === id ? 'rec' : ''}`}
            style={{ ['--track' as string]: t.color }}
            onClick={() => {
              if (id === sel) store.openSheet('trackMenu');
              else store.selectTrack(id);
            }}
            aria-pressed={id === sel}
            aria-label={`${t.name}${id === sel ? ' (selected — tap for options)' : ''}`}
          >
            <span className="chip-icon">{t.icon}</span>
            <span className="chip-name">{t.name}</span>
            {(t.mute || t.solo) && <span className="chip-flag">{t.solo ? 'S' : 'M'}</span>}
          </button>
        );
      })}
      <button className="track-chip add" onClick={() => store.openSheet('addTrack')} disabled={project.trackIds.length >= 8} aria-label="Add track">
        +
      </button>
    </nav>
  );
}

function PlayView({ project, track }: { project: Project; track: Track | undefined }) {
  const mode = useStore((s) => (track ? store.playModeFor(track.id) : 'keys'));
  if (!track)
    return (
      <div className="empty-state">
        <p>No tracks yet.</p>
        <button className="btn primary" onClick={() => store.openSheet('addTrack')}>
          Add a track
        </button>
      </div>
    );
  return (
    <div className="play">
      <div className="play-head" style={{ ['--track' as string]: track.color }}>
        <span className="track-dot" />
        <strong>{track.name}</strong>
        <button className="btn small" onClick={() => store.openSheet('trackMenu')}>
          {instrument(track.instrumentId).name} ▾
        </button>
        {track.type === 'pitched' && (
          <Segmented
            small
            label="Play surface"
            value={mode}
            onChange={(m: PlayMode) => store.setPlayMode(track.id, m)}
            options={[
              { value: 'keys', label: 'Keys' },
              { value: 'scale', label: 'Scale' },
              { value: 'chords', label: 'Chords' },
              { value: 'hum', label: 'Hum' },
            ]}
          />
        )}
      </div>
      {track.type === 'drum' ? (
        <DrumSurface track={track} />
      ) : mode === 'hum' ? (
        <HumPanel track={track} project={project} />
      ) : mode === 'scale' ? (
        <ScalePads track={track} project={project} />
      ) : mode === 'chords' ? (
        <ChordPads track={track} project={project} />
      ) : (
        <Keyboard track={track} />
      )}
    </div>
  );
}

export function ProjectScreen({ project }: { project: Project }) {
  const view = useStore((s) => s.view);
  const sheet = useStore((s) => s.sheet);
  const selTrack = useStore((s) => s.selectedTrackId);
  const editing = useStore((s) => s.editingClipId);
  const readOnly = useStore((s) => s.readOnly);
  const engineState = useStore((s) => s.engine.state);
  const ready = useStore((s) => s.engine.ready);
  const track = selTrack ? project.tracks[selTrack] : undefined;
  return (
    <div className="project">
      <header className="topbar">
        <button className="btn icon" onClick={() => void store.closeProject()} aria-label="Back to projects">
          ‹
        </button>
        <input
          className="title-input project-title"
          aria-label="Project name"
          value={project.title}
          onChange={(e) =>
            store.commit((d) => {
              d.title = e.target.value.slice(0, 80);
            }, { coalesce: 'title' })
          }
        />
        <SaveIndicator />
        <div className="topbar-actions">
          <button className="btn small" onClick={() => store.openSheet('key')} aria-label={`Key: ${keyLabel(project.keyRoot, project.keyMode)}`}>
            {project.keyMode ? keyLabel(project.keyRoot, project.keyMode) : 'Key'}
          </button>
          <button className="btn small" onClick={() => store.openSheet('mix')}>
            Mix
          </button>
          <button className="btn small primary" onClick={() => store.openSheet('export')}>
            Export
          </button>
          <button className="btn icon" onClick={() => store.openSheet('settings')} aria-label="Settings">
            ⚙
          </button>
        </div>
      </header>
      {readOnly && (
        <div className="banner warn" role="alert">
          This project is open in another tab, so this tab is read-only.
          <button className="btn small" onClick={() => void store.takeOver()}>
            Edit here instead
          </button>
        </div>
      )}
      {engineState === 'suspended' && (
        <div className="banner warn" role="alert">
          Audio was interrupted.
          <button
            className="btn small"
            onClick={async () => {
              await engine.ensure();
              store.set({ engine: { ...engine.status, state: 'stopped' } });
            }}
          >
            Resume audio
          </button>
        </div>
      )}
      {!ready && (
        <div className="banner" role="status">
          Tap anywhere to wake up the sound.
        </div>
      )}
      <Transport />
      <div className="view-switch">
        <Segmented
          label="View"
          value={view}
          onChange={(v) => store.set({ view: v })}
          options={[
            { value: 'play', label: 'Play' },
            { value: 'arrange', label: 'Arrange' },
          ]}
        />
      </div>
      <main className="main">{view === 'play' ? <PlayView project={project} track={track} /> : <ArrangeView project={project} />}</main>
      <TrackStrip project={project} />
      {editing && <ClipEditor clipId={editing} project={project} />}
      {sheet === 'mix' && <MixSheet project={project} />}
      {sheet === 'export' && <ExportSheet project={project} />}
      {sheet === 'key' && <KeySheet project={project} />}
      {sheet === 'addTrack' && <AddTrackSheet project={project} />}
      {sheet === 'settings' && <SettingsSheet project={project} />}
      {sheet === 'trackMenu' && <TrackSheet project={project} />}
      <TakeChoiceSheet />
    </div>
  );
}
