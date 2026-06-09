import { describe, it, expect } from 'vitest';
import { buildInstructions, EMPTY_CONTEXT } from '../../src/context/loader.js';

describe('buildInstructions', () => {
  it('combines base context with speaker', () => {
    const base = { instructions: 'You are Assistant.', soulContent: 'You are Assistant.', memoryContent: '' };
    const result = buildInstructions(base, 'Speaker: Alice (dad, prefers technical answers)');

    expect(result).toContain('You are Assistant.');
    expect(result).toContain('Speaker: Alice');
  });

  it('wraps fallback instructions as operating rules when base is empty', () => {
    const result = buildInstructions(EMPTY_CONTEXT, undefined, 'Default fallback');
    expect(result).toBe('## Operating rules\nDefault fallback');
  });

  it('order is rules → speaker → memory → persona', () => {
    const base = { instructions: 'ignored', soulContent: 'SOUL', memoryContent: 'MEMORY' };
    const result = buildInstructions(base, 'Speaker: Alice', 'Routing rules here');
    expect(result.indexOf('Routing rules here')).toBeLessThan(result.indexOf('Speaker: Alice'));
    expect(result.indexOf('Speaker: Alice')).toBeLessThan(result.indexOf('MEMORY'));
    expect(result.indexOf('MEMORY')).toBeLessThan(result.indexOf('SOUL'));
    expect(result).toContain('## Operating rules');
    expect(result).toContain('## Current Speaker');
    expect(result).toContain("## Who you're talking to");
    expect(result).toContain('## Persona');
  });

  it('works without speaker context', () => {
    const base = { instructions: 'ignored', soulContent: 'Base only.', memoryContent: '' };
    const result = buildInstructions(base);
    expect(result).toBe('## Persona\nBase only.');
  });

  it('memory before persona in instructions', () => {
    const base = {
      instructions: 'ignored',
      soulContent: 'SOUL_CONTENT',
      memoryContent: 'MEMORY_CONTENT',
    };
    const result = buildInstructions(base);
    expect(result.indexOf('MEMORY_CONTENT')).toBeLessThan(result.indexOf('SOUL_CONTENT'));
  });

  it('works with fallback context pattern (soul+identity as soulContent, users as memory)', () => {
    const soul = 'You are Assistant, a helpful home assistant.\n\nYour name is Assistant.';
    const memory = 'Users: Alice (owner), Bob (family)';
    const base = {
      instructions: [soul, memory].filter(Boolean).join('\n\n---\n\n'),
      soulContent: soul,
      memoryContent: memory,
    };
    const result = buildInstructions(base);
    expect(result).toContain('You are Assistant');
    expect(result).toContain('Users: Alice');
    // memory now comes BEFORE the persona
    expect(result.indexOf(memory)).toBeLessThan(result.indexOf(soul));
  });

  it('renders persona-only base correctly', () => {
    const soul = 'You are a helpful assistant.';
    const base = {
      instructions: soul,
      soulContent: soul,
      memoryContent: '',
    };
    const result = buildInstructions(base);
    expect(result).toBe('## Persona\nYou are a helpful assistant.');
  });
});
