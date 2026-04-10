// tests/speaker/speaker-switch.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpeakerIdentifier } from '../../src/speaker/identifier.js';
import { EagleAdapter, type IEagleFactory, type IEagleEngine, type IEagleProfiler } from '../../src/speaker/eagle.js';
import type { EagleConfig } from '../../src/types.js';

const FRAME_LENGTH = 512;
const BYTES_PER_SAMPLE = 2;

function createMockEngine(scoreSequences: number[][]): IEagleEngine {
  let callIdx = 0;
  return {
    sampleRate: 16000,
    frameLength: FRAME_LENGTH,
    process(_pcm: Int16Array): number[] {
      const scores = scoreSequences[Math.min(callIdx, scoreSequences.length - 1)];
      callIdx++;
      return scores;
    },
    // Real Eagle reset() clears audio state, NOT the score index.
    // Our mock simulates sequential turns via callIdx, so don't reset it.
    reset() {},
    release() {},
  };
}

function createMockProfiler(): IEagleProfiler {
  return {
    minEnrollSamples: 16000,
    enroll() { return { percentage: 100, feedback: 'NONE' }; },
    export() { return new Uint8Array([0xDE, 0xAD]); },
    reset() {},
    release() {},
  };
}

function createMockFactory(scoreSequences: number[][]): IEagleFactory {
  return {
    createRecognizer() { return createMockEngine(scoreSequences); },
    createProfiler() { return createMockProfiler(); },
  };
}

function makePcmChunk(samples = FRAME_LENGTH): Buffer {
  return Buffer.alloc(samples * BYTES_PER_SAMPLE);
}

describe('Speaker Switch (mid-conversation)', () => {
  let tmpDir: string;
  const eagleConfig: EagleConfig = {
    enabled: true,
    accessKey: 'test-key',
    confidenceThreshold: 0.7,
    identifyFrames: 1, // identify after 1 frame for fast tests
  };

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `eagle-switch-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupEagle(scoreSequences: number[][], speakers: string[]): Promise<EagleAdapter> {
    // Write voiceprint files so Eagle loads them
    const vpDir = join(tmpDir, 'voiceprints');
    await mkdir(vpDir, { recursive: true });
    for (const name of speakers) {
      await writeFile(join(vpDir, `${name}.vp`), new Uint8Array([0x01]));
    }
    const config = { ...eagleConfig, voiceprintsDir: vpDir };
    const factory = createMockFactory(scoreSequences);
    const eagle = new EagleAdapter(config, factory);
    await eagle.initialize();
    return eagle;
  }

  it('C1: reset() allows re-identification on next turn', async () => {
    // Speakers sorted alphabetically: alice, charlie. Scores: [alice=0.95, charlie=0.2]
    const eagle = await setupEagle([[0.95, 0.2]], ['alice', 'charlie']);
    const identifier = new SpeakerIdentifier(eagle, eagleConfig);

    const r1 = identifier.feedAudio(makePcmChunk());
    expect(r1?.speakerId).toBe('alice');
    expect(identifier.isIdentified).toBe(true);

    // Cached result
    expect(identifier.feedAudio(makePcmChunk())?.speakerId).toBe('alice');

    // Reset
    identifier.reset();
    expect(identifier.isIdentified).toBe(false);

    // Can identify again
    const r2 = identifier.feedAudio(makePcmChunk());
    expect(r2).not.toBeNull();
    expect(r2?.speakerId).toBe('alice');
  });

  it('C2: detects speaker switch Alice → Charlie', async () => {
    // Alphabetical order: alice, charlie. Scores: [alice, charlie]
    const eagle = await setupEagle(
      [[0.95, 0.2], [0.1, 0.88]],
      ['alice', 'charlie'],
    );
    const identifier = new SpeakerIdentifier(eagle, eagleConfig);

    // Turn 1: Alice
    const r1 = identifier.feedAudio(makePcmChunk());
    expect(r1?.speakerId).toBe('alice');
    expect(r1!.confidence).toBeCloseTo(0.95);

    identifier.reset();

    // Turn 2: Charlie
    const r2 = identifier.feedAudio(makePcmChunk());
    expect(r2?.speakerId).toBe('charlie');
    expect(r2!.confidence).toBeCloseTo(0.88);
  });

  it('C5: unknown speaker when confidence below threshold', async () => {
    const eagle = await setupEagle([[0.3, 0.2]], ['alice', 'charlie']);
    const identifier = new SpeakerIdentifier(eagle, eagleConfig);

    const r = identifier.feedAudio(makePcmChunk());
    expect(r?.speakerId).toBeNull();
    expect(r!.confidence).toBeCloseTo(0.3);
  });

  it('C6: same speaker on consecutive turns — stable', async () => {
    const eagle = await setupEagle([[0.95], [0.92]], ['alice']);
    const identifier = new SpeakerIdentifier(eagle, eagleConfig);

    expect(identifier.feedAudio(makePcmChunk())?.speakerId).toBe('alice');
    identifier.reset();
    expect(identifier.feedAudio(makePcmChunk())?.speakerId).toBe('alice');
  });

  it('C7: rapid 3-turn switch Alice → Bob → Alice', async () => {
    // Alphabetical: alice, bob. Scores: [alice, bob]
    const eagle = await setupEagle(
      [[0.95, 0.1], [0.1, 0.9], [0.88, 0.15]],
      ['alice', 'bob'],
    );
    const identifier = new SpeakerIdentifier(eagle, eagleConfig);

    expect(identifier.feedAudio(makePcmChunk())?.speakerId).toBe('alice');
    identifier.reset();
    expect(identifier.feedAudio(makePcmChunk())?.speakerId).toBe('bob');
    identifier.reset();
    expect(identifier.feedAudio(makePcmChunk())?.speakerId).toBe('alice');
  });
});
