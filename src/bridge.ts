import { EventEmitter } from 'node:events';
import { WyomingServer, type WyomingSession } from './wyoming/server.js';
import { RealtimeClient } from './realtime/client.js';
import { buildInstructions, type LoadedContext, EMPTY_CONTEXT } from './context/loader.js';
import { SpeakerResolver } from './context/speaker.js';
import { ContextSummarizer } from './context/summarizer.js';
import { EagleAdapter, type IEagleFactory } from './speaker/eagle.js';
import { SpeakerIdentifier } from './speaker/identifier.js';
import { EnrollmentCollector } from './speaker/enrollment-collector.js';
import { ENROLL_SPEAKER_TOOL } from './speaker/enrollment-tool.js';
import { REQUEST_REASONING_TOOL } from './tools/reasoning-tool.js';
import { getEffectiveLevel, type SecurityLevel } from './security/levels.js';
import { filterToolsForLevel } from './security/permissions.js';
import { ToolRouter } from './router/tool-router.js';
import { resolveProviderConfig } from './realtime/providers.js';
import { LatencyTracker } from './realtime/latency.js';
import type { IOpenClawClient } from './tools/openclaw-client.js';
import { type HAConfig, getHATools, executeHATool } from './tools/ha-direct.js';
import type { BridgeConfig, AudioConfig, RealtimeTool } from './types.js';

/** 16-bit PCM = 2 bytes per sample, mono */
const PCM_WIDTH = 2;
const PCM_CHANNELS = 1;

interface BridgeEvents {
  'session:connected': [sessionId: string];
  'session:disconnected': [sessionId: string];
  'transcript': [sessionId: string, text: string];
  'error': [sessionId: string, error: Error];
}

interface ActiveSession {
  wyomingSession: WyomingSession;
  realtimeClient: RealtimeClient;
  summarizer: ContextSummarizer;
  speakerIdentifier: SpeakerIdentifier | null;
  isStreaming: boolean;
  isResponding: boolean;
  audioStartSent: boolean;
  speakerId: string | undefined;
  confidence: number;
  securityLevel: SecurityLevel;
  lastUserTranscript: string;
  hadReasoning: boolean;
  /** Set whenever xAI invokes any tool in the current turn; reset on new user transcript */
  hadToolCall: boolean;
  latency: LatencyTracker;
  pcmAccumulator?: Buffer;
  audioDrainTimer?: ReturnType<typeof setInterval> | null;
  audioDrainDone?: boolean;
  idleTimer?: ReturnType<typeof setTimeout> | null;
  /** Pending tool call results keyed by call_id; flushed on response.done */
  pendingToolCalls: Map<string, Promise<string>>;
  /** Number of reasoning calls still in flight — idle timer is paused while > 0. */
  pendingReasoning: number;
  /** Monotonic id of the latest reasoning call; older ones are dropped when they return. */
  reasoningGeneration: number;
  enrollmentCollector?: EnrollmentCollector;
}

export class AudioBridge extends EventEmitter<BridgeEvents> {
  private wyoming: WyomingServer;
  private config: BridgeConfig;
  private activeSessions = new Map<string, ActiveSession>();
  private speakerResolver: SpeakerResolver;
  private eagle: EagleAdapter | null = null;
  private cachedContext: LoadedContext = EMPTY_CONTEXT;
  private toolRouter: ToolRouter;
  private openclawClient: IOpenClawClient | null;
  private haConfig: HAConfig | null;
  private availableTools: RealtimeTool[] = [];

  constructor(config: BridgeConfig, eagleFactory?: IEagleFactory, openclawClient?: IOpenClawClient, haConfig?: HAConfig) {
    super();
    this.config = config;
    this.wyoming = new WyomingServer(config.languages);
    this.speakerResolver = new SpeakerResolver(config.speaker);
    this.toolRouter = new ToolRouter(config.toolRouter);
    this.openclawClient = openclawClient ?? null;
    this.haConfig = haConfig ?? null;
    if (config.eagle.enabled && eagleFactory) {
      this.eagle = new EagleAdapter(config.eagle, eagleFactory);
    }
    this.setupWyomingHandlers();
  }

