import { useEffect } from 'react';
import { engine } from './audio/engine';
import { store, useStore } from './state/store';
import { Home } from './ui/Home';
import { ProjectScreen } from './ui/ProjectScreen';
import { isTypingTarget } from './ui/widgets';

export function App() {
  const screen = useStore((s) => s.screen);
  const project = useStore((s) => s.project);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    void store.boot();
    // The first gesture anywhere unlocks audio so the first note is never swallowed.
    const unlock = () => engine.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    const keys = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || store.state.screen !== 'project') return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redoEdit();
        else store.undoEdit();
      } else if (e.code === 'Space' && !store.state.editingClipId && !store.state.sheet) {
        e.preventDefault();
        void store.togglePlay();
      } else if (e.key === 'Escape' && !store.state.sheet && !store.state.editingClipId) {
        store.stopAllSound();
      }
    };
    window.addEventListener('keydown', keys);
    return () => {
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
      window.removeEventListener('keydown', keys);
    };
  }, []);

  return (
    <>
      {screen === 'project' && project ? <ProjectScreen project={project} /> : <Home />}
      {toast && (
        <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          {toast.text}
          {toast.action && (
            <button className="btn small" onClick={toast.action.run}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </>
  );
}
