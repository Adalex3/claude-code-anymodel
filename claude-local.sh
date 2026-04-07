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
# Key bindings (tmux, when using ollama backend):
#   Ctrl+B G              Toggle Ollama log pane (expand/collapse)
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

  # Start proxy in background, log file set per port to avoid conflicts
  export OLLAMA_MODEL="$MODEL"
  export PROXY_PORT="$PORT"
  export OLLAMA_LOG="/tmp/claude-ollama-${PORT}.log"

  OLLAMA_MODEL="$MODEL" PROXY_PORT="$PORT" OLLAMA_LOG="$OLLAMA_LOG" \
    node "$REPO/ollama-proxy.mjs" &
  PROXY_PID=$!

  # Wait for proxy to be ready (up to 5s)
  for i in {1..10}; do
    curl -sf "http://localhost:$PORT" >/dev/null 2>&1 && break
    sleep 0.5
  done
}

run_with_tmux() {
  local session="claude-$$"
  local work_dir="$(pwd)"

  # Build the claude command; kill session when claude exits
  local claude_cmd="ANTHROPIC_BASE_URL=http://localhost:${PORT} node '${REPO}/cli.js'"
  if [[ $# -gt 0 ]]; then
    claude_cmd="${claude_cmd} $(printf '%q ' "$@")"
  fi
  claude_cmd="${claude_cmd}; tmux kill-session -t ${session} 2>/dev/null"

  tmux new-session -d -s "$session" -x "$(tput cols)" -y "$(tput lines)"

  # Status bar — reads the .status file every second, lives outside the pane
  tmux set-option -t "$session" status on
  tmux set-option -t "$session" status-interval 1
  tmux set-option -t "$session" status-position bottom
  tmux set-option -t "$session" status-style "bg=colour235,fg=colour242"
  tmux set-option -t "$session" status-left ""
  tmux set-option -t "$session" status-right \
    "#[fg=colour242] ◆ ${MODEL}  #[fg=colour82]#(cat '${OLLAMA_LOG}.status' 2>/dev/null || echo 'waiting...')  #[fg=colour238]│ Ctrl+B G: log "
  tmux set-option -t "$session" status-right-length 150

  # Ctrl+B G — floating popup with full scrollable log (q or Escape to close)
  tmux bind-key -T prefix g display-popup \
    -E -w 90% -h 80% \
    -b rounded -T " ollama log — ${MODEL} " \
    "tail -n 100 -f '${OLLAMA_LOG}'"

  # Launch claude in the single full-screen pane
  tmux send-keys -t "$session" "cd '${work_dir}' && ${claude_cmd}" ENTER

  tmux attach-session -t "$session"
}

run_without_tmux() {
  echo "Running Claude Code in: $(pwd)"
  echo "Backend: Ollama ($MODEL)"
  echo "(Install tmux for the live status bar)"
  echo "---"
  ANTHROPIC_BASE_URL="http://localhost:$PORT" node "$REPO/cli.js" "$@"
}

if [[ "$BACKEND" == "ollama" ]]; then
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
  die "Unknown backend '$BACKEND'. Use: ollama | anthropic"
fi
