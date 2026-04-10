// src/tools/reasoning-tool.ts
import type { RealtimeTool } from '../types.js';

/**
 * Special tool that xAI can call when it detects a complex question
 * requiring deep reasoning. Triggers OpenClaw.ask() in the background.
 */
export const REQUEST_REASONING_TOOL: RealtimeTool = {
  type: 'function',
  name: 'request_reasoning',
  description: 'Call this when the user asks a complex question that requires deep thinking, analysis, or research. Examples: opinions, explanations, comparisons, philosophical questions. Do NOT call for simple commands like "turn off lights" or "play music".',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The full question or topic to reason about deeply',
      },
      context: {
        type: 'string',
        description: 'Additional conversation context if helpful',
      },
    },
    required: ['question'],
  },
};
