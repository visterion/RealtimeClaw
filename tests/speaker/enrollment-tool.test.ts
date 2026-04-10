import { describe, it, expect } from 'vitest';
import { ENROLL_SPEAKER_TOOL } from '../../src/speaker/enrollment-tool.js';

describe('ENROLL_SPEAKER_TOOL', () => {
  it('has correct name and type', () => {
    expect(ENROLL_SPEAKER_TOOL.name).toBe('enroll_speaker');
    expect(ENROLL_SPEAKER_TOOL.type).toBe('function');
  });

  it('requires name parameter', () => {
    const params = ENROLL_SPEAKER_TOOL.parameters as { required: string[] };
    expect(params.required).toContain('name');
  });
});
