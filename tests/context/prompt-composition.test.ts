import { describe, it, expect } from 'vitest';
import { buildInstructions, EMPTY_CONTEXT, type LoadedContext } from '../../src/context/loader.js';

/**
 * These tests cover every realistic combination of prompt sources the bridge
 * may face at session start. The goal: ensure `buildInstructions` output is
 * deterministic and the `## Operating rules` section is always applied when
 * REALTIME_INSTRUCTIONS are configured — regardless of whether OpenClaw
 * provided a SOUL, whether a speaker was identified, and whether a fallback
 * SOUL/IDENTITY/USER block is present.
 *
 * Scenarios mirror what `AudioBridge.reloadContext()` produces for `base`:
 *
 *  - openclaw-full:     OpenClaw returns SOUL + MEMORY (normal production case)
 *  - openclaw-soul:     OpenClaw returns SOUL only (no memory yet)
 *  - openclaw-memory:   OpenClaw returns MEMORY only (no SOUL)
 *  - openclaw-empty:    OpenClaw reachable but returns empty strings
 *  - fallback-full:     OpenClaw unreachable, addon config supplies soul+identity+users
 *  - fallback-soul:     OpenClaw unreachable, addon config supplies soul only
 *  - fallback-users:    OpenClaw unreachable, addon config supplies users only
 *  - none:              No OpenClaw and no fallback at all
 */

const SOUL = '# SOUL.md\nGerman by default. Be helpful.';
const MEM = '# USER.md\n- Viktor (dad)\n- Christina (mum)';
const IDENTITY = '## Identity\nName: Jarvis';
const OP_RULES =
  'Antworte immer auf Deutsch. Rufe request_reasoning für Wissensfragen.';
const SPEAKER = 'Speaker: Viktor, Level: owner';

// Replicates what bridge.reloadContext() builds after OpenClaw returns soul+memory
function buildFromOpenClaw(soul: string, memory: string): LoadedContext {
  return {
    instructions: [soul, memory].filter(Boolean).join('\n\n---\n\n'),
    soulContent: soul,
    memoryContent: memory,
  };
}

// Replicates what bridge.reloadContext() builds from addon fallback fields
function buildFromFallback(
  soul: string,
  identity: string,
  users: string,
): LoadedContext {
  const soulJoined = [soul, identity].filter(Boolean).join('\n\n');
  return {
    instructions: [soulJoined, users].filter(Boolean).join('\n\n---\n\n'),
    soulContent: soulJoined,
    memoryContent: users,
  };
}

