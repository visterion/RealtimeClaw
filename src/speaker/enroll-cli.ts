import { readFile } from 'node:fs/promises';
import { EagleAdapter, type IEagleFactory } from './eagle.js';
import type { EagleConfig } from '../types.js';

/**
 * CLI entry point for speaker enrollment.
 * Usage: npx tsx src/speaker/enroll-cli.ts <speaker-id> <audio-file.raw>
 *
 * Audio file must be raw PCM: 16kHz, 16-bit, mono, little-endian.
 * Requires EAGLE_ACCESS_KEY environment variable.
 */
export async function enrollSpeaker(
  speakerId: string,
  audioPath: string,
  factory: IEagleFactory,
  config?: Partial<EagleConfig>,
): Promise<void> {
  const accessKey = config?.accessKey ?? process.env.EAGLE_ACCESS_KEY;
  if (!accessKey) {
    throw new Error('EAGLE_ACCESS_KEY environment variable required');
  }

  const eagleConfig: EagleConfig = {
    enabled: true,
    accessKey,
    modelPath: config?.modelPath,
    voiceprintsDir: config?.voiceprintsDir ?? process.env.EAGLE_VOICEPRINTS_DIR ?? './voiceprints',
    confidenceThreshold: config?.confidenceThreshold ?? 0.7,
    identifyFrames: config?.identifyFrames ?? 10,
  };

  const adapter = new EagleAdapter(eagleConfig, factory);

  console.log(`Reading audio from ${audioPath}...`);
  const rawAudio = await readFile(audioPath);
  // Ensure even byte count for 16-bit PCM alignment
  const alignedLength = rawAudio.length & ~1;
  if (rawAudio.length !== alignedLength) {
    console.warn(`[Eagle] Audio file has odd byte count (${rawAudio.length}), truncating last byte`);
  }
  const samples = new Int16Array(rawAudio.buffer, rawAudio.byteOffset, alignedLength / 2);

  // Split into frames (512 samples each — Eagle's default frame length)
  const frameLength = 512;
  const frames: Int16Array[] = [];
  for (let i = 0; i + frameLength <= samples.length; i += frameLength) {
    frames.push(samples.slice(i, i + frameLength));
  }

  console.log(`Enrolling "${speakerId}" with ${frames.length} frames (${(samples.length / 16000).toFixed(1)}s audio)...`);

  const result = await adapter.enroll(speakerId, frames);
  if (result.success) {
    console.log(`Done: ${result.message}`);
  } else {
    console.error(`Failed: ${result.message}`);
    process.exit(1);
  }
}
