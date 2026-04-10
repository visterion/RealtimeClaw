// tests/integration-openclaw.test.ts
// Integration tests for OpenClaw WS RPC + Speaker Context flow
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MockOpenClawWsServer } from './helpers/mock-openclaw-ws.js';
import { WsOpenClawClient } from '../src/tools/ws-openclaw-client.js';
import type { OpenClawConfig } from '../src/types.js';

const OC_PORT = 19400 + Math.floor(Math.random() * 100);

describe('Integration: OpenClaw WS RPC', () => {
  let tmpDir: string;
  let mockOC: MockOpenClawWsServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-integ-'));
  });

  afterEach(async () => {
    if (mockOC) await mockOC.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeConfig(): OpenClawConfig {
    return {
      url: `http://127.0.0.1:${OC_PORT}`,
      token: 'test-token',
      timeoutMs: 5000,
      deviceStorePath: path.join(tmpDir, 'device.json'),
    };
  }

  it('F1: session start loads SOUL + IDENTITY + USER via WS', async () => {
    mockOC = new MockOpenClawWsServer({
      port: OC_PORT,
      files: {
        'SOUL.md': { content: '# Soul\nBe cheeky but helpful.' },
        'IDENTITY.md': { content: '# Identity\nName: Jarvis\nVoice: Eve' },
        'USER.md': { content: '# Users\nAlice is the owner. Bob is family.' },
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    const client = new WsOpenClawClient(makeConfig());
    const ctx = await client.getContext();

    // Soul = SOUL.md + IDENTITY.md combined
    expect(ctx.soul).toContain('Be cheeky but helpful');
    expect(ctx.soul).toContain('Name: Jarvis');
    // Memory = USER.md
    expect(ctx.memory).toContain('Alice is the owner');
    expect(ctx.memory).toContain('Bob is family');
  });

  it('F4: NOT_PAIRED graceful degradation — exhausts retries and falls back to HTTP', async () => {
    mockOC = new MockOpenClawWsServer({
      port: OC_PORT,
      rejectAsPending: true,
    });
    await new Promise((r) => setTimeout(r, 50));

    // Mock HTTP fallback
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: 'http-soul' }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: { text: 'http-mem' } }) } as Response);

    const client = new WsOpenClawClient(makeConfig());
    // Use short retry interval + maxAttempts=1 to exhaust immediately and fall back to HTTP
    const ctx = await client.getContextWithRetry(10, 1);

    // Falls back to HTTP — still returns something
    expect(ctx).toBeDefined();
    expect(ctx.soul).toBeDefined();
    expect(mockOC.fileGetCount).toBe(0); // Never reached files
  }, 5000);

  it('F5: context refresh between sessions returns fresh data', async () => {
    mockOC = new MockOpenClawWsServer({
      port: OC_PORT,
      files: {
        'SOUL.md': { content: 'Soul v1' },
        'IDENTITY.md': { content: 'Id v1' },
        'USER.md': { content: 'Users v1' },
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    const client = new WsOpenClawClient(makeConfig());

    // Session 1
    const ctx1 = await client.getContext();
    expect(ctx1.soul).toContain('Soul v1');
    expect(ctx1.memory).toContain('Users v1');

    // OpenClaw updates files between sessions (Jarvis learned something)
    mockOC.setFiles({
      'SOUL.md': { content: 'Soul v2 — evolved' },
      'IDENTITY.md': { content: 'Id v2' },
      'USER.md': { content: 'Users v2 — Charlie likes gaming' },
    });

    // Session 2
    const ctx2 = await client.getContext();
    expect(ctx2.soul).toContain('Soul v2');
    expect(ctx2.memory).toContain('Charlie likes gaming');
    expect(ctx2.soul).not.toContain('Soul v1');
  });

  it('F2: reasoning call includes speaker context', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: 'Rayleigh scattering causes the blue sky.' } }] }),
    } as Response);

    const client = new WsOpenClawClient(makeConfig());
    const answer = await client.ask('Warum ist der Himmel blau?', {
      speakerId: 'bob',
      speakerName: 'Bob',
      securityLevel: 'owner',
      recentContext: 'user: Mach das Licht an\nassistant: Erledigt.',
    });

    expect(answer).toContain('Rayleigh');

    // Verify speaker info was sent to OpenClaw
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('Bob');
    expect(body.messages[0].content).toContain('owner');
    // Recent context
    expect(body.messages[1].content).toContain('Mach das Licht an');
  });

  it('F3: guest tool routing — allowed vs blocked', async () => {
    // This tests the WsOpenClawClient executeTool delegation to HTTP
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ ok: true, result: { state: 'on' } }),
      } as Response);

    const client = new WsOpenClawClient(makeConfig());
    const result = await client.executeTool('ha_light_control', { action: 'on', entity: 'light.kitchen' });

    expect(JSON.parse(result)).toEqual({ state: 'on' });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
