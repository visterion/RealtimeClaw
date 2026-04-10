// src/realtime/reconnect.ts
export interface ReconnectConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  maxRetries: 5,
  initialDelayMs: 200,
  maxDelayMs: 10000,
  backoffFactor: 2.0,
};

/**
 * Calculate exponential backoff delay with jitter.
 * Jitter prevents thundering herd on reconnect.
 */
export function calculateBackoff(attempt: number, config: ReconnectConfig): number {
  const baseDelay = config.initialDelayMs * (config.backoffFactor ** attempt);
  const jitter = baseDelay * (0.75 + Math.random() * 0.5);
  const capped = Math.min(jitter, config.maxDelayMs);
  return Math.max(1, Math.floor(capped));
}
