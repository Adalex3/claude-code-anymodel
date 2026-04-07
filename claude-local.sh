#!/usr/bin/env bash
# claude-local.sh — start Claude Code with a local Ollama model from any directory
#
# Usage:
#   claude-local.sh [options] [-- claude-args...]
#
# Options:
#   -m, --model MODEL     Ollama model to use (default: qwen3-coder:30b)
#   -p, --port PORT       Proxy port (default: 9090)
#   -b, --backend BACKEND ollama | anthropic (default: ollama)
#   -l, --list            List available Ollama models and exit
#   -h, --help            Show this help
#
# Examples:
#   claude-local.sh                                  # use default model
#   claude-local.sh -m qwen2.5-coder:7b              # use smaller/faster model
#   claude-local.sh -b anthropic                     # use real Anthropic API
#   claude-local.sh -- --model claude-sonnet-4-6     # pass args to Claude Code

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODEL="qwen3-coder:30b"
PORT=9090
BACKEND="ollama"
PROXY_PID=""

usage() {
  sed -n '/^# Usage/,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
}

die() { echo "Error: $1" >&2; exit 1; }

cleanup() {
  if [[ -n "$PROXY_PID" ]]; then
    kill "$PROXY_PID" 2>/dev/null
    wait "$PROXY_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    -m|--model)    MODEL="$2"; shift 2;;
    -p|--port)     PORT="$2"; shift 2;;
    -b|--backend)  BACKEND="$2"; shift 2;;
    -l|--list)     ollama list; exit 0;;
    -h|--help)     usage;;
    --)            shift; break;;
    *)             break;;
  esac
done

if [[ "$BACKEND" == "ollama" ]]; then
  # Check Ollama is running
  if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    die "Ollama is not running. Start it with: ollama serve"
  fi

  # Check the model exists
  if ! ollama list 2>/dev/null | grep -q "^${MODEL}"; then
    echo "Model '$MODEL' not found locally."
    read -rp "Pull it now? [y/N] " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || die "Aborted. Run: ollama pull $MODEL"
    ollama pull "$MODEL" || die "Failed to pull $MODEL"
  fi

  # Kill any existing proxy on this port
  lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true

  # Start proxy in background
  echo "Starting Ollama proxy on :$PORT with model $MODEL..."
  OLLAMA_MODEL="$MODEL" PROXY_PORT="$PORT" node "$REPO/ollama-proxy.mjs" &
  PROXY_PID=$!

  # Wait for proxy to be ready (up to 5s)
  for i in {1..10}; do
    curl -sf "http://localhost:$PORT" >/dev/null 2>&1 && break
    sleep 0.5
  done

  echo "Running Claude Code in: $(pwd)"
  echo "Backend: Ollama ($MODEL)"
  echo "---"
  ANTHROPIC_BASE_URL="http://localhost:$PORT" node "$REPO/cli.js" "$@"

elif [[ "$BACKEND" == "anthropic" ]]; then
  [[ -z "$ANTHROPIC_API_KEY" ]] && die "ANTHROPIC_API_KEY is not set"
  echo "Running Claude Code in: $(pwd)"
  echo "Backend: Anthropic API"
  echo "---"
  node "$REPO/cli.js" "$@"

else
  die "Unknown backend '$BACKEND'. Use: ollama | anthropic"
fi
