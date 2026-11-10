import { useRef, useState } from 'react';
import type { ProjectSummary } from '../domain/types';
import { readBackup } from '../persist/backup';
import { store, useStore } from '../state/store';
import { Confirm, Sheet } from './widgets';

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

function ProjectRow({ p }: { p: ProjectSummary }) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState(p.title);
  return (
    <li className="project-row">
      <button className="project-open" onClick={() => void store.openProject(p.id)}>
        <strong>{p.title}</strong>
        <span className="muted small">
          {p.trackCount} track{p.trackCount === 1 ? '' : 's'} · {p.bpm} BPM · {ago(p.updatedAt)}
        </span>
      </button>
      <button className="btn icon" onClick={() => setMenu(true)} aria-label={`Options for ${p.title}`}>
        ⋯
      </button>
      {menu && (
        <Sheet title={p.title} onClose={() => setMenu(false)}>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="row gap wrap">
            <button
              className="btn primary"
              onClick={() => {
                void store.renameProject(p.id, name);
                setMenu(false);
              }}
            >
              Rename
            </button>
            <button
              className="btn"
              onClick={() => {
                void store.duplicateProject(p.id);
                setMenu(false);
              }}
            >
              Duplicate
            </button>
            <button className="btn danger" onClick={() => setConfirm(true)}>
              Delete…
            </button>
          </div>
        </Sheet>
      )}
      {confirm && (
        <Confirm
          text={`Delete “${p.title}” and its voice recordings from this device? This cannot be undone. Export a backup first if you might want it later.`}
          confirmLabel="Delete forever"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            setMenu(false);
            void store.deleteProject(p.id);
          }}
        />
      )}
    </li>
  );
}

export function Home() {
  const projects = useStore((s) => s.projects);
  const booting = useStore((s) => s.booting);
  const saveError = useStore((s) => s.saveError);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  return (
    <div className="home">
      <header className="home-head">
        <div className="logo" aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </div>
        <h1>Pocket Music</h1>
        <p className="muted">Get the music in your head into something you can hear, shape, and keep.</p>
      </header>
      <div className="start-grid">
        <button className="start hum" onClick={() => void store.createProject('hum')}>
          <span className="start-icon">◡</span>
          <strong>Hum an idea</strong>
          <span>Sing a melody, get editable notes</span>
        </button>
        <button className="start drums" onClick={() => void store.createProject('drums')}>
          <span className="start-icon">◉</span>
          <strong>Play drums</strong>
          <span>Finger-drum a beat</span>
        </button>
        <button className="start keys" onClick={() => void store.createProject('keys')}>
          <span className="start-icon">▥</span>
          <strong>Play keys</strong>
          <span>Piano, synths, chords</span>
        </button>
      </div>
      <div className="row gap wrap home-minor">
        <button className="btn" onClick={() => void store.openDemo()}>
          Try a demo
        </button>
        <button className="btn" disabled={importing} onClick={() => fileRef.current?.click()}>
          {importing ? 'Importing…' : 'Import backup'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setImporting(true);
            try {
              const r = await readBackup(f);
              await store.importProject(r.project, r.takes);
            } catch (err) {
              store.toast(`Import failed: ${(err as Error).message} Your existing projects were not changed.`, 'error');
            } finally {
              setImporting(false);
            }
          }}
        />
      </div>
      {saveError && <p className="error-text">{saveError}</p>}
      <section>
        <h2>Recent</h2>
        {booting ? (
          <p className="muted">Loading…</p>
        ) : projects.length ? (
          <ul className="project-list">
            {projects.map((p) => (
              <ProjectRow key={p.id} p={p} />
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing yet. Pick a starting point above — everything saves on this device automatically, no account needed.</p>
        )}
      </section>
      <footer className="muted small">Sketches are stored in this browser only. Export a backup to keep them safe.</footer>
    </div>
  );
}
