import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EagleConfig } from '../types.js';

/** Result of a speaker identification attempt */
export interface IdentifyResult {
  speakerId: string | null;
  confidence: number;
  scores: Map<string, number>;
}

/** Interface for the Eagle SDK — allows mocking in tests */
export interface IEagleEngine {
  readonly sampleRate: number;
  readonly frameLength: number;
  process(pcm: Int16Array): number[];
  reset(): void;
  release(): void;
}

export interface IEagleProfiler {
  readonly minEnrollSamples: number;
  enroll(pcm: Int16Array): { percentage: number; feedback: string };
  export(): Uint8Array;
  reset(): void;
  release(): void;
}

/** Factory to create Eagle SDK instances — injected for testability */
export interface IEagleFactory {
  createRecognizer(accessKey: string, profiles: Uint8Array[], modelPath?: string): IEagleEngine;
  createProfiler(accessKey: string, modelPath?: string): IEagleProfiler;
}

/**
 * Eagle adapter for speaker enrollment and real-time identification.
 * Wraps the Picovoice Eagle SDK behind interfaces for testability.
 */
export class EagleAdapter {
  private config: EagleConfig;
  private factory: IEagleFactory;
  private engine: IEagleEngine | null = null;
  private profiles = new Map<string, Uint8Array>();
  private speakerOrder: string[] = [];

  constructor(config: EagleConfig, factory: IEagleFactory) {
    this.config = config;
    this.factory = factory;
  }

  /** Load voiceprint profiles from disk and initialize the recognition engine */
  async initialize(): Promise<void> {
    if (!this.config.enabled || !this.config.accessKey) {
      console.log('[Eagle] Disabled or no access key');
      return;
    }

    await this.loadProfiles();

    if (this.profiles.size === 0) {
      console.warn('[Eagle] No voiceprint profiles found');
      return;
    }

    this.speakerOrder = [...this.profiles.keys()];
    const profileArrays = this.speakerOrder.map((id) => this.profiles.get(id)!);

    this.engine = this.factory.createRecognizer(
      this.config.accessKey,
      profileArrays,
      this.config.modelPath,
    );

    console.log(`[Eagle] Initialized with ${this.profiles.size} speakers: ${this.speakerOrder.join(', ')}`);
  }

  /** Identify speaker from PCM audio frames */
  identify(pcm: Int16Array): IdentifyResult {
    if (!this.engine || this.speakerOrder.length === 0) {
      return { speakerId: null, confidence: 0, scores: new Map() };
    }

    const rawScores = this.engine.process(pcm);
    const scores = new Map<string, number>();
    let bestId: string | null = null;
    let bestScore = 0;

    for (let i = 0; i < rawScores.length && i < this.speakerOrder.length; i++) {
      const id = this.speakerOrder[i];
      scores.set(id, rawScores[i]);
      if (rawScores[i] > bestScore) {
        bestScore = rawScores[i];
        bestId = id;
      }
    }

    if (bestScore < this.config.confidenceThreshold) {
      return { speakerId: null, confidence: bestScore, scores };
    }

    return { speakerId: bestId, confidence: bestScore, scores };
  }

  /** Enroll a new speaker from PCM audio */
  async enroll(speakerId: string, audioFrames: Int16Array[]): Promise<{ success: boolean; message: string }> {
    if (!this.config.accessKey) {
      return { success: false, message: 'No access key configured' };
    }

    const profiler = this.factory.createProfiler(this.config.accessKey, this.config.modelPath);

    try {
      for (const frame of audioFrames) {
        const result = profiler.enroll(frame);
        if (result.percentage >= 100) break;
        if (result.feedback !== 'NONE' && result.feedback !== 'AUDIO_OK') {
          console.warn(`[Eagle] Enrollment feedback: ${result.feedback}`);
        }
      }

      const profile = profiler.export();

      // Save to disk
      if (this.config.voiceprintsDir) {
        await mkdir(this.config.voiceprintsDir, { recursive: true });
        const path = join(this.config.voiceprintsDir, `${speakerId}.vp`);
        await writeFile(path, profile);
        console.log(`[Eagle] Saved voiceprint: ${path}`);
      }

      this.profiles.set(speakerId, profile);
      return { success: true, message: `Enrolled ${speakerId}` };
    } finally {
      profiler.release();
    }
  }

  /** Reset the recognition engine state (between utterances) */
  reset(): void {
    this.engine?.reset();
  }

  release(): void {
    this.engine?.release();
    this.engine = null;
  }

  get isReady(): boolean {
    return this.engine !== null;
  }

  get speakerCount(): number {
    return this.profiles.size;
  }

  get sampleRate(): number {
    return this.engine?.sampleRate ?? 16000;
  }

  get frameLength(): number {
    return this.engine?.frameLength ?? 512;
  }

  private async loadProfiles(): Promise<void> {
    const dir = this.config.voiceprintsDir;
    if (!dir) return;

    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.vp')) continue;
        const speakerId = file.replace('.vp', '');
        const profileData = await readFile(join(dir, file));
        this.profiles.set(speakerId, new Uint8Array(profileData));
        console.log(`[Eagle] Loaded profile: ${speakerId}`);
      }
    } catch {
      console.warn(`[Eagle] Could not read voiceprints from ${dir}`);
    }
  }
}
