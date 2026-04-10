// src/realtime/providers.ts
import { type ReconnectConfig, DEFAULT_RECONNECT_CONFIG } from './reconnect.js';

export type ProviderType = 'xai' | 'openai' | 'inworld';

export interface ProviderPreset {
  wsUrl: string;
  defaultVoice: string;
  supportedAudioFormats: string[];
  reconnect: ReconnectConfig;
}

export const PROVIDER_PRESETS: Record<ProviderType, ProviderPreset> = {
  xai: {
    wsUrl: 'wss://api.x.ai/v1/realtime',
    defaultVoice: 'eve',
    supportedAudioFormats: ['audio/pcm', 'audio/pcmu', 'audio/pcma'],
    reconnect: { ...DEFAULT_RECONNECT_CONFIG, maxRetries: 5 },
  },
  openai: {
    wsUrl: 'wss://api.openai.com/v1/realtime',
    defaultVoice: 'alloy',
    supportedAudioFormats: ['audio/pcm'],
    reconnect: { ...DEFAULT_RECONNECT_CONFIG, maxRetries: 3, initialDelayMs: 300 },
  },
  inworld: {
    wsUrl: 'wss://api.inworld.ai/v1/realtime',
    defaultVoice: 'default',
    supportedAudioFormats: ['audio/pcm'],
    reconnect: { ...DEFAULT_RECONNECT_CONFIG, maxRetries: 5, initialDelayMs: 150 },
  },
};

export interface ResolvedProviderConfig {
  wsUrl: string;
  voice: string;
  supportedAudioFormats: string[];
  reconnect: ReconnectConfig;
}

export function resolveProviderConfig(
  provider: ProviderType,
  overrides: { wsUrl?: string; voice?: string },
): ResolvedProviderConfig {
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) {
    throw new Error(`Unknown provider: ${provider}. Valid: ${Object.keys(PROVIDER_PRESETS).join(', ')}`);
  }
  return {
    wsUrl: overrides.wsUrl ?? preset.wsUrl,
    voice: overrides.voice ?? preset.defaultVoice,
    supportedAudioFormats: preset.supportedAudioFormats,
    reconnect: preset.reconnect,
  };
}
