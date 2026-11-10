// 16-bit PCM WAV encode/decode helpers.

export function encodeWav(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const bytes = 44 + len * numCh * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * 2, true);
  v.setUint16(32, numCh * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, len * numCh * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
      o += 2;
    }
  }
  return buf;
}

export interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
  bitsPerSample: number;
}

/** Minimal PCM16 / float32 WAV parser (used for verification and for stored takes). */
export function decodeWav(buf: ArrayBuffer): DecodedWav {
  const v = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let o = 12;
  let fmt: { ch: number; sr: number; bits: number; format: number } | null = null;
  while (o + 8 <= v.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = { format: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), sr: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id === 'data' && fmt) {
      const bytesPer = fmt.bits / 8;
      const frames = Math.floor(size / (bytesPer * fmt.ch));
      const channels = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
      let p = o + 8;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.ch; c++) {
          channels[c][i] = fmt.bits === 16 ? v.getInt16(p, true) / 0x8000 : v.getFloat32(p, true);
          p += bytesPer;
        }
      }
      return { sampleRate: fmt.sr, channels, bitsPerSample: fmt.bits };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export interface ExportCheck {
  ok: boolean;
  peak: number;
  rms: number;
  plateauRuns: number;
  problems: string[];
}

/** Post-render verification: bounded output, audible content, no hard-clipped plateaus. */
export function checkRender(channels: Float32Array[]): ExportCheck {
  let peak = 0;
  let sum = 0;
  let n = 0;
  let plateauRuns = 0;
  for (const ch of channels) {
    let run = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (!Number.isFinite(a)) return { ok: false, peak: Infinity, rms: 0, plateauRuns: 0, problems: ['Non-finite samples'] };
      peak = Math.max(peak, a);
      sum += a * a;
      n++;
      if (a >= 0.999) {
        run++;
        if (run === 3) plateauRuns++;
      } else run = 0;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  const problems: string[] = [];
  if (peak > 1) problems.push('Samples out of bounds');
  if (plateauRuns > 0) problems.push(`${plateauRuns} hard-clipped plateau(s)`);
  if (rms < 1e-5) problems.push('Render is silent');
  return { ok: problems.length === 0, peak, rms, plateauRuns, problems };
}
