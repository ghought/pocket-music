// IndexedDB persistence. Project JSON and audio blobs live in separate stores; each save is
// one atomic transaction so the previous valid revision survives until the new one commits.

import type { Project, ProjectSummary } from '../domain/types';
import { validateProject } from '../domain/validate';

const DB_NAME = 'pocket-music';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no local database (IndexedDB). Projects cannot be saved.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('summaries')) db.createObjectStore('summaries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Could not open local storage.'));
    };
    req.onblocked = () => reject(new Error('Local storage is blocked by another open tab. Close other Pocket Music tabs.'));
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Storage write failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Storage write was aborted.'));
  });
}
function get<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}

/** Test hook: `?simulateStorageFailure` makes writes fail like a full disk. */
function simulatedFailure(): boolean {
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('simulateStorageFailure');
  } catch {
    return false;
  }
}
function quotaError(): DOMException {
  return new DOMException('Simulated: storage quota exceeded', 'QuotaExceededError');
}

export function summarize(p: Project): ProjectSummary {
  return { id: p.id, title: p.title, updatedAt: p.updatedAt, trackCount: p.trackIds.length, bpm: p.bpm };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await openDb();
  const tx = db.transaction('summaries', 'readonly');
  const all = await new Promise<ProjectSummary[]>((resolve, reject) => {
    const r = tx.objectStore('summaries').getAll();
    r.onsuccess = () => resolve(r.result as ProjectSummary[]);
    r.onerror = () => reject(r.error);
  });
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadProject(id: string): Promise<Project | null> {
  const db = await openDb();
  const tx = db.transaction('projects', 'readonly');
  const rec = await get<{ id: string; project: Project }>(tx.objectStore('projects'), id);
  if (!rec) return null;
  return validateProject(rec.project);
}

export async function saveProject(p: Project): Promise<void> {
  if (simulatedFailure()) throw quotaError();
  const db = await openDb();
  const tx = db.transaction(['projects', 'summaries', 'meta'], 'readwrite');
  tx.objectStore('projects').put({ id: p.id, project: p, savedAt: Date.now() });
  tx.objectStore('summaries').put(summarize(p));
  tx.objectStore('meta').put(p.id, 'lastProjectId');
  await done(tx);
}

/** Takes are written immediately when capture completes, before any analysis. */
export async function putAsset(key: string, blob: Blob, projectId: string): Promise<void> {
  if (simulatedFailure()) throw quotaError();
  const db = await openDb();
  const tx = db.transaction('assets', 'readwrite');
  tx.objectStore('assets').put({ blob, projectId }, key);
  await done(tx);
}

export async function getAsset(key: string): Promise<Blob | null> {
  const db = await openDb();
  const tx = db.transaction('assets', 'readonly');
  const rec = await get<{ blob: Blob }>(tx.objectStore('assets'), key);
  return rec?.blob ?? null;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['projects', 'summaries', 'assets', 'meta'], 'readwrite');
  tx.objectStore('projects').delete(id);
  tx.objectStore('summaries').delete(id);
  const assets = tx.objectStore('assets');
  const cur = assets.openCursor();
  cur.onsuccess = () => {
    const c = cur.result;
    if (!c) return;
    if ((c.value as { projectId: string }).projectId === id) c.delete();
    c.continue();
  };
  await done(tx);
}

/** Remove only this project's assets that no clip or undo step references any more. */
export async function cleanupAssets(projectId: string, keep: Set<string>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('assets', 'readwrite');
  const cur = tx.objectStore('assets').openCursor();
  cur.onsuccess = () => {
    const c = cur.result;
    if (!c) return;
    const v = c.value as { projectId: string };
    if (v.projectId === projectId && !keep.has(String(c.key))) c.delete();
    c.continue();
  };
  await done(tx);
}

export async function getLastProjectId(): Promise<string | null> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readonly');
  return (await get<string>(tx.objectStore('meta'), 'lastProjectId')) ?? null;
}

export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

export function isQuotaError(e: unknown): boolean {
  const n = (e as DOMException)?.name;
  return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED';
}
