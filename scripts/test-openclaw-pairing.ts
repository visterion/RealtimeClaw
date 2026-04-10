#!/usr/bin/env npx tsx
/**
 * Test: OpenClaw device pairing flow via WebSocket RPC.
 *
 * 1. Generates Ed25519 key pair
 * 2. Connects to gateway, receives challenge nonce
 * 3. Signs v3 payload, sends connect with device identity
 * 4. If not yet paired → pairing request created (approve in Control UI)
 * 5. If paired → reads SOUL.md, IDENTITY.md, USER.md via agents.files.get
 *
 * Usage:
 *   npx tsx scripts/test-openclaw-pairing.ts
 *
 * Env:
 *   OPENCLAW_URL    — ws://host:port (default: ws://192.168.1.100:18789)
 *   OPENCLAW_TOKEN  — gateway token for shared-secret auth fallback
 *   DEVICE_STORE    — path to persist device credentials (default: /tmp/openclaw-device.json)
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';

const WS_URL = process.env.OPENCLAW_URL ?? 'ws://192.168.1.100:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_TOKEN ?? '';
const DEVICE_STORE = process.env.DEVICE_STORE ?? '/tmp/openclaw-device.json';
const AGENT_ID = 'main';
const FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md'];

const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const ROLE = 'operator';
const SCOPES = ['operator.read', 'operator.admin', 'operator.write', 'operator.approvals'];

// --- Crypto helpers ---

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface DeviceCredentials {
  deviceId: string;
  publicKey: string;       // base64url, raw 32 bytes
  privateKeyPem: string;   // PEM
  deviceToken?: string;
}

function generateDeviceIdentity(): DeviceCredentials {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  // Export raw 32-byte public key
  const spkiBuf = publicKey.export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI DER: 12-byte header + 32-byte key
  const rawPub = spkiBuf.subarray(spkiBuf.length - 32);
  const pubB64 = base64url(rawPub);

  // Device ID = SHA256 of raw public key bytes
  const deviceId = crypto.createHash('sha256').update(rawPub).digest('hex');

  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  return { deviceId, publicKey: pubB64, privateKeyPem };
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64url(sig);
}

function buildV3Payload(
  deviceId: string,
  signedAt: number,
  token: string,
  nonce: string,
): string {
  return `v3|${deviceId}|${CLIENT_ID}|${CLIENT_MODE}|${ROLE}|${SCOPES.join(',')}|${signedAt}|${token}|${nonce}|linux|`;
}

function loadOrCreateDevice(): DeviceCredentials {
  try {
    const data = fs.readFileSync(DEVICE_STORE, 'utf8');
    const creds = JSON.parse(data) as DeviceCredentials;
    console.log(`Loaded device: ${creds.deviceId.slice(0, 16)}...`);
    return creds;
  } catch {
    console.log('No stored device, generating new Ed25519 key pair...');
    const creds = generateDeviceIdentity();
    fs.writeFileSync(DEVICE_STORE, JSON.stringify(creds, null, 2));
    console.log(`Generated device: ${creds.deviceId.slice(0, 16)}...`);
    return creds;
  }
}

function saveDevice(creds: DeviceCredentials): void {
  fs.writeFileSync(DEVICE_STORE, JSON.stringify(creds, null, 2));
}

// --- WebSocket RPC ---

let reqCounter = 0;
function nextId(): string { return `req-${++reqCounter}`; }

interface RpcResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function rpcCall(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 10000,
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), timeoutMs);
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'res' && msg.id === id) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg as RpcResponse);
        }
      } catch { /* ignore */ }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

// --- Main ---

async function main() {
  const device = loadOrCreateDevice();

  console.log(`\nConnecting to ${WS_URL}...`);
  const ws = new WebSocket(WS_URL);

  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', (e) => reject(new Error(`WS error: ${e.message}`)));
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
  console.log('Connected.');

  // Wait for challenge
  const nonce = await new Promise<string>((resolve) => {
    const h = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          ws.off('message', h);
          resolve(msg.payload.nonce as string);
        }
      } catch { /* ignore */ }
    };
    ws.on('message', h);
    setTimeout(() => { ws.off('message', h); resolve(''); }, 3000);
  });

  if (!nonce) {
    console.error('No challenge nonce received');
    ws.close();
    process.exit(1);
  }
  console.log(`Challenge nonce: ${nonce.slice(0, 8)}...`);

  // Sign the payload
  const signedAt = Date.now();
  const token = device.deviceToken ?? GATEWAY_TOKEN ?? '';
  const payload = buildV3Payload(device.deviceId, signedAt, token, nonce);
  const signature = signPayload(device.privateKeyPem, payload);

  console.log(`Signed v3 payload (token=${token ? token.slice(0, 8) + '...' : 'none'})`);

  // Connect with device identity
  const connectRes = await rpcCall(ws, 'connect', {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: CLIENT_ID,
      displayName: 'RealtimeClaw',
      version: '0.1.0',
      platform: 'linux',
      mode: CLIENT_MODE,
    },
    device: {
      id: device.deviceId,
      publicKey: device.publicKey,
      signature,
      signedAt,
      nonce,
    },
    role: ROLE,
    scopes: SCOPES,
    auth: device.deviceToken
      ? { deviceToken: device.deviceToken }
      : GATEWAY_TOKEN
        ? { token: GATEWAY_TOKEN }
        : undefined,
    caps: [],
  });

  if (!connectRes.ok) {
    const code = connectRes.error?.details?.code ?? connectRes.error?.code;
    if (code === 'NOT_PAIRED' || code === 'DEVICE_IDENTITY_REQUIRED') {
      console.log('\n⏳ Device not yet paired. Approve in OpenClaw Control UI:');
      console.log(`   Device ID: ${device.deviceId.slice(0, 16)}...`);
      console.log('   Or run: openclaw pairing approve <request-id>');
      console.log('\nRe-run this script after approval.');
    } else {
      console.error('Connect failed:', connectRes.error);
    }
    ws.close();
    process.exit(1);
  }

  console.log('✓ Authenticated!\n');

  // Store device token if issued
  const authPayload = connectRes.payload as { auth?: { deviceToken?: string } };
  if (authPayload?.auth?.deviceToken) {
    device.deviceToken = authPayload.auth.deviceToken;
    saveDevice(device);
    console.log(`Stored device token: ${device.deviceToken.slice(0, 8)}...\n`);
  }

  // Now fetch the workspace files
  for (const name of FILES) {
    try {
      const res = await rpcCall(ws, 'agents.files.get', { agentId: AGENT_ID, name });
      if (res.ok) {
        const file = (res.payload as { file: { name: string; content: string; missing: boolean; size?: number } }).file;
        if (file.missing) {
          console.log(`⚠ ${name}: missing in workspace`);
        } else {
          console.log(`✓ ${name} (${file.size ?? file.content.length} bytes):`);
          console.log('---');
          console.log(file.content.slice(0, 300) + (file.content.length > 300 ? '\n...(truncated)' : ''));
          console.log('---\n');
        }
      } else {
        console.log(`✗ ${name}: ${res.error?.message}`);
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
