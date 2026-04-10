// src/session/flush.ts

export interface FlushContext {
  hadReasoning: boolean;
  transcriptTokens: number;
}

const DEFAULT_MIN_TOKENS_FOR_FLUSH = 200;

/**
 * Determine if a session's transcripts should be flushed to memory.
 * Only flush meaningful conversations — short tool commands are ignored.
 */
export function shouldFlush(
  ctx: FlushContext,
  minTokens: number = DEFAULT_MIN_TOKENS_FOR_FLUSH,
): boolean {
  return ctx.hadReasoning || ctx.transcriptTokens > minTokens;
}
