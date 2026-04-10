// tests/router/tool-router.test.ts
import { describe, it, expect } from 'vitest';
import { ToolRouter, type ToolType } from '../../src/router/tool-router.js';

describe('ToolRouter', () => {
  const router = new ToolRouter({
    direct:    ['ha_*', 'sonos_*', 'spotify_*', 'paperless_*', 'calendar_*'],
    reasoning: ['request_reasoning'],
    dangerous: ['exec_*', 'file_delete_*'],
  });

  it('routes ha_light_control to direct', () => {
    expect(router.getType('ha_light_control')).toBe('direct');
  });

  it('routes sonos_play to direct', () => {
    expect(router.getType('sonos_play')).toBe('direct');
  });

  it('routes paperless_full to direct', () => {
    expect(router.getType('paperless_full')).toBe('direct');
  });

  it('routes request_reasoning to reasoning', () => {
    expect(router.getType('request_reasoning')).toBe('reasoning');
  });

  it('routes exec_rm to dangerous', () => {
    expect(router.getType('exec_rm')).toBe('dangerous');
  });

  it('routes file_delete_all to dangerous', () => {
    expect(router.getType('file_delete_all')).toBe('dangerous');
  });

  it('routes unknown tool to blocked', () => {
    expect(router.getType('unknown_tool')).toBe('blocked');
  });

  it('routes empty string to blocked', () => {
    expect(router.getType('')).toBe('blocked');
  });

  it('checks types in order: dangerous before direct', () => {
    const customRouter = new ToolRouter({
      direct:    ['exec_safe'],
      reasoning: [],
      dangerous: ['exec_*'],
    });
    expect(customRouter.getType('exec_safe')).toBe('dangerous');
  });
});
