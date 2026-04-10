#!/bin/bash
#
# RealtimeClaw Installation Script
# Installs RealtimeClaw alongside OpenClaw in an LXC container (Ubuntu 24.04 LXC)
# Connects Home Assistant Wyoming voice pipelines to xAI Realtime API
#
# Usage: bash install-realtimeclaw.sh --xai-key <KEY> --openclaw-token <TOKEN> [--port <PORT>]
#
set -e

# Colors (matching install-openclaw.sh conventions)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
BOLD='\033[1m'

ERRORS=0

print_header() {
  echo -e "\n${BOLD}=== $1 ===${NC}"
}

check_ok() {
  echo -e "${GREEN}[OK]${NC} $1"
}

check_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

check_error() {
  echo -e "${RED}[ERROR]${NC} $1"
  ((ERRORS++))
}

# Defaults
XAI_API_KEY=""
OPENCLAW_TOKEN=""
WYOMING_PORT="10300"
OPENCLAW_USER="openclaw"
OPENCLAW_HOME="/home/${OPENCLAW_USER}"
INSTALL_DIR="${OPENCLAW_HOME}/realtime-claw"
OPENCLAW_GATEWAY_PORT="18789"
LXC_IP="192.168.1.100"
REPO_URL="https://github.com/visterion/RealtimeClaw.git"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --xai-key)
      XAI_API_KEY="$2"
      shift 2
      ;;
    --openclaw-token)
      OPENCLAW_TOKEN="$2"
      shift 2
      ;;
    --port)
      WYOMING_PORT="$2"
      shift 2
      ;;
    --help)
      echo "Usage: bash install-realtimeclaw.sh --xai-key <KEY> --openclaw-token <TOKEN> [--port <PORT>]"
      echo ""
      echo "Options:"
      echo "  --xai-key         xAI API key for Realtime API (required)"
      echo "  --openclaw-token  OpenClaw gateway auth token (required)"
      echo "  --port            Wyoming TCP port (default: 10300)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 2
      ;;
  esac
done

if [ -z "${XAI_API_KEY}" ]; then
  check_error "Missing required argument: --xai-key"
  echo "Usage: bash install-realtimeclaw.sh --xai-key <KEY> --openclaw-token <TOKEN>"
  exit 2
fi

if [ -z "${OPENCLAW_TOKEN}" ]; then
  check_error "Missing required argument: --openclaw-token"
  echo "Usage: bash install-realtimeclaw.sh --xai-key <KEY> --openclaw-token <TOKEN>"
  exit 2
fi

print_header "RealtimeClaw Installation"
echo "  Install Dir:   ${INSTALL_DIR}"
echo "  Wyoming Port:  ${WYOMING_PORT}"
echo "  OpenClaw URL:  http://localhost:${OPENCLAW_GATEWAY_PORT}"
echo "  User:          ${OPENCLAW_USER}"

# Step 1: Validate environment
print_header "Step 1: Validate Environment"

if [ "$(id -u)" -ne 0 ]; then
  check_error "Must run as root"
  exit 2
fi
check_ok "Running as root"

if ! id "${OPENCLAW_USER}" &>/dev/null; then
  check_error "User '${OPENCLAW_USER}' does not exist — is OpenClaw installed?"
  exit 2
fi
check_ok "User ${OPENCLAW_USER} exists"

if ! command -v node &>/dev/null; then
  check_error "Node.js is not installed — run install-openclaw.sh first"
  exit 2
fi
NODE_VERSION=$(node --version)
check_ok "Node.js ${NODE_VERSION} installed"

if ! command -v npm &>/dev/null; then
  check_error "npm is not installed — run install-openclaw.sh first"
  exit 2
fi
NPM_VERSION=$(npm --version)
check_ok "npm ${NPM_VERSION} installed"

if ! command -v git &>/dev/null; then
  check_error "git is not installed"
  exit 2
fi
check_ok "git $(git --version | awk '{print $3}') installed"

if ! ss -tlnp | grep -q ":${OPENCLAW_GATEWAY_PORT}"; then
  check_warning "OpenClaw gateway not listening on port ${OPENCLAW_GATEWAY_PORT} — tool calls may fail until it starts"
else
  check_ok "OpenClaw gateway listening on port ${OPENCLAW_GATEWAY_PORT}"
fi

# Step 2: Clone and build
print_header "Step 2: Clone and Build"

