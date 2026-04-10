import { EagleAdapter } from './eagle.js';
import type { EagleConfig } from '../types.js';

let activeCollector: EnrollmentCollector | null = null;

export class EnrollmentCollector {
  private eagle: EagleAdapter;
  private config: EagleConfig;
  private speakerName: string;
  private frames: Int16Array[] = [];
  private timer: ReturnType<typeof setTimeout>;
  private resolveResult!: (result: { success: boolean; message: string }) => void;
  private active = true;

  readonly result: Promise<{ success: boolean; message: string }>;

  constructor(eagle: EagleAdapter, name: string, config: EagleConfig, durationMs = 10000) {
    if (activeCollector?.isActive) {
      throw new Error('Enrollment already in progress');
    }
    this.eagle = eagle;
    this.config = config;
    this.speakerName = name.toLowerCase().replace(/\s+/g, '_');

    this.result = new Promise((resolve) => { this.resolveResult = resolve; });
    this.timer = setTimeout(() => this.complete(), durationMs);
    activeCollector = this;
  }

  get isActive(): boolean {
    return this.active;
  }

  feedAudio(pcm: Buffer): void {
    if (!this.active) return;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
    const frameLength = this.eagle.frameLength || 512;
    for (let i = 0; i + frameLength <= samples.length; i += frameLength) {
      this.frames.push(samples.slice(i, i + frameLength));
    }
  }

  async complete(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.timer);

    if (this.frames.length < 5) {
      this.resolveResult({ success: false, message: `Not enough audio for enrollment (${this.frames.length} frames)` });
      activeCollector = null;
      return;
    }

    try {
      const result = await this.eagle.enroll(this.speakerName, this.frames);
      this.resolveResult(result);
    } catch (err) {
      this.resolveResult({ success: false, message: (err as Error).message });
    }
    activeCollector = null;
  }
}

/** Reset the global enrollment lock — for use in tests only */
export function _resetActiveCollectorForTesting(): void {
  activeCollector = null;
}
