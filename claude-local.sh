#!/usr/bin/env bash
# claude-local.sh — start Claude Code with local/cloud models from any directory
#
# Usage:
#   claude-local.sh [options] [-- claude-args...]
#
# Options:
#   -b, --backend BACKEND      smart | ollama | anthropic  (default: smart)
#   -p, --port PORT            Proxy port                  (default: 9090)
#   -m, --model MODEL          Ollama model (only for --backend ollama)
#   --start-mlx MODEL          Start mlx_lm.server with MODEL before launching
#   --start-llamacpp PATH      Start llama-server with model at PATH[:GPU_LAYERS]
#   --start-ollama             Ensure ollama serve is running
#   --open-lmstudio            Open LM Studio app (auto-starts API on :1234)
#   --open-jan                 Open Jan app (auto-starts API on :1337)
#   --keep-servers             Keep inference servers running after Claude exits
#   -l, --list                 List available Ollama models and exit
#   -h, --help                 Show this help
#
# Backends:
#   smart      Auto-discovers all running local engines, routes by tier.
#              Set OPENROUTER_API_KEY for cloud fallback.
#              Tier overrides: TINY_MODEL, FAST_MODEL, BALANCED_MODEL,
#              POWERFUL_MODEL, REASONING_MODEL (format: "provider:id" or bare "id")
#   ollama     Single-model Ollama proxy (legacy)
#   anthropic  Pass-through to Anthropic API (needs ANTHROPIC_API_KEY)
#
# Key bindings (tmux):
#   Ctrl+B G   Toggle proxy log pane
#
# Examples:
#   claude-local.sh                    # open interactive launcher UI (default)
#   claude-local.sh --no-ui            # skip UI, launch smart backend directly
#   claude-local.sh --start-mlx mlx-community/Qwen2.5-Coder-7B-Instruct-8bit
#   claude-local.sh --start-llamacpp ~/models/qwen.gguf:30 --start-ollama
#   claude-local.sh --open-lmstudio --open-jan --keep-servers
#   claude-local.sh -b ollama -m qwen3:30b
#   claude-local.sh -b anthropic

# Resolve through symlinks so REPO always points to the actual script directory
_SCRIPT="${BASH_SOURCE[0]}"
while [[ -L "$_SCRIPT" ]]; do _SCRIPT="$(readlink "$_SCRIPT")"; done
REPO="$(cd "$(dirname "$_SCRIPT")" && pwd)"
NO_UI=0
BACKEND="smart"
MODEL="qwen3-coder:30b"
PORT=9090
PROXY_PID=""

# Inference server lifecycle
SERVER_PIDS=()
KEEP_SERVERS=0
START_MLX=""
START_LLAMA=""
ENSURE_OLLAMA=0
OPEN_LMSTUDIO=0
OPEN_JAN=0

# Ports (can be overridden by env, must match smart-proxy.mjs defaults)
MLX_PORT="${MLX_HOST##*:}"
MLX_PORT="${MLX_PORT:-8080}"
LLAMA_PORT="${LLAMACPP_HOST##*:}"
LLAMA_PORT="${LLAMA_PORT:-8082}"

usage() {
  sed -n '/^# Usage/,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
}

die() { echo "Error: $1" >&2; exit 1; }

# ── Cleanup ───────────────────────────────────────────────────────────────────

cleanup() {
  if [[ -n "$PROXY_PID" ]]; then
    kill "$PROXY_PID" 2>/dev/null
    wait "$PROXY_PID" 2>/dev/null
  fi
  if [[ $KEEP_SERVERS -eq 0 && ${#SERVER_PIDS[@]} -gt 0 ]]; then
    echo "Stopping inference servers..."
    for pid in "${SERVER_PIDS[@]}"; do
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
    done
  elif [[ $KEEP_SERVERS -eq 1 && ${#SERVER_PIDS[@]} -gt 0 ]]; then
    echo "Inference servers kept running (PIDs: ${SERVER_PIDS[*]})"
  fi
}
trap cleanup EXIT INT TERM

# ── Arg parsing ───────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    -m|--model)         MODEL="$2";        shift 2;;
    -p|--port)          PORT="$2";         shift 2;;
    -b|--backend)       BACKEND="$2";      shift 2;;
    --start-mlx)        START_MLX="$2";    shift 2;;
    --start-llamacpp)   START_LLAMA="$2";  shift 2;;
    --start-ollama)     ENSURE_OLLAMA=1;   shift;;
    --open-lmstudio)    OPEN_LMSTUDIO=1;   shift;;
    --open-jan)         OPEN_JAN=1;        shift;;
    --keep-servers)     KEEP_SERVERS=1;    shift;;
    --no-ui)            NO_UI=1;           shift;;
    -l|--list)          ollama list;       exit 0;;
    -h|--help)          usage;;
    --)                 shift;             break;;
    *)                  break;;
  esac
