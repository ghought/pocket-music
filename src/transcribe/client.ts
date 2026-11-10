// Runs transcription off the main thread. Cancellation terminates the worker.
import type { TranscribeResult } from './pitch';

export interface TranscribeJob {
  promise: Promise<{ result: TranscribeResult; ms: number }>;
  cancel(): void;
}

let seq = 0;

export function startTranscription(samples: Float32Array, sampleRate: number): TranscribeJob {
  const id = ++seq;
  let worker: Worker | null = null;
  let rejectFn: (e: Error) => void = () => {};
  const promise = new Promise<{ result: TranscribeResult; ms: number }>((resolve, reject) => {
    rejectFn = reject;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(new Error('Could not start the analysis worker in this browser.'));
      return;
    }
    worker.onmessage = (e) => {
      if (e.data.id !== id) return;
      worker?.terminate();
      if (e.data.ok) resolve({ result: e.data.result, ms: e.data.ms });
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker?.terminate();
      reject(new Error(e.message || 'Analysis failed to load.'));
    };
    const copy = samples.slice();
    worker.postMessage({ id, samples: copy, sampleRate }, [copy.buffer]);
  });
  return {
    promise,
    cancel() {
      worker?.terminate();
      rejectFn(new Error('cancelled'));
    },
  };
}
