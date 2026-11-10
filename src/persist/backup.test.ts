import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildDemoProject } from '../domain/demo';
import { encodeWav, decodeWav, checkRender } from '../audio/wav';
import { buildBackup, readBackup } from './backup';
import type { SourceTake } from '../domain/types';

function demoWithTake() {
  const p = buildDemoProject();
  const take: SourceTake = { id: 'take1', blobKey: 'blobA', mimeType: 'audio/wav', sampleRate: 8000, channels: 1, durationSeconds: 1, captureBpm: 92, captureOffsetSeconds: 0, incomplete: false, createdAt: 1 };
  p.takes[take.id] = take;
  const wav = new Blob([encodeWav([new Float32Array(8000).map((_, i) => Math.sin(i / 10) * 0.3)], 8000)], { type: 'audio/wav' });
  return { p, wav };
}

describe('backup', () => {
  it('round-trips project data and original takes', async () => {
    const { p, wav } = demoWithTake();
    const zip = await buildBackup(p, async (k) => (k === 'blobA' ? wav : null));
    const back = await readBackup(zip);
    expect(back.project.id).not.toBe(p.id);
    expect(back.project.arrangement.length).toBe(p.arrangement.length);
    expect(back.takes).toHaveLength(1);
    const decoded = decodeWav(await back.takes[0].blob.arrayBuffer());
    expect(decoded.sampleRate).toBe(8000);
    expect(decoded.channels[0].length).toBe(8000);
    expect(back.project.takes.take1.blobKey).toBe(back.takes[0].blobKey);
  });

  it('rejects path traversal', async () => {
    const z = zipSync({ '../evil.json': strToU8('{}'), 'project.json': strToU8('{}'), 'manifest.json': strToU8('{}') });
    await expect(readBackup(new Blob([z]))).rejects.toThrow(/Unexpected file/);
  });

  it('rejects unsupported future versions', async () => {
    const p = { ...buildDemoProject(), schemaVersion: 42 };
    const z = zipSync({ 'project.json': strToU8(JSON.stringify(p)), 'manifest.json': strToU8(JSON.stringify({ format: 'pocket-music-backup', version: 1, assets: [] })) });
    await expect(readBackup(new Blob([z]))).rejects.toThrow(/newer version/);
  });

  it('rejects decompression bombs before allocating', async () => {
    const big = new Uint8Array(260 * 1024 * 1024); // zeros compress tiny
    const z = zipSync({ 'takes/x.wav': big }, { level: 9 });
    await expect(readBackup(new Blob([z]))).rejects.toThrow(/250 MB/);
  }, 30000);

  it('rejects tampered takes', async () => {
    const { p, wav } = demoWithTake();
    const zip = await buildBackup(p, async () => wav);
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    files['takes/take1.wav'][100] ^= 0xff;
    await expect(readBackup(new Blob([zipSync(files)]))).rejects.toThrow(/integrity/);
  });
});

describe('wav', () => {
  it('encodes 16-bit stereo and verifies bounds', () => {
    const l = new Float32Array(44100).map((_, i) => 0.5 * Math.sin(i / 20));
    const buf = encodeWav([l, l], 44100);
    const d = decodeWav(buf);
    expect(d.channels).toHaveLength(2);
    expect(d.bitsPerSample).toBe(16);
    expect(checkRender(d.channels).ok).toBe(true);
    const clipped = new Float32Array(100).fill(1);
    expect(checkRender([clipped]).ok).toBe(false);
  });
});
