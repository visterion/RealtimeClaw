import { describe, it, expect } from 'vitest';
import {
  type SecurityLevel,
  getSecurityLevel,
  getEffectiveLevel,
  SECURITY_LEVEL_ORDER,
} from '../../src/security/levels.js';

describe('getSecurityLevel', () => {
  it('returns guest when confidence < 0.50', () => {
    expect(getSecurityLevel(0.0)).toBe('guest');
    expect(getSecurityLevel(0.3)).toBe('guest');
    expect(getSecurityLevel(0.49)).toBe('guest');
  });

  it('returns family when confidence 0.50–0.69', () => {
    expect(getSecurityLevel(0.50)).toBe('family');
    expect(getSecurityLevel(0.60)).toBe('family');
    expect(getSecurityLevel(0.69)).toBe('family');
  });

  it('returns trusted when confidence 0.70–0.89', () => {
    expect(getSecurityLevel(0.70)).toBe('trusted');
    expect(getSecurityLevel(0.80)).toBe('trusted');
    expect(getSecurityLevel(0.89)).toBe('trusted');
  });

  it('returns owner when confidence >= 0.90', () => {
    expect(getSecurityLevel(0.90)).toBe('owner');
    expect(getSecurityLevel(0.95)).toBe('owner');
    expect(getSecurityLevel(1.0)).toBe('owner');
  });

  it('uses configurable thresholds', () => {
    const thresholds = { family: 0.40, trusted: 0.60, owner: 0.80 };
    expect(getSecurityLevel(0.39, thresholds)).toBe('guest');
    expect(getSecurityLevel(0.40, thresholds)).toBe('family');
    expect(getSecurityLevel(0.60, thresholds)).toBe('trusted');
    expect(getSecurityLevel(0.80, thresholds)).toBe('owner');
  });
});

describe('getEffectiveLevel', () => {
  const speakerMaxLevels: Record<string, SecurityLevel> = {
    alice: 'owner',
    bob: 'owner',
    charlie: 'family',
    dana: 'family',
  };

  it('caps charlie at family even with 99% confidence', () => {
    expect(getEffectiveLevel(0.99, 'charlie', speakerMaxLevels)).toBe('family');
  });

  it('caps dana at family even with 95% confidence', () => {
    expect(getEffectiveLevel(0.95, 'dana', speakerMaxLevels)).toBe('family');
  });

  it('allows alice to reach owner at 95%', () => {
    expect(getEffectiveLevel(0.95, 'alice', speakerMaxLevels)).toBe('owner');
  });

  it('limits alice to trusted at 75%', () => {
    expect(getEffectiveLevel(0.75, 'alice', speakerMaxLevels)).toBe('trusted');
  });

  it('defaults unknown speakers to guest', () => {
    expect(getEffectiveLevel(0.99, 'stranger', speakerMaxLevels)).toBe('guest');
  });

  it('defaults undefined speakerId to guest', () => {
    expect(getEffectiveLevel(0.99, undefined, speakerMaxLevels)).toBe('guest');
  });

  it('returns guest for low confidence regardless of speaker', () => {
    expect(getEffectiveLevel(0.30, 'alice', speakerMaxLevels)).toBe('guest');
  });
});

describe('SECURITY_LEVEL_ORDER', () => {
  it('orders guest < family < trusted < owner', () => {
    expect(SECURITY_LEVEL_ORDER.indexOf('guest'))
      .toBeLessThan(SECURITY_LEVEL_ORDER.indexOf('family'));
    expect(SECURITY_LEVEL_ORDER.indexOf('family'))
      .toBeLessThan(SECURITY_LEVEL_ORDER.indexOf('trusted'));
    expect(SECURITY_LEVEL_ORDER.indexOf('trusted'))
      .toBeLessThan(SECURITY_LEVEL_ORDER.indexOf('owner'));
  });
});
