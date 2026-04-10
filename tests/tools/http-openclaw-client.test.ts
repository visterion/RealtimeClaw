// tests/tools/http-openclaw-client.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RealtimeTool, OpenClawConfig } from '../../src/types.js';
import { HttpOpenClawClient } from '../../src/tools/http-openclaw-client.js';

const config: OpenClawConfig = {
  url: 'http://localhost:18789',
  token: 'test-token',
  timeoutMs: 5000,
};

function makeFetchSpy(body: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
  } as Response);
}

describe('HttpOpenClawClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('executeTool', () => {
    it('calls POST /tools/invoke with tool name and args', async () => {
      const spy = makeFetchSpy({ ok: true, result: { status: 'done' } });
      const client = new HttpOpenClawClient(config);
      await client.executeTool('ha_light_control', { action: 'on' });

      expect(spy).toHaveBeenCalledOnce();
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:18789/tools/invoke');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        tool: 'ha_light_control',
        args: { action: 'on' },
      });
    });

    it('sends Authorization: Bearer header', async () => {
      makeFetchSpy({ ok: true, result: {} });
      const client = new HttpOpenClawClient(config);
      await client.executeTool('ha_light_control', {});

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    });

    it('returns JSON.stringify of the result field', async () => {
      makeFetchSpy({ ok: true, result: { lights: ['kitchen'] } });
      const client = new HttpOpenClawClient(config);
      const result = await client.executeTool('get_lights', {});
      expect(result).toBe(JSON.stringify({ lights: ['kitchen'] }));
    });

    it('throws when response body has ok: false', async () => {
      makeFetchSpy({ ok: false, error: 'Unknown tool' });
      const client = new HttpOpenClawClient(config);
      await expect(client.executeTool('bad_tool', {})).rejects.toThrow();
    });

    it('throws on HTTP error status', async () => {
      makeFetchSpy({ ok: false }, false, 500);
      const client = new HttpOpenClawClient(config);
      await expect(client.executeTool('ha_light_control', {})).rejects.toThrow();
    });
  });

  describe('getTools', () => {
    it('calls /tools/invoke with tool: "tools_catalog"', async () => {
      const tools: RealtimeTool[] = [
        { type: 'function', name: 'ha_light_control', description: 'Control lights', parameters: {} },
      ];
      const spy = makeFetchSpy({ ok: true, result: tools });
      const client = new HttpOpenClawClient(config);
      await client.getTools();

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:18789/tools/invoke');
      expect(JSON.parse(init.body as string)).toEqual({ tool: 'tools_catalog', args: undefined });
    });

    it('returns result as RealtimeTool[]', async () => {
      const tools: RealtimeTool[] = [
        { type: 'function', name: 'ha_light_control', description: 'Control lights', parameters: {} },
      ];
      makeFetchSpy({ ok: true, result: tools });
      const client = new HttpOpenClawClient(config);
      const result = await client.getTools();
      expect(result).toEqual(tools);
    });
  });

  describe('ask', () => {
    it('calls POST /v1/chat/completions', async () => {
      const spy = makeFetchSpy({
        choices: [{ message: { content: 'The answer is 42.' } }],
      });
      const client = new HttpOpenClawClient(config);
      await client.ask('What is the meaning of life?', {});

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:18789/v1/chat/completions');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe('openclaw');
      expect(body.messages).toEqual([{ role: 'user', content: 'What is the meaning of life?' }]);
    });

    it('returns choices[0].message.content', async () => {
      makeFetchSpy({
        choices: [{ message: { content: 'The answer is 42.' } }],
      });
      const client = new HttpOpenClawClient(config);
      const result = await client.ask('What is the meaning of life?', {});
      expect(result).toBe('The answer is 42.');
    });

    it('sends Authorization: Bearer header', async () => {
      makeFetchSpy({ choices: [{ message: { content: 'ok' } }] });
      const client = new HttpOpenClawClient(config);
      await client.ask('hello', {});

      const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    });
  });

  describe('requestApproval', () => {
    it('calls /tools/invoke with tool: "approval_request"', async () => {
      const spy = makeFetchSpy({ ok: true, result: { approved: true, message: 'Approved' } });
      const client = new HttpOpenClawClient(config);
      await client.requestApproval('exec_rm', { path: '/tmp/foo' });

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:18789/tools/invoke');
      expect(JSON.parse(init.body as string)).toEqual({
        tool: 'approval_request',
        args: { tool: 'exec_rm', args: { path: '/tmp/foo' } },
      });
    });

    it('returns { approved, message }', async () => {
      makeFetchSpy({ ok: true, result: { approved: false, message: 'Denied by owner' } });
      const client = new HttpOpenClawClient(config);
      const result = await client.requestApproval('exec_rm', { path: '/tmp' });
      expect(result).toEqual({ approved: false, message: 'Denied by owner' });
    });
  });

  describe('updateMemory', () => {
    it('calls /tools/invoke with tool: "memory_update"', async () => {
      const spy = makeFetchSpy({ ok: true, result: null });
      const client = new HttpOpenClawClient(config);
      const transcripts = [{ role: 'user', text: 'hello' }];
      const speakers = ['alice'];
      await client.updateMemory(transcripts, speakers);

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:18789/tools/invoke');
      expect(JSON.parse(init.body as string)).toEqual({
        tool: 'memory_update',
        args: { transcripts, speakers },
      });
    });

    it('resolves void', async () => {
      makeFetchSpy({ ok: true, result: null });
      const client = new HttpOpenClawClient(config);
      await expect(
        client.updateMemory([{ role: 'user', text: 'bye' }], ['bob']),
      ).resolves.toBeUndefined();
    });
  });

  describe('getContext', () => {
    it('calls soul_get and memory_get in parallel', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: 'You are Jarvis.' }) } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: { path: 'memory.md', text: 'Alice is the owner.' } }) } as Response);

      const client = new HttpOpenClawClient(config);
      const ctx = await client.getContext();

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const bodies = fetchSpy.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
      expect(bodies).toContainEqual({ tool: 'soul_get', args: undefined });
      expect(bodies).toContainEqual({ tool: 'memory_get', args: { path: 'memory.md' } });
      expect(ctx.soul).toBe('You are Jarvis.');
      expect(ctx.memory).toBe('Alice is the owner.');
    });

    it('returns empty soul if soul_get fails', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: { path: 'memory.md', text: 'mem' } }) } as Response);

      const client = new HttpOpenClawClient(config);
      const ctx = await client.getContext();
      expect(ctx.soul).toBe('');
      expect(ctx.memory).toBe('mem');
    });

    it('returns empty memory if memory_get fails', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: 'soul content' }) } as Response)
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);

      const client = new HttpOpenClawClient(config);
      const ctx = await client.getContext();
      expect(ctx.soul).toBe('soul content');
      expect(ctx.memory).toBe('');
    });
  });

  describe('URL normalisation', () => {
    it('strips trailing slash from URL', async () => {
      const spy = makeFetchSpy({ ok: true, result: {} });
      const client = new HttpOpenClawClient({ ...config, url: 'http://localhost:18789/' });
      await client.executeTool('ha_light_control', {});

      const [url] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:18789/tools/invoke');
    });
  });
});
