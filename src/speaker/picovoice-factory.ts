// src/speaker/picovoice-factory.ts
// Real Picovoice Eagle SDK binding — adapts @picovoice/eagle-node to IEagleFactory interface.
// Eagle is an optional dependency — dynamic import so builds succeed without it.
import type { IEagleFactory, IEagleEngine, IEagleProfiler } from './eagle.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let eagleModule: any = null;

async function ensureEagleLoaded(): Promise<void> {
  if (eagleModule) return;
  try {
    eagleModule = await import('@picovoice/eagle-node');
  } catch {
    throw new Error('Picovoice Eagle SDK not installed. Run: npm install @picovoice/eagle-node');
  }
}

/**
 * Real Picovoice Eagle factory — creates SDK instances bound to IEagleFactory.
 * Requires `@picovoice/eagle-node` optional dependency to be installed.
 * Call `init()` before using createRecognizer/createProfiler.
 */
export class PicovoiceEagleFactory implements IEagleFactory {
  /** Load the Eagle SDK. Must be called once before createRecognizer/createProfiler. */
  async init(): Promise<void> {
    await ensureEagleLoaded();
  }

  createRecognizer(accessKey: string, profiles: Uint8Array[], modelPath?: string): IEagleEngine {
    if (!eagleModule) throw new Error('Call PicovoiceEagleFactory.init() first');
    const options: Record<string, unknown> = {};
    if (modelPath) options.modelPath = modelPath;

    const eagle = new eagleModule.Eagle(accessKey, options);
    return {
      sampleRate: eagle.sampleRate as number,
      frameLength: eagle.minProcessSamples as number,
      process(pcm: Int16Array): number[] {
        const result = eagle.process(pcm, profiles);
        return result ?? profiles.map(() => 0);
      },
      reset() { /* Eagle v3 is stateless per process() call */ },
      release() { eagle.release(); },
    };
  }

  createProfiler(accessKey: string, modelPath?: string): IEagleProfiler {
    if (!eagleModule) throw new Error('Call PicovoiceEagleFactory.init() first');
    const options: Record<string, unknown> = {};
    if (modelPath) options.modelPath = modelPath;

    const profiler = new eagleModule.EagleProfiler(accessKey, options);
    return {
      minEnrollSamples: profiler.sampleRate as number,
      enroll(pcm: Int16Array): { percentage: number; feedback: string } {
        const percentage = profiler.enroll(pcm) as number;
        return { percentage, feedback: 'NONE' };
      },
      export(): Uint8Array { return profiler.export(); },
      reset() { profiler.reset(); },
      release() { profiler.release(); },
    };
  }
}