  async start(): Promise<void> {
    // Load context (soul + memory) from OpenClaw, or from fallback config fields
    await this.reloadContext();

    // Load tools
    if (this.openclawClient) {
      const openclawTools = await this.openclawClient.getTools();
      this.availableTools.push(...openclawTools);
      this.availableTools.push(REQUEST_REASONING_TOOL);
      console.log(`[Bridge] Loaded ${openclawTools.length} tools from OpenClaw (+ request_reasoning)`);
    }
    if (this.haConfig) {
      const haTools = getHATools();
      this.availableTools.push(...haTools);
      console.log(`[Bridge] Loaded ${haTools.length} HA direct tools`);
    }

    if (this.eagle) {
      this.availableTools.push(ENROLL_SPEAKER_TOOL);
      console.log('[Bridge] Enrollment tool available');
    }

    console.log(
      `[Bridge] availableTools: [${this.availableTools.map((t) => t.name).join(', ')}]`,
    );

    // Initialize Eagle speaker identification
    if (this.eagle) {
      await this.eagle.initialize();
    }

    await this.wyoming.listen(this.config.wyomingPort);
    console.log(`[Bridge] Started on port ${this.config.wyomingPort}`);
  }

  async stop(): Promise<void> {
    for (const session of this.activeSessions.values()) {
      session.realtimeClient.disconnect();
    }
    this.activeSessions.clear();
    await this.wyoming.close();
    console.log('[Bridge] Stopped');
  }

  /** Reload soul + memory from OpenClaw (e.g., after a memory update) */
  async reloadContext(): Promise<void> {
    if (this.openclawClient) {
      try {
        const ctx = await this.openclawClient.getContext();
        this.cachedContext = {
          instructions: [ctx.soul, ctx.memory].filter(Boolean).join('\n\n---\n\n'),
          soulContent: ctx.soul,
          memoryContent: ctx.memory,
        };
        if (ctx.soul) console.log(`[Bridge] Soul loaded (${ctx.soul.length} chars)`);
        if (ctx.memory) console.log(`[Bridge] Memory loaded (${ctx.memory.length} chars)`);
        return;
      } catch (err) {
        console.warn('[Bridge] Could not load context from OpenClaw:', (err as Error).message);
      }
    }

    // Fallback: use config text fields (soul/identity/users from addon UI)
    const fb = this.config.fallbackContext;
    if (fb?.soul || fb?.identity || fb?.users) {
      const soul = [fb.soul, fb.identity].filter(Boolean).join('\n\n');
      const memory = fb.users ?? '';
      this.cachedContext = {
        instructions: [soul, memory].filter(Boolean).join('\n\n---\n\n'),
        soulContent: soul,
        memoryContent: memory,
      };
      console.log('[Bridge] Using fallback context from config');
    }
  }

  private get pcmRate(): number { return this.config.realtime.outputAudioFormat.rate; }

