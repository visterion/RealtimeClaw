// src/router/tool-router.ts
import { matchesGlob } from '../security/permissions.js';

export type ToolType = 'direct' | 'reasoning' | 'dangerous' | 'blocked';

export interface ToolRouteConfig {
  direct: string[];
  reasoning: string[];
  dangerous: string[];
}

/**
 * Routes tool names to execution types using glob patterns.
 * Check order: dangerous → reasoning → direct → blocked.
 * Dangerous is checked first so it cannot be bypassed by a direct match.
 */
export class ToolRouter {
  private config: ToolRouteConfig;

  constructor(config: ToolRouteConfig) {
    this.config = config;
  }

  getType(toolName: string): ToolType {
    if (!toolName) return 'blocked';
    if (this.config.dangerous.some((p) => matchesGlob(toolName, p))) return 'dangerous';
    if (this.config.reasoning.some((p) => matchesGlob(toolName, p))) return 'reasoning';
    if (this.config.direct.some((p) => matchesGlob(toolName, p))) return 'direct';
    return 'blocked';
  }
}
