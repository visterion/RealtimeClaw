import type { RealtimeTool } from '../types.js';

export const ENROLL_SPEAKER_TOOL: RealtimeTool = {
  type: 'function',
  name: 'enroll_speaker',
  description: 'Enroll a new speaker for voice recognition. Call when the user wants the assistant to learn their voice. After calling this, the user should keep speaking for about 10 seconds while their voiceprint is recorded.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Speaker name in lowercase without spaces (e.g. "alice", "bob")',
      },
    },
    required: ['name'],
  },
};
