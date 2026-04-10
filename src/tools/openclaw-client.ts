// src/tools/openclaw-client.ts
import type { RealtimeTool } from '../types.js';

export interface IOpenClawClient {
  /** Get all registered tools */
  getTools(): Promise<RealtimeTool[]>;

  /** Execute a direct tool (HA, Sonos, Spotify, etc.) */
  executeTool(name: string, args: Record<string, unknown>): Promise<string>;

  /** Ask for deep reasoning via background LLM */
  ask(question: string, options: {
    model?: string;
    sessionId?: string;
    speakerId?: string;
    speakerName?: string;
    securityLevel?: string;
    recentContext?: string;
  }): Promise<string>;

  /** Request approval for a dangerous action */
  requestApproval(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ approved: boolean; message: string }>;

  /** Fetch soul and memory content from OpenClaw */
  getContext(): Promise<{ soul: string; memory: string }>;

  /** Update memory with session transcripts */
  updateMemory(
    transcripts: Array<{ role: string; text: string; speaker?: string }>,
    speakers: string[],
  ): Promise<void>;
}

/**
 * Stub implementation for development/testing.
 * Replace with real OpenClaw SDK client when available.
 */
export class StubOpenClawClient implements IOpenClawClient {
  private tools: RealtimeTool[];

  constructor(tools: RealtimeTool[]) {
    this.tools = tools;
  }

  async getTools(): Promise<RealtimeTool[]> {
    return this.tools;
  }

  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    console.log(`[OpenClaw] Executing ${name}:`, args);
    return JSON.stringify({ status: 'ok', tool: name, stub: true });
  }

  async ask(question: string, _options: {
    model?: string; sessionId?: string; speakerId?: string;
    speakerName?: string; securityLevel?: string; recentContext?: string;
  }): Promise<string> {
    console.log(`[OpenClaw] Reasoning: ${question}`);
    return `[Stub reasoning response for: ${question}]`;
  }

  async requestApproval(
    toolName: string,
    _args: Record<string, unknown>,
  ): Promise<{ approved: boolean; message: string }> {
    console.log(`[OpenClaw] Approval requested for ${toolName}`);
    return { approved: false, message: `Approval pending for ${toolName}. Check WhatsApp.` };
  }

  async getContext(): Promise<{ soul: string; memory: string }> {
    console.log('[OpenClaw] Context fetch (stub)');
    return { soul: '', memory: '' };
  }

  async updateMemory(
    transcripts: Array<{ role: string; text: string; speaker?: string }>,
    speakers: string[],
  ): Promise<void> {
    console.log(`[OpenClaw] Memory update: ${transcripts.length} turns, speakers: ${speakers.join(', ')}`);
  }
}
