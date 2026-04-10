import { describe, it, expect } from 'vitest';
import { filterToolsForLevel, matchesGlob } from '../../src/security/permissions.js';
import type { SecurityLevel } from '../../src/security/levels.js';
import type { RealtimeTool } from '../../src/types.js';

function tool(name: string): RealtimeTool {
  return { type: 'function', name, description: `Test ${name}`, parameters: {} };
}

describe('matchesGlob', () => {
  it('matches exact name', () => {
    expect(matchesGlob('sonos_play', 'sonos_play')).toBe(true);
  });

  it('matches wildcard suffix', () => {
    expect(matchesGlob('ha_light_control', 'ha_*')).toBe(true);
    expect(matchesGlob('ha_climate_set', 'ha_*')).toBe(true);
  });

  it('rejects non-matching pattern', () => {
    expect(matchesGlob('sonos_play', 'ha_*')).toBe(false);
  });

  it('rejects partial match without wildcard', () => {
    expect(matchesGlob('ha_light_control', 'ha_light')).toBe(false);
  });
});

describe('filterToolsForLevel', () => {
  const levelTools: Record<SecurityLevel, string[]> = {
    guest:   ['ha_light_*', 'sonos_*', 'spotify_*'],
    family:  ['ha_climate_*', 'calendar_own'],
    trusted: ['paperless_titles_only', 'calendar_all'],
    owner:   ['paperless_full'],
  };

  const allTools = [
    tool('ha_light_control'),
    tool('ha_climate_set'),
    tool('sonos_play'),
    tool('spotify_play'),
    tool('calendar_own'),
    tool('calendar_all'),
    tool('paperless_titles_only'),
    tool('paperless_full'),
    tool('request_reasoning'),
  ];

  it('guest gets only light, sonos, spotify + request_reasoning', () => {
    const result = filterToolsForLevel(allTools, 'guest', levelTools);
    const names = result.map((t) => t.name);
    expect(names).toContain('ha_light_control');
    expect(names).toContain('sonos_play');
    expect(names).toContain('spotify_play');
    expect(names).toContain('request_reasoning');
    expect(names).not.toContain('ha_climate_set');
    expect(names).not.toContain('paperless_full');
  });

  it('family gets guest tools + climate + calendar_own', () => {
    const result = filterToolsForLevel(allTools, 'family', levelTools);
    const names = result.map((t) => t.name);
    expect(names).toContain('ha_light_control');
    expect(names).toContain('ha_climate_set');
    expect(names).toContain('calendar_own');
    expect(names).not.toContain('paperless_titles_only');
  });

  it('trusted gets family tools + paperless_titles_only + calendar_all', () => {
    const result = filterToolsForLevel(allTools, 'trusted', levelTools);
    const names = result.map((t) => t.name);
    expect(names).toContain('paperless_titles_only');
    expect(names).toContain('calendar_all');
    expect(names).not.toContain('paperless_full');
  });

  it('owner gets all tools', () => {
    const result = filterToolsForLevel(allTools, 'owner', levelTools);
    const names = result.map((t) => t.name);
    expect(names).toContain('paperless_full');
    expect(names).toContain('ha_light_control');
    expect(names).toContain('request_reasoning');
  });

  it('request_reasoning is always included regardless of level', () => {
    for (const level of ['guest', 'family', 'trusted', 'owner'] as SecurityLevel[]) {
      const result = filterToolsForLevel(allTools, level, levelTools);
      expect(result.map((t) => t.name)).toContain('request_reasoning');
    }
  });

  it('returns empty array when no tools match', () => {
    const result = filterToolsForLevel(allTools, 'guest', { guest: [], family: [], trusted: [], owner: [] });
    expect(result.map((t) => t.name)).toEqual(['request_reasoning']);
  });
});
