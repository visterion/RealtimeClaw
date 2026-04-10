// tests/tools/verify.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyConfig } from '../../src/tools/verify.js';
import type { BridgeConfig } from '../../src/types.js';

// Prevent real network calls
vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in tests')));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('verifyConfig', () => {
  it('returns error when no xAI key', async () => {
    const results = await verifyConfig({
      realtime: { apiKey: '', wsUrl: '' },
    } as unknown as BridgeConfig);

    const xai = results.find((r) => r.name === 'xAI');
    expect(xai?.status).toBe('error');
    expect(xai?.message).toBe('not configured');
  });

  it('returns skip for unconfigured OpenClaw', async () => {
    const results = await verifyConfig({
      realtime: { apiKey: '', wsUrl: '' },
    } as unknown as BridgeConfig);

    const openclaw = results.find((r) => r.name === 'OpenClaw');
    expect(openclaw?.status).toBe('skip');
    expect(openclaw?.message).toBe('not configured');
  });

  it('returns skip for disabled Eagle', async () => {
    const results = await verifyConfig({
      realtime: { apiKey: '', wsUrl: '' },
      eagle: { enabled: false },
    } as unknown as BridgeConfig);

    const eagle = results.find((r) => r.name === 'Eagle');
    expect(eagle?.status).toBe('skip');
    expect(eagle?.message).toBe('disabled');
  });

  it('returns error for enabled Eagle without accessKey', async () => {
    const results = await verifyConfig({
      realtime: { apiKey: '', wsUrl: '' },
      eagle: { enabled: true, accessKey: undefined },
    } as unknown as BridgeConfig);

    const eagle = results.find((r) => r.name === 'Eagle');
    expect(eagle?.status).toBe('error');
    expect(eagle?.message).toContain('no accessKey');
  });

  it('returns skip for unconfigured HA (no HA_URL env)', async () => {
    vi.unstubAllEnvs();
    delete process.env.HA_URL;
    delete process.env.HA_TOKEN;

    const results = await verifyConfig({
      realtime: { apiKey: '', wsUrl: '' },
    } as unknown as BridgeConfig);

    const ha = results.find((r) => r.name === 'HA');
    expect(ha?.status).toBe('skip');
    expect(ha?.message).toContain('not configured');
  });
});
