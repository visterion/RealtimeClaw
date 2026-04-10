#!/usr/bin/env bash
set -e

CONFIG=/data/options.json

# Helper: read JSON field
val() { jq -r ".$1 // empty" "$CONFIG"; }

# Required
export XAI_API_KEY="$(val xai_api_key)"
if [ -z "$XAI_API_KEY" ]; then
  echo "[RealtimeClaw] ERROR: xai_api_key is required" >&2
  exit 1
fi

# Provider
export REALTIME_PROVIDER="$(val realtime_provider)"
export REALTIME_VOICE="$(val realtime_voice)"
export REALTIME_TRANSCRIPTION_MODEL="$(val realtime_transcription_model)"

# Audio
export REALTIME_INPUT_AUDIO_RATE="$(val input_audio_rate)"
export REALTIME_OUTPUT_AUDIO_RATE="$(val output_audio_rate)"
export REALTIME_VAD_THRESHOLD="$(val vad_threshold)"
export REALTIME_SILENCE_DURATION_MS="$(val silence_duration_ms)"
export REALTIME_PREFIX_PADDING_MS="$(val prefix_padding_ms)"

# Assistant
export ASSISTANT_NAME="$(val assistant_name)"
export ASSISTANT_LANGUAGES="$(val assistant_languages)"
export REALTIME_INSTRUCTIONS="$(val instructions)"

# Fallback context (used when no OpenClaw)
export REALTIME_SOUL="$(val soul)"
export REALTIME_IDENTITY="$(val identity)"
export REALTIME_USERS="$(val users)"

# HA Direct
export HA_URL="$(val ha_url)"
export HA_TOKEN="$(val ha_token)"

# OpenClaw (optional)
export OPENCLAW_URL="$(val openclaw_url)"
export OPENCLAW_TOKEN="$(val openclaw_token)"
export OPENCLAW_TIMEOUT_MS="$(val openclaw_timeout_ms)"
export OPENCLAW_DEVICE_STORE="/data/openclaw-device.json"

# Eagle (optional)
export EAGLE_ENABLED="$(val eagle_enabled)"
export EAGLE_ACCESS_KEY="$(val eagle_access_key)"
export EAGLE_CONFIDENCE_THRESHOLD="$(val eagle_confidence_threshold)"
export EAGLE_IDENTIFY_FRAMES="$(val eagle_identify_frames)"
export EAGLE_VOICEPRINTS_DIR="/data/voiceprints"

# Speaker / Security
export SPEAKER_DEVICE_MAP="$(val speaker_device_map)"
export SPEAKER_CONFIG="$(val speaker_config)"
export SPEAKER_MAX_LEVELS="$(val speaker_max_levels)"
export SECURITY_THRESHOLD_FAMILY="$(val security_threshold_family)"
export SECURITY_THRESHOLD_TRUSTED="$(val security_threshold_trusted)"
export SECURITY_THRESHOLD_OWNER="$(val security_threshold_owner)"

# Tool Routing
export TOOL_ROUTE_DIRECT="$(val tool_route_direct)"
export TOOL_ROUTE_REASONING="$(val tool_route_reasoning)"
export TOOL_ROUTE_DANGEROUS="$(val tool_route_dangerous)"

# Debug
export DEBUG_REALTIME_CLAW="$(val debug)"

# Wyoming port is fixed in addon
export WYOMING_PORT=10300

echo "[RealtimeClaw] Starting as HA addon..."
echo "[RealtimeClaw] Provider: $REALTIME_PROVIDER | Voice: $REALTIME_VOICE"
echo "[RealtimeClaw] Wyoming port: $WYOMING_PORT"

exec node dist/index.js