  private setupWyomingHandlers(): void {
    this.wyoming.on('audio:start', (session, config) => {
      this.handleAudioStart(session, config).catch((err) => {
        console.error(`[Bridge] Failed to connect Realtime for ${session.id}:`, err);
        this.activeSessions.delete(session.id);
        this.emit('error', session.id, err instanceof Error ? err : new Error(String(err)));
      });
    });

    this.wyoming.on('audio:chunk', (session, pcm) => {
      const active = this.activeSessions.get(session.id);
      if (!active?.isStreaming) return;

      // Always stream audio to Realtime (no delay)
      active.realtimeClient.sendAudio(pcm);

      // Parallel: feed audio to Eagle for speaker ID
      if (active.speakerIdentifier && !active.speakerIdentifier.isIdentified) {
        const result = active.speakerIdentifier.feedAudio(pcm);
        if (result?.speakerId) {
          // Eagle identified speaker — update context and security
          active.speakerId = result.speakerId;
          active.confidence = result.confidence;

          const newLevel = getEffectiveLevel(
            result.confidence,
            result.speakerId,
            this.config.security.speakerMaxLevel,
            this.config.security.thresholds,
          );

          if (newLevel !== active.securityLevel) {
            active.securityLevel = newLevel;
            const newTools = filterToolsForLevel(
              this.availableTools,
              newLevel,
              this.config.toolRouter.levelTools,
            );
            active.realtimeClient.updateSession({ tools: newTools });
            console.log(`[Bridge] Security level upgraded to ${newLevel} for ${session.id}`);
          }

          // Inject speaker context
          this.speakerResolver.setSessionSpeaker(session.id, result.speakerId);
          const speakerContext = this.speakerResolver.buildSpeakerContext(result.speakerId);
          if (speakerContext) {
            active.realtimeClient.sendConversationItem({
              type: 'message',
              role: 'system',
              content: [{ type: 'text', text: speakerContext }],
            });
          }
          console.log(`[Bridge] Eagle identified ${result.speakerId} for ${session.id}`);
        }
      }

      // Feed enrollment collector if active
      if (active.enrollmentCollector?.isActive) {
        active.enrollmentCollector.feedAudio(pcm);
      }
    });

    this.wyoming.on('audio:stop', (session) => {
      const active = this.activeSessions.get(session.id);
      if (active) {
        active.isStreaming = false;
        // Signal to Realtime API that audio input is complete
        active.realtimeClient.commitAudio();
        // Reset speaker identifier for next turn (allows mid-conversation speaker switch)
        if (active.speakerIdentifier) {
          active.speakerIdentifier.reset();
        }
        // Early-complete enrollment if enough audio collected
        if (active.enrollmentCollector?.isActive) {
          active.enrollmentCollector.complete();
        }
      }
    });

    this.wyoming.on('session:end', (sessionId) => {
      const active = this.activeSessions.get(sessionId);
      if (!active) return;
      if (active.idleTimer) clearTimeout(active.idleTimer);
      if (active.audioDrainTimer) clearInterval(active.audioDrainTimer);
      active.realtimeClient.disconnect();
      this.speakerResolver.clearSession(sessionId);
      this.activeSessions.delete(sessionId);
      this.emit('session:disconnected', sessionId);
    });
  }

  private buildActiveSession(
    session: WyomingSession,
    realtimeClient: RealtimeClient,
    speakerId: string | undefined,
    instructions: string,
  ): ActiveSession {
    const summarizer = new ContextSummarizer(this.config.context, this.config.assistantName);
    summarizer.setBaseInstructionSize(instructions);

    const speakerIdentifier = this.eagle?.isReady
      ? new SpeakerIdentifier(this.eagle, this.config.eagle)
      : null;

    return {
      wyomingSession: session,
      realtimeClient,
      summarizer,
      speakerIdentifier,
      isStreaming: true,
      isResponding: false,
      audioStartSent: false,
      speakerId,
      confidence: 0,
      securityLevel: 'guest' as SecurityLevel,
      lastUserTranscript: '',
      hadReasoning: false,
      hadToolCall: false,
      latency: new LatencyTracker(),
      pendingToolCalls: new Map(),
      pendingReasoning: 0,
      reasoningGeneration: 0,
    };
  }

