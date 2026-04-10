import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EagleAdapter, type IEagleFactory, type IEagleEngine, type IEagleProfiler } from '../../src/speaker/eagle.js';
import type { EagleConfig } from '../../src/types.js';

// --- Mock Eagle SDK ---

function createMockEngine(speakerScores: number[][]): IEagleEngine {
  let callIdx = 0;
  return {
    sampleRate: 16000,
    frameLength: 512,
    process(_pcm: Int16Array): number[] {
      const scores = speakerScores[Math.min(callIdx, speakerScores.length - 1)];
      callIdx++;
      return scores;
    },
    reset() { callIdx = 0; },
    release() {},
  };
}

function createMockProfiler(): IEagleProfiler {
  let enrollCount = 0;
  return {
    minEnrollSamples: 16000, // 1 second
    enroll(_pcm: Int16Array) {
      enrollCount++;
      const pct = Math.min(100, enrollCount * 25);
      return { percentage: pct, feedback: 'NONE' };
    },
    export() {
      return new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    },
    reset() { enrollCount = 0; },
    release() {},
  };
}

function createMockFactory(speakerScores: number[][] = [[0.9, 0.1]]): IEagleFactory {
  return {
    createRecognizer(_accessKey, _profiles, _modelPath) {
      return createMockEngine(speakerScores);
    },
    createProfiler(_accessKey, _modelPath) {
      return createMockProfiler();
    },
  };
}

function createTestEagleConfig(voiceprintsDir: string): EagleConfig {
  return {
    enabled: true,
    accessKey: 'test-key',
    voiceprintsDir,
    confidenceThreshold: 0.7,
    identifyFrames: 3,
  };
}

describe('EagleAdapter', () => {
  const testDir = join(tmpdir(), `eagle-test-${Date.now()}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('initializes with no profiles (no engine)', async () => {
    const adapter = new EagleAdapter(createTestEagleConfig(testDir), createMockFactory());
    await adapter.initialize();

    expect(adapter.isReady).toBe(false);
    expect(adapter.speakerCount).toBe(0);
  });

  it('enrolls a speaker and saves voiceprint', async () => {
    const config = createTestEagleConfig(testDir);
    const adapter = new EagleAdapter(config, createMockFactory());

    const frames = Array.from({ length: 10 }, () => new Int16Array(512));
    const result = await adapter.enroll('alice', frames);

    expect(result.success).toBe(true);
    expect(result.message).toContain('alice');

    const files = await readdir(testDir);
    expect(files).toContain('alice.vp');
  });

  it('identifies speaker with high confidence', async () => {
    const config = createTestEagleConfig(testDir);
    // Scores: [alice=0.95, bob=0.2]
    const factory = createMockFactory([[0.95, 0.2]]);
    const adapter = new EagleAdapter(config, factory);

    // Enroll two speakers first
    const frames = Array.from({ length: 10 }, () => new Int16Array(512));
    await adapter.enroll('alice', frames);
    await adapter.enroll('bob', frames);

    // Re-initialize to load profiles
    await adapter.initialize();
    expect(adapter.isReady).toBe(true);
    expect(adapter.speakerCount).toBe(2);

    const result = adapter.identify(new Int16Array(512));
    expect(result.speakerId).toBe('alice');
    expect(result.confidence).toBe(0.95);
  });

  it('returns null speaker when below confidence threshold', async () => {
    const config = createTestEagleConfig(testDir);
    // All scores below 0.7 threshold
    const factory = createMockFactory([[0.3, 0.2]]);
    const adapter = new EagleAdapter(config, factory);

    const frames = Array.from({ length: 10 }, () => new Int16Array(512));
    await adapter.enroll('alice', frames);
    await adapter.enroll('bob', frames);
    await adapter.initialize();

    const result = adapter.identify(new Int16Array(512));
    expect(result.speakerId).toBeNull();
    expect(result.confidence).toBe(0.3);
    expect(result.scores.size).toBe(2);
  });

  it('returns empty result when not initialized', () => {
    const config = createTestEagleConfig(testDir);
    const adapter = new EagleAdapter(config, createMockFactory());

    const result = adapter.identify(new Int16Array(512));
    expect(result.speakerId).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('does nothing when disabled', async () => {
    const config = { ...createTestEagleConfig(testDir), enabled: false };
    const adapter = new EagleAdapter(config, createMockFactory());
    await adapter.initialize();

    expect(adapter.isReady).toBe(false);
  });

  it('resets engine state', async () => {
    const config = createTestEagleConfig(testDir);
    const factory = createMockFactory([[0.9, 0.1]]);
    const adapter = new EagleAdapter(config, factory);

    const frames = Array.from({ length: 10 }, () => new Int16Array(512));
    await adapter.enroll('alice', frames);
    await adapter.initialize();

    adapter.reset();
    // Should not throw
    const result = adapter.identify(new Int16Array(512));
    expect(result.speakerId).toBe('alice');
  });
});
