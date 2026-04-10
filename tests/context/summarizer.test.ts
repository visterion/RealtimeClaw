import { describe, it, expect } from 'vitest';
import { ContextSummarizer } from '../../src/context/summarizer.js';

describe('ContextSummarizer', () => {
  it('does not summarize when under budget', () => {
    const summarizer = new ContextSummarizer({ summarizeAtTokenRatio: 0.8, maxContextTokens: 10000 }, 'Assistant');
    summarizer.setBaseInstructionSize('Short instructions');

    summarizer.addTurn('user', 'Hello');
    summarizer.addTurn('assistant', 'Hi there!');

    const result = summarizer.checkAndSummarize();
    expect(result).toBeNull();
  });

  it('summarizes when over budget', () => {
    // Small window to trigger summarization easily
    const summarizer = new ContextSummarizer({ summarizeAtTokenRatio: 0.8, maxContextTokens: 100 }, 'Assistant');
    summarizer.setBaseInstructionSize('x'.repeat(200)); // 50 tokens base

    // Add many turns to exceed 80 tokens (80% of 100)
    for (let i = 0; i < 10; i++) {
      summarizer.addTurn('user', `Question number ${i} about something interesting`);
      summarizer.addTurn('assistant', `Answer number ${i} with detailed explanation`);
    }

    const result = summarizer.checkAndSummarize();
    expect(result).not.toBeNull();
    expect(result!.removedTurns).toBeGreaterThan(0);
    expect(result!.summary).toContain('Question');
  });

  it('keeps last 4 turns after summarization', () => {
    const summarizer = new ContextSummarizer({ summarizeAtTokenRatio: 0.8, maxContextTokens: 100 }, 'Assistant');
    summarizer.setBaseInstructionSize('x'.repeat(200));

    for (let i = 0; i < 10; i++) {
      summarizer.addTurn('user', `Q${i} ${'x'.repeat(50)}`);
      summarizer.addTurn('assistant', `A${i} ${'x'.repeat(50)}`);
    }

    summarizer.checkAndSummarize();

    // Should have summary turn + 4 kept turns = 5
    expect(summarizer.getTurnCount()).toBe(5);
  });

  it('truncates long turns in summary', () => {
    const summarizer = new ContextSummarizer({ summarizeAtTokenRatio: 0.8, maxContextTokens: 100 }, 'Assistant');
    summarizer.setBaseInstructionSize('x'.repeat(200));

    const longText = 'A'.repeat(500);
    for (let i = 0; i < 10; i++) {
      summarizer.addTurn('user', longText);
      summarizer.addTurn('assistant', longText);
    }

    const result = summarizer.checkAndSummarize();
    expect(result).not.toBeNull();
    expect(result!.summary).toContain('...');
  });

  it('tracks turn count', () => {
    const summarizer = new ContextSummarizer({ summarizeAtTokenRatio: 0.8, maxContextTokens: 10000 }, 'Assistant');

    expect(summarizer.getTurnCount()).toBe(0);

    summarizer.addTurn('user', 'Q');
    summarizer.addTurn('assistant', 'A');

    expect(summarizer.getTurnCount()).toBe(2);
  });

  it('estimates tokens', () => {
    const summarizer = new ContextSummarizer({ summarizeAtTokenRatio: 0.8, maxContextTokens: 10000 }, 'Assistant');
    summarizer.setBaseInstructionSize('x'.repeat(400)); // ~100 tokens

    summarizer.addTurn('user', 'x'.repeat(40)); // ~10 tokens

    expect(summarizer.getEstimatedTokens()).toBe(110);
  });

  it('resets state', () => {
    const summarizer = new ContextSummarizer({ summarizeAtTokenRatio: 0.8, maxContextTokens: 10000 }, 'Assistant');
    summarizer.setBaseInstructionSize('test');
    summarizer.addTurn('user', 'Hello');

    summarizer.reset();

    expect(summarizer.getTurnCount()).toBe(0);
    expect(summarizer.getEstimatedTokens()).toBe(0);
  });

  it('uses configured assistant name in summaries', () => {
    const summarizer = new ContextSummarizer({ summarizeAtTokenRatio: 0.8, maxContextTokens: 100 }, 'Assistant');
    summarizer.setBaseInstructionSize('x'.repeat(200));

    for (let i = 0; i < 10; i++) {
      summarizer.addTurn('user', `Q${i} pad ${'x'.repeat(30)}`);
      summarizer.addTurn('assistant', `A${i} pad ${'x'.repeat(30)}`);
    }

    const result = summarizer.checkAndSummarize();
    expect(result!.summary).toContain('Assistant:');
    expect(result!.summary).toContain('User:');
  });
});
