# Firmware — ESPHome Wyoming TCP Client

ESPHome external component that connects a Voice PE directly to
[RealtimeClaw](../README.md) over Wyoming Protocol TCP, bypassing Home
Assistant's Assist pipeline for sub-1s speech-to-speech.

> This folder ships as part of the RealtimeClaw monorepo. In your ESPHome
> dashboard reference it via:
>
> ```yaml
> external_components:
>   - source: github://ufelmann/RealtimeClaw@main
>     path: firmware/components
>     components: [wyoming_tcp_client]
> ```

## How It Works

1. Voice PE detects wake word locally (micro_wake_word)
2. Opens TCP connection to RealtimeClaw
3. Streams 16kHz 16-bit PCM audio using Wyoming protocol
4. Receives response audio and plays through speaker
5. No STT -> Agent -> TTS pipeline -- audio goes directly to xAI Realtime API

## Install

Add to your ESPHome YAML:

```yaml
external_components:
  - source: github://ufelmann/esphome-wyoming-client
    components: [wyoming_tcp_client]

wyoming_tcp_client:
  host: "192.168.178.150"
  port: 10300
  microphone:
    microphone: i2s_mics
    channels: 0
  speaker: i2s_audio_speaker
```

Replace `voice_assistant:` with this component. Keep `micro_wake_word:` and
change its `on_wake_word_detected` to trigger `wyoming_tcp_client.start`.

See [example.yaml](example.yaml) for a complete Voice PE configuration.

## Requirements

- ESPHome 2024.4+
- A Wyoming protocol server (e.g., RealtimeClaw) reachable on the network
- Voice PE or compatible ESP32-S3 device with I2S mic + speaker

## Architecture

```
Voice PE (ESP32-S3)              RealtimeClaw              xAI Realtime API
+------------------+            +-------------+           +---------------+
| micro_wake_word  |            |             |           |               |
| "Okay Nabu"      |   TCP      |  Wyoming    |  WSS      |  Grok         |
|   |              |----------->|  Server     |---------->|  Speech-to-   |
| wyoming_tcp_     |  Wyoming   |  :10300     |           |  Speech       |
| client           |  protocol  |             |<----------|               |
|   |              |<-----------|  Bridge     |           |               |
| I2S Speaker      |  audio     +-------------+           +---------------+
+------------------+
```

## License

MIT
