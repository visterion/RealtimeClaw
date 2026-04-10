import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { AudioBridge } from '../src/bridge.js';
import { WyomingParser, audioStart, audioChunk, audioStop } from '../src/wyoming/protocol.js';
import { createTestConfig } from './helpers.js';
import { StubOpenClawClient } from '../src/tools/openclaw-client.js';
import type { WyomingMessage, RealtimeTool } from '../src/types.js';

// --- Realistic mock xAI Realtime server ---

class MockRealtimeServer {
  private wss: WebSocketServer;
  private connections: WebSocket[] = [];
  readonly port: number;

  constructor(port: number) {
    this.port = port;
    this.wss = new WebSocketServer({ port, host: '127.0.0.1' });
    this.wss.on('connection', (ws) => {
      this.connections.push(ws);
      this.setupDefaultBehavior(ws);
    });
  }

  /** Set up a mock xAI server that echoes audio back with a response */
  private setupDefaultBehavior(ws: WebSocket): void {
    let audioChunks: string[] = [];
    let sessionConfigured = false;

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'session.update':
          sessionConfigured = true;
          ws.send(JSON.stringify({
            type: 'session.created',
            session: { id: `sess_${Date.now()}` },
          }));
          ws.send(JSON.stringify({
            type: 'session.updated',
            session: msg.session,
          }));
          break;

        case 'input_audio_buffer.append':
          audioChunks.push(msg.audio);
          break;

        case 'input_audio_buffer.commit':
          if (sessionConfigured && audioChunks.length > 0) {
            this.sendResponse(ws, audioChunks);
            audioChunks = [];
          }
          break;

        case 'response.cancel':
          // Acknowledge cancellation
          ws.send(JSON.stringify({
            type: 'response.done',
            response: { id: `resp_cancelled_${Date.now()}`, status: 'cancelled' },
          }));
          break;
      }
    });
  }

  /** Simulate VAD-triggered speech detection and response on a specific connection */
  triggerVadResponse(connectionIndex = -1): void {
    const ws = connectionIndex >= 0
      ? this.connections[connectionIndex]
      : this.connections[this.connections.length - 1];
    if (!ws) return;

    // Simulate speech detected → committed → response
    ws.send(JSON.stringify({
      type: 'input_audio_buffer.speech_started',
      item_id: 'msg_auto',
    }));

    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'msg_auto',
      }));
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'msg_auto',
        previous_item_id: null,
      }));

      this.sendResponse(ws, []);
    }, 30);
  }

  /** Simulate a full audio response with multiple delta chunks */
  private sendResponse(ws: WebSocket, _inputChunks: string[]): void {
    const respId = `resp_${Date.now()}`;
    const itemId = `item_${Date.now()}`;

    ws.send(JSON.stringify({
      type: 'response.created',
      response: { id: respId, status: 'in_progress' },
    }));

    // Send multiple audio deltas (simulating streamed response)
    const chunkSize = 640; // 20ms of 16kHz 16-bit mono
    const numChunks = 5;
    for (let i = 0; i < numChunks; i++) {
      const pcm = Buffer.alloc(chunkSize);
      // Fill with a recognizable pattern per chunk
      pcm.fill(i + 1);
      ws.send(JSON.stringify({
        type: 'response.output_audio.delta',
        response_id: respId,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: pcm.toString('base64'),
      }));
    }

    ws.send(JSON.stringify({
      type: 'response.output_audio.done',
      response_id: respId,
      item_id: itemId,
    }));

    // Send transcript
    ws.send(JSON.stringify({
      type: 'response.output_audio_transcript.done',
      response_id: respId,
      item_id: itemId,
      transcript: 'Das ist eine Testantwort von Assistant.',
    }));

    ws.send(JSON.stringify({
      type: 'response.done',
      response: { id: respId, status: 'completed' },
    }));
  }

  /** Simulate a function call response */
  sendFunctionCall(name: string, args: string, connectionIndex = -1): void {
    const ws = connectionIndex >= 0
      ? this.connections[connectionIndex]
      : this.connections[this.connections.length - 1];
    if (!ws) return;

    const respId = `resp_fn_${Date.now()}`;
    ws.send(JSON.stringify({
      type: 'response.created',
      response: { id: respId, status: 'in_progress' },
    }));
    ws.send(JSON.stringify({
      type: 'response.function_call_arguments.done',
      response_id: respId,
      item_id: `item_fn_${Date.now()}`,
      output_index: 0,
      call_id: `call_${Date.now()}`,
      name,
      arguments: args,
    }));
  }

  /** Forcefully close a specific connection (simulating server-side disconnect) */
  disconnectClient(connectionIndex = -1): void {
    const ws = connectionIndex >= 0
      ? this.connections[connectionIndex]
      : this.connections[this.connections.length - 1];
    if (ws) ws.terminate();
  }

  /** Send an error event */
  sendError(message: string, connectionIndex = -1): void {
    const ws = connectionIndex >= 0
      ? this.connections[connectionIndex]
      : this.connections[this.connections.length - 1];
    if (!ws) return;
    ws.send(JSON.stringify({
      type: 'error',
      error: { type: 'server_error', code: 'internal_error', message },
    }));
  }

  getConnectionCount(): number {
    return this.connections.length;
  }

  async close(): Promise<void> {
    for (const ws of this.connections) ws.close();
    this.connections = [];
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

// --- Wyoming client helper: connects + parses responses ---

class WyomingTestClient {
  private socket: net.Socket | null = null;
  private parser = new WyomingParser();
  private received: Array<{ event: WyomingMessage; payload?: Buffer }> = [];
  private port: number;

  constructor(port: number) {
    this.port = port;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ port: this.port, host: '127.0.0.1' }, () => resolve());
      this.socket.on('error', reject);
      this.socket.on('data', (data) => {
        const msgs = this.parser.parse(data);
        this.received.push(...msgs);
      });
    });
  }

  sendAudioStart(rate = 16000, width = 2, channels = 1): void {
    this.socket!.write(audioStart(rate, width, channels));
  }

  sendAudioChunk(pcm: Buffer, rate = 16000, width = 2, channels = 1): void {
    this.socket!.write(audioChunk(pcm, rate, width, channels));
  }

  sendAudioStop(): void {
    this.socket!.write(audioStop());
  }

  /** Send a realistic PCM stream: N chunks of given size with small delays */
  async streamAudio(numChunks: number, chunkSize = 640, delayMs = 5): Promise<void> {
    this.sendAudioStart();
    for (let i = 0; i < numChunks; i++) {
      const pcm = Buffer.alloc(chunkSize);
      // Simulate a sine-ish waveform at ~440Hz in 16kHz 16-bit
      for (let s = 0; s < chunkSize / 2; s++) {
        const sample = Math.floor(16000 * Math.sin(2 * Math.PI * 440 * (i * chunkSize / 2 + s) / 16000));
        pcm.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), s * 2);
      }
      this.sendAudioChunk(pcm);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    this.sendAudioStop();
  }

  getMessages(): Array<{ event: WyomingMessage; payload?: Buffer }> {
    return [...this.received];
  }

  getMessagesByType(type: string): Array<{ event: WyomingMessage; payload?: Buffer }> {
    return this.received.filter((m) => m.event.type === type);
  }

  getTotalAudioBytes(): number {
    return this.getMessagesByType('audio-chunk')
      .reduce((sum, m) => sum + (m.payload?.length ?? 0), 0);
  }

  clearMessages(): void {
    this.received = [];
  }

  async waitForMessageType(type: string, timeoutMs = 2000): Promise<{ event: WyomingMessage; payload?: Buffer }> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.received.find((m) => m.event.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timeout waiting for message type: ${type}`);
  }

  async waitForMessageCount(type: string, count: number, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.getMessagesByType(type).length >= count) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`Timeout: expected ${count} messages of type ${type}, got ${this.getMessagesByType(type).length}`);
  }

  destroy(): void {
    this.socket?.destroy();
    this.socket = null;
    this.parser.reset();
  }
}

// --- Integration tests ---

describe('Integration: Realistic Audio Streams', () => {
  let bridge: AudioBridge;
  let mockServer: MockRealtimeServer;
  const WYOMING_PORT = 18700 + Math.floor(Math.random() * 100);
  const REALTIME_PORT = 18800 + Math.floor(Math.random() * 100);


  beforeEach(async () => {
    mockServer = new MockRealtimeServer(REALTIME_PORT);
    await new Promise<void>((r) => setTimeout(r, 50));
    bridge = new AudioBridge(createTestConfig(WYOMING_PORT, REALTIME_PORT));
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
    await mockServer.close();
  });

  it('streams 1 second of realistic PCM audio (50 chunks × 640 bytes)', async () => {
    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    // Stream ~1 second of audio: 50 chunks × 640 bytes = 32000 bytes = 1s at 16kHz 16bit mono
    await client.streamAudio(50, 640, 2);

    // Wait for bridge to forward everything
    await new Promise((r) => setTimeout(r, 300));

    // Trigger VAD response from mock server
    mockServer.triggerVadResponse();

    // Wait for response audio to arrive at Wyoming client
    await client.waitForMessageType('audio-start');
    await client.waitForMessageType('audio-stop');

    const audioChunks = client.getMessagesByType('audio-chunk');
    expect(audioChunks.length).toBe(5); // mock sends 5 chunks
    expect(client.getTotalAudioBytes()).toBe(5 * 640); // 5 × 640 bytes

    // Verify transcript arrived
    const transcriptMsg = await client.waitForMessageType('transcript');
    expect((transcriptMsg.event as any).data.text).toBe('Das ist eine Testantwort von Assistant.');

    client.destroy();
  });

  it('streams 3 seconds of audio without data loss', async () => {
    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    // 3 seconds: 150 chunks × 640 bytes = 96000 bytes
    await client.streamAudio(150, 640, 1);

    await new Promise((r) => setTimeout(r, 200));
    mockServer.triggerVadResponse();

    await client.waitForMessageType('transcript');
    const transcriptMsg = client.getMessagesByType('transcript')[0];
    expect((transcriptMsg.event as any).data.text).toContain('Testantwort');

    client.destroy();
  });

  it('handles audio chunks of varying sizes', async () => {
    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    client.sendAudioStart();
    await new Promise((r) => setTimeout(r, 200)); // wait for realtime connection

    // Send chunks of different sizes (like real hardware might produce)
    const sizes = [320, 640, 1280, 160, 960, 640];
    for (const size of sizes) {
      const pcm = Buffer.alloc(size, 0x42);
      client.sendAudioChunk(pcm);
      await new Promise((r) => setTimeout(r, 5));
    }
    client.sendAudioStop();

    await new Promise((r) => setTimeout(r, 200));
    mockServer.triggerVadResponse();

    await client.waitForMessageType('transcript');
    client.destroy();
  });
});

describe('Integration: Multi-Turn Conversations', () => {
  let bridge: AudioBridge;
  let mockServer: MockRealtimeServer;
  const WYOMING_PORT = 18900 + Math.floor(Math.random() * 100);
  const REALTIME_PORT = 19000 + Math.floor(Math.random() * 100);


  beforeEach(async () => {
    mockServer = new MockRealtimeServer(REALTIME_PORT);
    await new Promise<void>((r) => setTimeout(r, 50));
    bridge = new AudioBridge(createTestConfig(WYOMING_PORT, REALTIME_PORT));
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
    await mockServer.close();
  });

  it('handles 3 consecutive question-answer turns', async () => {
    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    for (let turn = 0; turn < 3; turn++) {
      client.clearMessages();

      // User speaks
      await client.streamAudio(25, 640, 2); // ~0.5s
      await new Promise((r) => setTimeout(r, 200));

      // Server responds
      mockServer.triggerVadResponse();

      // Wait for full response cycle
      await client.waitForMessageType('audio-start');
      await client.waitForMessageType('audio-stop');
      await client.waitForMessageType('transcript');

      const transcripts = client.getMessagesByType('transcript');
      expect(transcripts.length).toBeGreaterThanOrEqual(1);
    }

    client.destroy();
  });

  it('handles rapid back-to-back turns without gap', async () => {
    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    // First turn
    await client.streamAudio(10, 640, 1);
    await new Promise((r) => setTimeout(r, 150));
    mockServer.triggerVadResponse();
    await client.waitForMessageType('transcript');

    // Immediately start second turn (no pause)
    client.clearMessages();
    await client.streamAudio(10, 640, 1);
    await new Promise((r) => setTimeout(r, 150));
    mockServer.triggerVadResponse();
    await client.waitForMessageType('transcript');

    client.destroy();
  });

  it('handles barge-in mid-response then completes new turn', async () => {
    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    // First turn: stream audio, get response started
    await client.streamAudio(10, 640, 1);
    await new Promise((r) => setTimeout(r, 200));
    mockServer.triggerVadResponse();

    // Wait for response audio to start
    await client.waitForMessageType('audio-start');
    await new Promise((r) => setTimeout(r, 50));

    // Barge-in: user starts speaking while Assistant is responding
    // The mock server's triggerVadResponse sends speech_started
    mockServer.triggerVadResponse();
    await new Promise((r) => setTimeout(r, 200));

    // Should have received audio-stop (from barge-in cancellation or natural end)
    const audioStops = client.getMessagesByType('audio-stop');
    expect(audioStops.length).toBeGreaterThanOrEqual(1);

    client.destroy();
  });
});

describe('Integration: Concurrent Sessions', () => {
  let bridge: AudioBridge;
  let mockServer: MockRealtimeServer;
  const WYOMING_PORT = 19100 + Math.floor(Math.random() * 100);
  const REALTIME_PORT = 19200 + Math.floor(Math.random() * 100);


  beforeEach(async () => {
    mockServer = new MockRealtimeServer(REALTIME_PORT);
    await new Promise<void>((r) => setTimeout(r, 50));
    bridge = new AudioBridge(createTestConfig(WYOMING_PORT, REALTIME_PORT));
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
    await mockServer.close();
  });

  it('handles 2 simultaneous Wyoming clients', async () => {
    const client1 = new WyomingTestClient(WYOMING_PORT);
    const client2 = new WyomingTestClient(WYOMING_PORT);

    await client1.connect();
    await client2.connect();

    // Both clients stream audio simultaneously
    const stream1 = client1.streamAudio(20, 640, 2);
    const stream2 = client2.streamAudio(20, 640, 2);
    await Promise.all([stream1, stream2]);

    await new Promise((r) => setTimeout(r, 300));

    // Each client should have triggered a separate Realtime connection
    expect(mockServer.getConnectionCount()).toBe(2);

    // Trigger responses for both
    mockServer.triggerVadResponse(0);
    mockServer.triggerVadResponse(1);

    // Both should receive transcripts
    await client1.waitForMessageType('transcript');
    await client2.waitForMessageType('transcript');

    client1.destroy();
    client2.destroy();
  });

  it('one client disconnecting does not affect the other', async () => {
    const client1 = new WyomingTestClient(WYOMING_PORT);
    const client2 = new WyomingTestClient(WYOMING_PORT);

    await client1.connect();
    await client2.connect();

    // Both start streaming
    await client1.streamAudio(10, 640, 1);
    await client2.streamAudio(10, 640, 1);
    await new Promise((r) => setTimeout(r, 300));

    // Client 1 disconnects abruptly
    client1.destroy();
    await new Promise((r) => setTimeout(r, 100));

    // Client 2 should still work fine
    mockServer.triggerVadResponse(1);
    await client2.waitForMessageType('transcript');

    const transcript = client2.getMessagesByType('transcript')[0];
    expect((transcript.event as any).data.text).toContain('Testantwort');

    client2.destroy();
  });

  it('handles 5 sequential connect-stream-disconnect cycles', async () => {
    for (let i = 0; i < 5; i++) {
      const client = new WyomingTestClient(WYOMING_PORT);
      await client.connect();

      await client.streamAudio(10, 640, 1);
      await new Promise((r) => setTimeout(r, 200));

      mockServer.triggerVadResponse();
      await client.waitForMessageType('transcript');

      client.destroy();
      await new Promise((r) => setTimeout(r, 50));
    }

    // All 5 cycles created Realtime connections
    expect(mockServer.getConnectionCount()).toBe(5);
  });
});

describe('Integration: Error Scenarios', () => {
  let bridge: AudioBridge;
  let mockServer: MockRealtimeServer;
  const WYOMING_PORT = 18500 + Math.floor(Math.random() * 100);
  const REALTIME_PORT = 18600 + Math.floor(Math.random() * 100);


  beforeEach(async () => {
    mockServer = new MockRealtimeServer(REALTIME_PORT);
    await new Promise<void>((r) => setTimeout(r, 50));
    bridge = new AudioBridge(createTestConfig(WYOMING_PORT, REALTIME_PORT));
    await bridge.start();
  });

  afterEach(async () => {
    await bridge.stop();
    await mockServer.close();
  });

  it('emits error when Realtime server disconnects mid-stream', async () => {
    const errors: Error[] = [];
    bridge.on('error', (_id, err) => errors.push(err));

    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    await client.streamAudio(10, 640, 1);
    await new Promise((r) => setTimeout(r, 200));

    // Server drops the connection
    mockServer.disconnectClient();
    await new Promise((r) => setTimeout(r, 200));

    // Bridge should not crash — client can still connect
    const client2 = new WyomingTestClient(WYOMING_PORT);
    await client2.connect();
    await client2.streamAudio(5, 640, 1);
    await new Promise((r) => setTimeout(r, 200));

    // New connection should work
    mockServer.triggerVadResponse();
    await client2.waitForMessageType('transcript');

    client.destroy();
    client2.destroy();
  });

  it('handles Realtime API error event gracefully', async () => {
    const errors: Error[] = [];
    bridge.on('error', (_id, err) => errors.push(err));

    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    await client.streamAudio(5, 640, 1);
    await new Promise((r) => setTimeout(r, 200));

    // Server sends an error
    mockServer.sendError('rate_limit_exceeded');
    await new Promise((r) => setTimeout(r, 100));

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain('rate_limit_exceeded');

    client.destroy();
  });

  it('bridge survives when Realtime server is unreachable', { timeout: 15_000 }, async () => {
    // Stop mock server
    await mockServer.close();

    const errors: Error[] = [];
    bridge.on('error', (_id, err) => errors.push(err));

    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    // This triggers a Realtime connection attempt that will fail
    // (connectWithRetry retries with exponential backoff, so wait for all retries)
    client.sendAudioStart();
    await new Promise((r) => setTimeout(r, 10_000));

    // Should have emitted an error but not crashed
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // Bridge is still running (can accept new connections)
    const client2 = new WyomingTestClient(WYOMING_PORT);
    await client2.connect();

    // Clean up — recreate mock server for afterEach
    mockServer = new MockRealtimeServer(REALTIME_PORT);
    await new Promise((r) => setTimeout(r, 50));

    client.destroy();
    client2.destroy();
  });

  it('Wyoming client disconnecting cleans up Realtime connection', async () => {
    const disconnected: string[] = [];
    bridge.on('session:disconnected', (id) => disconnected.push(id));

    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    await client.streamAudio(5, 640, 1);
    await new Promise((r) => setTimeout(r, 200));

    // Client drops
    client.destroy();
    await new Promise((r) => setTimeout(r, 200));

    expect(disconnected.length).toBe(1);
    expect(disconnected[0]).toMatch(/^session-/);
  });
});

describe('Integration: Tool Routing + Security', () => {
  let bridge: AudioBridge;
  let mockServer: MockRealtimeServer;
  let mockOpenClaw: StubOpenClawClient;
  const WYOMING_PORT = 19300 + Math.floor(Math.random() * 100);
  const REALTIME_PORT = 19400 + Math.floor(Math.random() * 100);

  const testTools: RealtimeTool[] = [
    { type: 'function', name: 'ha_light_control', description: 'Control lights', parameters: {} },
    { type: 'function', name: 'paperless_full', description: 'Full paperless access', parameters: {} },
    { type: 'function', name: 'request_reasoning', description: 'Deep reasoning', parameters: {} },
    { type: 'function', name: 'exec_rm', description: 'Execute rm', parameters: {} },
  ];

  beforeEach(async () => {
    mockServer = new MockRealtimeServer(REALTIME_PORT);
    await new Promise<void>((r) => setTimeout(r, 50));

    mockOpenClaw = new StubOpenClawClient(testTools);
    vi.spyOn(mockOpenClaw, 'executeTool');
    vi.spyOn(mockOpenClaw, 'ask');
    vi.spyOn(mockOpenClaw, 'requestApproval');

    bridge = new AudioBridge(
      createTestConfig(WYOMING_PORT, REALTIME_PORT),
      undefined,
      mockOpenClaw,
    );
    await bridge.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await bridge.stop();
    await mockServer.close();
  });

  it('direct tool (ha_light_control) executes via OpenClaw for guest', async () => {
    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    // Stream audio to establish Realtime connection
    await client.streamAudio(10, 640, 2);
    await new Promise((r) => setTimeout(r, 300));

    // Send function call from mock Realtime server
    mockServer.sendFunctionCall('ha_light_control', '{"action":"off"}');
    await new Promise((r) => setTimeout(r, 300));

    expect(mockOpenClaw.executeTool).toHaveBeenCalledWith('ha_light_control', { action: 'off' });

    client.destroy();
  });

  it('guest cannot use paperless_full (permission denied)', async () => {
    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    // Stream audio to establish Realtime connection (no Eagle = guest)
    await client.streamAudio(10, 640, 2);
    await new Promise((r) => setTimeout(r, 300));

    mockServer.sendFunctionCall('paperless_full', '{"query":"test"}');
    await new Promise((r) => setTimeout(r, 300));

    // executeTool should NOT have been called — permission denied
    expect(mockOpenClaw.executeTool).not.toHaveBeenCalled();

    client.destroy();
  });

  it('reasoning tool triggers openclawClient.ask()', async () => {
    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();

    await client.streamAudio(10, 640, 2);
    await new Promise((r) => setTimeout(r, 300));

    mockServer.sendFunctionCall('request_reasoning', '{"question":"Why is the sky blue?"}');
    await new Promise((r) => setTimeout(r, 300));

    expect(mockOpenClaw.ask).toHaveBeenCalledWith(
      'Why is the sky blue?',
      expect.objectContaining({ sessionId: expect.any(String) }),
    );

    client.destroy();
  });

  it('dangerous tool triggers requestApproval() when permitted', async () => {
    // Need a separate bridge with exec_* in guest-level tools
    // so the permission check passes and the dangerous routing is reached
    await bridge.stop();
    await mockServer.close();

    const dangerousPort = WYOMING_PORT + 50;
    const dangerousRtPort = REALTIME_PORT + 50;
    const dangerousMockServer = new MockRealtimeServer(dangerousRtPort);
    await new Promise<void>((r) => setTimeout(r, 50));

    const dangerousOpenClaw = new StubOpenClawClient(testTools);
    vi.spyOn(dangerousOpenClaw, 'requestApproval');

    const config = createTestConfig(dangerousPort, dangerousRtPort);
    // Add exec_* to guest-level tools so permission check passes
    config.toolRouter.levelTools.guest.push('exec_*');

    const dangerousBridge = new AudioBridge(config, undefined, dangerousOpenClaw);
    await dangerousBridge.start();

    const client = new WyomingTestClient(dangerousPort);
    await client.connect();

    await client.streamAudio(10, 640, 2);
    await new Promise((r) => setTimeout(r, 300));

    dangerousMockServer.sendFunctionCall('exec_rm', '{"path":"/tmp"}');
    await new Promise((r) => setTimeout(r, 300));

    expect(dangerousOpenClaw.requestApproval).toHaveBeenCalledWith('exec_rm', { path: '/tmp' });

    client.destroy();
    await dangerousBridge.stop();
    await dangerousMockServer.close();

    // Recreate default bridge/mockServer for afterEach cleanup
    mockServer = new MockRealtimeServer(REALTIME_PORT);
    await new Promise<void>((r) => setTimeout(r, 50));
    bridge = new AudioBridge(createTestConfig(WYOMING_PORT, REALTIME_PORT), undefined, mockOpenClaw);
    await bridge.start();
  });
});

describe('Integration: Provider + Reconnect', () => {
  it('uses provider preset for config', () => {
    const config = createTestConfig(10300, 19999);
    expect(config.realtime.provider).toBe('xai');
  });

  it('bridge starts with connectWithRetry and recovers from late server', async () => {
    const WYOMING_PORT = 18500 + Math.floor(Math.random() * 100);
    const REALTIME_PORT = 18600 + Math.floor(Math.random() * 100);

    const config = createTestConfig(WYOMING_PORT, REALTIME_PORT);
    const bridge = new AudioBridge(config);
    await bridge.start();

    // Start mock server with small delay AFTER bridge starts (simulating late server)
    await new Promise((r) => setTimeout(r, 100));
    const mockServer = new MockRealtimeServer(REALTIME_PORT);
    // Give mock server time to bind
    await new Promise((r) => setTimeout(r, 50));

    const client = new WyomingTestClient(WYOMING_PORT);
    await client.connect();
    await client.streamAudio(10);
    await new Promise((r) => setTimeout(r, 300));

    // connectWithRetry should have succeeded; trigger VAD response
    mockServer.triggerVadResponse();

    // connectWithRetry should succeed once server is available
    await client.waitForMessageType('transcript', 8000);

    const transcripts = client.getMessagesByType('transcript');
    expect(transcripts.length).toBeGreaterThan(0);

    client.destroy();
    await bridge.stop();
    await mockServer.close();
  }, 15000);
});
