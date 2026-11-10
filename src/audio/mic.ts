// Microphone capture: timestamped PCM via AudioWorklet, ScriptProcessor fallback.
// No live monitoring — the input is never routed to the speakers.

import { MAX_TAKE_SECONDS } from '../domain/constants';

const WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.on = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; }; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.on) this.port.postMessage({ frame: currentFrame, data: ch.slice(0) });
    return this.on;
  }
}
registerProcessor('pm-capture', CaptureProcessor);
`;

const loadedWorklets = new WeakSet<BaseAudioContext>();

export class MicError extends Error {
  constructor(public kind: 'denied' | 'unavailable' | 'insecure', message: string) {
    super(message);
  }
}

export class MicCapture {
  private chunks: Float32Array[] = [];
  private firstFrame: number | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private length = 0;
  level = 0;
  peak = 0;
  onLimit: (() => void) | null = null;
  private running = false;

  private constructor(private ctx: AudioContext, private stream: MediaStream) {}

  static async open(ctx: AudioContext): Promise<MicCapture> {
    if (!window.isSecureContext) throw new MicError('insecure', 'Microphone needs HTTPS. Open the app over https:// or localhost.');
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unavailable', 'This browser does not provide microphone access.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied', 'Microphone access was blocked. Drums and Keys still work — you can allow the mic in your browser’s site settings and try again.');
      throw new MicError('unavailable', 'No microphone was found or it is in use by another app.');
    }
    const m = new MicCapture(ctx, stream);
    await m.connect();
    return m;
  }

  private async connect() {
    const ctx = this.ctx;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0; // keeps the graph pulling without monitoring
    this.sink.connect(ctx.destination);
    const onData = (frame: number, data: Float32Array) => {
      if (!this.running) return;
      if (this.firstFrame === null) this.firstFrame = frame;
      this.chunks.push(data);
      this.length += data.length;
      let s = 0;
      let pk = 0;
      for (let i = 0; i < data.length; i++) {
        s += data[i] * data[i];
        pk = Math.max(pk, Math.abs(data[i]));
      }
      this.level = Math.sqrt(s / data.length);
      this.peak = Math.max(this.peak * 0.95, pk);
      if (this.length >= MAX_TAKE_SECONDS * ctx.sampleRate) {
        this.running = false;
        this.onLimit?.();
      }
    };
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      if (!loadedWorklets.has(ctx)) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        loadedWorklets.add(ctx);
      }
      const node = new AudioWorkletNode(ctx, 'pm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (e) => onData(e.data.frame, e.data.data);
      this.source.connect(node).connect(this.sink);
      this.node = node;
    } catch {
      const sp = ctx.createScriptProcessor(2048, 1, 1);
      sp.onaudioprocess = (e) => onData(Math.round(e.playbackTime * ctx.sampleRate), e.inputBuffer.getChannelData(0).slice());
      this.source.connect(sp).connect(this.sink);
      this.node = sp;
    }
  }

  get seconds(): number {
    return this.length / this.ctx.sampleRate;
  }

  start(): void {
    this.chunks = [];
    this.length = 0;
    this.firstFrame = null;
    this.running = true;
  }

  /** Stop collecting and return the PCM with the audio-clock time of its first sample. */
  stop(): { samples: Float32Array; sampleRate: number; startTime: number } {
    this.running = false;
    const out = new Float32Array(Math.min(this.length, MAX_TAKE_SECONDS * this.ctx.sampleRate));
    let o = 0;
    for (const c of this.chunks) {
      if (o >= out.length) break;
      out.set(c.subarray(0, out.length - o), o);
      o += c.length;
    }
    const startTime = (this.firstFrame ?? 0) / this.ctx.sampleRate;
    this.chunks = [];
    return { samples: out, sampleRate: this.ctx.sampleRate, startTime };
  }

  /** Release the microphone. */
  close(): void {
    this.running = false;
    if (this.node instanceof AudioWorkletNode) this.node.port.postMessage('stop');
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* noop */
    }
    this.stream.getTracks().forEach((t) => t.stop());
  }
}
