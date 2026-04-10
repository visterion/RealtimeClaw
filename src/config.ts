import { readFile } from 'node:fs/promises';
import type { BridgeConfig } from './types.js';
import { resolveProviderConfig, type ProviderType } from './realtime/providers.js';

function parseIntEnv(name: string, fallback: string): number {
  const value = parseInt(process.env[name] ?? fallback, 10);
  if (isNaN(value)) {
    throw new Error(`Invalid ${name}: ${process.env[name]}`);
  }
  return value;
}

function parseFloatEnv(name: string, fallback: string): number {
  const value = parseFloat(process.env[name] ?? fallback);
  if (isNaN(value)) {
    throw new Error(`Invalid ${name}: ${process.env[name]}`);
  }
  return value;
}

export function loadConfig(): BridgeConfig {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('XAI_API_KEY environment variable is required');
  }

  const port = parseIntEnv('WYOMING_PORT', '10300');
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid WYOMING_PORT: ${process.env.WYOMING_PORT}`);
  }

  const inputAudioRate = parseIntEnv('REALTIME_INPUT_AUDIO_RATE',
    process.env.REALTIME_AUDIO_RATE ?? '16000');
  const outputAudioRate = parseIntEnv('REALTIME_OUTPUT_AUDIO_RATE',
    process.env.REALTIME_AUDIO_RATE ?? '16000');

  const provider = (process.env.REALTIME_PROVIDER ?? 'xai') as ProviderType;
  const providerConfig = resolveProviderConfig(provider, {
    wsUrl: process.env.REALTIME_WS_URL,
    voice: process.env.REALTIME_VOICE,
  });

  return {
    wyomingPort: port,
    assistantName: process.env.ASSISTANT_NAME ?? 'Assistant',
    languages: (process.env.ASSISTANT_LANGUAGES ?? 'de,en').split(',').map((l) => l.trim()),
    realtime: {
      provider,
      wsUrl: providerConfig.wsUrl,
      apiKey,
      voice: providerConfig.voice,
      instructions: process.env.REALTIME_INSTRUCTIONS ?? '',
      inputAudioFormat: {
        type: 'audio/pcm',
        rate: inputAudioRate,
      },
      outputAudioFormat: {
        type: 'audio/pcm',
        rate: outputAudioRate,
      },
      turnDetection: {
        type: 'server_vad',
        threshold: parseFloatEnv('REALTIME_VAD_THRESHOLD', '0.85'),
        silence_duration_ms: parseIntEnv('REALTIME_SILENCE_DURATION_MS', '700'),
        prefix_padding_ms: parseIntEnv('REALTIME_PREFIX_PADDING_MS', '333'),
      },
      inputAudioTranscription: {
        model: process.env.REALTIME_TRANSCRIPTION_MODEL ?? 'grok-2-audio',
      },
    },
    context: {
      summarizeAtTokenRatio: 0.8,
      maxContextTokens: 128_000,
    },
    speaker: {
      deviceMap: process.env.SPEAKER_DEVICE_MAP ? JSON.parse(process.env.SPEAKER_DEVICE_MAP) : {},
      speakers: process.env.SPEAKER_CONFIG ? JSON.parse(process.env.SPEAKER_CONFIG) : {},
    },
    openclaw: process.env.OPENCLAW_URL
      ? {
          url: process.env.OPENCLAW_URL,
          token: (() => {
            const token = process.env.OPENCLAW_TOKEN;
            if (!token) throw new Error('OPENCLAW_TOKEN is required when OPENCLAW_URL is set');
            return token;
          })(),
          timeoutMs: parseIntEnv('OPENCLAW_TIMEOUT_MS', '10000'),
          deviceStorePath: process.env.OPENCLAW_DEVICE_STORE ?? './openclaw-device.json',
        }
      : undefined,
    eagle: {
      enabled: process.env.EAGLE_ENABLED === 'true',
      accessKey: process.env.EAGLE_ACCESS_KEY,
      modelPath: process.env.EAGLE_MODEL_PATH,
      voiceprintsDir: process.env.EAGLE_VOICEPRINTS_DIR,
      confidenceThreshold: parseFloatEnv('EAGLE_CONFIDENCE_THRESHOLD', '0.7'),
      identifyFrames: parseIntEnv('EAGLE_IDENTIFY_FRAMES', '10'),
    },
    security: {
      thresholds: {
        family: parseFloatEnv('SECURITY_THRESHOLD_FAMILY', '0.50'),
        trusted: parseFloatEnv('SECURITY_THRESHOLD_TRUSTED', '0.70'),
        owner: parseFloatEnv('SECURITY_THRESHOLD_OWNER', '0.90'),
      },
      speakerMaxLevel: process.env.SPEAKER_MAX_LEVELS
        ? JSON.parse(process.env.SPEAKER_MAX_LEVELS)
        : {},
    },
    toolRouter: {
      direct: (process.env.TOOL_ROUTE_DIRECT ?? 'ha_*,sonos_*,spotify_*,paperless_*,calendar_*,enroll_speaker')
        .split(',').map((s) => s.trim()),
      reasoning: (process.env.TOOL_ROUTE_REASONING ?? 'request_reasoning')
        .split(',').map((s) => s.trim()),
      dangerous: (process.env.TOOL_ROUTE_DANGEROUS ?? 'exec_*,file_delete_*')
        .split(',').map((s) => s.trim()),
      levelTools: process.env.TOOL_LEVEL_PERMISSIONS
        ? JSON.parse(process.env.TOOL_LEVEL_PERMISSIONS)
        : {
            guest:   ['ha_light_*', 'sonos_*', 'spotify_*'],
            family:  ['ha_climate_*', 'calendar_own'],
            trusted: ['paperless_titles_only', 'calendar_all'],
            owner:   ['paperless_full'],
          },
    },
    fallbackContext: {
      soul: process.env.REALTIME_SOUL || undefined,
      identity: process.env.REALTIME_IDENTITY || undefined,
      users: process.env.REALTIME_USERS || undefined,
    },
    debug: process.env.DEBUG_REALTIME_CLAW === 'true',
  };
}

/**
 * Load config from JSON file, with env vars as fallback for missing fields.
 */
export async function loadConfigFromFile(configPath?: string): Promise<BridgeConfig> {
  const filePath = configPath ?? process.env.CONFIG_FILE;
  if (!filePath) return loadConfig();

  try {
    const content = await readFile(filePath, 'utf-8');
    const fileConfig = JSON.parse(content) as Partial<BridgeConfig>;
    const envConfig = loadConfig();

    return {
      ...envConfig,
      ...fileConfig,
      realtime: { ...envConfig.realtime, ...fileConfig.realtime },
      context: { ...envConfig.context, ...fileConfig.context },
      speaker: { ...envConfig.speaker, ...fileConfig.speaker },
      openclaw: fileConfig.openclaw
        ? { ...envConfig.openclaw, ...fileConfig.openclaw }
        : envConfig.openclaw,
      eagle: { ...envConfig.eagle, ...fileConfig.eagle },
      security: { ...envConfig.security, ...fileConfig.security },
      toolRouter: { ...envConfig.toolRouter, ...fileConfig.toolRouter },
    } as BridgeConfig;
  } catch (err) {
    console.warn(`[Config] Could not load ${filePath}, falling back to env vars:`, (err as Error).message);
    return loadConfig();
  }
}
