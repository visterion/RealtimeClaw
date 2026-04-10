import { EagleAdapter, type IdentifyResult } from './eagle.js';
import type { EagleConfig } from '../types.js';

/** Convert PCM byte count to sample count (16-bit = 2 bytes per sample) */
const BYTES_PER_SAMPLE = 2;
function bytesToSamples(bytes: number): number {
  return bytes / BYTES_PER_SAMPLE;
}

/**
 * Buffers initial audio frames and runs Eagle identification in parallel
 * with the Realtime API audio stream.
 *
 * Flow:
 * 1. Audio chunks arrive from Wyoming
 * 2. First N frames are buffered for Eagle
 * 3. After enough frames, Eagle.identify() runs (~300ms)
 * 4. Meanwhile, audio is also streamed to Realtime API (no delay)
 * 5. Result is injected as speaker context via conversation.item.create
 */
export class SpeakerIdentifier {
  private eagle: EagleAdapter;
  private config: EagleConfig;
  private audioBuffer: Buffer[] = [];
  private totalSamples = 0;
  private identified = false;
  private result: IdentifyResult | null = null;

  constructor(eagle: EagleAdapter, config: EagleConfig) {
    this.eagle = eagle;
    this.config = config;
  }

  /** Feed a PCM audio chunk. Returns identification result when ready. */
  feedAudio(pcm: Buffer): IdentifyResult | null {
    if (!this.eagle.isReady || this.identified) return this.result;

    this.audioBuffer.push(pcm);
    this.totalSamples += bytesToSamples(pcm.length);

    const frameLength = this.eagle.frameLength;
    const requiredSamples = frameLength * this.config.identifyFrames;

    if (this.totalSamples >= requiredSamples) {
      this.result = this.runIdentification();
      this.identified = true;
      this.audioBuffer = [];
      return this.result;
    }

    return null;
  }

  /** Check if identification is complete */
  get isIdentified(): boolean {
    return this.identified;
  }

  /** Get the last identification result */
  getResult(): IdentifyResult | null {
    return this.result;
  }

  reset(): void {
    this.audioBuffer = [];
    this.totalSamples = 0;
    this.identified = false;
    this.result = null;
    this.eagle.reset();
  }

  private runIdentification(): IdentifyResult {
    // Combine all buffered audio into one Int16Array
    const combined = Buffer.concat(this.audioBuffer);
    const samples = new Int16Array(combined.buffer, combined.byteOffset, bytesToSamples(combined.length));

    // Process in frame-sized chunks, accumulate scores
    const frameLength = this.eagle.frameLength;
    let bestResult: IdentifyResult = { speakerId: null, confidence: 0, scores: new Map() };

    for (let offset = 0; offset + frameLength <= samples.length; offset += frameLength) {
      const frame = samples.slice(offset, offset + frameLength);
      const result = this.eagle.identify(frame);

      if (result.confidence > bestResult.confidence) {
        bestResult = result;
      }
    }

    if (bestResult.speakerId) {
      console.log(`[Eagle] Identified: ${bestResult.speakerId} (${(bestResult.confidence * 100).toFixed(1)}%)`);
    } else {
      console.log(`[Eagle] Unknown speaker (best: ${(bestResult.confidence * 100).toFixed(1)}%)`);
    }

    return bestResult;
  }
}
