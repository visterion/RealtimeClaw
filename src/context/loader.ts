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

  // Operating rules FIRST: language lock, routing, voice format. Putting them
  // at the top (and re-anchoring tool behaviour in tool descriptions) prevents
  // the persona — which may be largely English — from dominating the session.
  if (fallbackInstructions) {
    parts.push(`## Operating rules\n${fallbackInstructions}`);
  }

  // Then: who is being spoken to.
  if (speakerContext) {
    parts.push(`## Current Speaker\n${speakerContext}`);
  }

  if (base.memoryContent) {
    parts.push(`## Who you're talking to\n${base.memoryContent}`);
  }

  // Persona (SOUL) last — defines vibe without overriding the rules above.
  if (base.soulContent) {
    parts.push(`## Persona\n${base.soulContent}`);
  }

  return parts.join('\n\n---\n\n');
}
