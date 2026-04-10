import type { BridgeConfig } from '../src/types.js';

export function createTestConfig(wyomingPort: number, realtimePort: number): BridgeConfig {
  return {
    wyomingPort,
    assistantName: 'Assistant',
    languages: ['de', 'en'],
    realtime: {
      provider: 'xai' as const,
      wsUrl: `ws://127.0.0.1:${realtimePort}`,
      apiKey: 'test-key',
      voice: 'rex',
      instructions: 'Test instructions',
      inputAudioFormat: { type: 'audio/pcm', rate: 16000 },
      outputAudioFormat: { type: 'audio/pcm', rate: 16000 },
      turnDetection: { type: 'server_vad', threshold: 0.85, silence_duration_ms: 500 },
    },
    context: {
      summarizeAtTokenRatio: 0.8,
      maxContextTokens: 128_000,
    },
    speaker: {
      deviceMap: {},
      speakers: {},
    },
    memory: {
      enabled: false,
    },
    eagle: {
      enabled: false,
      confidenceThreshold: 0.7,
      identifyFrames: 10,
    },
    security: {
      thresholds: { family: 0.50, trusted: 0.70, owner: 0.90 },
      speakerMaxLevel: {
        alice: 'owner' as const,
        bob: 'owner' as const,
        charlie: 'family' as const,
        dana: 'family' as const,
      },
    },
    toolRouter: {
      direct: ['ha_*', 'sonos_*', 'spotify_*', 'paperless_*', 'calendar_*'],
      reasoning: ['request_reasoning'],
      dangerous: ['exec_*', 'file_delete_*'],
      levelTools: {
        guest:   ['ha_light_*', 'sonos_*', 'spotify_*'],
        family:  ['ha_climate_*', 'calendar_own'],
        trusted: ['paperless_titles_only', 'calendar_all'],
        owner:   ['paperless_full'],
      },
    },
  };
}
