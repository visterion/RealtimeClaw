// tests/tools/openclaw-device.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateDeviceIdentity,
  buildV3Payload,
  signPayload,
  base64url,
  loadOrCreateDevice,
  saveDevice,
  loadDeviceCredentials,
  CLIENT_ID,
  CLIENT_MODE,
  ROLE,
  SCOPES,
} from '../../src/tools/openclaw-device.js';

describe('openclaw-device', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-device-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('generateDeviceIdentity', () => {
    it('produces a 64-char hex deviceId (SHA256 of public key)', () => {
      const creds = generateDeviceIdentity();
      expect(creds.deviceId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces a base64url-encoded public key (32 bytes raw)', () => {
      const creds = generateDeviceIdentity();
      // base64url of 32 bytes = 43 chars (no padding)
      expect(creds.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('produces a valid PEM private key', () => {
      const creds = generateDeviceIdentity();
      expect(creds.privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
      expect(creds.privateKeyPem).toContain('-----END PRIVATE KEY-----');
    });

    it('generates unique keys on each call', () => {
      const a = generateDeviceIdentity();
      const b = generateDeviceIdentity();
      expect(a.deviceId).not.toBe(b.deviceId);
      expect(a.publicKey).not.toBe(b.publicKey);
    });

    it('deviceToken is undefined initially', () => {
      const creds = generateDeviceIdentity();
      expect(creds.deviceToken).toBeUndefined();
    });
  });

  describe('buildV3Payload', () => {
    it('produces correct v3 format', () => {
      const payload = buildV3Payload('abc123', 1700000000000, 'mytoken', 'nonce-uuid');
      const expected = `v3|abc123|${CLIENT_ID}|${CLIENT_MODE}|${ROLE}|${SCOPES.join(',')}|1700000000000|mytoken|nonce-uuid|linux|`;
      expect(payload).toBe(expected);
    });

    it('handles empty token', () => {
      const payload = buildV3Payload('dev1', 1234, '', 'n1');
      expect(payload).toContain('||n1|');
    });
  });

  describe('signPayload + verify', () => {
    it('signature can be verified with the corresponding public key', () => {
      const creds = generateDeviceIdentity();
      const payload = buildV3Payload(creds.deviceId, Date.now(), 'tok', 'nonce');
      const signature = signPayload(creds.privateKeyPem, payload);

      // Decode base64url signature
      const sigBuf = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      expect(sigBuf.length).toBe(64); // Ed25519 signature = 64 bytes

      // Verify using Node crypto
      const pubKeyDer = Buffer.from(creds.publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      // Wrap raw 32-byte Ed25519 public key in SPKI DER
      const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
      const spkiBuf = Buffer.concat([spkiPrefix, pubKeyDer]);
      const publicKey = crypto.createPublicKey({ key: spkiBuf, format: 'der', type: 'spki' });

      const valid = crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, sigBuf);
      expect(valid).toBe(true);
    });

    it('signature fails verification with wrong payload', () => {
      const creds = generateDeviceIdentity();
      const signature = signPayload(creds.privateKeyPem, 'original');

      const sigBuf = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const pubKeyDer = Buffer.from(creds.publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
      const spkiBuf = Buffer.concat([spkiPrefix, pubKeyDer]);
      const publicKey = crypto.createPublicKey({ key: spkiBuf, format: 'der', type: 'spki' });

      const valid = crypto.verify(null, Buffer.from('tampered', 'utf8'), publicKey, sigBuf);
      expect(valid).toBe(false);
    });
  });

  describe('base64url', () => {
    it('encodes without padding or +/', () => {
      const buf = Buffer.from([0xff, 0xfe, 0xfd]);
      const encoded = base64url(buf);
      expect(encoded).not.toContain('+');
      expect(encoded).not.toContain('/');
      expect(encoded).not.toContain('=');
    });
  });

  describe('credential persistence', () => {
    it('save + load round-trips correctly', () => {
      const storePath = path.join(tmpDir, 'device.json');
      const creds = generateDeviceIdentity();
      creds.deviceToken = 'test-token-123';
      saveDevice(storePath, creds);

      const loaded = loadDeviceCredentials(storePath);
      expect(loaded).not.toBeNull();
      expect(loaded!.deviceId).toBe(creds.deviceId);
      expect(loaded!.publicKey).toBe(creds.publicKey);
      expect(loaded!.privateKeyPem).toBe(creds.privateKeyPem);
      expect(loaded!.deviceToken).toBe('test-token-123');
    });

    it('loadDeviceCredentials returns null for missing file', () => {
      const loaded = loadDeviceCredentials(path.join(tmpDir, 'nonexistent.json'));
      expect(loaded).toBeNull();
    });

    it('loadOrCreateDevice creates on first call, loads on second', () => {
      const storePath = path.join(tmpDir, 'device.json');
      const first = loadOrCreateDevice(storePath);
      const second = loadOrCreateDevice(storePath);

      expect(first.deviceId).toBe(second.deviceId);
      expect(first.publicKey).toBe(second.publicKey);
      expect(first.privateKeyPem).toBe(second.privateKeyPem);
    });

    it('saveDevice updates deviceToken without changing keys', () => {
      const storePath = path.join(tmpDir, 'device.json');
      const creds = loadOrCreateDevice(storePath);
      expect(creds.deviceToken).toBeUndefined();

      creds.deviceToken = 'new-token';
      saveDevice(storePath, creds);

      const loaded = loadDeviceCredentials(storePath)!;
      expect(loaded.deviceToken).toBe('new-token');
      expect(loaded.deviceId).toBe(creds.deviceId);
    });
  });
});
