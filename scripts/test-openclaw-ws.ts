#!/usr/bin/env npx tsx
/**
 * Proof-of-concept: fetch soul.md + identity.md + users.md from OpenClaw
 * via WebSocket RPC (agents.files.get).
 *
 * Usage:
 *   OPENCLAW_URL=ws://192.168.1.x:18789 OPENCLAW_TOKEN=your-token npx tsx scripts/test-openclaw-ws.ts
 */
import WebSocket from 'ws';

const WS_URL = process.env.OPENCLAW_URL ?? 'ws://localhost:18789';
const TOKEN = process.env.OPENCLAW_TOKEN ?? '';
const AGENT_ID = process.env.OPENCLAW_AGENT_ID ?? 'main';
const FILES = ['soul.md', 'identity.md', 'users.md'];

let reqCounter = 0;
function nextId(): string {
  return `req-${++reqCounter}`;
}

interface RpcResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}

function rpcCall(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method} (${id})`)), timeoutMs);

    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'res' && msg.id === id) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg as RpcResponse);
        }
      } catch { /* ignore non-JSON */ }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    console.log(`→ ${method}(${JSON.stringify(params)})`);
  });
}

async function main() {
  console.log(`Connecting to ${WS_URL} ...`);
  const ws = new WebSocket(WS_URL);

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', (err) => reject(new Error(`WebSocket error: ${err.message}`)));
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
  console.log('Connected.\n');

  // Wait for challenge event (if any), then send connect
  await new Promise<void>((resolve) => {
    let resolved = false;
    const onMsg = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          console.log('← connect.challenge received');
          ws.off('message', onMsg);
          resolved = true;
          resolve();
        }
      } catch { /* ignore */ }
    };
    ws.on('message', onMsg);
    // If no challenge within 2s, assume no auth required
    setTimeout(() => {
      if (!resolved) {
        ws.off('message', onMsg);
        console.log('(no challenge received, proceeding)');
        resolve();
      }
    }, 2000);
  });

  // Send connect RPC
  const connectRes = await rpcCall(ws, 'connect', {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: 'gateway-client',
      version: '0.1.0',
      platform: 'linux',
      mode: 'backend',
    },
    role: 'operator',
    scopes: ['operator.read'],
    auth: TOKEN ? { token: TOKEN } : undefined,
    caps: [],
  });

  if (!connectRes.ok) {
    console.error('✗ Connect failed:', connectRes.error);
    ws.close();
    process.exit(1);
  }
  console.log('✓ Authenticated\n');

  // Fetch each file
  for (const name of FILES) {
    try {
      const res = await rpcCall(ws, 'agents.files.get', { agentId: AGENT_ID, name });
      if (res.ok) {
        const file = (res.payload as { file: { name: string; content: string; missing: boolean; size?: number } }).file;
        if (file.missing) {
          console.log(`⚠ ${name}: file missing in workspace`);
        } else {
          console.log(`✓ ${name} (${file.size ?? file.content.length} bytes):`);
          console.log('---');
          console.log(file.content.slice(0, 500) + (file.content.length > 500 ? '\n...(truncated)' : ''));
          console.log('---\n');
        }
      } else {
        console.log(`✗ ${name}: ${res.error?.message ?? 'unknown error'}`);
      }
    } catch (err) {
      console.log(`✗ ${name}: ${(err as Error).message}`);
    }
  }

  ws.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