  private async handleAudioStart(session: WyomingSession, _config: AudioConfig): Promise<void> {
    // Reload context (soul/identity/users) fresh from OpenClaw — non-blocking
    // Uses cachedContext immediately; update arrives for next session if slow
    if (this.openclawClient) {
      this.reloadContext().catch((err) => {
        console.warn('[Bridge] Background context reload failed:', (err as Error).message);
      });
    }

    // Resolve speaker from device mapping
    const speaker = this.speakerResolver.resolve(session.id, session.deviceId);
    const speakerId = speaker?.id;

    // Build instructions with context + speaker
    const speakerContext = speakerId ? this.speakerResolver.buildSpeakerContext(speakerId) ?? undefined : undefined;
    const instructions = buildInstructions(this.cachedContext, speakerContext, this.config.realtime.instructions);

    // Default confidence for device-mapped speakers (no Eagle yet)
    const defaultConfidence = speakerId ? 0.60 : 0.0;
    const securityLevel = getEffectiveLevel(
      defaultConfidence,
      speakerId,
      this.config.security.speakerMaxLevel,
      this.config.security.thresholds,
    );

    // Filter tools by security level
    const sessionTools = filterToolsForLevel(
      this.availableTools,
      securityLevel,
      this.config.toolRouter.levelTools,
    );

    // Create Realtime client with loaded instructions and filtered tools
    const realtimeConfig = { ...this.config.realtime, instructions, tools: sessionTools };
    const realtimeClient = new RealtimeClient(realtimeConfig);

    if (this.config.debug) {
      realtimeClient.setDebug(true);
    }

    const active = this.buildActiveSession(session, realtimeClient, speakerId, instructions);
    this.activeSessions.set(session.id, active);
    this.setupRealtimeHandlers(active);

    active.latency.mark('session_start');

    const providerConfig = resolveProviderConfig(
      this.config.realtime.provider,
      { wsUrl: this.config.realtime.wsUrl, voice: this.config.realtime.voice },
    );

    await realtimeClient.connectWithRetry(providerConfig.reconnect);

    // Eagle may have upgraded security level while WS was still connecting —
    // re-filter tools and re-inject speaker context if needed.
    if (active.securityLevel !== securityLevel) {
      const upgradedTools = filterToolsForLevel(
        this.availableTools,
        active.securityLevel,
        this.config.toolRouter.levelTools,
      );
      realtimeClient.updateSession({ tools: upgradedTools });
    }
    if (active.speakerId && active.speakerId !== speakerId) {
      const ctx = this.speakerResolver.buildSpeakerContext(active.speakerId);
      if (ctx) {
        realtimeClient.sendConversationItem({
          type: 'message',
          role: 'system',
          content: [{ type: 'text', text: ctx }],
        });
      }
    }

    active.latency.mark('realtime_connected');
    const connectMs = active.latency.measureBetween('session_start', 'realtime_connected');

    if (speakerId) {
      console.log(`[Bridge] Realtime connected for ${session.id} in ${connectMs}ms (speaker: ${speakerId})`);
    } else {
      console.log(`[Bridge] Realtime connected for ${session.id} in ${connectMs}ms`);
    }
    console.log(
      `[Bridge] Tools sent to xAI (${session.id}, level=${active.securityLevel}): [${sessionTools.map((t) => t.name).join(', ')}]`,
    );
    const instrPreview = instructions.replace(/\s+/g, ' ').slice(0, 240);
    console.log(
      `[Bridge] Instructions (${session.id}, ${instructions.length} chars): ${instrPreview}${instructions.length > 240 ? '…' : ''}`,
    );
    this.emit('session:connected', session.id);
    this.resetIdleTimer(active, session.id);
  }

  private static readonly IDLE_TIMEOUT_MS = 30_000;

  /** Inject a late OpenClaw reasoning reply and trigger a follow-up xAI response. */
  private injectReasoningReply(active: ActiveSession, sessionId: string, reply: string): void {
    active.pendingReasoning = Math.max(0, active.pendingReasoning - 1);
    if (!this.activeSessions.has(sessionId)) {
      // Session has gone away — nothing to say.
      return;
    }
    console.log(`[Bridge] Reasoning reply (${sessionId}): ${reply.slice(0, 200)}`);
    active.realtimeClient.sendConversationItem({
      type: 'message',
      role: 'system',
      content: [{ type: 'text', text: `[Antwort von Jarvis für die letzte Frage]:\n${reply}` }],
    });
    active.realtimeClient.createResponse();
    // Resume idle timer once all pending reasoning is done.
    if (active.pendingReasoning === 0) {
      this.resetIdleTimer(active, sessionId);
    }
  }

