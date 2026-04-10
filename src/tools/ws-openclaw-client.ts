// src/tools/ws-openclaw-client.ts
import WebSocket from 'ws';
import type { RealtimeTool, OpenClawConfig } from '../types.js';
import type { IOpenClawClient } from './openclaw-client.js';
import { HttpOpenClawClient } from './http-openclaw-client.js';
import {
  loadOrCreateDevice,
  saveDevice,
  buildV3Payload,
  signPayload,
  type DeviceCredentials,
} from './openclaw-device.js';

interface RpcResponse {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string; details?: { code?: string } };
}

/**
 * Hybrid OpenClaw client: WS RPC for getContext() (agents.files.get),
 * HTTP for everything else (tools, reasoning, memory).
 *
 * Each getContext() call opens a transient WS connection:
 * connect → authenticate with device identity → read files → disconnect.
 */
export class WsOpenClawClient implements IOpenClawClient {
  private readonly httpClient: HttpOpenClawClient;
  private readonly device: DeviceCredentials;
  private readonly wsUrl: string;
  private readonly gatewayToken: string;
  private readonly deviceStorePath: string;
  private readonly timeoutMs: number;
  private paired = false;

  constructor(config: OpenClawConfig) {
    this.httpClient = new HttpOpenClawClient(config);
    this.gatewayToken = config.token;
    this.timeoutMs = config.timeoutMs;
    this.deviceStorePath = config.deviceStorePath ?? './openclaw-device.json';
    this.wsUrl = config.url.replace(/^http/, 'ws').replace(/\/$/, '');
    this.device = loadOrCreateDevice(this.deviceStorePath);
    console.log(`[OpenClaw] Device: ${this.device.deviceId.slice(0, 16)}... (WS: ${this.wsUrl})`);
  }

  // --- HTTP delegation ---

  getTools(): Promise<RealtimeTool[]> { return this.httpClient.getTools(); }
  executeTool(name: string, args: Record<string, unknown>): Promise<string> { return this.httpClient.executeTool(name, args); }
  ask(question: string, options: { model?: string; sessionId?: string; speakerId?: string; speakerName?: string; securityLevel?: string; recentContext?: string }): Promise<string> { return this.httpClient.ask(question, options); }
  requestApproval(toolName: string, args: Record<string, unknown>): Promise<{ approved: boolean; message: string }> { return this.httpClient.requestApproval(toolName, args); }
  updateMemory(transcripts: Array<{ role: string; text: string; speaker?: string }>, speakers: string[]): Promise<void> { return this.httpClient.updateMemory(transcripts, speakers); }

  // --- WS-based getContext ---

  async getContext(): Promise<{ soul: string; memory: string }> {
    try {
      if (!this.paired) {
        // First call: retry with guided pairing flow
        const result = await this.getContextWithRetry();
        this.paired = true;
        return result;
      }
      // Subsequent calls: single attempt, quick fallback
      return await this.fetchContextViaWs();
    } catch (err) {
      console.warn('[OpenClaw] WS getContext failed, falling back to HTTP:', (err as Error).message);
      return this.httpClient.getContext();
    }
  }

