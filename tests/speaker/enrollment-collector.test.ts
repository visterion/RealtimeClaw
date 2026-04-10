import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EnrollmentCollector, _resetActiveCollectorForTesting } from '../../src/speaker/enrollment-collector.js';
import { EagleAdapter, type IEagleFactory, type IEagleEngine, type IEagleProfiler } from '../../src/speaker/eagle.js';
import type { EagleConfig } from '../../src/types.js';

const FRAME_LENGTH = 512;

function createMockEngine(): IEagleEngine {
  return {
    sampleRate: 16000,
    frameLength: FRAME_LENGTH,
    process: () => [0.9],
    reset: () => {},
    release: () => {},
  };
}

function createMockProfiler(): IEagleProfiler {
  let enrollCount = 0;
  return {
    minEnrollSamples: 16000,
    enroll(_pcm: Int16Array) {
      enrollCount++;
      return { percentage: Math.min(100, enrollCount * 10), feedback: 'NONE' };
    },
    export() { return new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]); },
    reset() { enrollCount = 0; },
    release() {},
  };
}

function createMockFactory(): IEagleFactory {
  return {
    createRecognizer: () => createMockEngine(),
    createProfiler: () => createMockProfiler(),
  };
}

describe('EnrollmentCollector', () => {
  let tmpDir: string;
  let eagle: EagleAdapter;
  const eagleConfig: EagleConfig = {
    enabled: true,
    accessKey: 'test-key',
    confidenceThreshold: 0.7,
    identifyFrames: 1,
  };

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `enroll-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    eagleConfig.voiceprintsDir = tmpDir;
    eagle = new EagleAdapter(eagleConfig, createMockFactory());
  });

  afterEach(async () => {
    _resetActiveCollectorForTesting();
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('collects frames and saves voiceprint after duration', async () => {
    vi.useFakeTimers();
    const collector = new EnrollmentCollector(eagle, 'alice', eagleConfig, 2000);

    for (let i = 0; i < 20; i++) {
      collector.feedAudio(Buffer.alloc(FRAME_LENGTH * 2));
    }

    expect(collector.isActive).toBe(true);
    await vi.advanceTimersByTimeAsync(2100);

    const result = await collector.result;
    expect(result.success).toBe(true);
    expect(result.message).toContain('alice');
    expect(collector.isActive).toBe(false);

    const files = await readdir(tmpDir);
    expect(files).toContain('alice.vp');

    vi.useRealTimers();
  });

  it('sanitizes speaker name', async () => {
    vi.useFakeTimers();
    const collector = new EnrollmentCollector(eagle, 'Alice Smith', eagleConfig, 500);

    for (let i = 0; i < 10; i++) {
      collector.feedAudio(Buffer.alloc(FRAME_LENGTH * 2));
    }
    await vi.advanceTimersByTimeAsync(600);

    const result = await collector.result;
    expect(result.success).toBe(true);

    const files = await readdir(tmpDir);
    expect(files).toContain('alice_smith.vp');

    vi.useRealTimers();
  });

  it('fails when no frames collected', async () => {
    vi.useFakeTimers();
    const collector = new EnrollmentCollector(eagle, 'bob', eagleConfig, 500);

    await vi.advanceTimersByTimeAsync(600);

    const result = await collector.result;
    expect(result.success).toBe(false);
    expect(result.message).toContain('Not enough');

    vi.useRealTimers();
  });

  it('rejects concurrent enrollment', () => {
    vi.useFakeTimers();
    const _c1 = new EnrollmentCollector(eagle, 'alice', eagleConfig, 5000);
    expect(() => new EnrollmentCollector(eagle, 'bob', eagleConfig, 5000))
      .toThrow('already in progress');
    vi.useRealTimers();
  });
});