  private resetIdleTimer(active: ActiveSession, sessionId: string): void {
    if (active.pendingReasoning > 0) return;
    if (active.idleTimer) clearTimeout(active.idleTimer);
    active.idleTimer = setTimeout(() => {
      console.log(`[Bridge] Session idle for ${AudioBridge.IDLE_TIMEOUT_MS / 1000}s, closing (${sessionId})`);
      active.realtimeClient.disconnect();
      this.wyoming.sendAudioStop(sessionId);
      const wyomingSession = active.wyomingSession;
      wyomingSession.socket.end();
    }, AudioBridge.IDLE_TIMEOUT_MS);
  }

  private setupRealtimeHandlers(active: ActiveSession): void {
    const { realtimeClient } = active;
    const sessionId = active.wyomingSession.id;

    realtimeClient.on('speech_started', () => {
      this.resetIdleTimer(active, sessionId);
      this.handleSpeechStarted(active, sessionId);
    });
    realtimeClient.on('audio_delta', (pcm: Buffer) => this.handleAudioDelta(active, sessionId, pcm));
    realtimeClient.on('audio_done', () => {
      this.handleAudioDone(active, sessionId);
      this.resetIdleTimer(active, sessionId);
    });
    realtimeClient.on('transcript_done', (text: string) => this.handleTranscriptDone(active, sessionId, text));
    realtimeClient.on('server_event', (event) => this.handleServerEvent(active, event));
    realtimeClient.on('function_call', (callId, name, args) => this.handleFunctionCall(active, sessionId, callId, name, args));
    realtimeClient.on('response_done', () => this.handleResponseDone(active, sessionId).catch((err) => {
      console.error(`[Bridge] Error flushing tool results (${sessionId}):`, (err as Error).message);
    }));
    realtimeClient.on('error', (err) => this.handleRealtimeError(sessionId, err));
    realtimeClient.on('close', (_code, _reason) => this.handleRealtimeClose(active, sessionId, _code, _reason));
  }

  private handleSpeechStarted(active: ActiveSession, sessionId: string): void {
    if (active.isResponding) {
      console.log(`[Bridge] Barge-in detected (${sessionId}), cancelling response`);
      active.realtimeClient.cancelResponse();
      this.wyoming.sendAudioStop(sessionId);
      active.isResponding = false;
      active.audioStartSent = false;
    }
  }

  private handleAudioDelta(active: ActiveSession, sessionId: string, pcm: Buffer): void {
    if (!active.audioStartSent) {
      const ttfa = active.latency.measure('session_start');
      if (ttfa > 0) {
        console.log(`[Bridge] TTFA: ${ttfa}ms (${sessionId})`);
      }
      this.wyoming.sendAudioStart(sessionId, this.pcmRate, PCM_WIDTH, PCM_CHANNELS);
      active.audioStartSent = true;
      active.isResponding = true;
      active.pcmAccumulator = Buffer.alloc(0);
      active.audioDrainTimer = null;
    }
    // Accumulate raw PCM bytes
    active.pcmAccumulator = Buffer.concat([active.pcmAccumulator!, pcm]);
    if (this.config.debug) {
      console.log(`[Bridge] Audio delta: +${pcm.length}B, accumulated: ${active.pcmAccumulator.length}B (${sessionId})`);
    }

    // Start drain timer — sends 1024 bytes at the real-time rate for the configured sample rate
    // 16kHz: 1024B / (16000*2) = 32ms, 24kHz: 1024B / (24000*2) = ~21ms
    if (!active.audioDrainTimer) {
      const msPerChunk = Math.floor(1024 / (this.pcmRate * PCM_WIDTH) * 1000);
      active.audioDrainTimer = setInterval(() => {
        this.drainPcmAccumulator(active, sessionId);
      }, msPerChunk);
    }
  }

