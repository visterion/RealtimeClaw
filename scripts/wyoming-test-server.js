#!/usr/bin/env node
// Minimal Wyoming test server that plays back a PCM file
// Usage: node wyoming-test-server.js [pcm-file] [port]
//
// Accepts Wyoming connections, waits for audio-start,
// then sends back the test PCM file as response audio.

import { createServer } from 'net';
import { readFileSync } from 'fs';

const pcmFile = process.argv[2] || '/tmp/test-tone.pcm';
const port = parseInt(process.argv[3] || '10300');
const pcmData = readFileSync(pcmFile);

console.log(`[TestServer] Loaded ${pcmFile} (${pcmData.length} bytes)`);
console.log(`[TestServer] Listening on port ${port}`);

function sendEvent(socket, type, data, payload) {
  const header = { type, version: '1.7.2' };
  const dataJson = data ? JSON.stringify(data) : null;
  const dataLen = dataJson ? Buffer.byteLength(dataJson) : 0;
  const payloadLen = payload ? payload.length : 0;

  if (dataLen > 0) header.data_length = dataLen;
  if (payloadLen > 0) header.payload_length = payloadLen;

  socket.write(JSON.stringify(header) + '\n');
  if (dataJson) socket.write(dataJson);
  if (payload) socket.write(payload);
}

const server = createServer((socket) => {
  console.log('[TestServer] New connection');
  let gotAudioStart = false;
  let buf = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    // Simple: look for audio-start in the buffer
    const str = buf.toString('utf-8', 0, Math.min(buf.length, 2000));
    if (!gotAudioStart && str.includes('audio-start')) {
      gotAudioStart = true;
      console.log('[TestServer] Got audio-start, waiting 2s then sending response...');

      // Wait a bit (simulate processing), then send response audio
      setTimeout(() => {
        console.log('[TestServer] Sending audio response...');

        // Send audio-start
        sendEvent(socket, 'audio-start', { rate: 16000, width: 2, channels: 1 });

        // Send audio in 1024-byte chunks
        const chunkSize = 1024;
        let offset = 0;
        const sendChunk = () => {
          if (offset >= pcmData.length) {
            // Send audio-stop
            sendEvent(socket, 'audio-stop', { timestamp: null });
            console.log('[TestServer] Audio response complete');
            return;
          }
          const end = Math.min(offset + chunkSize, pcmData.length);
          const audioChunk = pcmData.subarray(offset, end);
          sendEvent(socket, 'audio-chunk',
            { rate: 16000, width: 2, channels: 1 },
            audioChunk
          );
          offset = end;
          // Send one chunk every 32ms (real-time rate for 1024 bytes at 16kHz)
          setTimeout(sendChunk, 32);
        };
        sendChunk();
      }, 2000);
    }
  });

  socket.on('close', () => console.log('[TestServer] Connection closed'));
  socket.on('error', (err) => console.error('[TestServer] Error:', err.message));
});

server.listen(port, '0.0.0.0');
