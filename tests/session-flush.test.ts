// tests/session-flush.test.ts
import { describe, it, expect } from 'vitest';
import { shouldFlush } from '../src/session/flush.js';

describe('shouldFlush', () => {
  it('returns false for short tool-only session', () => {
    expect(shouldFlush({ hadReasoning: false, transcriptTokens: 50 })).toBe(false);
  });

  it('returns true when reasoning was active', () => {
    expect(shouldFlush({ hadReasoning: true, transcriptTokens: 10 })).toBe(true);
  });

  it('returns true for long conversation > 200 tokens', () => {
    expect(shouldFlush({ hadReasoning: false, transcriptTokens: 250 })).toBe(true);
  });

  it('returns false at exactly 200 tokens without reasoning', () => {
    expect(shouldFlush({ hadReasoning: false, transcriptTokens: 200 })).toBe(false);
  });

  it('uses configurable token threshold', () => {
    expect(shouldFlush({ hadReasoning: false, transcriptTokens: 100 }, 50)).toBe(true);
  });
});