  private drainPcmAccumulator(active: ActiveSession, sessionId: string): void {
    const CHUNK_SIZE = 1024;  // 32ms at 16kHz 16-bit mono
    if (!active.pcmAccumulator || active.pcmAccumulator.length < CHUNK_SIZE) {
      if (active.audioDrainDone && (!active.pcmAccumulator || active.pcmAccumulator.length === 0)) {
        if (active.audioDrainTimer) {
          clearInterval(active.audioDrainTimer);
          active.audioDrainTimer = null;
        }
        this.wyoming.sendAudioStop(sessionId);
        active.audioStartSent = false;
        active.isResponding = false;
        active.audioDrainDone = false;
      } else if (active.audioDrainDone && active.pcmAccumulator && active.pcmAccumulator.length > 0) {
        // Flush remaining bytes
        this.wyoming.sendAudioChunk(sessionId, active.pcmAccumulator, this.pcmRate, PCM_WIDTH, PCM_CHANNELS);
        active.pcmAccumulator = Buffer.alloc(0);
      }
      return;
    }
    // Send exactly 1024 bytes, amplified
    const chunk = Buffer.from(active.pcmAccumulator.subarray(0, CHUNK_SIZE));
    active.pcmAccumulator = active.pcmAccumulator.subarray(CHUNK_SIZE);
    // Amplify 2x (16-bit signed PCM)
    for (let i = 0; i < chunk.length - 1; i += 2) {
      let sample = chunk.readInt16LE(i) * 2;
      if (sample > 32767) sample = 32767;
      if (sample < -32768) sample = -32768;
      chunk.writeInt16LE(sample, i);
    }
    this.wyoming.sendAudioChunk(sessionId, chunk, this.pcmRate, PCM_WIDTH, PCM_CHANNELS);
  }

  private handleAudioDone(active: ActiveSession, sessionId: string): void {
    if (active.audioDrainTimer) {
      // Audio is being drained via timer — signal completion
      active.audioDrainDone = true;
      return;
    }
    if (active.audioStartSent) {
      this.wyoming.sendAudioStop(sessionId);
      active.audioStartSent = false;
      active.isResponding = false;
    }
  }

  private handleTranscriptDone(active: ActiveSession, sessionId: string, text: string): void {
    console.log(`[Bridge] Transcript (${sessionId}): ${text}`);
    this.wyoming.sendTranscript(sessionId, text);
    this.emit('transcript', sessionId, text);

    // Track turns for summarization
    active.summarizer.addTurn('assistant', text);

    // Forward knowledge-type turns to OpenClaw: skip pure smart-home tool calls,
    // fire-and-forget so Jarvis can remember/reason about conversation turns.
    const sid2 = active.wyomingSession.id;
    const willForward = !!this.openclawClient && !!active.lastUserTranscript && !active.hadToolCall;
    console.log(
      `[Bridge] Turn end (${sid2}): hadToolCall=${active.hadToolCall}, forwardToOpenClaw=${willForward}`,
    );
    if (this.openclawClient && active.lastUserTranscript && !active.hadToolCall) {
      const sid = active.wyomingSession.id;
      const speakerInfo = active.speakerId
        ? this.speakerResolver.getSpeakerInfo(active.speakerId)
        : null;
      const recentContext = active.summarizer.getRecentTurns(5);
      this.openclawClient
        .ask(active.lastUserTranscript, {
          sessionId: sid,
          speakerId: active.speakerId,
          speakerName: speakerInfo?.displayName,
          securityLevel: active.securityLevel,
          recentContext,
        })
        .then((reply) => {
          console.log(`[Bridge] OpenClaw forward (${sid}): ${reply.slice(0, 200)}`);
        })
        .catch((err) => {
          console.warn(`[Bridge] OpenClaw forward failed (${sid}):`, (err as Error).message);
        });
    }

    // Check if summarization is needed
    const result = active.summarizer.checkAndSummarize();
    if (result) {
      console.log(`[Bridge] Summarized ${result.removedTurns} turns (${sessionId})`);
      active.realtimeClient.sendConversationItem({
        type: 'message',
        role: 'system',
        content: [{ type: 'text', text: `[Conversation summary]: ${result.summary}` }],
      });
    }
  }

