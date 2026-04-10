// tests/realtime/providers.test.ts
import { describe, it, expect } from 'vitest';
import {
  type ProviderType,
  PROVIDER_PRESETS,
  resolveProviderConfig,
} from '../../src/realtime/providers.js';

describe('PROVIDER_PRESETS', () => {
  it('has xai preset', () => {
    expect(PROVIDER_PRESETS.xai).toBeDefined();
    expect(PROVIDER_PRESETS.xai.wsUrl).toContain('x.ai');
    expect(PROVIDER_PRESETS.xai.defaultVoice).toBe('eve');
  });

  it('has openai preset', () => {
    expect(PROVIDER_PRESETS.openai).toBeDefined();
    expect(PROVIDER_PRESETS.openai.wsUrl).toContain('openai.com');
    expect(PROVIDER_PRESETS.openai.defaultVoice).toBe('alloy');
  });

  it('has inworld preset', () => {
    expect(PROVIDER_PRESETS.inworld).toBeDefined();
    expect(PROVIDER_PRESETS.inworld.wsUrl).toContain('inworld');
  });
});

describe('resolveProviderConfig', () => {
  it('returns xai defaults when provider is xai and no overrides', () => {
    const result = resolveProviderConfig('xai', {});
    expect(result.wsUrl).toBe(PROVIDER_PRESETS.xai.wsUrl);
    expect(result.voice).toBe('eve');
  });

  it('allows overriding wsUrl', () => {
    const result = resolveProviderConfig('xai', { wsUrl: 'wss://custom.url' });
    expect(result.wsUrl).toBe('wss://custom.url');
  });

  it('allows overriding voice', () => {
    const result = resolveProviderConfig('openai', { voice: 'nova' });
    expect(result.voice).toBe('nova');
  });

  it('returns provider-specific audio formats', () => {
    const xai = resolveProviderConfig('xai', {});
    expect(xai.supportedAudioFormats).toContain('audio/pcm');

    const openai = resolveProviderConfig('openai', {});
    expect(openai.supportedAudioFormats).toContain('audio/pcm');
  });

  it('includes reconnect config from provider defaults', () => {
    const result = resolveProviderConfig('xai', {});
    expect(result.reconnect).toBeDefined();
    expect(result.reconnect.maxRetries).toBeGreaterThan(0);
  });

  it('throws for unknown provider', () => {
    expect(() => resolveProviderConfig('unknown' as ProviderType, {})).toThrow();
  });
});
