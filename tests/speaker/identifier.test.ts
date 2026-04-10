import { describe, it, expect } from 'vitest';
import { EagleAdapter, type IEagleFactory, type IEagleEngine } from '../../src/speaker/eagle.js';
import { SpeakerIdentifier } from '../../src/speaker/identifier.js';
import type { EagleConfig } from '../../src/types.js';

function createMockFactory(scores: number[]): IEagleFactory {
  return {
    createRecognizer(): IEagleEngine {
      return {
        sampleRate: 16000,
        frameLength: 512,
        process(): number[] { return scores; },
        reset() {},
        release() {},
      };
    },
    createProfiler() {
      return {
        minEnrollSamples: 16000,
        enroll() { return { percentage: 100, feedback: 'NONE' }; },
        export() { return new Uint8Array([1, 2, 3]); },
        reset() {},
        release() {},
      };
    },
  };
}

async function createReadyAdapter(scores: number[]): Promise<EagleAdapter> {
  const config: EagleConfig = {
    enabled: true,
    accessKey: 'test',
    confidenceThreshold: 0.7,
    identifyFrames: 3,
  };
  const adapter = new EagleAdapter(config, createMockFactory(scores));

  // Enroll a dummy speaker so initialize() creates engine
  const frames = Array.from({ length: 5 }, () => new Int16Array(512));
  await adapter.enroll('alice', frames);
  await adapter.initialize();
  return adapter;
}

describe('SpeakerIdentifier', () => {
  const identifyConfig: EagleConfig = {
    enabled: true,
    accessKey: 'test',
    confidenceThreshold: 0.7,
    identifyFrames: 3, // Need 3 * 512 = 1536 samples
  };

  it('does not identify until enough frames buffered', async () => {
    const adapter = await createReadyAdapter([0.95]);
    const identifier = new SpeakerIdentifier(adapter, identifyConfig);

    // Send 1 frame of 512 samples = 1024 bytes (less than 3 frames needed)
    const result1 = identifier.feedAudio(Buffer.alloc(1024));
    expect(result1).toBeNull();
    expect(identifier.isIdentified).toBe(false);
  });

  it('identifies after enough frames', async () => {
    const adapter = await createReadyAdapter([0.95]);
    const identifier = new SpeakerIdentifier(adapter, identifyConfig);

    // Feed 3 frames * 512 samples * 2 bytes = 3072 bytes
    identifier.feedAudio(Buffer.alloc(1024)); // 512 samples
    identifier.feedAudio(Buffer.alloc(1024)); // 512 samples
    const result = identifier.feedAudio(Buffer.alloc(1024)); // 512 samples = 1536 total

    expect(result).not.toBeNull();
    expect(result!.speakerId).toBe('alice');
    expect(result!.confidence).toBe(0.95);
    expect(identifier.isIdentified).toBe(true);
  });

  it('returns null speaker below threshold', async () => {
    const adapter = await createReadyAdapter([0.3]); // Below 0.7
    const identifier = new SpeakerIdentifier(adapter, identifyConfig);

    identifier.feedAudio(Buffer.alloc(1024));
    identifier.feedAudio(Buffer.alloc(1024));
    const result = identifier.feedAudio(Buffer.alloc(1024));

    expect(result).not.toBeNull();
    expect(result!.speakerId).toBeNull();
    expect(result!.confidence).toBe(0.3);
  });

  it('does not re-identify after first result', async () => {
    const adapter = await createReadyAdapter([0.95]);
    const identifier = new SpeakerIdentifier(adapter, identifyConfig);

    // First identification
    identifier.feedAudio(Buffer.alloc(1024));
    identifier.feedAudio(Buffer.alloc(1024));
    identifier.feedAudio(Buffer.alloc(1024));

    // Additional audio should return cached result
    const result = identifier.feedAudio(Buffer.alloc(1024));
    expect(result!.speakerId).toBe('alice');
  });

  it('resets for new identification', async () => {
    const adapter = await createReadyAdapter([0.95]);
    const identifier = new SpeakerIdentifier(adapter, identifyConfig);

    identifier.feedAudio(Buffer.alloc(1024));
    identifier.feedAudio(Buffer.alloc(1024));
    identifier.feedAudio(Buffer.alloc(1024));
    expect(identifier.isIdentified).toBe(true);

    identifier.reset();
    expect(identifier.isIdentified).toBe(false);
    expect(identifier.getResult()).toBeNull();
  });

  it('handles large single chunk', async () => {
    const adapter = await createReadyAdapter([0.85]);
    const identifier = new SpeakerIdentifier(adapter, identifyConfig);

    // Send all 1536 samples in one chunk = 3072 bytes
    const result = identifier.feedAudio(Buffer.alloc(3072));

    expect(result).not.toBeNull();
    expect(result!.speakerId).toBe('alice');
  });

  it('returns null when Eagle not ready', () => {
    const config: EagleConfig = {
      enabled: true,
      accessKey: 'test',
      confidenceThreshold: 0.7,
      identifyFrames: 3,
    };
    // Not initialized adapter
    const adapter = new EagleAdapter(config, createMockFactory([0.95]));
    const identifier = new SpeakerIdentifier(adapter, config);

    const result = identifier.feedAudio(Buffer.alloc(3072));
    expect(result).toBeNull();
  });
});
