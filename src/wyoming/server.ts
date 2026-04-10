import net from 'node:net';
import { EventEmitter } from 'node:events';
import { WyomingParser, info, audioStart, audioChunk, audioStop, transcript } from './protocol.js';
import type { WyomingMessage, AudioConfig } from '../types.js';

const DEFAULT_AUDIO_CONFIG: AudioConfig = { rate: 16000, width: 2, channels: 1 };

export function normalizeAudioConfig(data: Partial<AudioConfig>): AudioConfig {
  return {
    rate: data.rate ?? DEFAULT_AUDIO_CONFIG.rate,
    width: data.width ?? DEFAULT_AUDIO_CONFIG.width,
    channels: data.channels ?? DEFAULT_AUDIO_CONFIG.channels,
  };
}

export interface WyomingSession {
  id: string;
  deviceId?: string;
  socket: net.Socket;
  parser: WyomingParser;
  audioConfig: AudioConfig | null;
}

interface WyomingServerEvents {
  'session:start': [session: WyomingSession];
  'session:end': [sessionId: string];
  'audio:start': [session: WyomingSession, config: AudioConfig];
  'audio:chunk': [session: WyomingSession, pcm: Buffer, config: AudioConfig];
  'audio:stop': [session: WyomingSession];
  'describe': [session: WyomingSession];
}

export class WyomingServer extends EventEmitter<WyomingServerEvents> {
  private server: net.Server;
  private sessions = new Map<string, WyomingSession>();
  private sessionCounter = 0;
  private languages: string[];

  constructor(languages: string[] = ['de', 'en']) {
    super();
    this.languages = languages;
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  listen(port: number, host = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        console.log(`[Wyoming] Listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const session of this.sessions.values()) {
        session.socket.destroy();
      }
      this.sessions.clear();
      this.server.close(() => resolve());
    });
  }

  sendAudioStart(sessionId: string, rate: number, width: number, channels: number): void {
    this.writeToSession(sessionId, audioStart(rate, width, channels));
  }

  sendAudioChunk(sessionId: string, pcm: Buffer, rate: number, width: number, channels: number): void {
    this.writeToSession(sessionId, audioChunk(pcm, rate, width, channels));
  }

  sendAudioStop(sessionId: string): void {
    this.writeToSession(sessionId, audioStop());
  }

  sendTranscript(sessionId: string, text: string): void {
    this.writeToSession(sessionId, transcript(text));
  }

  private writeToSession(sessionId: string, data: Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.socket.write(data);
  }

  private handleConnection(socket: net.Socket): void {
    const sessionId = `session-${++this.sessionCounter}`;
    const parser = new WyomingParser();
    const session: WyomingSession = {
      id: sessionId,
      socket,
      parser,
      audioConfig: null,
    };

    this.sessions.set(sessionId, session);
    console.log(`[Wyoming] New connection: ${sessionId}`);
    this.emit('session:start', session);

    socket.on('data', (data: Buffer) => {
      const messages = parser.parse(data);
      for (const msg of messages) {
        this.handleMessage(session, msg.event, msg.payload);
      }
    });

    const cleanup = () => {
      if (!this.sessions.delete(sessionId)) return;
      parser.reset();
      console.log(`[Wyoming] Connection closed: ${sessionId}`);
      this.emit('session:end', sessionId);
    };

    socket.on('close', cleanup);

    socket.on('error', (err) => {
      console.error(`[Wyoming] Socket error (${sessionId}):`, err.message);
      socket.destroy();
      // cleanup() is called by the 'close' event fired after destroy()
    });
  }

  private handleMessage(session: WyomingSession, event: WyomingMessage, payload?: Buffer): void {
    switch (event.type) {
      case 'describe':
        session.socket.write(info(this.languages));
        this.emit('describe', session);
        break;

      case 'audio-start': {
        session.audioConfig = normalizeAudioConfig(event.data as Partial<AudioConfig>);
        console.log(`[Wyoming] Audio start (${session.id}): ${session.audioConfig.rate}Hz, ${session.audioConfig.width * 8}bit, ${session.audioConfig.channels}ch`);
        this.emit('audio:start', session, session.audioConfig);
        break;
      }

      case 'audio-chunk': {
        if (!session.audioConfig) {
          console.warn(`[Wyoming] Audio chunk without audio-start (${session.id})`);
          return;
        }
        if (payload) {
          this.emit('audio:chunk', session, payload, session.audioConfig);
        }
        break;
      }

      case 'audio-stop':
        console.log(`[Wyoming] Audio stop (${session.id})`);
        this.emit('audio:stop', session);
        session.audioConfig = null;
        break;

      default:
        console.log(`[Wyoming] Unhandled event (${session.id}): ${event.type}`);
        break;
    }
  }
}
