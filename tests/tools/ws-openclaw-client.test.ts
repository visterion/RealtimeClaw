// tests/tools/ws-openclaw-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MockOpenClawWsServer } from '../helpers/mock-openclaw-ws.js';
import { WsOpenClawClient } from '../../src/tools/ws-openclaw-client.js';
import type { OpenClawConfig } from '../../src/types.js';

const WS_PORT = 19200 + Math.floor(Math.random() * 100);

function makeConfig(tmpDir: string, overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    url: `http://127.0.0.1:${WS_PORT}`,
    token: 'test-gateway-token',
    timeoutMs: 5000,
    deviceStorePath: path.join(tmpDir, 'device.json'),
    ...overrides,
  };
}

describe('WsOpenClawClient', () => {
  let tmpDir: string;
  let mockServer: MockOpenClawWsServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-openclaw-test-'));
  });

  afterEach(async () => {
    if (mockServer) await mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('getContext() — happy path', () => {
    it('B1: connects via WS, reads SOUL+IDENTITY+USER files', async () => {
      mockServer = new MockOpenClawWsServer({
        port: WS_PORT,
        files: {
          'SOUL.md': { content: '# Soul\nBe helpful.' },
          'IDENTITY.md': { content: '# Identity\nName: Jarvis' },
          'USER.md': { content: '# Users\nAlice is the owner.' },
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      const client = new WsOpenClawClient(makeConfig(tmpDir));
      const ctx = await client.getContext();

      expect(ctx.soul).toContain('# Soul');
      expect(ctx.soul).toContain('# Identity');
      expect(ctx.memory).toContain('Alice is the owner');
      expect(mockServer.fileGetCount).toBe(3);
    });
  });

  describe('getContext() — error handling', () => {
    it('B2: NOT_PAIRED exhausts retries and falls back to HTTP getContext()', async () => {
      mockServer = new MockOpenClawWsServer({
        port: WS_PORT,
        rejectAsPending: true,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Mock the HTTP fallback
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: 'fallback-soul' }) } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: { path: 'memory.md', text: 'fallback-memory' } }) } as Response);

      const client = new WsOpenClawClient(makeConfig(tmpDir));
      // Use maxAttempts=1 and short interval so we exhaust immediately and fall back to HTTP
      const ctx = await client.getContextWithRetry(10, 1);

      // Should fall back to HTTP after exhausting retries
      expect(ctx.soul).toBeDefined();
      expect(mockServer.fileGetCount).toBe(0); // Never reached file reading
    }, 5000);

    it('B4: WS connection error falls back to HTTP', async () => {
      // No server running on this port
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: 'fallback' }) } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: { text: 'mem' } }) } as Response);

      const deadPort = 19900 + Math.floor(Math.random() * 50);
      const client = new WsOpenClawClient(makeConfig(tmpDir, { url: `http://127.0.0.1:${deadPort}` }));
      const ctx = await client.getContext();

      expect(ctx).toBeDefined();
    });

    it('B7: missing IDENTITY.md returns soul with only SOUL.md', async () => {
      mockServer = new MockOpenClawWsServer({
        port: WS_PORT,
        files: {
          'SOUL.md': { content: '# Soul content' },
          'IDENTITY.md': { content: '', missing: true },
          'USER.md': { content: '# Users' },
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      const client = new WsOpenClawClient(makeConfig(tmpDir));
      const ctx = await client.getContext();

      expect(ctx.soul).toContain('# Soul content');
      expect(ctx.soul).not.toContain('IDENTITY');
    });
  });

  describe('getContextWithRetry()', () => {
    it('retries on NOT_PAIRED and succeeds when approved', async () => {
      mockServer = new MockOpenClawWsServer({
        port: WS_PORT,
        rejectAsPending: true,
        files: { 'SOUL.md': { content: 'soul' }, 'IDENTITY.md': { content: '' }, 'USER.md': { content: '' } },
      });
      await new Promise((r) => setTimeout(r, 50));

      // After 200ms, switch to accepting
      setTimeout(() => {
        mockServer.rejectAsPending = false;
      }, 200);

      const client = new WsOpenClawClient(makeConfig(tmpDir));
      // Use short retry interval for test speed
      const ctx = await client.getContextWithRetry(100, 10);
      expect(ctx.soul).toContain('soul');
    }, 10000);
  });

  describe('device token persistence', () => {
    it('B5: saves device token after successful connect', async () => {
      mockServer = new MockOpenClawWsServer({
        port: WS_PORT,
        files: { 'SOUL.md': { content: 'soul' }, 'IDENTITY.md': { content: 'id' }, 'USER.md': { content: 'user' } },
        deviceToken: 'issued-token-abc',
      });
      await new Promise((r) => setTimeout(r, 50));

      const storePath = path.join(tmpDir, 'device.json');
      const client = new WsOpenClawClient(makeConfig(tmpDir));
      await client.getContext();

      const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      expect(stored.deviceToken).toBe('issued-token-abc');
    });
  });

  describe('fresh context per call', () => {
    it('B9: two getContext() calls read fresh files each time', async () => {
      mockServer = new MockOpenClawWsServer({
        port: WS_PORT,
        files: { 'SOUL.md': { content: 'v1' }, 'IDENTITY.md': { content: '' }, 'USER.md': { content: '' } },
      });
      await new Promise((r) => setTimeout(r, 50));

      const client = new WsOpenClawClient(makeConfig(tmpDir));

      const ctx1 = await client.getContext();
      expect(ctx1.soul).toContain('v1');

      // Update files
      mockServer.setFiles({ 'SOUL.md': { content: 'v2' }, 'IDENTITY.md': { content: '' }, 'USER.md': { content: '' } });

      const ctx2 = await client.getContext();
      expect(ctx2.soul).toContain('v2');
      expect(mockServer.fileGetCount).toBe(6); // 3 files × 2 calls
    });
  });

  describe('HTTP delegation', () => {
    it('B8: executeTool delegates to HTTP client', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: async () => ({ ok: true, result: { status: 'done' } }),
        } as Response);

      const client = new WsOpenClawClient(makeConfig(tmpDir));
      const result = await client.executeTool('ha_light_control', { action: 'on' });

      expect(result).toContain('done');
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/tools/invoke');
    });

    it('B8: ask delegates to HTTP client', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: 'The answer is 42.' } }] }),
        } as Response);

      const client = new WsOpenClawClient(makeConfig(tmpDir));
      const result = await client.ask('What is life?', {});

      expect(result).toBe('The answer is 42.');
    });
  });
});