done

# ── Inference server helpers ──────────────────────────────────────────────────

# Wait for an HTTP endpoint to become ready, printing progress every 5s.
# Usage: wait_for_url URL LABEL [TIMEOUT_SECS]
wait_for_url() {
  local url="$1" label="$2" max="${3:-90}"
  local i=0
  printf "  Waiting for %s" "$label"
  while ! curl -sf "$url" >/dev/null 2>&1; do
    sleep 1
    i=$((i + 1))
    [[ $((i % 5)) -eq 0 ]] && printf " %ds..." "$i"
    if [[ $i -ge $max ]]; then
      echo " TIMED OUT after ${max}s"
      return 1
    fi
  done
  echo " ready (${i}s)"
  return 0
}

# Start mlx_lm.server. MODEL is a HuggingFace repo like
# "mlx-community/Qwen2.5-Coder-7B-Instruct-8bit".
# First run downloads the model (~minutes); subsequent runs load in seconds.
start_mlx() {
  local model="$1"
  local port="${MLX_PORT:-8080}"

  if ! command -v mlx_lm.server &>/dev/null; then
    echo "  ✗ mlx_lm not found — install with: pip install mlx-lm" >&2
    return 1
  fi

  # Check if something is already listening on the port
  if curl -sf "http://localhost:$port/v1/models" >/dev/null 2>&1; then
    echo "  MLX: port $port already in use, skipping start"
    return 0
  fi

  echo "  Starting MLX server: $model on :$port"
  echo "  (First run downloads the model from HuggingFace — may take a few minutes)"
  mlx_lm.server --model "$model" --port "$port" \
    >"$TMPDIR/claude-mlx.log" 2>&1 &
  local pid=$!
  SERVER_PIDS+=("$pid")

  wait_for_url "http://localhost:$port/v1/models" "MLX [:$port]" 180 \
    || echo "  Warning: MLX may still be loading — check /tmp/claude-mlx.log"
}

# Start llama-server (brew install llama.cpp).
# SPEC format: "/path/to/model.gguf" or "/path/to/model.gguf:N" where N is GPU layers.
# GPU_LAYERS=0 → CPU only; GPU_LAYERS=-1 → all layers on GPU.
start_llamacpp() {
  local spec="$1"
  local port="${LLAMA_PORT:-8082}"

  if ! command -v llama-server &>/dev/null; then
    echo "  ✗ llama-server not found — install with: brew install llama.cpp" >&2
    return 1
  fi

  # Split path and optional :LAYERS suffix
  local model_path gpu_layers=0
  if [[ "$spec" =~ ^(.+):(-?[0-9]+)$ ]]; then
    model_path="${BASH_REMATCH[1]}"
    gpu_layers="${BASH_REMATCH[2]}"
  else
    model_path="$spec"
  fi
  model_path="${model_path/#\~/$HOME}"  # expand leading ~

  [[ -f "$model_path" ]] || { echo "  ✗ Model not found: $model_path" >&2; return 1; }

  # Check if something is already listening
  if curl -sf "http://localhost:$port/v1/models" >/dev/null 2>&1; then
    echo "  llama.cpp: port $port already in use, skipping start"
    return 0
  fi

  echo "  Starting llama.cpp: $(basename "$model_path") on :$port (GPU layers: $gpu_layers)"
  llama-server \
    --model "$model_path" \
    --port  "$port" \
    --n-gpu-layers "$gpu_layers" \
    --ctx-size "${LLAMA_CTX:-8192}" \
    >"$TMPDIR/claude-llamacpp.log" 2>&1 &
  local pid=$!
  SERVER_PIDS+=("$pid")

  wait_for_url "http://localhost:$port/v1/models" "llama.cpp [:$port]" 120 \
    || echo "  Warning: llama.cpp may still be loading — check $TMPDIR/claude-llamacpp.log"
}

# Ensure ollama serve is running (starts it if not).
ensure_ollama() {
  if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "  Ollama already running"
    return 0
  fi
  if ! command -v ollama &>/dev/null; then
    echo "  ✗ ollama not found — install from https://ollama.com" >&2
    return 1
  fi
  echo "  Starting Ollama..."
  OLLAMA_ORIGINS='*' ollama serve >"$TMPDIR/claude-ollama-serve.log" 2>&1 &
  SERVER_PIDS+=("$!")
  wait_for_url "http://localhost:11434/api/tags" "Ollama [:11434]" 30
}