  async getContextWithRetry(intervalMs = 10000, maxAttempts = 30): Promise<{ soul: string; memory: string }> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.fetchContextViaWs();
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('pairing required') || msg.includes('NOT_PAIRED')) {
          if (attempt === 1) {
            console.log('═'.repeat(55));
            console.log('  OpenClaw Device Pairing Required');
            console.log('');
            console.log('  Approve this device in the OpenClaw Control UI:');
            console.log(`  Device: ${this.device.deviceId.slice(0, 16)}...`);
            console.log('');
            console.log(`  Waiting for approval... (retry every ${Math.round(intervalMs / 1000)}s)`);
            console.log('═'.repeat(55));
          } else {
            console.log(`[OpenClaw] Pairing retry ${attempt}/${maxAttempts}...`);
          }
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }
        throw err;
      }
    }
    console.warn('[OpenClaw] Pairing timeout — continuing without OpenClaw');
    return this.httpClient.getContext();
  }

  private async fetchContextViaWs(): Promise<{ soul: string; memory: string }> {
    const ws = new WebSocket(this.wsUrl);
    let reqCounter = 0;

    // Track connection errors to reject pending promises
    let connectionError: Error | null = null;
    ws.on('error', (e) => {
      connectionError = e;
    });

    const rpcCall = (method: string, params: Record<string, unknown>): Promise<RpcResponse> => {
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error(`WS not open: ${method}`));
          return;
        }
        const id = `req-${++reqCounter}`;
        const timer = setTimeout(() => { ws.off('message', handler); reject(new Error(`Timeout: ${method}`)); }, this.timeoutMs);
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
      });
    };

    try {
      // 1. Connect and wait for challenge nonce (set up handler BEFORE open to avoid race)
      const nonce = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No challenge received')), this.timeoutMs);
        const handler = (data: WebSocket.Data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'event' && msg.event === 'connect.challenge') {
              clearTimeout(timer);
              ws.off('message', handler);
              ws.off('close', onClose);
              resolve(msg.payload.nonce as string);
            }
          } catch { /* ignore */ }
        };
        const onClose = () => {
          clearTimeout(timer);
          ws.off('message', handler);
          reject(connectionError ?? new Error('WS closed before challenge'));
        };
        ws.on('message', handler);
        ws.once('close', onClose);
      });

      // 3. Sign and send connect
      const signedAt = Date.now();
      const token = this.device.deviceToken ?? this.gatewayToken;
      const payload = buildV3Payload(this.device.deviceId, signedAt, token, nonce);
      const signature = signPayload(this.device.privateKeyPem, payload);

      const connectRes = await rpcCall('connect', {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: 'gateway-client', displayName: 'RealtimeClaw', version: '0.1.0', platform: 'linux', mode: 'backend' },
        device: { id: this.device.deviceId, publicKey: this.device.publicKey, signature, signedAt, nonce },
        role: 'operator',
        scopes: ['operator.read', 'operator.admin', 'operator.write', 'operator.approvals'],
        auth: this.device.deviceToken ? { deviceToken: this.device.deviceToken } : { token: this.gatewayToken },
        caps: [],
      });

      if (!connectRes.ok) {
        const code = connectRes.error?.details?.code ?? connectRes.error?.code;
        if (code === 'NOT_PAIRED' || code === 'PAIRING_REQUIRED') {
          console.warn(`[OpenClaw] Device not paired. Approve in Control UI. Device: ${this.device.deviceId.slice(0, 16)}...`);
        }
        throw new Error(`Connect failed: ${connectRes.error?.message ?? 'unknown'}`);
      }

      // 4. Save device token if issued
      const authPayload = connectRes.payload as { auth?: { deviceToken?: string } } | undefined;
      if (authPayload?.auth?.deviceToken) {
        this.device.deviceToken = authPayload.auth.deviceToken;
        saveDevice(this.deviceStorePath, this.device);
      }

      // 5. Read workspace files in parallel
      const fileNames = ['SOUL.md', 'IDENTITY.md', 'USER.md'];
      const results = await Promise.allSettled(
        fileNames.map((name) =>
          rpcCall('agents.files.get', { agentId: 'main', name }).then((res) => {
            if (!res.ok) return '';
            const file = (res.payload as { file: { content: string; missing: boolean } }).file;
            return file.missing ? '' : file.content;
          }),
        ),
      );

      const contents = results.map((r) => (r.status === 'fulfilled' ? r.value : ''));
      const [soul, identity, users] = contents;

      const soulParts = [soul, identity].filter(Boolean);

      return {
        soul: soulParts.join('\n\n'),
        memory: users,
      };
    } finally {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
  }
}
