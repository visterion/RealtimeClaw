import type { WyomingEvent, WyomingMessage } from '../types.js';

const NEWLINE = 0x0a; // '\n'
const MAX_LINE_LOG_LENGTH = 200;
const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * Wyoming protocol parser.
 *
 * Wyoming v1.7+ sends: header JSON\n + data JSON (data_length bytes) + payload (payload_length bytes).
 * The header contains {type, version?, data_length?, payload_length?}.
 * The data block is a separate JSON object immediately after the newline (NOT on the same line).
 * The payload is raw binary (e.g., PCM audio) immediately after the data block.
 *
 * State machine: HEADER -> DATA (if data_length > 0) -> PAYLOAD (if payload_length > 0) -> HEADER
 */
export class WyomingParser {
  private remainder: Buffer = EMPTY_BUFFER;
  private pendingHeader: WyomingEvent | null = null;
  private pendingDataLength = 0;
  private pendingPayloadLength = 0;
  private state: 'header' | 'data' | 'payload' = 'header';

  parse(data: Buffer): Array<{ event: WyomingMessage; payload?: Buffer }> {
    let buffer = this.remainder.length > 0
      ? Buffer.concat([this.remainder, data])
      : data;

    const results: Array<{ event: WyomingMessage; payload?: Buffer }> = [];

    while (buffer.length > 0) {
      if (this.state === 'payload') {
        // Read raw payload bytes (e.g., PCM audio)
        if (buffer.length < this.pendingPayloadLength) {
          break;
        }
        const payload = buffer.subarray(0, this.pendingPayloadLength);
        buffer = buffer.subarray(this.pendingPayloadLength);
        results.push({ event: this.pendingHeader as WyomingMessage, payload });
        this.pendingHeader = null;
        this.pendingPayloadLength = 0;
        this.state = 'header';
        continue;
      }

      if (this.state === 'data') {
        // Read data_length bytes as JSON data block
        if (buffer.length < this.pendingDataLength) {
          break;
        }
        const dataBlock = buffer.subarray(0, this.pendingDataLength).toString('utf-8');
        buffer = buffer.subarray(this.pendingDataLength);
        this.pendingDataLength = 0;

        try {
          const parsed = JSON.parse(dataBlock);
          if (this.pendingHeader) {
            this.pendingHeader.data = parsed;
          }
        } catch {
          // data block not valid JSON — ignore
        }

        if (this.pendingPayloadLength > 0) {
          this.state = 'payload';
        } else {
          results.push({ event: this.pendingHeader as WyomingMessage });
          this.pendingHeader = null;
          this.state = 'header';
        }
        continue;
      }

      // state === 'header': read until newline
      const newlineIdx = buffer.indexOf(NEWLINE);
      if (newlineIdx === -1) {
        break;
      }

      const line = buffer.subarray(0, newlineIdx).toString('utf-8').trim();
      buffer = buffer.subarray(newlineIdx + 1);

      if (line.length === 0) continue;

      let event: WyomingEvent;
      try {
        event = JSON.parse(line);
      } catch {
        console.warn(`[Wyoming] Malformed header: ${line.slice(0, MAX_LINE_LOG_LENGTH)}`);
        continue;
      }

      if (process.env.DEBUG_REALTIME_CLAW === 'true') {
        console.log(`[Wyoming] Event: ${event.type}, data_length: ${event.data_length ?? 0}, payload_length: ${event.payload_length ?? 0}`);
      }

      this.pendingHeader = event;
      this.pendingDataLength = event.data_length ?? 0;
      this.pendingPayloadLength = event.payload_length ?? 0;

      if (this.pendingDataLength > 0) {
        this.state = 'data';
      } else if (this.pendingPayloadLength > 0) {
        this.state = 'payload';
      } else {
        results.push({ event: event as WyomingMessage });
        this.pendingHeader = null;
        this.state = 'header';
      }
    }

    this.remainder = buffer.length > 0 ? buffer : EMPTY_BUFFER;
    return results;
  }

  reset(): void {
    this.remainder = EMPTY_BUFFER;
    this.pendingHeader = null;
    this.pendingDataLength = 0;
    this.pendingPayloadLength = 0;
    this.state = 'header';
  }
}

export function serializeEvent(event: WyomingEvent | WyomingMessage, payload?: Buffer): Buffer {
  const header: Record<string, unknown> = { type: event.type };

  if ('data' in event && event.data !== undefined) {
    header.data = event.data;
  }
  if ('data_length' in event && event.data_length !== undefined) {
    header.data_length = event.data_length;
  }
  if (payload && payload.length > 0) {
    header.payload_length = payload.length;
  }

  const headerLine = JSON.stringify(header) + '\n';
  const headerBuf = Buffer.from(headerLine, 'utf-8');

  if (payload && payload.length > 0) {
    return Buffer.concat([headerBuf, payload]);
  }
  return headerBuf;
}

export function audioStart(rate: number, width: number, channels: number): Buffer {
  return serializeEvent({
    type: 'audio-start',
    data: { rate, width, channels },
  });
}

export function audioChunk(pcm: Buffer, rate: number, width: number, channels: number): Buffer {
  return serializeEvent(
    {
      type: 'audio-chunk',
      data: { rate, width, channels },
      payload_length: pcm.length,
    },
    pcm,
  );
}

export function audioStop(): Buffer {
  return serializeEvent({ type: 'audio-stop' });
}

export function transcript(text: string): Buffer {
  return serializeEvent({ type: 'transcript', data: { text } });
}

export function info(languages: string[] = ['de', 'en']): Buffer {
  return serializeEvent({
    type: 'info',
    data: {
      asr: [
        {
          name: 'wyoming-realtime-bridge',
          description: 'Realtime Speech-to-Speech bridge via xAI/OpenAI',
          installed: true,
          attribution: { name: 'RealtimeClaw', url: 'https://github.com/RealtimeClaw' },
          languages,
          models: [
            {
              name: 'realtime-s2s',
              description: 'Realtime Speech-to-Speech (xAI/OpenAI)',
              languages,
              installed: true,
              attribution: { name: 'RealtimeClaw', url: 'https://github.com/RealtimeClaw' },
            },
          ],
        },
      ],
    },
  });
}