# Open a macOS app by name. Silently skips on non-Darwin.
open_mac_app() {
  local app="$1" port="$2" name="$3"
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "  $name: --open-* flags are macOS only" >&2
    return 1
  fi
  if curl -sf "http://localhost:$port/v1/models" >/dev/null 2>&1; then
    echo "  $name: already running on :$port"
    return 0
  fi
  echo "  Opening $name..."
  if ! open -a "$app" 2>/dev/null; then
    echo "  ✗ $app not found in Applications" >&2
    return 1
  fi
  wait_for_url "http://localhost:$port/v1/models" "$name [:$port]" 30 \
    || echo "  Note: $name may need a model loaded before its API responds"
}

# ── Start all requested inference servers ─────────────────────────────────────
# Called before the proxy so discovery can find freshly started engines.

start_inference_servers() {
  local any=0
  [[ $ENSURE_OLLAMA -eq 1 ]] && { ensure_ollama; any=1; } || true

  # If the smart backend already needs Ollama and --start-ollama wasn't passed,
  # do a passive check to surface whether Ollama is running.
  [[ $ENSURE_OLLAMA -eq 0 ]] && ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 \
    && echo "  Note: Ollama not running (add --start-ollama to auto-start it)" || true

  if [[ -n "$START_MLX" ]];   then start_mlx     "$START_MLX";   any=1; fi
  if [[ -n "$START_LLAMA" ]]; then start_llamacpp "$START_LLAMA"; any=1; fi
  if [[ $OPEN_LMSTUDIO -eq 1 ]]; then open_mac_app "LM Studio" 1234 "LM Studio"; any=1; fi
  if [[ $OPEN_JAN -eq 1 ]];      then open_mac_app "Jan"        1337 "Jan";       any=1; fi

  [[ $any -eq 1 ]] && echo ""  # blank line before proxy startup
}

# ── Smart backend ─────────────────────────────────────────────────────────────

start_smart_backend() {
  lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true

  export PROXY_PORT="$PORT"
  export PROXY_LOG="/tmp/claude-smart-${PORT}.log"

  node "$REPO/smart-proxy.mjs" >/dev/null 2>&1 &
  PROXY_PID=$!

  for i in {1..10}; do
    curl -sf "http://localhost:$PORT/proxy/status" >/dev/null 2>&1 && break
    sleep 0.5
  done

  LOG_FILE="$PROXY_LOG"
  LABEL="smart-proxy"
}

# ── Ollama backend (single-model, legacy) ─────────────────────────────────────

start_ollama_backend() {
  if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    die "Ollama is not running. Start it with: ollama serve  (or add --start-ollama)"
  fi

  if ! ollama list 2>/dev/null | grep -q "^${MODEL}"; then
    echo "Model '$MODEL' not found locally."
    read -rp "Pull it now? [y/N] " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || die "Aborted. Run: ollama pull $MODEL"
    ollama pull "$MODEL" || die "Failed to pull $MODEL"
  fi

  lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true

  export OLLAMA_MODEL="$MODEL"
  export PROXY_PORT="$PORT"
  export OLLAMA_LOG="/tmp/claude-ollama-${PORT}.log"

  OLLAMA_MODEL="$MODEL" PROXY_PORT="$PORT" OLLAMA_LOG="$OLLAMA_LOG" \
    node "$REPO/ollama-proxy.mjs" >/dev/null 2>&1 &
  PROXY_PID=$!

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

# When no flags were passed that bypass the UI, and no-ui flag not set,
# launch the interactive launcher instead of starting directly.
needs_ui() {
  [[ $NO_UI -eq 0 ]] \
    && [[ -z "$START_MLX" ]] \
    && [[ -z "$START_LLAMA" ]] \
    && [[ $ENSURE_OLLAMA -eq 0 ]] \
    && [[ $OPEN_LMSTUDIO -eq 0 ]] \
    && [[ $OPEN_JAN -eq 0 ]]
}

if [[ "$BACKEND" == "smart" ]] && needs_ui; then
  # Launch the interactive TUI launcher — it handles everything from here
  exec node "$REPO/launch.mjs"
fi

if [[ "$BACKEND" == "smart" ]]; then
  start_inference_servers
  start_smart_backend

  if command -v tmux &>/dev/null; then
    run_with_tmux "$@"
  else
    run_without_tmux "$@"
  fi

elif [[ "$BACKEND" == "ollama" ]]; then
  [[ $ENSURE_OLLAMA -eq 1 ]] && ensure_ollama
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
