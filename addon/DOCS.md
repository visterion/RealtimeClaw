# RealtimeClaw

Wyoming Protocol to Realtime Speech-to-Speech bridge for Home Assistant.

## Installation

1. In Home Assistant go to **Settings → Add-ons → Add-on Store**
2. Click the **⋮** menu (top right) → **Repositories**
3. Add this URL: `https://github.com/visterion/RealtimeClaw`
4. Click **Add** → Close
5. Find **RealtimeClaw** in the store list → Click **Install**
6. Go to the **Configuration** tab → set your **xAI API Key**
7. Click **Start**
8. Check the **Log** tab — you should see all ✓ checks and "Ready"

## Quick Start

After installation:

1. Set your **xAI API Key** (required — get one at [console.x.ai](https://console.x.ai))
2. Choose a **Voice** (default: eve)
3. Start the addon
4. Check the **Log** tab — startup verification shows which integrations work:

```
[Verify] xAI API Key: ✓ connected (eve)
[Verify] HA Direct: ✓ reachable (Home Assistant 2025.4)
[Verify] OpenClaw: – not configured
[Verify] Eagle: – disabled
[Wyoming] Listening on 0.0.0.0:10300
[RealtimeClaw] Ready.
```

## Voice PE Setup (ESPHome Wyoming Client)

To connect Voice PE devices directly to RealtimeClaw (bypasses HA Assist pipeline for true speech-to-speech):

1. Install the **ESPHome** addon in HA
2. Add this to your Voice PE device config:

```yaml
external_components:
  - source:
      type: git
      url: https://github.com/visterion/esphome-wyoming-client
    components: [wyoming_tcp_client]

substitutions:
  wyoming_host: "YOUR_HA_IP"    # e.g. 192.168.1.50
  wyoming_port: "10300"

wyoming_tcp_client:
  id: wyoming_client
  host: ${wyoming_host}
  port: ${wyoming_port}
  microphone:
    microphone: i2s_mics
    channels: 0
    gain_factor: 4
  speaker: i2s_audio_speaker
```

3. **Remove** the default HA voice pipeline config (`micro_wake_word`, `voice_assistant`) — replaced by `wyoming_tcp_client`
4. Flash via ESPHome addon: **ESPHome Web UI → Edit device → Install** (OTA or USB)
5. Voice PE reboots → connects to RealtimeClaw → speak and get a response!

## Personality Setup

### With OpenClaw (recommended)

OpenClaw manages your assistant's personality (SOUL.md), identity, and user profiles. It also provides deep reasoning via GPT-5.4 with web search.

1. Set **OpenClaw URL** (e.g. `http://192.168.1.100:18789`)
2. Set **OpenClaw Token** (your gateway authentication token)
3. Start the addon
4. **First start:** Check the Log tab — you'll see:

```
═══════════════════════════════════════════════════════
  OpenClaw Device Pairing Required

  Approve this device in the OpenClaw Control UI:
  → Settings → Devices → Pending
  → Approve: "RealtimeClaw"

  Waiting for approval... (retry every 10s)
═══════════════════════════════════════════════════════
```

5. Open your OpenClaw Control UI, approve the pending device
6. The addon auto-connects — you'll see:

```
✓ OpenClaw device paired successfully!
✓ SOUL.md loaded (2914 bytes)
✓ IDENTITY.md loaded (525 bytes)
✓ USER.md loaded (1003 bytes)
```

7. **Done!** On subsequent restarts, pairing is automatic (token saved).

### Without OpenClaw

Use the **Soul**, **Identity**, and **Users** text fields in the addon config to set personality directly. Paste the same markdown you'd put in SOUL.md, IDENTITY.md, USER.md.

## Home Assistant Direct Tools

Set **HA URL** and **HA Token** to enable direct tool calling (lights, climate, etc.) with ~50ms latency — no OpenClaw LLM overhead for simple commands.

1. In HA: **Profile → Long-Lived Access Tokens → Create Token**
2. Set **HA URL** to `http://homeassistant.local:8123`
3. Set **HA Token** to the token you created
4. Restart — tools like `light_control`, `get_state`, `call_service` are now available

## Speaker Identification (Eagle)

Optional Picovoice Eagle integration for recognizing who is speaking. Free tier: 100 min/month (enough for ~20,000 identifications).

### Setup

1. Sign up at [picovoice.ai](https://picovoice.ai) (free, no credit card)
2. Copy your **Access Key**
3. In addon config: enable **Eagle**, paste your **Access Key**
4. Restart the addon

### Enrolling Speakers

Say: **"Jarvis, lerne meine Stimme, ich bin Alice"**

Jarvis will ask you to keep talking for 10 seconds, then save your voiceprint. Next time you speak, Jarvis recognizes you and adjusts permissions accordingly.

### Security Levels

| Level | Who | Tools |
|-------|-----|-------|
| guest | Unknown speaker | Lights, music |
| family | Recognized family member | + Climate, calendar |
| trusted | Trusted person | + Documents |
| owner | House owner | Everything |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| **"xAI API Key: ✗"** | Verify your key at [console.x.ai](https://console.x.ai) |
| **"OpenClaw: ✗ connection refused"** | Check OpenClaw URL and that the gateway is running |
| **"Device Pairing Required"** | Approve the device in OpenClaw Control UI → Settings → Devices |
| **No audio response** | Check Voice PE is connected to the correct IP and port 10300 |
| **Eagle not identifying** | Enroll speakers first: "Jarvis, lerne meine Stimme" |
| **"Starting with limited functionality"** | Check Log tab — one or more integrations failed verification |
