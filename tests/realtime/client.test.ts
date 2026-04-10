import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { RealtimeClient } from '../../src/realtime/client.js';
import type { RealtimeConfig } from '../../src/types.js';

function createTestConfig(port: number): RealtimeConfig {
  return {
    provider: 'xai' as const,
    wsUrl: `ws://127.0.0.1:${port}`,
    apiKey: 'test-key',
    voice: 'rex',
    instructions: 'Test instructions',
    inputAudioFormat: { type: 'audio/pcm', rate: 16000 },
    outputAudioFormat: { type: 'audio/pcm', rate: 16000 },
    turnDetection: { type: 'server_vad', threshold: 0.85, silence_duration_ms: 500 },
  };
}

describe('RealtimeClient', () => {
  let wss: WebSocketServer;
  let client: RealtimeClient;
  let serverSocket: WebSocket | null = null;
  const TEST_PORT = 19400 + Math.floor(Math.random() * 100);

  beforeEach(async () => {
    serverSocket = null;
    wss = new WebSocketServer({ port: TEST_PORT, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.on('listening', resolve));

    wss.on('connection', (ws) => {
      serverSocket = ws;
    });
  });

  afterEach(async () => {
    client?.disconnect();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('connects and sends session.update', async () => {
    const messagePromise = new Promise<Record<string, any>>((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          resolve(JSON.parse(data.toString()));
        });
      });
    });

    client = new RealtimeClient(createTestConfig(TEST_PORT));
    await client.connect();

    const msg = await messagePromise;
    expect(msg.type).toBe('session.update');
    expect(msg.session.voice).toBe('rex');
    expect(msg.session.instructions).toBe('Test instructions');
    expect(msg.session.turn_detection.type).toBe('server_vad');
    expect(msg.session.audio.input.format.type).toBe('audio/pcm');
    expect(msg.session.audio.input.format.rate).toBe(16000);
  });

  it('sends audio as base64', async () => {
    const messages: any[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
      });
    });

    client = new RealtimeClient(createTestConfig(TEST_PORT));
    await client.connect();

    const pcm = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    client.sendAudio(pcm);

    // Wait for messages to arrive
    await new Promise((r) => setTimeout(r, 50));

    const audioMsg = messages.find((m) => m.type === 'input_audio_buffer.append');
    expect(audioMsg).toBeDefined();
    expect(audioMsg.audio).toBe(pcm.toString('base64'));
  });

  it('emits audio_delta when receiving audio response', async () => {
    client = new RealtimeClient(createTestConfig(TEST_PORT));
    await client.connect();

    const deltaPromise = new Promise<Buffer>((resolve) => {
      client.on('audio_delta', (pcm) => resolve(pcm));
    });

    // Wait for serverSocket to be set
    await new Promise((r) => setTimeout(r, 50));

    const pcmData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    serverSocket!.send(JSON.stringify({
      type: 'response.output_audio.delta',
      response_id: 'resp_1',
      item_id: 'item_1',
      delta: pcmData.toString('base64'),
    }));

    const received = await deltaPromise;
    expect(received).toEqual(pcmData);
  });

  it('emits transcript_done with full transcript', async () => {
    client = new RealtimeClient(createTestConfig(TEST_PORT));
    await client.connect();

    const transcriptPromise = new Promise<string>((resolve) => {
      client.on('transcript_done', (text) => resolve(text));
    });

    await new Promise((r) => setTimeout(r, 50));

    // Send transcript deltas then done
    serverSocket!.send(JSON.stringify({
      type: 'response.output_audio_transcript.delta',
      response_id: 'resp_1',
      item_id: 'item_1',
      delta: 'Hallo ',
    }));
    serverSocket!.send(JSON.stringify({
      type: 'response.output_audio_transcript.delta',
      response_id: 'resp_1',
      item_id: 'item_1',
      delta: 'Welt',
    }));
    serverSocket!.send(JSON.stringify({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_1',
      item_id: 'item_1',
    }));

    const text = await transcriptPromise;
    expect(text).toBe('Hallo Welt');
  });

  it('emits speech_started for barge-in detection', async () => {
    client = new RealtimeClient(createTestConfig(TEST_PORT));
    await client.connect();

    const speechPromise = new Promise<void>((resolve) => {
      client.on('speech_started', () => resolve());
    });

    await new Promise((r) => setTimeout(r, 50));

    serverSocket!.send(JSON.stringify({
      type: 'input_audio_buffer.speech_started',
      item_id: 'msg_1',
    }));

    await speechPromise;
  });

  it('emits function_call for tool calls', async () => {
    client = new RealtimeClient(createTestConfig(TEST_PORT));
    await client.connect();

    const fnPromise = new Promise<{ callId: string; name: string; args: string }>((resolve) => {
      client.on('function_call', (callId, name, args) => resolve({ callId, name, args }));
    });

    await new Promise((r) => setTimeout(r, 50));

    serverSocket!.send(JSON.stringify({
      type: 'response.function_call_arguments.done',
      call_id: 'call_1',
      name: 'turn_on_light',
      arguments: '{"entity":"light.kitchen"}',
    }));

    const fn = await fnPromise;
    expect(fn.callId).toBe('call_1');
    expect(fn.name).toBe('turn_on_light');
    expect(JSON.parse(fn.args)).toEqual({ entity: 'light.kitchen' });
  });

  it('sends function result and triggers response', async () => {
    const messages: any[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
      });
    });

    client = new RealtimeClient(createTestConfig(TEST_PORT));
    await client.connect();

    client.sendFunctionResult('call_1', '{"status":"ok"}');
    await new Promise((r) => setTimeout(r, 50));

    const fnResult = messages.find((m) => m.type === 'conversation.item.create');
    expect(fnResult).toBeDefined();
    expect(fnResult.item.type).toBe('function_call_output');
    expect(fnResult.item.call_id).toBe('call_1');
    expect(fnResult.item.output).toBe('{"status":"ok"}');

    const responseCreate = messages.find((m) => m.type === 'response.create');
    expect(responseCreate).toBeDefined();
  });

  it('sends response.cancel for barge-in', async () => {
    const messages: any[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
      });
    });

    client = new RealtimeClient(createTestConfig(TEST_PORT));
    await client.connect();

    client.cancelResponse();
    await new Promise((r) => setTimeout(r, 50));

    const cancel = messages.find((m) => m.type === 'response.cancel');
    expect(cancel).toBeDefined();
  });

  describe('connectWithRetry', () => {
    it('connects successfully on first attempt', async () => {
      const port = 19800 + Math.floor(Math.random() * 100);
      const server = new WebSocketServer({ port, host: '127.0.0.1' });
      server.on('connection', (ws) => {
        ws.on('message', () => {}); // ignore messages
      });

      const config = createTestConfig(port);
      const c = new RealtimeClient(config);

      await c.connectWithRetry({ maxRetries: 3, initialDelayMs: 50, maxDelayMs: 200, backoffFactor: 2 });
      c.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('gives up after maxRetries', async () => {
      const port = 19900 + Math.floor(Math.random() * 100);
      // No server running on this port
      const config = createTestConfig(port);
      const c = new RealtimeClient(config);

      await expect(
        c.connectWithRetry({ maxRetries: 2, initialDelayMs: 10, maxDelayMs: 50, backoffFactor: 1.5 })
      ).rejects.toThrow();
    }, 10000);
  });

  it('sends session.update with tools via updateSession()', async () => {
    const messages: any[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
      });
    });

    client = new RealtimeClient(createTestConfig(TEST_PORT));
    await client.connect();

    const tools = [{ type: 'function' as const, name: 'test_tool', description: 'test', parameters: {} }];
    client.updateSession({ tools });
    await new Promise((r) => setTimeout(r, 50));

    const sessionUpdates = messages.filter((m) => m.type === 'session.update');
    const toolUpdate = sessionUpdates.find((m) => m.session.tools !== undefined);
    expect(toolUpdate).toBeDefined();
    expect(toolUpdate.session.tools).toEqual(tools);
  });
});
