// tests/tools/reasoning-context.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpOpenClawClient } from '../../src/tools/http-openclaw-client.js';
import type { OpenClawConfig } from '../../src/types.js';

const config: OpenClawConfig = {
  url: 'http://localhost:18789',
  token: 'test-token',
  timeoutMs: 5000,
};

function makeFetchSpy(body: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok, status,
    json: async () => body,
  } as Response);
}

describe('Reasoning with Speaker Context', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('E1: ask() sends speaker info as system message', async () => {
    const spy = makeFetchSpy({ choices: [{ message: { content: 'answer' } }] });
    const client = new HttpOpenClawClient(config);
    await client.ask('Why is the sky blue?', {
      speakerId: 'alice',
      speakerName: 'Alice',
      securityLevel: 'owner',
    });

    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('Alice');
    expect(body.messages[0].content).toContain('owner');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('Why is the sky blue?');
  });

  it('E2: guest has Speaker: Unknown (guest)', async () => {
    const spy = makeFetchSpy({ choices: [{ message: { content: 'answer' } }] });
    const client = new HttpOpenClawClient(config);
    await client.ask('What time is it?', { securityLevel: 'guest' });

    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content).toContain('guest');
  });

  it('E3: child speaker has Speaker: Charlie (family)', async () => {
    const spy = makeFetchSpy({ choices: [{ message: { content: 'answer' } }] });
    const client = new HttpOpenClawClient(config);
    await client.ask('Help with homework', {
      speakerId: 'charlie',
      speakerName: 'Charlie',
      securityLevel: 'family',
    });

    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content).toContain('Charlie');
    expect(body.messages[0].content).toContain('family');
  });

  it('E4: recent context sent as additional system message', async () => {
    const spy = makeFetchSpy({ choices: [{ message: { content: 'answer' } }] });
    const client = new HttpOpenClawClient(config);
    await client.ask('Continue our discussion', {
      speakerName: 'Alice',
      recentContext: 'user: Turn on the lights\nassistant: Done!',
    });

    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    // system (speaker) + system (context) + user
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].content).toContain('Turn on the lights');
  });

  it('E5: ask() without speaker context sends only user message', async () => {
    const spy = makeFetchSpy({ choices: [{ message: { content: 'plain' } }] });
    const client = new HttpOpenClawClient(config);
    const result = await client.ask('Simple question', {});

    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(result).toBe('plain');
  });
});

describe('Speaker Tagging in updateMemory', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('D1: user transcript includes speaker tag', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ ok: true, result: null }),
    } as Response);
    const client = new HttpOpenClawClient(config);
    await client.updateMemory(
      [{ role: 'user', text: 'Hello!', speaker: 'alice' }],
      ['alice'],
    );

    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.args.transcripts[0].speaker).toBe('alice');
  });

  it('D2: assistant transcript has no speaker', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ ok: true, result: null }),
    } as Response);
    const client = new HttpOpenClawClient(config);
    await client.updateMemory(
      [
        { role: 'user', text: 'Hi', speaker: 'alice' },
        { role: 'assistant', text: 'Hello!' },
      ],
      ['alice'],
    );

    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.args.transcripts[0].speaker).toBe('alice');
    expect(body.args.transcripts[1].speaker).toBeUndefined();
  });

  it('D3: speaker switch tagged per turn', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: null }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, result: null }) } as Response);
    const client = new HttpOpenClawClient(config);

    await client.updateMemory(
      [{ role: 'user', text: 'Turn 1', speaker: 'alice' }, { role: 'assistant', text: 'OK' }],
      ['alice'],
    );
    await client.updateMemory(
      [{ role: 'user', text: 'Turn 2', speaker: 'charlie' }, { role: 'assistant', text: 'OK' }],
      ['charlie'],
    );

    const body1 = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    const body2 = JSON.parse((spy.mock.calls[1][1] as RequestInit).body as string);
    expect(body1.args.transcripts[0].speaker).toBe('alice');
    expect(body2.args.transcripts[0].speaker).toBe('charlie');
  });

  it('D4: unknown speaker has no speaker tag', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ ok: true, result: null }),
    } as Response);
    const client = new HttpOpenClawClient(config);
    await client.updateMemory(
      [{ role: 'user', text: 'Who am I?' }],
      [],
    );

    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.args.transcripts[0].speaker).toBeUndefined();
  });
});
