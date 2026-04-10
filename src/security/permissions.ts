import { type SecurityLevel, SECURITY_LEVEL_ORDER } from './levels.js';
import type { RealtimeTool } from '../types.js';

/** The reasoning tool is always available regardless of security level */
const ALWAYS_ALLOWED = ['request_reasoning'];

/** Simple glob matching: supports trailing wildcard only (e.g. "ha_*") */
export function matchesGlob(name: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return name.startsWith(pattern.slice(0, -1));
  }
  return name === pattern;
}

/**
 * Filter tools by security level. Higher levels include all lower-level tools.
 * The `request_reasoning` tool is always included.
 */
export function filterToolsForLevel(
  tools: RealtimeTool[],
  level: SecurityLevel,
  levelTools: Record<SecurityLevel, string[]>,
): RealtimeTool[] {
  const levelIdx = SECURITY_LEVEL_ORDER.indexOf(level);
  const allowedPatterns: string[] = [];
  for (let i = 0; i <= levelIdx; i++) {
    const lvl = SECURITY_LEVEL_ORDER[i];
    allowedPatterns.push(...(levelTools[lvl] ?? []));
  }

  return tools.filter((tool) => {
    if (ALWAYS_ALLOWED.includes(tool.name)) return true;
    return allowedPatterns.some((pattern) => matchesGlob(tool.name, pattern));
  });
}
