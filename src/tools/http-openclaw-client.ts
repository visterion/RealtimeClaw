// src/tools/http-openclaw-client.ts
import type { RealtimeTool, OpenClawConfig } from '../types.js';
import type { IOpenClawClient } from './openclaw-client.js';

export class HttpOpenClawClient implements IOpenClawClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: OpenClawConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.token = config.token;
    this.timeoutMs = config.timeoutMs;
  }

  private get authHeaders(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  private async invokeToolRaw(tool: string, args?: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.url}/tools/invoke`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`[OpenClaw] HTTP error ${res.status} invoking tool "${tool}"`);
    }

    const data = (await res.json()) as { ok: boolean; result: unknown; error?: string };

    if (!data.ok) {
      throw new Error(`[OpenClaw] Tool "${tool}" failed: ${data.error ?? 'unknown error'}`);
    }

    return data.result;
  }

  async getTools(): Promise<RealtimeTool[]> {
    try {
      const result = await this.invokeToolRaw('tools_catalog');
      return result as RealtimeTool[];
    } catch {
      // OpenClaw may not expose tools_catalog — tools come from config instead
      console.log('[OpenClaw] tools_catalog not available, using tools from config');
      return [];
    }
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.invokeToolRaw(name, args);
    return JSON.stringify(result);
  }

  async ask(question: string, options: {
    model?: string; sessionId?: string; speakerId?: string;
    speakerName?: string; securityLevel?: string; recentContext?: string;
  }): Promise<string> {
    const messages: Array<{ role: string; content: string }> = [];

    // Inject speaker context as system message so OpenClaw knows who's asking
    const speakerParts: string[] = [];
    if (options.speakerName || options.speakerId) {
      speakerParts.push(`Speaker: ${options.speakerName ?? options.speakerId ?? 'Unknown'}`);
    }
    if (options.securityLevel) {
      speakerParts.push(`Level: ${options.securityLevel}`);
    }
    if (speakerParts.length > 0) {
      messages.push({ role: 'system', content: speakerParts.join(' | ') });
    }
    if (options.recentContext) {
      messages.push({ role: 'system', content: `Recent conversation:\n${options.recentContext}` });
    }

    messages.push({ role: 'user', content: question });

    const res = await fetch(`${this.url}/v1/chat/completions`, {
      method: 'POST',
      headers: this.authHeaders,
      body: JSON.stringify({ model: 'openclaw', messages }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      throw new Error(`[OpenClaw] HTTP error ${res.status} calling /v1/chat/completions`);
    }

    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0].message.content;
  }

  async requestApproval(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ approved: boolean; message: string }> {
    const result = await this.invokeToolRaw('approval_request', { tool: toolName, args });
    return result as { approved: boolean; message: string };
  }

  async getContext(): Promise<{ soul: string; memory: string }> {
    const [soulResult, memoryResult] = await Promise.allSettled([
      this.invokeToolRaw('soul_get').then((r) => String(r ?? '')),
      this.invokeToolRaw('memory_get', { path: 'memory.md' }).then((r) => {
        const obj = r as { text?: string } | null;
        return String(obj?.text ?? r ?? '');
      }),
    ]);

    if (soulResult.status === 'rejected') {
      console.warn('[OpenClaw] soul_get not available, using empty soul:', (soulResult.reason as Error).message);
    }
    if (memoryResult.status === 'rejected') {
      console.warn('[OpenClaw] memory_get not available, using empty memory:', (memoryResult.reason as Error).message);
    }

    return {
      soul: soulResult.status === 'fulfilled' ? soulResult.value : '',
      memory: memoryResult.status === 'fulfilled' ? memoryResult.value : '',
    };
  }

  async updateMemory(
    transcripts: Array<{ role: string; text: string; speaker?: string }>,
    speakers: string[],
  ): Promise<void> {
    await this.invokeToolRaw('memory_update', { transcripts, speakers });
  }
}
