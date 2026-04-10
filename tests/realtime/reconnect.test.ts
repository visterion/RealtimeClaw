// tests/realtime/reconnect.test.ts
import { describe, it, expect } from 'vitest';
import { calculateBackoff, DEFAULT_RECONNECT_CONFIG, type ReconnectConfig } from '../../src/realtime/reconnect.js';

describe('calculateBackoff', () => {
  const config: ReconnectConfig = {
    maxRetries: 5,
    initialDelayMs: 100,
    maxDelayMs: 10000,
    backoffFactor: 2.0,
  };

  it('returns delay near initialDelayMs for attempt 0', () => {
    const delay = calculateBackoff(0, config);
    expect(delay).toBeGreaterThanOrEqual(config.initialDelayMs * 0.5);
    expect(delay).toBeLessThanOrEqual(config.initialDelayMs * 1.5);
  });

  it('increases delay for higher attempts', () => {
    const delays = Array.from({ length: 5 }, (_, i) => calculateBackoff(i, config));
    // On average, each delay should be larger than the previous (allow jitter)
    const avgFirst = (calculateBackoff(0, config) + calculateBackoff(0, config) + calculateBackoff(0, config)) / 3;
    const avgLast = (calculateBackoff(4, config) + calculateBackoff(4, config) + calculateBackoff(4, config)) / 3;
    expect(avgLast).toBeGreaterThan(avgFirst);
  });

  it('caps at maxDelayMs', () => {
    for (let i = 0; i < 10; i++) {
      expect(calculateBackoff(100, config)).toBeLessThanOrEqual(config.maxDelayMs);
    }
  });

  it('never returns negative or zero', () => {
    for (let i = 0; i < 20; i++) {
      expect(calculateBackoff(i, config)).toBeGreaterThan(0);
    }
  });
});

describe('DEFAULT_RECONNECT_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_RECONNECT_CONFIG.maxRetries).toBeGreaterThan(0);
    expect(DEFAULT_RECONNECT_CONFIG.initialDelayMs).toBeGreaterThan(0);
    expect(DEFAULT_RECONNECT_CONFIG.maxDelayMs).toBeGreaterThan(DEFAULT_RECONNECT_CONFIG.initialDelayMs);
    expect(DEFAULT_RECONNECT_CONFIG.backoffFactor).toBeGreaterThan(1);
  });
});
