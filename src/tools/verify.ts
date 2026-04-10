// src/tools/verify.ts — startup checks for configured integrations
import type { BridgeConfig } from '../types.js';

export interface VerifyResult {
  name: string;
  status: 'ok' | 'error' | 'skip';
  message: string;
}

export async function verifyConfig(config: BridgeConfig): Promise<VerifyResult[]> {
  const checks = await Promise.allSettled([
    verifyXai(config),
    verifyHA(config),
    verifyOpenClaw(config),
    verifyEagle(config),
  ]);
  return checks.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: 'Unknown', status: 'error' as const, message: (r.reason as Error).message },
  );
}

async function verifyXai(config: BridgeConfig): Promise<VerifyResult> {
  if (!config.realtime?.apiKey) {
    return { name: 'xAI', status: 'error', message: 'not configured' };
  }
  try {
    const res = await fetch('https://api.x.ai/v1/models', {
      headers: { 'Authorization': `Bearer ${config.realtime.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return { name: 'xAI', status: 'ok', message: 'API key valid' };
    }
    return { name: 'xAI', status: 'error', message: `HTTP ${res.status}` };
  } catch (err) {
    return { name: 'xAI', status: 'error', message: (err as Error).message };
  }
}

async function verifyHA(_config: BridgeConfig): Promise<VerifyResult> {
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!url || !token) {
    return { name: 'HA', status: 'skip', message: 'not configured' };
  }
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return { name: 'HA', status: 'ok', message: `Connected to ${url}` };
    }
    return { name: 'HA', status: 'error', message: `HTTP ${res.status}` };
  } catch (err) {
    return { name: 'HA', status: 'error', message: (err as Error).message };
  }
}

async function verifyOpenClaw(config: BridgeConfig): Promise<VerifyResult> {
  if (!config.openclaw) {
    return { name: 'OpenClaw', status: 'skip', message: 'not configured' };
  }
  try {
    const url = config.openclaw.url.replace(/\/$/, '');
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.openclaw.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'ping',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(config.openclaw.timeoutMs ?? 5000),
    });
    // 200 or 4xx with body means server is reachable
    if (res.ok || res.status < 500) {
      return { name: 'OpenClaw', status: 'ok', message: `Reachable at ${config.openclaw.url}` };
    }
    return { name: 'OpenClaw', status: 'error', message: `HTTP ${res.status}` };
  } catch (err) {
    return { name: 'OpenClaw', status: 'error', message: (err as Error).message };
  }
}

async function verifyEagle(config: BridgeConfig): Promise<VerifyResult> {
  if (!config.eagle?.enabled) {
    return { name: 'Eagle', status: 'skip', message: 'disabled' };
  }
  if (!config.eagle.accessKey) {
    return { name: 'Eagle', status: 'error', message: 'enabled but no accessKey configured' };
  }
  return { name: 'Eagle', status: 'ok', message: 'configured' };
}

export function logVerifyResults(results: VerifyResult[]): void {
  console.log('[RealtimeClaw] Startup checks:');
  for (const r of results) {
    const icon = r.status === 'ok' ? '✓' : r.status === 'skip' ? '–' : '✗';
    console.log(`  ${icon} ${r.name}: ${r.message}`);
  }
}
