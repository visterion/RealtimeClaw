/**
 * Tracks timestamps at named points in the audio pipeline.
 * Used to measure TTFA, function call latency, etc.
 */
export class LatencyTracker {
  private marks = new Map<string, number>();

  mark(name: string): void {
    this.marks.set(name, Date.now());
  }

  measure(name: string): number {
    const start = this.marks.get(name);
    if (start === undefined) return -1;
    return Date.now() - start;
  }

  measureBetween(startMark: string, endMark: string): number {
    const start = this.marks.get(startMark);
    const end = this.marks.get(endMark);
    if (start === undefined || end === undefined) return -1;
    return end - start;
  }

  reset(): void {
    this.marks.clear();
  }

  toJSON(): Record<string, number> {
    const now = Date.now();
    const result: Record<string, number> = {};
    for (const [name, start] of this.marks) {
      result[name] = now - start;
    }
    return result;
  }
}
