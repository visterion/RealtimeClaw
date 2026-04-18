import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { calculateBackoff, type ReconnectConfig, DEFAULT_RECONNECT_CONFIG } from './reconnect.js';
import type {
  RealtimeConfig,
  RealtimeServerEvent,
  TurnDetection,
  AudioFormat,
  RealtimeTool,
} from '../types.js';

interface RealtimeClientEvents {
  'open': [];
  'close': [code: number, reason: string];
  'error': [error: Error];
  'session.created': [session: { id: string }];
  'session.updated': [];
  'speech_started': [];
  'speech_stopped': [];
  'audio_delta': [pcm: Buffer];
  'audio_done': [];
  'transcript_delta': [text: string];
  'transcript_done': [text: string];
  'function_call': [callId: string, name: string, args: string];
  'response_done': [responseId: string];
  'server_event': [event: RealtimeServerEvent];
}

const MAX_TRANSCRIPT_LENGTH = 100_000;

export class RealtimeClient extends EventEmitter<RealtimeClientEvents> {
  private ws: WebSocket | null = null;
  private config: RealtimeConfig;
  private transcriptBuffer = '';
  private debug = false;

  constructor(config: RealtimeConfig) {
    super();
    this.config = config;
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
      });

      const onOpen = () => {
        cleanup();
        this.ws = ws;
        this.setupListeners(ws);
        this.sendSessionUpdate();
        resolve();
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        ws.removeListener('open', onOpen);
        ws.removeListener('error', onError);
      };

      ws.once('open', onOpen);
      ws.once('error', onError);
    });
  }

  /** Connect with exponential backoff retry */
  async connectWithRetry(reconnectConfig: ReconnectConfig = DEFAULT_RECONNECT_CONFIG): Promise<void> {
    for (let attempt = 0; attempt <= reconnectConfig.maxRetries; attempt++) {
      try {
        await this.connect();
        return;
      } catch (err) {
        if (attempt >= reconnectConfig.maxRetries) {
          throw err;
        }
        const delayMs = calculateBackoff(attempt, reconnectConfig);
        console.log(`[Realtime] Connect failed, retry ${attempt + 1}/${reconnectConfig.maxRetries} in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  sendAudio(pcm: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  commitAudio(): void {
    this.send({ type: 'input_audio_buffer.commit' });
  }

  clearAudio(): void {
    this.send({ type: 'input_audio_buffer.clear' });
  }

  cancelResponse(): void {
    this.send({ type: 'response.cancel' });
  }

  createResponse(): void {
    this.send({ type: 'response.create' });
  }

  sendConversationItem(item: {
    type: 'message' | 'function_call_output';
    role?: 'user' | 'assistant' | 'system';
    call_id?: string;
    output?: string;
    content?: Array<{ type: 'input_text' | 'text'; text: string }>;
  }): void {
    this.send({ type: 'conversation.item.create', item });
  }

  /** Update session instructions (e.g., after context load or speaker change) */
  updateInstructions(instructions: string): void {
    this.send({
      type: 'session.update',
      session: { instructions },
    });
  }

  /** Update session parameters (e.g., tools after security level change) */
  updateSession(session: Record<string, unknown>): void {
    this.send({ type: 'session.update', session });
  }

  sendFunctionResult(callId: string, result: string): void {
    this.sendConversationItem({
      type: 'function_call_output',
      call_id: callId,
      output: result,
    });
    this.createResponse();
  }

  private sendSessionUpdate(): void {
    const session: {
      voice: string;
      instructions: string;
      turn_detection: TurnDetection;
      audio: { input: { format: AudioFormat }; output: { format: AudioFormat } };
      input_audio_transcription?: { model: string; language?: string };
      tools?: RealtimeTool[];
    } = {
      voice: this.config.voice,
      instructions: this.config.instructions,
      turn_detection: this.config.turnDetection,
      audio: {
        input: { format: this.config.inputAudioFormat },
        output: { format: this.config.outputAudioFormat },
      },
      ...(this.config.inputAudioTranscription && {
        input_audio_transcription: this.config.inputAudioTranscription,
      }),
      tools: this.config.tools,
    };
    this.send({ type: 'session.update', session });
  }

  private send(data: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(data);
    if (this.debug) {
      const type = (data as { type?: string }).type ?? '<no-type>';
      // audio chunks are too noisy — summarize
      if (type === 'input_audio_buffer.append') {
        const audio = (data as { audio?: string }).audio ?? '';
        console.log(`[Realtime→xAI:debug] ${type} (audio ${audio.length}b base64)`);
      } else if (type === 'session.update') {
        const s = (data as { session?: Record<string, unknown> }).session ?? {};
        const tools = Array.isArray(s.tools) ? (s.tools as Array<{ name: string }>).map((t) => t.name) : [];
        const instr = typeof s.instructions === 'string' ? s.instructions : '';
        console.log(
          `[Realtime→xAI:debug] session.update: instructions=${instr.length}chars, tools=[${tools.join(', ')}], voice=${String(s.voice)}`,
        );
        console.log(`[Realtime→xAI:debug] full payload: ${payload}`);
      } else {
        console.log(`[Realtime→xAI:debug] ${type}: ${payload.slice(0, 1000)}${payload.length > 1000 ? '…' : ''}`);
      }
    }
    this.ws.send(payload);
  }

  private setupListeners(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.RawData) => {
      const str = typeof data === 'string' ? data : data.toString();
      let event: RealtimeServerEvent;
      try {
        event = JSON.parse(str);
      } catch {
        return;
      }

      this.emit('server_event', event);
      this.handleServerEvent(event);
    });

    ws.on('close', (code, reason) => {
      this.ws = null;
      this.emit('close', code, reason.toString());
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  private handleServerEvent(event: RealtimeServerEvent): void {
    if (this.debug) {
      const body = JSON.stringify(event);
      console.log(`[Realtime:debug] ${event.type} ${body.slice(0, 1200)}${body.length > 1200 ? '…' : ''}`);
    }

    switch (event.type) {
      case 'session.created':
        console.log(`[Realtime] Session created: ${event.session.id}`);
        this.emit('session.created', event.session);
        break;

      case 'session.updated':
        console.log('[Realtime] Session updated');
        this.emit('session.updated');
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speech_started');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.emit('speech_stopped');
        break;

      case 'response.output_audio.delta': {
        const pcm = Buffer.from(event.delta, 'base64');
        this.emit('audio_delta', pcm);
        break;
      }

      case 'response.output_audio.done':
        this.emit('audio_done');
        break;

      case 'response.output_audio_transcript.delta':
        if (this.transcriptBuffer.length < MAX_TRANSCRIPT_LENGTH) {
          this.transcriptBuffer += event.delta;
        }
        this.emit('transcript_delta', event.delta);
        break;

      case 'response.output_audio_transcript.done': {
        const fullTranscript = event.transcript ?? this.transcriptBuffer;
        this.transcriptBuffer = '';
        this.emit('transcript_done', fullTranscript);
        break;
      }

      case 'response.function_call_arguments.done':
        this.emit('function_call', event.call_id, event.name, event.arguments);
        break;

      case 'response.done':
        // transcript_done already clears the buffer; this is a safety net
        // for cases where response.done arrives without a transcript event
        this.emit('response_done', event.response.id);
        break;

      case 'error':
        console.error('[Realtime] Error:', event.error.message);
        this.emit('error', new Error(`${event.error.type}: ${event.error.message}`));
        break;
    }
  }
}
