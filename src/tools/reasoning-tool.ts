// src/tools/reasoning-tool.ts
import type { RealtimeTool } from '../types.js';

/**
 * Special tool that xAI can call when it detects a complex question
 * requiring deep reasoning. Triggers OpenClaw.ask() in the background.
 */
export const REQUEST_REASONING_TOOL: RealtimeTool = {
  type: 'function',
  name: 'request_reasoning',
  description: [
    'Forward a substantive user question to Jarvis (deep reasoning backend). Jarvis answers asynchronously; meanwhile you only say a short "Moment" to the user.',
    '',
    'CALL THIS ONLY for real knowledge questions that need thinking, research, or family/memory context. Examples:',
    '- "Was weißt du über Paul / Sophia / Christina / Viktor"',
    '- "Wie wird das Wetter", "Was läuft heute Abend", "Was soll ich kochen"',
    '- "Erklär mir X", "Warum Y", "Wie funktioniert Z"',
    '- Opinion / recommendation / planning questions ("Was empfiehlst du", "Was denkst du über")',
    '',
    'DO NOT CALL for:',
    '- Smart-home commands (light_control, get_state, call_service, list_entities handle those)',
    '- One-word confirmations, acknowledgements or back-channel: "ok", "ja", "nein", "danke", "verstehe", "gut", "alles klar", "okay super"',
    '- Filler repeats or "Hast du gar nichts gesagt"-type meta-complaints — just apologize and wait, do NOT call reasoning again',
    '- While a previous request_reasoning is still pending: wait for the system message with Jarvis\'s answer before calling another reasoning. Never call reasoning back-to-back on the same topic.',
    '',
    'If you already called request_reasoning in the current turn and a reply came back as a system message, use that reply verbatim and do not call the tool again. Never invent weather, facts about the family, or anything you don\'t know — if in doubt and the rules above allow it, forward the question.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The full user question, verbatim if possible',
      },
      context: {
        type: 'string',
        description: 'Optional extra context from the recent conversation',
      },
    },
    required: ['question'],
  },
};
