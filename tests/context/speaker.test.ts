import { describe, it, expect } from 'vitest';
import { SpeakerResolver } from '../../src/context/speaker.js';

const testConfig = {
  deviceMap: {
    'kitchen-satellite': 'alice',
    'livingroom-satellite': 'bob',
  },
  speakers: {
    alice: { displayName: 'Alice', contextKey: 'alice' },
    bob: { displayName: 'Bob', contextKey: 'bob' },
    charlie: { displayName: 'Charlie', contextKey: 'charlie' },
    dana: { displayName: 'Dana', contextKey: 'dana' },
  },
};

describe('SpeakerResolver', () => {
  it('resolves speaker from device ID', () => {
    const resolver = new SpeakerResolver(testConfig);
    const speaker = resolver.resolve('session-1', 'kitchen-satellite');

    expect(speaker).not.toBeNull();
    expect(speaker!.id).toBe('alice');
    expect(speaker!.displayName).toBe('Alice');
  });

  it('returns null for unknown device', () => {
    const resolver = new SpeakerResolver(testConfig);
    const speaker = resolver.resolve('session-1', 'unknown-device');

    expect(speaker).toBeNull();
  });

  it('returns null without device ID', () => {
    const resolver = new SpeakerResolver(testConfig);
    const speaker = resolver.resolve('session-1');

    expect(speaker).toBeNull();
  });

  it('caches speaker for session', () => {
    const resolver = new SpeakerResolver(testConfig);

    // First call resolves from device map
    resolver.resolve('session-1', 'kitchen-satellite');

    // Second call uses cache (no device ID needed)
    const speaker = resolver.resolve('session-1');
    expect(speaker!.id).toBe('alice');
  });

  it('allows manual speaker override', () => {
    const resolver = new SpeakerResolver(testConfig);

    resolver.setSessionSpeaker('session-1', 'charlie');
    const speaker = resolver.resolve('session-1');

    expect(speaker!.id).toBe('charlie');
    expect(speaker!.displayName).toBe('Charlie');
  });

  it('clears session cache', () => {
    const resolver = new SpeakerResolver(testConfig);

    resolver.setSessionSpeaker('session-1', 'charlie');
    resolver.clearSession('session-1');

    const speaker = resolver.resolve('session-1');
    expect(speaker).toBeNull();
  });

  it('builds speaker context string', () => {
    const resolver = new SpeakerResolver(testConfig);
    const context = resolver.buildSpeakerContext('alice');

    expect(context).toContain('Alice');
    expect(context).toContain('alice');
  });

  it('returns null for unknown speaker context', () => {
    const resolver = new SpeakerResolver(testConfig);
    const context = resolver.buildSpeakerContext('unknown');

    expect(context).toBeNull();
  });

  it('lists all speaker IDs', () => {
    const resolver = new SpeakerResolver(testConfig);
    const ids = resolver.getSpeakerIds();

    expect(ids).toContain('alice');
    expect(ids).toContain('bob');
    expect(ids).toContain('charlie');
    expect(ids).toContain('dana');
    expect(ids).toHaveLength(4);
  });
});
