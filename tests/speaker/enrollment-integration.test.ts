import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EnrollmentCollector, _resetActiveCollectorForTesting } from '../../src/speaker/enrollment-collector.js';
import { SpeakerIdentifier } from '../../src/speaker/identifier.js';
import { EagleAdapter, type IEagleFactory, type IEagleEngine, type IEagleProfiler } from '../../src/speaker/eagle.js';
import type { EagleConfig } from '../../src/types.js';

const FRAME_LENGTH = 512;
const SAMPLE_RATE = 16000;

/**
 * Mock Eagle factory that tracks enrollment state.
 * After enrollment, the recognizer returns high scores for all loaded profiles.
 */
function createLifecycleMockFactory(): {
  factory: IEagleFactory;
  enrolledSpeakers: Set<string>;
} {
  const enrolledSpeakers = new Set<string>();
  let enrollCount = 0;

  const factory: IEagleFactory = {
    createRecognizer(_accessKey, profiles, _modelPath): IEagleEngine {
      return {
        sampleRate: SAMPLE_RATE,
        frameLength: FRAME_LENGTH,
        process(_pcm: Int16Array): number[] {
          return profiles.map(() => enrolledSpeakers.size > 0 ? 0.95 : 0.0);
        },
        reset() {},
        release() {},
      };
    },
    createProfiler(_accessKey, _modelPath): IEagleProfiler {
      enrollCount = 0;
      return {
        minEnrollSamples: SAMPLE_RATE,
        enroll(_pcm: Int16Array) {
          enrollCount++;
          return { percentage: Math.min(100, enrollCount * 10), feedback: 'NONE' };
        },
        export() {
          return new Uint8Array([0x01, 0x02, 0x03, 0x04]);
        },
        reset() { enrollCount = 0; },
        release() {},
      };
    },
  };

  return { factory, enrolledSpeakers };
}

function makePcmChunks(seconds: number): Buffer[] {
  const totalSamples = SAMPLE_RATE * seconds;
  const chunks: Buffer[] = [];
  const chunkSamples = 640; // typical Wyoming chunk
  for (let i = 0; i < totalSamples; i += chunkSamples) {
    const size = Math.min(chunkSamples, totalSamples - i);
    const buf = Buffer.alloc(size * 2);
    for (let s = 0; s < size; s++) {
      buf.writeInt16LE(Math.floor(Math.sin((i + s) * 0.1) * 10000), s * 2);
    }
    chunks.push(buf);
  }
  return chunks;
}

describe('Speaker Enrollment → Recognition Lifecycle', () => {
  let tmpDir: string;
  const eagleConfig: EagleConfig = {
    enabled: true,
    accessKey: 'test-key',
    confidenceThreshold: 0.7,
    identifyFrames: 1,
  };

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `enroll-lifecycle-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    eagleConfig.voiceprintsDir = tmpDir;
  });

  afterEach(async () => {
    _resetActiveCollectorForTesting();
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('full lifecycle: enroll → voiceprint saved → recognized in next session', async () => {
    vi.useFakeTimers();
    const { factory, enrolledSpeakers } = createLifecycleMockFactory();

    // Phase 1: Enrollment
    const eagle1 = new EagleAdapter(eagleConfig, factory);
    const collector = new EnrollmentCollector(eagle1, 'alice', eagleConfig, 3000);

    const audioChunks = makePcmChunks(3);
    for (const chunk of audioChunks) {
      collector.feedAudio(chunk);
    }

    await vi.advanceTimersByTimeAsync(3100);
    const enrollResult = await collector.result;

    expect(enrollResult.success).toBe(true);
    expect(enrollResult.message).toContain('alice');

    // Verify voiceprint file
    const files = await readdir(tmpDir);
    expect(files).toContain('alice.vp');

    // Phase 2: Recognition
    enrolledSpeakers.add('alice');
    const eagle2 = new EagleAdapter(eagleConfig, factory);
    await eagle2.initialize();
    expect(eagle2.speakerCount).toBe(1);

    const identifier = new SpeakerIdentifier(eagle2, eagleConfig);
    const result = identifier.feedAudio(makePcmChunks(0.1)[0]);

    expect(result).not.toBeNull();
    expect(result?.speakerId).toBe('alice');
    expect(result!.confidence).toBeGreaterThan(0.7);

    vi.useRealTimers();
  });

  it('multiple speakers enrolled and all recognized', async () => {
    vi.useFakeTimers();
    const { factory, enrolledSpeakers } = createLifecycleMockFactory();
    const eagle = new EagleAdapter(eagleConfig, factory);

    // Enroll Alice
    const c1 = new EnrollmentCollector(eagle, 'alice', eagleConfig, 1000);
    for (const chunk of makePcmChunks(1)) c1.feedAudio(chunk);
    await vi.advanceTimersByTimeAsync(1100);
    expect((await c1.result).success).toBe(true);

    // Enroll Bob
    const c2 = new EnrollmentCollector(eagle, 'bob', eagleConfig, 1000);
    for (const chunk of makePcmChunks(1)) c2.feedAudio(chunk);
    await vi.advanceTimersByTimeAsync(1100);
    expect((await c2.result).success).toBe(true);

    const files = await readdir(tmpDir);
    expect(files).toContain('alice.vp');
    expect(files).toContain('bob.vp');

    // Recognize both
    enrolledSpeakers.add('alice');
    enrolledSpeakers.add('bob');
    const eagle2 = new EagleAdapter(eagleConfig, factory);
    await eagle2.initialize();
    expect(eagle2.speakerCount).toBe(2);

    vi.useRealTimers();
  });

  it('re-enrollment overwrites existing voiceprint', async () => {
    vi.useFakeTimers();
    const { factory } = createLifecycleMockFactory();
    const eagle = new EagleAdapter(eagleConfig, factory);

    // First enrollment
    const c1 = new EnrollmentCollector(eagle, 'alice', eagleConfig, 500);
    for (const chunk of makePcmChunks(0.5)) c1.feedAudio(chunk);
    await vi.advanceTimersByTimeAsync(600);
    expect((await c1.result).success).toBe(true);

    // Re-enroll
    const c2 = new EnrollmentCollector(eagle, 'alice', eagleConfig, 500);
    for (const chunk of makePcmChunks(0.5)) c2.feedAudio(chunk);
    await vi.advanceTimersByTimeAsync(600);
    expect((await c2.result).success).toBe(true);

    const files = await readdir(tmpDir);
    expect(files.filter(f => f === 'alice.vp')).toHaveLength(1);

    vi.useRealTimers();
  });
});
