import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { AudioBridge } from '../src/bridge.js';
import { audioStart, audioChunk, audioStop } from '../src/wyoming/protocol.js';
import { createTestConfig } from './helpers.js';

describe('AudioBridge', () => {
  let bridge: AudioBridge;
  let wss: WebSocketServer;
  let serverSockets: WebSocket[];
  const WYOMING_PORT = 19500 + Math.floor(Math.random() * 100);
  const REALTIME_PORT = 19600 + Math.floor(Math.random() * 100);

  beforeEach(async () => {
    serverSockets = [];
    wss = new WebSocketServer({ port: REALTIME_PORT, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.on('listening', resolve));

    wss.on('connection', (ws) => {
      serverSockets.push(ws);
    });

    bridge = new AudioBridge(createTestConfig(WYOMING_PORT, REALTIME_PORT));
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  function connectWyoming(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection({ port: WYOMING_PORT, host: '127.0.0.1' }, () => {
        resolve(client);
      });
      client.on('error', reject);
    });
  }

  it('bridges audio from Wyoming to Realtime API', async () => {
    const realtimeMessages: any[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        realtimeMessages.push(JSON.parse(data.toString()));
      });
    });

    const client = await connectWyoming();

    // Send audio through Wyoming
    const pcm = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    client.write(audioStart(16000, 2, 1));

    // Wait for Realtime connection to establish
    await new Promise((r) => setTimeout(r, 200));

    client.write(audioChunk(pcm, 16000, 2, 1));
    await new Promise((r) => setTimeout(r, 100));

    // Verify session.update was sent
    const sessionUpdate = realtimeMessages.find((m) => m.type === 'session.update');
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate.session.voice).toBe('rex');

    // Verify audio was forwarded
    const audioAppend = realtimeMessages.find((m) => m.type === 'input_audio_buffer.append');
    expect(audioAppend).toBeDefined();
    expect(audioAppend.audio).toBe(pcm.toString('base64'));

    client.destroy();
  });

  it('bridges audio response from Realtime back to Wyoming', async () => {
    const client = await connectWyoming();

    // Collect Wyoming response data
    const responseData: Buffer[] = [];
    client.on('data', (chunk) => responseData.push(chunk));

    // Start audio to trigger Realtime connection
    client.write(audioStart(16000, 2, 1));

    // Wait for Realtime connection
    await new Promise((r) => setTimeout(r, 200));

    const realtimeWs = serverSockets[serverSockets.length - 1];
    expect(realtimeWs).toBeDefined();

    // Simulate xAI audio response
    const responsePcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    realtimeWs.send(JSON.stringify({
      type: 'response.output_audio.delta',
      response_id: 'resp_1',
      item_id: 'item_1',
      delta: responsePcm.toString('base64'),
    }));

    realtimeWs.send(JSON.stringify({
      type: 'response.output_audio.done',
      response_id: 'resp_1',
      item_id: 'item_1',
    }));

    // Wait for response to arrive at Wyoming client
    await new Promise((r) => setTimeout(r, 200));

    const combined = Buffer.concat(responseData).toString();
    expect(combined).toContain('audio-start');
    expect(combined).toContain('audio-chunk');
    expect(combined).toContain('audio-stop');

    client.destroy();
  });

  it('handles barge-in by cancelling response', async () => {
    const realtimeMessages: any[] = [];
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        realtimeMessages.push(JSON.parse(data.toString()));
      });
    });

    const client = await connectWyoming();
    client.write(audioStart(16000, 2, 1));

    await new Promise((r) => setTimeout(r, 200));
    const realtimeWs = serverSockets[serverSockets.length - 1];

    // Simulate ongoing audio response (puts bridge in "responding" state)
    realtimeWs.send(JSON.stringify({
      type: 'response.output_audio.delta',
      response_id: 'resp_1',
      item_id: 'item_1',
      delta: Buffer.alloc(100).toString('base64'),
    }));

    await new Promise((r) => setTimeout(r, 50));

    // Simulate speech_started (barge-in)
    realtimeWs.send(JSON.stringify({
      type: 'input_audio_buffer.speech_started',
      item_id: 'msg_2',
    }));

    await new Promise((r) => setTimeout(r, 100));

    const cancel = realtimeMessages.find((m) => m.type === 'response.cancel');
    expect(cancel).toBeDefined();

    client.destroy();
  });

  it('emits session:connected event', async () => {
    const connectedPromise = new Promise<string>((resolve) => {
      bridge.on('session:connected', (id) => resolve(id));
    });

    const client = await connectWyoming();
    client.write(audioStart(16000, 2, 1));

    const sessionId = await connectedPromise;
    expect(sessionId).toMatch(/^session-/);

    client.destroy();
  });

  it('forwards transcript from Realtime to Wyoming', async () => {
    const client = await connectWyoming();

    const responseData: Buffer[] = [];
    client.on('data', (chunk) => responseData.push(chunk));

    client.write(audioStart(16000, 2, 1));
    await new Promise((r) => setTimeout(r, 200));

    const realtimeWs = serverSockets[serverSockets.length - 1];

    // Send transcript
    realtimeWs.send(JSON.stringify({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_1',
      item_id: 'item_1',
      transcript: 'Hallo, wie kann ich helfen?',
    }));

    await new Promise((r) => setTimeout(r, 100));

    const combined = Buffer.concat(responseData).toString();
    expect(combined).toContain('transcript');
    expect(combined).toContain('Hallo, wie kann ich helfen?');

    client.destroy();
  });
});
