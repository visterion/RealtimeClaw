// tests/tools/reasoning-tool.test.ts
import { describe, it, expect } from 'vitest';
import { REQUEST_REASONING_TOOL } from '../../src/tools/reasoning-tool.js';

describe('REQUEST_REASONING_TOOL', () => {
  it('has type function', () => {
    expect(REQUEST_REASONING_TOOL.type).toBe('function');
  });

  it('is named request_reasoning', () => {
    expect(REQUEST_REASONING_TOOL.name).toBe('request_reasoning');
  });

  it('has a question parameter', () => {
    const params = REQUEST_REASONING_TOOL.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(params.type).toBe('object');
    expect(params.properties).toHaveProperty('question');
    expect(params.required).toContain('question');
  });
});
