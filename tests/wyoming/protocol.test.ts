import { describe, it, expect } from 'vitest';
import { WyomingParser, serializeEvent, audioStart, audioChunk, audioStop, transcript, info } from '../../src/wyoming/protocol.js';

describe('WyomingParser', () => {
  it('parses a simple event without payload', () => {
    const parser = new WyomingParser();
    const input = Buffer.from('{"type":"audio-stop"}\n');
    const results = parser.parse(input);

    expect(results).toHaveLength(1);
    expect(results[0].event.type).toBe('audio-stop');
    expect(results[0].payload).toBeUndefined();
  });

  it('parses an event with payload', () => {
    const parser = new WyomingParser();
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const header = `{"type":"audio-chunk","data":{"rate":16000,"width":2,"channels":1},"payload_length":4}\n`;
    const input = Buffer.concat([Buffer.from(header), pcm]);

    const results = parser.parse(input);

    expect(results).toHaveLength(1);
    expect(results[0].event.type).toBe('audio-chunk');
    expect(results[0].payload).toEqual(pcm);
    expect((results[0].event as any).data.rate).toBe(16000);
  });

  it('handles partial data across multiple parse calls', () => {
    const parser = new WyomingParser();
    const header = '{"type":"audio-chunk","data":{"rate":16000,"width":2,"channels":1},"payload_length":4}\n';
    const pcm = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);

    // Send header in two parts
    const results1 = parser.parse(Buffer.from(header.slice(0, 20)));
    expect(results1).toHaveLength(0);

    const results2 = parser.parse(Buffer.from(header.slice(20)));
    expect(results2).toHaveLength(0); // still waiting for payload

    const results3 = parser.parse(pcm);
    expect(results3).toHaveLength(1);
    expect(results3[0].event.type).toBe('audio-chunk');
    expect(results3[0].payload).toEqual(pcm);
  });

  it('handles partial payload', () => {
    const parser = new WyomingParser();
    const header = '{"type":"audio-chunk","data":{"rate":16000,"width":2,"channels":1},"payload_length":4}\n';

    const results1 = parser.parse(Buffer.from(header));
    expect(results1).toHaveLength(0);

    // Only 2 of 4 bytes
    const results2 = parser.parse(Buffer.from([0x01, 0x02]));
    expect(results2).toHaveLength(0);

    // Remaining 2 bytes
    const results3 = parser.parse(Buffer.from([0x03, 0x04]));
    expect(results3).toHaveLength(1);
    expect(results3[0].payload!.length).toBe(4);
  });

  it('parses multiple events in a single buffer', () => {
    const parser = new WyomingParser();
    const input = Buffer.from(
      '{"type":"audio-start","data":{"rate":16000,"width":2,"channels":1}}\n' +
      '{"type":"audio-stop"}\n'
    );
    const results = parser.parse(input);

    expect(results).toHaveLength(2);
    expect(results[0].event.type).toBe('audio-start');
    expect(results[1].event.type).toBe('audio-stop');
  });

  it('parses describe event', () => {
    const parser = new WyomingParser();
    const results = parser.parse(Buffer.from('{"type":"describe"}\n'));

    expect(results).toHaveLength(1);
    expect(results[0].event.type).toBe('describe');
  });

  it('skips malformed JSON lines', () => {
    const parser = new WyomingParser();
    const input = Buffer.from('not json\n{"type":"audio-stop"}\n');
    const results = parser.parse(input);

    expect(results).toHaveLength(1);
    expect(results[0].event.type).toBe('audio-stop');
  });

  it('skips empty lines', () => {
    const parser = new WyomingParser();
    const input = Buffer.from('\n\n{"type":"audio-stop"}\n\n');
    const results = parser.parse(input);

    expect(results).toHaveLength(1);
    expect(results[0].event.type).toBe('audio-stop');
  });

  it('resets parser state', () => {
    const parser = new WyomingParser();
    parser.parse(Buffer.from('{"type":"audio-chunk","payload_length":100}\n'));
    // Parser is now waiting for 100 bytes of payload

    parser.reset();

    // After reset, should parse fresh
    const results = parser.parse(Buffer.from('{"type":"audio-stop"}\n'));
    expect(results).toHaveLength(1);
    expect(results[0].event.type).toBe('audio-stop');
  });
});

