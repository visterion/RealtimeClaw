import type { SpeakerConfig } from '../types.js';

export interface SpeakerInfo {
  id: string;
  displayName: string;
  contextKey: string;
}

/**
 * Resolve speaker from Wyoming session metadata.
 * Uses device ID → speaker mapping from config.
 */
export class SpeakerResolver {
  private config: SpeakerConfig;
  private sessionCache = new Map<string, string>();

  constructor(config: SpeakerConfig) {
    this.config = config;
  }

  /**
   * Resolve speaker for a Wyoming session.
   * Checks session cache first, then device map.
   */
  resolve(sessionId: string, deviceId?: string): SpeakerInfo | null {
    const cached = this.sessionCache.get(sessionId);
    if (cached) return this.getSpeakerInfo(cached);

    if (deviceId) {
      const speakerId = this.config.deviceMap[deviceId];
      if (speakerId) {
        this.sessionCache.set(sessionId, speakerId);
        return this.getSpeakerInfo(speakerId);
      }
    }

    return null;
  }

  /**
   * Manually set speaker for a session (e.g., after asking "who are you?").
   */
  setSessionSpeaker(sessionId: string, speakerId: string): void {
    this.sessionCache.set(sessionId, speakerId);
  }

  clearSession(sessionId: string): void {
    this.sessionCache.delete(sessionId);
  }

  /**
   * Build speaker-specific context string for injection into instructions.
   */
  buildSpeakerContext(speakerId: string): string | null {
    const speaker = this.config.speakers[speakerId];
    if (!speaker) return null;
    return `Speaker: ${speaker.displayName} (id: ${speakerId})`;
  }

  getSpeakerIds(): string[] {
    return Object.keys(this.config.speakers);
  }

  getSpeakerInfo(speakerId: string): SpeakerInfo | null {
    const speaker = this.config.speakers[speakerId];
    if (!speaker) return null;
    return {
      id: speakerId,
      displayName: speaker.displayName,
      contextKey: speaker.contextKey,
    };
  }
}
