// tests/helpers/mock-openclaw-ws.ts
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';

export interface MockWorkspaceFiles {
  [name: string]: { content: string; missing?: boolean };
}

export interface MockOpenClawWsServerOptions {
  port: number;
  files?: MockWorkspaceFiles;
  /** If true, respond with NOT_PAIRED on connect instead of hello-ok */
  rejectAsPending?: boolean;
  /** Device token to issue on successful connect */
  deviceToken?: string;
}

/**
 * Mock OpenClaw Gateway WebSocket server for testing device pairing + agents.files.get.
 */
export class MockOpenClawWsServer {
  private wss: WebSocketServer;
  private files: MockWorkspaceFiles;
  /** Settable from tests to toggle pairing rejection mid-run */
  rejectAsPending: boolean;
  private deviceToken: string;
  private connections: WebSocket[] = [];

  /** Last received connect params for test assertions */
  lastConnectParams: Record<string, unknown> | null = null;
  /** Count of agents.files.get calls */
  fileGetCount = 0;

  constructor(options: MockOpenClawWsServerOptions) {
    this.files = options.files ?? {};
    this.rejectAsPending = options.rejectAsPending ?? false;
    this.deviceToken = options.deviceToken ?? 'mock-device-token';

    this.wss = new WebSocketServer({ port: options.port });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
  }

  private handleConnection(ws: WebSocket): void {
    this.connections.push(ws);

    // Send challenge immediately
    const nonce = crypto.randomUUID();
    ws.send(JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce, ts: Date.now() },
    }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'req') {
          this.handleRequest(ws, msg);
        }
      } catch { /* ignore */ }
    });

    ws.on('close', () => {
      this.connections = this.connections.filter((c) => c !== ws);
    });
  }

  private handleRequest(ws: WebSocket, msg: { id: string; method: string; params: Record<string, unknown> }): void {
    const { id, method, params } = msg;

    if (method === 'connect') {
      this.lastConnectParams = params;
      if (this.rejectAsPending) {
        this.sendResponse(ws, id, false, undefined, {
          code: 'NOT_PAIRED',
          message: 'pairing required',
          details: { code: 'PAIRING_REQUIRED', requestId: crypto.randomUUID() },
        });
      } else {
        this.sendResponse(ws, id, true, {
          type: 'hello-ok',
          protocol: 3,
          server: { version: '0.1.0-mock', connId: crypto.randomUUID() },
          features: { methods: ['agents.files.get', 'agents.files.list'], events: [] },
          snapshot: {},
          auth: {
            deviceToken: this.deviceToken,
            role: 'operator',
            scopes: ['operator.read', 'operator.admin', 'operator.write', 'operator.approvals'],
          },
        });
      }
      return;
    }

    if (method === 'agents.files.get') {
      this.fileGetCount++;
      const name = params.name as string;
      const agentId = params.agentId as string;
      const fileData = this.files[name];

      if (fileData) {
        this.sendResponse(ws, id, true, {
          agentId,
          workspace: '/mock/workspace',
          file: {
            name,
            path: `/mock/workspace/${name}`,
            missing: fileData.missing ?? false,
            size: fileData.content.length,
            content: fileData.missing ? '' : fileData.content,
          },
        });
      } else {
        this.sendResponse(ws, id, true, {
          agentId,
          workspace: '/mock/workspace',
          file: { name, path: `/mock/workspace/${name}`, missing: true, content: '' },
        });
      }
      return;
    }

    // Unknown method
    this.sendResponse(ws, id, false, undefined, {
      code: 'UNKNOWN_METHOD',
      message: `Unknown method: ${method}`,
    });
  }

  private sendResponse(
    ws: WebSocket,
    id: string,
    ok: boolean,
    payload?: Record<string, unknown>,
    error?: Record<string, unknown>,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(ok ? { type: 'res', id, ok: true, payload } : { type: 'res', id, ok: false, error }));
  }

  /** Update files for subsequent requests */
  setFiles(files: MockWorkspaceFiles): void {
    this.files = files;
  }

  async close(): Promise<void> {
    for (const ws of this.connections) {
      ws.close();
    }
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
