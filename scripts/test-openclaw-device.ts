import WebSocket from 'ws';

const WS_URL = process.env.OPENCLAW_URL ?? 'ws://192.168.1.100:18789';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN ?? '';
const AGENT_ID = 'main';
const FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md'];

let reqCounter = 0;
function nextId(): string { return `req-${++reqCounter}`; }

function rpcCall(ws: WebSocket, method: string, params: Record<string, unknown>, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), timeoutMs);
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'res' && msg.id === id) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    console.log(`→ ${method}`);
  });
}

async function main() {
  console.log(`Connecting to ${WS_URL}...`);
  const ws = new WebSocket(WS_URL);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', (e) => reject(e));
    setTimeout(() => reject(new Error('timeout')), 5000);
  });

  // Wait for challenge
  await new Promise<void>((resolve) => {
    const h = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          ws.off('message', h);
          resolve();
        }
      } catch {}
    };
    ws.on('message', h);
    setTimeout(() => { ws.off('message', h); resolve(); }, 2000);
  });

  // Connect with device token
  const res = await rpcCall(ws, 'connect', {
    minProtocol: 3,
    maxProtocol: 3,
    client: { id: 'gateway-client', version: '0.1.0', platform: 'linux', mode: 'backend' },
    role: 'operator',
    scopes: ['operator.read', 'operator.admin', 'operator.write'],
    auth: { deviceToken: DEVICE_TOKEN },
    caps: [],
  });

  if (!res.ok) {
    console.error('Connect failed:', res.error);
    ws.close();
    process.exit(1);
  }
  console.log('✓ Authenticated with device token\n');

  for (const name of FILES) {
    try {
      const r = await rpcCall(ws, 'agents.files.get', { agentId: AGENT_ID, name });
      if (r.ok) {
        const file = r.payload.file;
        if (file.missing) {
          console.log(`⚠ ${name}: missing`);
        } else {
          console.log(`✓ ${name} (${file.size ?? file.content.length} bytes):`);
          console.log('---');
          console.log(file.content.slice(0, 300) + (file.content.length > 300 ? '\n...(truncated)' : ''));
          console.log('---\n');
        }
      } else {
        console.log(`✗ ${name}: ${r.error?.message}`);
      }
    } catch (err: any) {
      console.log(`✗ ${name}: ${err.message}`);
    }
  }
  ws.close();
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