if [ -d "${INSTALL_DIR}/.git" ]; then
  check_warning "Repository already exists at ${INSTALL_DIR} — pulling latest"
  sudo -u "${OPENCLAW_USER}" git -C "${INSTALL_DIR}" pull --ff-only
else
  sudo -u "${OPENCLAW_USER}" git clone "${REPO_URL}" "${INSTALL_DIR}"
  check_ok "Cloned RealtimeClaw to ${INSTALL_DIR}"
fi

sudo -u "${OPENCLAW_USER}" npm ci --prefix "${INSTALL_DIR}"
check_ok "Dependencies installed"

sudo -u "${OPENCLAW_USER}" npm run build --prefix "${INSTALL_DIR}"
check_ok "Build complete"

# Step 3: Configure
print_header "Step 3: Write Configuration"

ENV_FILE="${INSTALL_DIR}/.env"

cat > "${ENV_FILE}" << ENVEOF
XAI_API_KEY=${XAI_API_KEY}
WYOMING_PORT=${WYOMING_PORT}
ASSISTANT_NAME=Assistant
ASSISTANT_LANGUAGES=de,en
REALTIME_PROVIDER=xai
OPENCLAW_URL=http://localhost:${OPENCLAW_GATEWAY_PORT}
OPENCLAW_TOKEN=${OPENCLAW_TOKEN}
OPENCLAW_TIMEOUT_MS=10000
ENVEOF

chmod 600 "${ENV_FILE}"
chown "${OPENCLAW_USER}:${OPENCLAW_USER}" "${ENV_FILE}"
check_ok "Configuration written to ${ENV_FILE}"

# Step 4: Install systemd user service
print_header "Step 4: Install systemd User Service"

SYSTEMD_DIR="${OPENCLAW_HOME}/.config/systemd/user"
sudo -u "${OPENCLAW_USER}" mkdir -p "${SYSTEMD_DIR}"

cat > "${SYSTEMD_DIR}/realtime-claw.service" << SVCEOF
[Unit]
Description=RealtimeClaw Wyoming-to-Realtime Bridge
After=network.target openclaw-gateway.service
Wants=openclaw-gateway.service

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${INSTALL_DIR}/dist/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
SVCEOF

chown -R "${OPENCLAW_USER}:${OPENCLAW_USER}" "${OPENCLAW_HOME}/.config"

OPENCLAW_UID=$(id -u "${OPENCLAW_USER}")
sudo -u "${OPENCLAW_USER}" XDG_RUNTIME_DIR="/run/user/${OPENCLAW_UID}" \
  systemctl --user daemon-reload
sudo -u "${OPENCLAW_USER}" XDG_RUNTIME_DIR="/run/user/${OPENCLAW_UID}" \
  systemctl --user enable realtime-claw
sudo -u "${OPENCLAW_USER}" XDG_RUNTIME_DIR="/run/user/${OPENCLAW_UID}" \
  systemctl --user start realtime-claw
check_ok "realtime-claw service installed and started"

# Step 5: Verify
print_header "Step 5: Verify"

sleep 3

if ss -tlnp | grep -q ":${WYOMING_PORT}"; then
  check_ok "RealtimeClaw listening on Wyoming port ${WYOMING_PORT}"
else
  check_warning "Wyoming port ${WYOMING_PORT} not yet listening"
  echo "  Check logs: sudo -u ${OPENCLAW_USER} journalctl --user -u realtime-claw -f"
fi

# Summary
print_header "Installation Complete"
echo ""
echo -e "${BOLD}RealtimeClaw is installed and running.${NC}"
echo ""
echo "  Wyoming TCP:   ${LXC_IP}:${WYOMING_PORT}"
echo "  OpenClaw URL:  http://localhost:${OPENCLAW_GATEWAY_PORT}"
echo ""
echo -e "${BOLD}Home Assistant Integration:${NC}"
echo "  1. Settings -> Devices & Services -> Add Integration -> Wyoming Protocol"
echo "  2. Host: ${LXC_IP}"
echo "  3. Port: ${WYOMING_PORT}"
echo "  4. Settings -> Voice Assistants -> create or update pipeline"
echo "     -> Speech-to-text: Assistant (RealtimeClaw)"
echo ""
echo -e "${YELLOW}TIP: View service logs with:${NC}"
echo "  sudo -u ${OPENCLAW_USER} journalctl --user -u realtime-claw -f"

if [ ${ERRORS} -gt 0 ]; then
  echo ""
  check_error "${ERRORS} error(s) during installation"
  exit 2
fi

exit 0
