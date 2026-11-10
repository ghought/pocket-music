/// <reference lib="webworker" />
import { transcribe } from './pitch';

self.onmessage = (e: MessageEvent<{ id: number; samples: Float32Array; sampleRate: number }>) => {
  const { id, samples, sampleRate } = e.data;
  const t0 = performance.now();
  try {
    const result = transcribe(samples, sampleRate);
    (self as unknown as Worker).postMessage({ id, ok: true, result, ms: performance.now() - t0 });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
