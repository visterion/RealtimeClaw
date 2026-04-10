import { describe, it, expect } from 'vitest';
import { buildInstructions, EMPTY_CONTEXT } from '../../src/context/loader.js';

describe('buildInstructions', () => {
  it('combines base context with speaker', () => {
    const base = { instructions: 'You are Assistant.', soulContent: 'You are Assistant.', memoryContent: '' };
    const result = buildInstructions(base, 'Speaker: Alice (dad, prefers technical answers)');

    expect(result).toContain('You are Assistant.');
    expect(result).toContain('Speaker: Alice');
  });

  it('uses fallback instructions when base is empty', () => {
    const result = buildInstructions(EMPTY_CONTEXT, undefined, 'Default fallback');
    expect(result).toBe('Default fallback');
  });

  it('works without speaker context', () => {
    const base = { instructions: 'Base only.', soulContent: 'Base only.', memoryContent: '' };
    const result = buildInstructions(base);
    expect(result).toBe('Base only.');
  });

  it('soul before memory in instructions (prompt caching)', () => {
    const base = {
      instructions: 'SOUL_CONTENT\n\n---\n\nMEMORY_CONTENT',
      soulContent: 'SOUL_CONTENT',
      memoryContent: 'MEMORY_CONTENT',
    };
    const result = buildInstructions(base);
    expect(result.indexOf('SOUL_CONTENT')).toBeLessThan(result.indexOf('MEMORY_CONTENT'));
  });

  it('works with fallback context pattern (soul+identity joined, users as memory)', () => {
    // Simulate what reloadContext() produces when using fallbackContext fields
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
    expect(result.indexOf(soul)).toBeLessThan(result.indexOf(memory));
  });

  it('works with fallback context when only soul is provided', () => {
    const soul = 'You are a helpful assistant.';
    const base = {
      instructions: soul,
      soulContent: soul,
      memoryContent: '',
    };
    const result = buildInstructions(base);
    expect(result).toBe(soul);
  });
});
