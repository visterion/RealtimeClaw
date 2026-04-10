import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { WyomingServer } from '../../src/wyoming/server.js';
import { audioStart, audioChunk, audioStop } from '../../src/wyoming/protocol.js';
import type { AudioConfig } from '../../src/types.js';

describe('WyomingServer', () => {
  let server: WyomingServer;
  const TEST_PORT = 19300 + Math.floor(Math.random() * 100);

  beforeEach(async () => {
    server = new WyomingServer();
    await server.listen(TEST_PORT, '127.0.0.1');
  });

  afterEach(async () => {
    await server.close();
  });

  function connectClient(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection({ port: TEST_PORT, host: '127.0.0.1' }, () => {
        resolve(client);
      });
      client.on('error', reject);
    });
  }

  it('accepts TCP connections and emits session:start', async () => {
    const sessionPromise = new Promise<string>((resolve) => {
      server.on('session:start', (session) => resolve(session.id));
    });

    const client = await connectClient();
    const sessionId = await sessionPromise;

    expect(sessionId).toMatch(/^session-/);
    client.destroy();
  });

  it('emits session:end when client disconnects', async () => {
    const endPromise = new Promise<string>((resolve) => {
      server.on('session:end', (id) => resolve(id));
    });
    const startPromise = new Promise<void>((resolve) => {
      server.on('session:start', () => resolve());
    });

    const client = await connectClient();
    await startPromise;

    client.destroy();
    const endedId = await endPromise;
    expect(endedId).toMatch(/^session-/);
  });

  it('parses audio-start event from client', async () => {
    const audioStartPromise = new Promise<AudioConfig>((resolve) => {
      server.on('audio:start', (_session, config) => resolve(config));
    });

    const client = await connectClient();
    client.write(audioStart(16000, 2, 1));

    const config = await audioStartPromise;
    expect(config.rate).toBe(16000);
    expect(config.width).toBe(2);
    expect(config.channels).toBe(1);

    client.destroy();
  });

  it('parses audio-chunk events with PCM payload', async () => {
    const chunkPromise = new Promise<Buffer>((resolve) => {
      server.on('audio:start', () => {});
      server.on('audio:chunk', (_session, pcm) => resolve(pcm));
    });

    const client = await connectClient();
    const pcm = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    client.write(audioStart(16000, 2, 1));
    client.write(audioChunk(pcm, 16000, 2, 1));

    const received = await chunkPromise;
    expect(received).toEqual(pcm);

    client.destroy();
  });

  it('parses audio-stop event', async () => {
    const stopPromise = new Promise<void>((resolve) => {
      server.on('audio:stop', () => resolve());
    });

    const client = await connectClient();
    client.write(audioStart(16000, 2, 1));
    client.write(audioStop());

    await stopPromise;
    client.destroy();
  });

  it('responds to describe with info', async () => {
    const client = await connectClient();

    const responsePromise = new Promise<string>((resolve) => {
      let data = '';
      client.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          resolve(data.trim());
        }
      });
    });

    client.write(Buffer.from('{"type":"describe"}\n'));
    const response = await responsePromise;
    const parsed = JSON.parse(response);

    expect(parsed.type).toBe('info');
    expect(parsed.data.asr).toBeDefined();
    expect(parsed.data.asr[0].name).toBe('wyoming-realtime-bridge');

    client.destroy();
  });

  it('sends audio response back to client', async () => {
    const sessionPromise = new Promise<string>((resolve) => {
      server.on('session:start', (session) => resolve(session.id));
    });

    const client = await connectClient();
    const sessionId = await sessionPromise;

    const responsePromise = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      client.on('data', (chunk) => {
        chunks.push(chunk);
        const combined = Buffer.concat(chunks).toString();
        // Wait for audio-stop
        if (combined.includes('"audio-stop"')) {
          resolve(Buffer.concat(chunks));
        }
      });
    });

    // Server sends audio response
    const pcm = Buffer.alloc(320, 0x42);
    server.sendAudioStart(sessionId, 16000, 2, 1);
    server.sendAudioChunk(sessionId, pcm, 16000, 2, 1);
    server.sendAudioStop(sessionId);

    const response = await responsePromise;
    const responseStr = response.toString();
    expect(responseStr).toContain('audio-start');
    expect(responseStr).toContain('audio-stop');

    client.destroy();
  });
});
