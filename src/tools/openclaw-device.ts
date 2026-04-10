// src/tools/openclaw-device.ts
import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const CLIENT_ID = 'gateway-client';
export const CLIENT_MODE = 'backend';
export const ROLE = 'operator';
export const SCOPES = ['operator.read', 'operator.admin', 'operator.write', 'operator.approvals'];

export interface DeviceCredentials {
  deviceId: string;
  publicKey: string;       // base64url, raw 32-byte Ed25519 public key
  privateKeyPem: string;   // PKCS8 PEM
  deviceToken?: string;
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateDeviceIdentity(): DeviceCredentials {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  // Export raw 32-byte public key from SPKI DER (12-byte header + 32 bytes)
  const spkiBuf = publicKey.export({ type: 'spki', format: 'der' });
  const rawPub = spkiBuf.subarray(spkiBuf.length - 32);

  return {
    deviceId: crypto.createHash('sha256').update(rawPub).digest('hex'),
    publicKey: base64url(rawPub),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

export function buildV3Payload(
  deviceId: string,
  signedAt: number,
  token: string,
  nonce: string,
): string {
  return `v3|${deviceId}|${CLIENT_ID}|${CLIENT_MODE}|${ROLE}|${SCOPES.join(',')}|${signedAt}|${token}|${nonce}|linux|`;
}

export function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64url(sig);
}

export function loadDeviceCredentials(storePath: string): DeviceCredentials | null {
  try {
    const data = readFileSync(storePath, 'utf8');
    return JSON.parse(data) as DeviceCredentials;
  } catch {
    return null;
  }
}

export function saveDevice(storePath: string, creds: DeviceCredentials): void {
  writeFileSync(storePath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function loadOrCreateDevice(storePath: string): DeviceCredentials {
  const existing = loadDeviceCredentials(storePath);
  if (existing) return existing;

  const creds = generateDeviceIdentity();
  saveDevice(storePath, creds);
  return creds;
}