describe('prompt composition matrix', () => {
  describe('OpenClaw reachable', () => {
    it('openclaw-full + speaker + rules → all four sections in order', () => {
      const base = buildFromOpenClaw(SOUL, MEM);
      const out = buildInstructions(base, SPEAKER, OP_RULES);

      expect(out).toContain(SOUL);
      expect(out).toContain(MEM);
      expect(out).toContain(SPEAKER);
      expect(out).toContain(OP_RULES);
      expect(out).toContain('## Operating rules');
      expect(out).toContain('## Current Speaker');
      expect(out).toContain("## Who you're talking to");
      expect(out).toContain('## Persona');

      // Required ordering: Rules → Speaker → Memory → Persona
      expect(out.indexOf(OP_RULES)).toBeLessThan(out.indexOf(SPEAKER));
      expect(out.indexOf(SPEAKER)).toBeLessThan(out.indexOf(MEM));
      expect(out.indexOf(MEM)).toBeLessThan(out.indexOf(SOUL));
    });

    it('openclaw-full + rules, no speaker', () => {
      const out = buildInstructions(buildFromOpenClaw(SOUL, MEM), undefined, OP_RULES);
      expect(out).toContain(SOUL);
      expect(out).toContain(MEM);
      expect(out).toContain('## Operating rules');
      expect(out).not.toContain('## Current Speaker');
    });

    it('openclaw-soul only (no memory) + rules', () => {
      const out = buildInstructions(buildFromOpenClaw(SOUL, ''), undefined, OP_RULES);
      expect(out).toContain(SOUL);
      expect(out).not.toContain('# USER.md');
      expect(out).toContain('## Operating rules');
    });

    it('openclaw-memory only (no soul) + rules', () => {
      const out = buildInstructions(buildFromOpenClaw('', MEM), undefined, OP_RULES);
      expect(out).toContain(MEM);
      expect(out).not.toContain('# SOUL.md');
      expect(out).toContain('## Operating rules');
    });

    it('openclaw-empty (reachable but empty) + rules → only rules', () => {
      const out = buildInstructions(buildFromOpenClaw('', ''), undefined, OP_RULES);
      expect(out).toBe(`## Operating rules\n${OP_RULES}`);
    });
  });

  describe('OpenClaw unreachable, fallback config used', () => {
    it('fallback-full + speaker + rules → all sections', () => {
      const base = buildFromFallback(SOUL, IDENTITY, MEM);
      const out = buildInstructions(base, SPEAKER, OP_RULES);

      expect(out).toContain(SOUL);
      expect(out).toContain(IDENTITY);
      expect(out).toContain(MEM);
      expect(out).toContain(SPEAKER);
      expect(out).toContain(OP_RULES);
      // Rules come first; soul+identity (persona) last; memory (users) between speaker and persona.
      expect(out.indexOf(OP_RULES)).toBeLessThan(out.indexOf(SPEAKER));
      expect(out.indexOf(MEM)).toBeLessThan(out.indexOf(IDENTITY));
    });

    it('fallback-soul only + rules', () => {
      const out = buildInstructions(buildFromFallback(SOUL, '', ''), undefined, OP_RULES);
      expect(out).toContain(SOUL);
      expect(out).not.toContain('## Identity');
      expect(out).not.toContain('# USER.md');
      expect(out).toContain('## Operating rules');
    });

    it('fallback-users only (no soul/identity) + rules', () => {
      const out = buildInstructions(buildFromFallback('', '', MEM), undefined, OP_RULES);
      expect(out).toContain(MEM);
      expect(out).not.toContain('# SOUL.md');
      expect(out).toContain('## Operating rules');
    });
  });

  describe('No context at all', () => {
    it('none + rules → only the operating rules section', () => {
      const out = buildInstructions(EMPTY_CONTEXT, undefined, OP_RULES);
      expect(out).toBe(`## Operating rules\n${OP_RULES}`);
    });

    it('none + no rules → empty string', () => {
      const out = buildInstructions(EMPTY_CONTEXT, undefined, undefined);
      expect(out).toBe('');
    });

    it('none + speaker + rules → rules then speaker, no persona', () => {
      const out = buildInstructions(EMPTY_CONTEXT, SPEAKER, OP_RULES);
      expect(out).toContain(SPEAKER);
      expect(out).toContain(OP_RULES);
      expect(out).not.toContain('## Persona');
      expect(out.indexOf(OP_RULES)).toBeLessThan(out.indexOf(SPEAKER));
    });
  });

  describe('invariants across all scenarios', () => {
    const cases: Array<[string, LoadedContext]> = [
      ['openclaw-full', buildFromOpenClaw(SOUL, MEM)],
      ['openclaw-soul-only', buildFromOpenClaw(SOUL, '')],
      ['openclaw-memory-only', buildFromOpenClaw('', MEM)],
      ['openclaw-empty', buildFromOpenClaw('', '')],
      ['fallback-full', buildFromFallback(SOUL, IDENTITY, MEM)],
      ['fallback-soul', buildFromFallback(SOUL, '', '')],
      ['fallback-users', buildFromFallback('', '', MEM)],
      ['none', EMPTY_CONTEXT],
    ];

    for (const [label, base] of cases) {
      it(`[${label}] operating rules are ALWAYS appended when provided`, () => {
        const out = buildInstructions(base, undefined, OP_RULES);
        expect(out).toContain('## Operating rules');
        expect(out).toContain(OP_RULES);
      });

      it(`[${label}] operating rules section is the FIRST block`, () => {
        const out = buildInstructions(base, SPEAKER, OP_RULES);
        const rulesIdx = out.indexOf('## Operating rules');
        expect(rulesIdx).toBe(0);
        expect(out.slice(0, OP_RULES.length + 40)).toContain(OP_RULES);
      });

      it(`[${label}] no duplicate operating-rules header`, () => {
        const out = buildInstructions(base, SPEAKER, OP_RULES);
        const count = out.split('## Operating rules').length - 1;
        expect(count).toBe(1);
      });

      it(`[${label}] omitting rules gives output without operating-rules section`, () => {
        const out = buildInstructions(base, SPEAKER);
        expect(out).not.toContain('## Operating rules');
      });
    }
  });
});
