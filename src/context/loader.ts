export interface LoadedContext {
  instructions: string;
  soulContent: string;
  memoryContent: string;
}

export const EMPTY_CONTEXT: LoadedContext = { instructions: '', soulContent: '', memoryContent: '' };

/**
 * Build session instructions from loaded context and optional speaker context.
 * Static content (soul) first for prompt caching, dynamic (memory) last.
 */
export function buildInstructions(
  base: LoadedContext,
  speakerContext?: string,
  fallbackInstructions?: string,
): string {
  const parts: string[] = [];

  if (base.instructions) {
    parts.push(base.instructions);
  } else if (fallbackInstructions) {
    parts.push(fallbackInstructions);
  }

  if (speakerContext) {
    parts.push(`## Current Speaker\n${speakerContext}`);
  }

  return parts.join('\n\n---\n\n');
}