describe('serializeEvent', () => {
  it('serializes event without payload', () => {
    const buf = serializeEvent({ type: 'audio-stop' });
    const str = buf.toString('utf-8');
    const parsed = JSON.parse(str.trim());

    expect(parsed.type).toBe('audio-stop');
    expect(parsed.payload_length).toBeUndefined();
  });

  it('serializes event with data', () => {
    const buf = serializeEvent({
      type: 'audio-start',
      data: { rate: 16000, width: 2, channels: 1 },
    });
    const str = buf.toString('utf-8');
    const parsed = JSON.parse(str.trim());

    expect(parsed.type).toBe('audio-start');
    expect(parsed.data.rate).toBe(16000);
  });

  it('serializes event with payload', () => {
    const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const buf = serializeEvent(
      { type: 'audio-chunk', data: { rate: 16000, width: 2, channels: 1 }, payload_length: 4 },
      pcm,
    );

    // Find the newline to split header from payload
    const newlineIdx = buf.indexOf(0x0a);
    const header = JSON.parse(buf.subarray(0, newlineIdx).toString('utf-8'));
    const payload = buf.subarray(newlineIdx + 1);

    expect(header.type).toBe('audio-chunk');
    expect(header.payload_length).toBe(4);
    expect(payload).toEqual(pcm);
  });
});

describe('helper functions', () => {
  it('builds audio-start frame', () => {
    const buf = audioStart(16000, 2, 1);
    const parsed = JSON.parse(buf.toString('utf-8').trim());
    expect(parsed.type).toBe('audio-start');
    expect(parsed.data.rate).toBe(16000);
    expect(parsed.data.width).toBe(2);
    expect(parsed.data.channels).toBe(1);
  });

  it('builds audio-chunk frame with payload', () => {
    const pcm = Buffer.alloc(320, 0x42); // 10ms of 16kHz 16-bit mono
    const buf = audioChunk(pcm, 16000, 2, 1);

    const newlineIdx = buf.indexOf(0x0a);
    const header = JSON.parse(buf.subarray(0, newlineIdx).toString('utf-8'));
    const payload = buf.subarray(newlineIdx + 1);

    expect(header.type).toBe('audio-chunk');
    expect(header.payload_length).toBe(320);
    expect(payload.length).toBe(320);
  });

  it('builds audio-stop frame', () => {
    const buf = audioStop();
    const parsed = JSON.parse(buf.toString('utf-8').trim());
    expect(parsed.type).toBe('audio-stop');
  });

  it('builds transcript frame', () => {
    const buf = transcript('Hallo Assistant');
    const parsed = JSON.parse(buf.toString('utf-8').trim());
    expect(parsed.type).toBe('transcript');
    expect(parsed.data.text).toBe('Hallo Assistant');
  });

  it('builds info frame', () => {
    const buf = info();
    const parsed = JSON.parse(buf.toString('utf-8').trim());
    expect(parsed.type).toBe('info');
    expect(parsed.data.asr).toHaveLength(1);
    expect(parsed.data.asr[0].name).toBe('wyoming-realtime-bridge');
  });
});

describe('roundtrip', () => {
  it('serialize → parse roundtrip for audio-chunk', () => {
    const pcm = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const serialized = audioChunk(pcm, 16000, 2, 1);

    const parser = new WyomingParser();
    const results = parser.parse(serialized);

    expect(results).toHaveLength(1);
    expect(results[0].event.type).toBe('audio-chunk');
    expect(results[0].payload).toEqual(pcm);
  });

  it('serialize → parse roundtrip for multiple events', () => {
    const pcm1 = Buffer.alloc(4, 0xAA);
    const pcm2 = Buffer.alloc(4, 0xBB);

    const serialized = Buffer.concat([
      audioStart(16000, 2, 1),
      audioChunk(pcm1, 16000, 2, 1),
      audioChunk(pcm2, 16000, 2, 1),
      audioStop(),
    ]);

    const parser = new WyomingParser();
    const results = parser.parse(serialized);

    expect(results).toHaveLength(4);
    expect(results[0].event.type).toBe('audio-start');
    expect(results[1].event.type).toBe('audio-chunk');
    expect(results[1].payload).toEqual(pcm1);
    expect(results[2].event.type).toBe('audio-chunk');
    expect(results[2].payload).toEqual(pcm2);
    expect(results[3].event.type).toBe('audio-stop');
  });
});
