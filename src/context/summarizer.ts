import type { ContextConfig } from '../types.js';

// Rough token estimation: ~4 chars per token for English/German mixed text
const CHARS_PER_TOKEN = 4;

interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

/**
 * Tracks conversation turns and estimates token usage.
 * When approaching the context window limit, summarizes older turns.
 */
export class ContextSummarizer {
  private config: ContextConfig;
  private assistantName: string;
  private turns: ConversationTurn[] = [];
  private baseInstructionTokens = 0;

  constructor(config: ContextConfig, assistantName: string) {
    this.config = config;
    this.assistantName = assistantName;
  }

  setBaseInstructionSize(instructions: string): void {
    this.baseInstructionTokens = this.estimateTokens(instructions);
  }

  addTurn(role: 'user' | 'assistant', text: string): void {
    this.turns.push({ role, text, timestamp: Date.now() });
  }

  /**
   * Check if summarization is needed and return summary if so.
   * Returns null if within budget.
   */
  checkAndSummarize(): { summary: string; removedTurns: number } | null {
    const totalTokens = this.estimateTotalTokens();
    const threshold = this.config.maxContextTokens * this.config.summarizeAtTokenRatio;

    if (totalTokens < threshold) return null;

    // Keep the last 4 turns, summarize everything before
    const keepCount = Math.min(4, this.turns.length);
    const toSummarize = this.turns.slice(0, this.turns.length - keepCount);

    if (toSummarize.length === 0) return null;

    const summary = this.buildSummary(toSummarize);
    const removedTurns = toSummarize.length;

    // Replace old turns with summary
    this.turns = [
      { role: 'assistant', text: `[Summary of earlier conversation]: ${summary}`, timestamp: Date.now() },
      ...this.turns.slice(this.turns.length - keepCount),
    ];

    return { summary, removedTurns };
  }

  getTurnCount(): number {
    return this.turns.length;
  }

  /** Get the last N turns formatted as a string for context injection */
  getRecentTurns(count: number): string | undefined {
    if (this.turns.length === 0) return undefined;
    const recent = this.turns.slice(-count);
    return recent.map((t) => `${t.role}: ${t.text}`).join('\n');
  }

  getEstimatedTokens(): number {
    return this.estimateTotalTokens();
  }

  reset(): void {
    this.turns = [];
    this.baseInstructionTokens = 0;
  }

  private estimateTotalTokens(): number {
    const turnTokens = this.turns.reduce((sum, t) => sum + this.estimateTokens(t.text), 0);
    return this.baseInstructionTokens + turnTokens;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  private buildSummary(turns: ConversationTurn[]): string {
    const lines = turns.map((t) => {
      const label = t.role === 'user' ? 'User' : this.assistantName;
      // Truncate long turns in summary
      const text = t.text.length > 200 ? t.text.slice(0, 200) + '...' : t.text;
      return `${label}: ${text}`;
    });
    return lines.join(' | ');
  }
}
