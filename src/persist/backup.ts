// Portable project backup: ZIP with versioned project JSON, original takes, and an asset manifest.

import { strToU8, strFromU8, unzipSync, zipSync, type Unzipped } from 'fflate';
import { INSTRUMENTS } from '../domain/catalog';
import { MAX_TAKE_SECONDS } from '../domain/constants';
import { uid } from '../domain/ops';
import type { AssetManifestEntry, Project } from '../domain/types';
import { SCHEMA_VERSION } from '../domain/types';
import { validateProject, ValidationError } from '../domain/validate';

export const BACKUP_FORMAT = 'pocket-music-backup';
export const BACKUP_VERSION = 1;
export const LIMITS = { compressed: 100 * 1024 * 1024, expanded: 250 * 1024 * 1024, files: 200 };

const ALLOWED_PATH = /^(project\.json|manifest\.json|takes\/[A-Za-z0-9_-]{1,64}\.wav)$/;

export async function sha256(data: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface BackupManifest {
  format: string;
  version: number;
  schemaVersion: number;
  createdAt: number;
  factoryAssets: { id: string; version: number }[];
  assets: { takeId: string; path: string; hash: string; byteLength: number }[];
}

export async function buildBackup(p: Project, getBlob: (key: string) => Promise<Blob | null>): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: Date.now(),
    factoryAssets: INSTRUMENTS.filter((i) => Object.values(p.tracks).some((t) => t.instrumentId === i.id)).map((i) => ({ id: i.id, version: i.version })),
    assets: [],
  };
  const assetManifest: AssetManifestEntry[] = [];
  for (const take of Object.values(p.takes)) {
    const blob = await getBlob(take.blobKey);
    if (!blob) throw new Error(`Original take ${take.id} is missing from this device and can't be backed up.`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = `takes/${take.id}.wav`;
    const hash = await sha256(bytes);
    files[path] = bytes;
    manifest.assets.push({ takeId: take.id, path, hash, byteLength: bytes.byteLength });
    assetManifest.push({ id: take.id, kind: 'take', version: 1, hash, byteLength: bytes.byteLength, localBlobKey: take.blobKey, licenseReference: 'user-recording' });
  }
  files['project.json'] = strToU8(JSON.stringify({ ...p, assetManifest }, null, 1));
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 1));
  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped], { type: 'application/zip' });
}

export interface ImportedBackup {
  project: Project;
  takes: { blobKey: string; blob: Blob }[];
}

/** Validate a backup before allocating large buffers; returns a NEW project (fresh ids). */
export async function readBackup(file: Blob): Promise<ImportedBackup> {
  if (file.size > LIMITS.compressed) throw new ValidationError('Backup is larger than 100 MB.');
  const data = new Uint8Array(await file.arrayBuffer());
  let count = 0;
  let expanded = 0;
  let files: Unzipped;
  try {
    files = unzipSync(data, {
      filter(f) {
        count++;
        if (count > LIMITS.files) throw new ValidationError('Backup contains too many files.');
        if (!ALLOWED_PATH.test(f.name)) throw new ValidationError(`Unexpected file in backup: ${f.name.slice(0, 80)}`);
        expanded += f.originalSize;
        if (expanded > LIMITS.expanded) throw new ValidationError('Backup expands beyond 250 MB.');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError('This file is not a valid Pocket Music backup (unreadable ZIP).');
  }
  // Declared sizes can lie; verify real sizes after decompression.
  const real = Object.values(files).reduce((s, f) => s + f.byteLength, 0);
  if (real > LIMITS.expanded) throw new ValidationError('Backup expands beyond 250 MB.');
  if (!files['project.json'] || !files['manifest.json']) throw new ValidationError('Backup is missing project.json or manifest.json.');
  let manifest: BackupManifest;
  let raw: any;
  try {
    manifest = JSON.parse(strFromU8(files['manifest.json']));
    raw = JSON.parse(strFromU8(files['project.json']));
  } catch {
    throw new ValidationError('Backup JSON is corrupted.');
  }
  if (manifest.format !== BACKUP_FORMAT) throw new ValidationError('Not a Pocket Music backup.');
  if (typeof manifest.version !== 'number' || manifest.version > BACKUP_VERSION) throw new ValidationError('This backup was made by a newer version of the app.');
  const project = validateProject(raw);

  const takes: ImportedBackup['takes'] = [];
  const keyMap = new Map<string, string>();
  for (const take of Object.values(project.takes)) {
    const entry = manifest.assets.find((a) => a.takeId === take.id);
    if (!entry) throw new ValidationError(`Take ${take.id} is missing from the manifest.`);
    const bytes = files[entry.path];
    if (!bytes) throw new ValidationError(`Take file ${entry.path} is missing.`);
    if ((await sha256(bytes)) !== entry.hash) throw new ValidationError(`Take ${take.id} failed its integrity check.`);
    if (take.durationSeconds > MAX_TAKE_SECONDS + 0.5) throw new ValidationError('Take longer than 20 seconds.');
    const newKey = uid('blob');
    keyMap.set(take.blobKey, newKey);
    takes.push({ blobKey: newKey, blob: new Blob([bytes], { type: 'audio/wav' }) });
  }
  for (const take of Object.values(project.takes)) take.blobKey = keyMap.get(take.blobKey)!;
  project.assetManifest = project.assetManifest.map((a) => ({ ...a, localBlobKey: keyMap.get(a.localBlobKey) ?? a.localBlobKey }));
  project.id = uid('p');
  project.title = `${project.title} (imported)`;
  project.updatedAt = Date.now();
  return { project, takes };
}
