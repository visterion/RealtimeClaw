// Wyoming Protocol types

export interface WyomingEvent {
  type: string;
  data?: Record<string, unknown>;
  data_length?: number;
  payload_length?: number;
}

export interface AudioConfig {
  rate: number;
  width: number;
  channels: number;
}

export interface WyomingAudioStart {
  type: 'audio-start';
  data: AudioConfig & { timestamp?: number };
  payload_length?: number;
}

export interface WyomingAudioChunk {
  type: 'audio-chunk';
  data: AudioConfig & { timestamp?: number };
  payload_length: number;
}

export interface WyomingAudioStop {
  type: 'audio-stop';
  data?: { timestamp?: number; [key: string]: unknown };
}

export interface WyomingTranscript {
  type: 'transcript';
  data: { text: string; [key: string]: unknown };
}

export interface WyomingDescribe {
  type: 'describe';
  data?: Record<string, unknown>;
}

export interface AsrServiceInfo {
  name: string;
  description?: string;
  installed: boolean;
  attribution?: { name: string; url: string };
  languages?: string[];
}

export interface TtsVoiceInfo {
  name: string;
  description?: string;
  languages?: string[];
}

export interface TtsServiceInfo {
  name: string;
  description?: string;
  installed: boolean;
  attribution?: { name: string; url: string };
  languages?: string[];
  voices?: TtsVoiceInfo[];
}

export interface WyomingInfo {
  type: 'info';
  data: {
    asr?: AsrServiceInfo[];
    tts?: TtsServiceInfo[];
    [key: string]: unknown;
  };
}

export type WyomingMessage = WyomingAudioStart | WyomingAudioChunk | WyomingAudioStop | WyomingTranscript | WyomingDescribe | WyomingInfo | WyomingEvent;

// xAI Realtime API types

export interface InputAudioTranscription {
  model: string;
}

export interface RealtimeConfig {
  provider: 'xai' | 'openai' | 'inworld';
  wsUrl: string;
  apiKey: string;
  voice: string;
  instructions: string;
  inputAudioFormat: AudioFormat;
  outputAudioFormat: AudioFormat;
  turnDetection: TurnDetection;
  inputAudioTranscription?: InputAudioTranscription;
  tools?: RealtimeTool[];
}

export interface AudioFormat {
  type: 'audio/pcm' | 'audio/pcmu' | 'audio/pcma';
  rate: number;
}

export interface TurnDetection {
  type: 'server_vad' | null;
  threshold?: number;
  silence_duration_ms?: number;
  prefix_padding_ms?: number;
}

export interface RealtimeTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// Server → Client events (discriminated union)
export type RealtimeServerEvent =
  | { type: 'session.created'; session: { id: string } }
  | { type: 'session.updated'; session: Record<string, unknown> }
  | { type: 'conversation.created'; conversation: { id: string } }
  | { type: 'input_audio_buffer.speech_started'; item_id?: string }
  | { type: 'input_audio_buffer.speech_stopped'; item_id?: string }
  | { type: 'input_audio_buffer.committed'; item_id: string }
  | { type: 'response.created'; response: { id: string; status: string } }
  | { type: 'response.output_audio.delta'; response_id: string; item_id: string; delta: string }
  | { type: 'response.output_audio.done'; response_id: string; item_id: string }
  | { type: 'response.output_audio_transcript.delta'; response_id: string; item_id: string; delta: string }
  | { type: 'response.output_audio_transcript.done'; response_id: string; item_id: string; transcript?: string }
  | { type: 'conversation.item.input_audio_transcription.completed'; item_id: string; transcript: string }
  | { type: 'response.function_call_arguments.done'; call_id: string; name: string; arguments: string }
  | { type: 'response.done'; response: { id: string; status: string } }
  | { type: 'error'; error: { type: string; code?: string; message: string } };

// Context config — soul/memory content lives in OpenClaw, not local files
export interface ContextConfig {
  summarizeAtTokenRatio: number;
  maxContextTokens: number;
}

export interface SpeakerConfig {
  deviceMap: Record<string, string>;
  speakers: Record<string, { displayName: string; contextKey: string }>;
}

export interface EagleConfig {
  enabled: boolean;
  accessKey?: string;
  modelPath?: string;
  voiceprintsDir?: string;
  confidenceThreshold: number;
  /** Number of initial audio frames to buffer for identification */
  identifyFrames: number;
}


export interface SecurityConfig {
  thresholds: { family: number; trusted: number; owner: number };
  speakerMaxLevel: Record<string, 'guest' | 'family' | 'trusted' | 'owner'>;
}

export interface ToolRouterConfig {
  direct: string[];
  reasoning: string[];
  dangerous: string[];
  levelTools: Record<'guest' | 'family' | 'trusted' | 'owner', string[]>;
}

export interface OpenClawConfig {
  url: string;
  token: string;
  timeoutMs: number;
  deviceStorePath?: string;
}

// Bridge config
export interface BridgeConfig {
  wyomingPort: number;
  assistantName: string;
  languages: string[];
  realtime: RealtimeConfig;
  context: ContextConfig;
  speaker: SpeakerConfig;
  eagle: EagleConfig;
  security: SecurityConfig;
  toolRouter: ToolRouterConfig;
  openclaw?: OpenClawConfig;
  fallbackContext?: {
    soul?: string;
    identity?: string;
    users?: string;
  };
  debug?: boolean;
}
