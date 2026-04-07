#!/usr/bin/env bash
# claude-local.sh — start Claude Code with a local/cloud model from any directory
#
# Usage:
#   claude-local.sh [options] [-- claude-args...]
#
# Options:
#   -b, --backend BACKEND  smart | ollama | anthropic (default: smart)
#   -p, --port PORT        Proxy port (default: 9090)
#   -m, --model MODEL      Ollama model override (only used with --backend ollama)
#   -l, --list             List available Ollama models and exit
#   -h, --help             Show this help
#
# Backends:
#   smart      Auto-discovers Ollama + LM Studio models, routes by tier.
#              Set OPENROUTER_API_KEY for cloud fallback.
#              Model tier env overrides: TINY_MODEL, FAST_MODEL, BALANCED_MODEL,
#              POWERFUL_MODEL, REASONING_MODEL (format: "provider:id" or bare "id")
#   ollama     Single-model Ollama proxy (legacy, uses -m/--model flag)
#   anthropic  Pass-through to real Anthropic API (needs ANTHROPIC_API_KEY)
#
# Key bindings (tmux):
#   Ctrl+B G   Toggle proxy log pane (expand/collapse)
#
# Examples:
#   claude-local.sh                            # smart backend, auto-detect models
#   claude-local.sh -b ollama -m qwen3:30b     # specific Ollama model
#   claude-local.sh -b anthropic               # real Anthropic API
#   claude-local.sh -- --model claude-sonnet-4-6  # pass args to Claude Code

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="smart"
MODEL="qwen3-coder:30b"
PORT=9090
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

# ── Smart backend (multi-provider, auto-routing) ─────────────────────────────

start_smart_backend() {
  # Kill any existing proxy on this port
  lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true

  export PROXY_PORT="$PORT"
  export PROXY_LOG="/tmp/claude-smart-${PORT}.log"

  node "$REPO/smart-proxy.mjs" >/dev/null 2>&1 &
  PROXY_PID=$!

  # Wait for proxy to be ready (up to 5s)
  for i in {1..10}; do
    curl -sf "http://localhost:$PORT/proxy/status" >/dev/null 2>&1 && break
    sleep 0.5
  done

  LOG_FILE="$PROXY_LOG"
  LABEL="smart-proxy"
}

# ── Ollama backend (single model, legacy) ────────────────────────────────────

start_ollama_backend() {
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

  export OLLAMA_MODEL="$MODEL"
  export PROXY_PORT="$PORT"
  export OLLAMA_LOG="/tmp/claude-ollama-${PORT}.log"

  OLLAMA_MODEL="$MODEL" PROXY_PORT="$PORT" OLLAMA_LOG="$OLLAMA_LOG" \
    node "$REPO/ollama-proxy.mjs" >/dev/null 2>&1 &
  PROXY_PID=$!

  # Wait for proxy to be ready (up to 5s)
  for i in {1..10}; do
    curl -sf "http://localhost:$PORT" >/dev/null 2>&1 && break
    sleep 0.5
  done

  LOG_FILE="$OLLAMA_LOG"
  LABEL="$MODEL"
}

# ── tmux runner ───────────────────────────────────────────────────────────────

run_with_tmux() {
  local session="claude-$$"
  local work_dir
  work_dir="$(pwd)"

  local claude_cmd="ANTHROPIC_BASE_URL=http://localhost:${PORT} DISABLE_AUTOUPDATER=1 node '${REPO}/cli.js'"
  if [[ $# -gt 0 ]]; then
    claude_cmd="${claude_cmd} $(printf '%q ' "$@")"
  fi
  claude_cmd="${claude_cmd}; tmux kill-session -t ${session} 2>/dev/null"

  tmux new-session -d -s "$session" -x "$(tput cols)" -y "$(tput lines)"

  tmux set-option -t "$session" status on
  tmux set-option -t "$session" status-interval 1
  tmux set-option -t "$session" status-position bottom
  tmux set-option -t "$session" status-style "bg=colour235,fg=colour242"
  tmux set-option -t "$session" status-left ""
  tmux set-option -t "$session" status-right \
    "#[fg=colour242] ◆ ${LABEL}  #[fg=colour82]#(cat '${LOG_FILE}.status' 2>/dev/null || echo 'waiting...')  #[fg=colour238]│ Ctrl+B G: log "
  tmux set-option -t "$session" status-right-length 160

  tmux bind-key -T prefix g display-popup \
    -E -w 90% -h 80% \
    -b rounded -T " proxy log — ${LABEL} " \
    "tail -n 100 -f '${LOG_FILE}'"

  tmux send-keys -t "$session" "cd '${work_dir}' && ${claude_cmd}" ENTER
  tmux attach-session -t "$session"
}

run_without_tmux() {
  echo "Running Claude Code in: $(pwd)"
  echo "Backend: $BACKEND ($LABEL)"
  echo "(Install tmux for the live status bar)"
  echo "---"
  ANTHROPIC_BASE_URL="http://localhost:$PORT" DISABLE_AUTOUPDATER=1 node "$REPO/cli.js" "$@"
}

# ── Main ──────────────────────────────────────────────────────────────────────

if [[ "$BACKEND" == "smart" ]]; then
  start_smart_backend

  if command -v tmux &>/dev/null; then
    run_with_tmux "$@"
  else
    run_without_tmux "$@"
  fi

elif [[ "$BACKEND" == "ollama" ]]; then
  start_ollama_backend

  if command -v tmux &>/dev/null; then
    run_with_tmux "$@"
  else
    run_without_tmux "$@"
  fi

elif [[ "$BACKEND" == "anthropic" ]]; then
  [[ -z "$ANTHROPIC_API_KEY" ]] && die "ANTHROPIC_API_KEY is not set"
  echo "Running Claude Code in: $(pwd)"
  echo "Backend: Anthropic API"
  echo "---"
  node "$REPO/cli.js" "$@"

else
  die "Unknown backend '$BACKEND'. Use: smart | ollama | anthropic"
fi
