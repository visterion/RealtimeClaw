// tests/tools/openclaw-client.test.ts
import { describe, it, expect } from 'vitest';
import { StubOpenClawClient } from '../../src/tools/openclaw-client.js';

describe('StubOpenClawClient', () => {
  it('returns configured tools from getTools()', async () => {
    const tools = [
      { type: 'function' as const, name: 'ha_light_control', description: 'Control lights', parameters: {} },
    ];
    const client = new StubOpenClawClient(tools);
    const result = await client.getTools();
    expect(result).toEqual(tools);
  });

  it('executeTool returns stub result', async () => {
    const client = new StubOpenClawClient([]);
    const result = await client.executeTool('ha_light_control', { action: 'off' });
    expect(JSON.parse(result)).toHaveProperty('status');
  });

  it('ask returns stub reasoning response', async () => {
    const client = new StubOpenClawClient([]);
    const result = await client.ask('What is the meaning of life?', {});
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('requestApproval returns pending status', async () => {
    const client = new StubOpenClawClient([]);
    const result = await client.requestApproval('exec_rm', { path: '/tmp' });
    expect(result).toHaveProperty('approved');
    expect(result).toHaveProperty('message');
  });

  it('updateMemory resolves without error', async () => {
    const client = new StubOpenClawClient([]);
    await expect(
      client.updateMemory([{ role: 'user', text: 'hello' }], ['alice']),
    ).resolves.toBeUndefined();
  });
});
