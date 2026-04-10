// tests/realtime/latency.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LatencyTracker } from '../../src/realtime/latency.js';

describe('LatencyTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('records start and measures duration', () => {
    const tracker = new LatencyTracker();
    tracker.mark('audio_received');
    vi.advanceTimersByTime(150);
    expect(tracker.measure('audio_received')).toBe(150);
  });

  it('returns -1 for unknown marks', () => {
    const tracker = new LatencyTracker();
    expect(tracker.measure('nonexistent')).toBe(-1);
  });

  it('tracks multiple independent marks', () => {
    const tracker = new LatencyTracker();
    tracker.mark('step_a');
    vi.advanceTimersByTime(100);
    tracker.mark('step_b');
    vi.advanceTimersByTime(50);
    expect(tracker.measure('step_a')).toBe(150);
    expect(tracker.measure('step_b')).toBe(50);
  });

  it('measures duration between two marks', () => {
    const tracker = new LatencyTracker();
    tracker.mark('start');
    vi.advanceTimersByTime(200);
    tracker.mark('end');
    expect(tracker.measureBetween('start', 'end')).toBe(200);
  });

  it('returns -1 for measureBetween with missing marks', () => {
    const tracker = new LatencyTracker();
    tracker.mark('start');
    expect(tracker.measureBetween('start', 'missing')).toBe(-1);
    expect(tracker.measureBetween('missing', 'start')).toBe(-1);
  });

  it('reset clears all marks', () => {
    const tracker = new LatencyTracker();
    tracker.mark('test');
    tracker.reset();
    expect(tracker.measure('test')).toBe(-1);
  });

  it('toJSON returns all marks with durations', () => {
    const tracker = new LatencyTracker();
    tracker.mark('a');
    vi.advanceTimersByTime(100);
    tracker.mark('b');
    vi.advanceTimersByTime(50);
    const json = tracker.toJSON();
    expect(json.a).toBe(150);
    expect(json.b).toBe(50);
  });
});