  private handleServerEvent(active: ActiveSession, event: { type: string; transcript?: string }): void {
    if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
      const sid = active.wyomingSession.id;
      active.reasoningGeneration += 1;
      console.log(
        `[Bridge] User turn (${sid}, gen=${active.reasoningGeneration}): ${event.transcript}`,
      );
      active.lastUserTranscript = event.transcript;
      active.hadToolCall = false;
      active.summarizer.addTurn('user', event.transcript);
    }
  }

  private handleFunctionCall(active: ActiveSession, sessionId: string, callId: string, name: string, args: string): void {
    console.log(`[Bridge] Function call (${sessionId}): ${name}(${args})`);
    active.hadToolCall = true;
    // Store the result promise — all results are flushed together on response.done
    const resultPromise = this.executeFunctionCall(active, sessionId, name, args).catch((err) => {
      console.error(`[Bridge] Unhandled tool error (${sessionId}):`, (err as Error).message);
      return JSON.stringify({ error: 'internal_error' });
    });
    active.pendingToolCalls.set(callId, resultPromise);
  }

  /** Flush all pending tool results and trigger a single response.create. */
  private async handleResponseDone(active: ActiveSession, sessionId: string): Promise<void> {
    if (active.pendingToolCalls.size === 0) return;

    const entries = Array.from(active.pendingToolCalls.entries());
    active.pendingToolCalls.clear();

    // Await all tool executions (may already be resolved)
    const results = await Promise.all(
      entries.map(async ([callId, promise]) => ({ callId, result: await promise })),
    );

    for (const { callId, result } of results) {
      console.log(`[Bridge] Tool result (${sessionId}): ${callId} → ${result.slice(0, 200)}`);
      active.realtimeClient.sendConversationItem({
        type: 'function_call_output',
        call_id: callId,
        output: result,
      });
    }

    active.realtimeClient.createResponse();
  }

  private async executeFunctionCall(
    active: ActiveSession,
    sessionId: string,
    name: string,
    args: string,
  ): Promise<string> {
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      return JSON.stringify({ error: 'invalid_arguments' });
    }

    // Voice enrollment — collect audio for speaker voiceprint
    if (name === 'enroll_speaker') {
      if (!this.eagle) {
        return JSON.stringify({ success: false, message: 'Speaker identification not configured' });
      }
      const speakerName = (parsedArgs.name as string) ?? 'unknown';
      try {
        const collector = new EnrollmentCollector(this.eagle, speakerName, this.config.eagle);
        active.enrollmentCollector = collector;
        console.log(`[Bridge] Enrollment started for "${speakerName}" (${sessionId})`);
        const result = await collector.result;
        active.enrollmentCollector = undefined;
        console.log(`[Bridge] Enrollment ${result.success ? 'succeeded' : 'failed'}: ${result.message}`);
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({ success: false, message: (err as Error).message });
      }
    }

    // HA direct tools — bypass ToolRouter, execute immediately
    const haToolNames = ['light_control', 'get_state', 'call_service', 'list_entities'];
    if (this.haConfig && haToolNames.includes(name)) {
      console.log(`[Bridge] HA direct call (${sessionId}): ${name}(${JSON.stringify(parsedArgs)})`);
      const start = Date.now();
      const result = await executeHATool(this.haConfig, name, parsedArgs);
      console.log(
        `[Bridge] HA direct result (${sessionId}, ${Date.now() - start}ms): ${result.slice(0, 200)}`,
      );
      return result;
    }

    const toolType = this.toolRouter.getType(name);

    // Check permission — reasoning is always allowed (filtered separately)
    if (toolType !== 'reasoning') {
      const allowed = filterToolsForLevel(
        [{ type: 'function', name, description: '', parameters: {} }],
        active.securityLevel,
        this.config.toolRouter.levelTools,
      );
      if (allowed.length === 0) {
        console.warn(`[Bridge] Tool ${name} blocked for level ${active.securityLevel} (${sessionId})`);
        return JSON.stringify({
          error: 'permission_denied',
          message: `Tool ${name} requires higher security level than ${active.securityLevel}`,
        });
      }
    }

    if (!this.openclawClient) {
      return JSON.stringify({ error: 'no_executor' });
    }

    try {
      switch (toolType) {
        case 'direct':
          return await this.openclawClient.executeTool(name, parsedArgs);

        case 'reasoning': {
          active.hadReasoning = true;
          active.pendingReasoning += 1;
          // Capture the turn generation at call time. Any reply that returns after
          // a newer user turn arrived will be dropped to avoid cascading responses.
          const myGen = active.reasoningGeneration;
          if (active.idleTimer) {
            clearTimeout(active.idleTimer);
            active.idleTimer = null;
            console.log(`[Bridge] Idle timer paused (${sessionId}, pendingReasoning=${active.pendingReasoning})`);
          }
          const speakerInfo = active.speakerId
            ? this.speakerResolver.getSpeakerInfo(active.speakerId)
            : null;
          const recentTurns = active.summarizer.getRecentTurns(5);
          const question = (parsedArgs.question as string) ?? JSON.stringify(parsedArgs);
          const startedAt = Date.now();
          console.log(`[Bridge] Reasoning start (${sessionId}, gen=${myGen}): question="${question}"`);
          const client = this.openclawClient;
          client
            .ask(question, {
              sessionId,
              speakerId: active.speakerId,
              speakerName: speakerInfo?.displayName,
              securityLevel: active.securityLevel,
              recentContext: recentTurns,
            })
            .then((reply) => {
              const elapsed = Date.now() - startedAt;
              if (myGen !== active.reasoningGeneration) {
                active.pendingReasoning = Math.max(0, active.pendingReasoning - 1);
                console.log(
                  `[Bridge] Reasoning stale, dropped (${sessionId}, gen=${myGen} vs current=${active.reasoningGeneration}, ${elapsed}ms)`,
                );
                if (active.pendingReasoning === 0) this.resetIdleTimer(active, sessionId);
                return;
              }
              console.log(`[Bridge] Reasoning done (${sessionId}, gen=${myGen}, ${elapsed}ms)`);
              this.injectReasoningReply(active, sessionId, reply);
            })
            .catch((err) => {
              const elapsed = Date.now() - startedAt;
              if (myGen !== active.reasoningGeneration) {
                active.pendingReasoning = Math.max(0, active.pendingReasoning - 1);
                console.warn(
                  `[Bridge] Reasoning stale, error dropped (${sessionId}, gen=${myGen}, ${elapsed}ms):`,
                  (err as Error).message,
                );
                if (active.pendingReasoning === 0) this.resetIdleTimer(active, sessionId);
                return;
              }
              console.warn(
                `[Bridge] Reasoning failed (${sessionId}, gen=${myGen}, ${elapsed}ms):`,
                (err as Error).message,
              );
              this.injectReasoningReply(
                active,
                sessionId,
                `Jarvis konnte nicht antworten: ${(err as Error).message}`,
              );
            });
          console.log(`[Bridge] Reasoning stub returned to xAI (${sessionId}, gen=${myGen}) — response expected later`);
          return JSON.stringify({
            status: 'pending',
            hint: 'Sag dem Nutzer nur in EINEM kurzen Satz, dass du nachdenkst (z.B. "Moment."). Die echte Antwort kommt gleich als System-Nachricht. Erfinde KEINE Inhalte selbst und rufe KEIN Tool erneut auf bis die System-Nachricht kam.',
          });
        }

        case 'dangerous': {
          const approval = await this.openclawClient.requestApproval(name, parsedArgs);
          return JSON.stringify(approval);
        }

        case 'blocked':
        default:
          return JSON.stringify({ error: 'tool_not_registered', tool: name });
      }
    } catch (err) {
      console.error(`[Bridge] Tool execution error (${sessionId}):`, (err as Error).message);
      return JSON.stringify({ error: 'execution_failed', message: (err as Error).message });
    }
  }

  private handleRealtimeError(sessionId: string, err: Error): void {
    console.error(`[Bridge] Realtime error (${sessionId}):`, err.message);
    this.emit('error', sessionId, err);
  }

  private handleRealtimeClose(active: ActiveSession, sessionId: string, code: number, reason: string): void {
    console.log(`[Bridge] Realtime closed (${sessionId}): ${code} ${reason}`);
    active.audioStartSent = false;
    active.isResponding = false;
  }
}
