#!/usr/bin/env bash
# Compact Ollama status bar — runs in a tmux split pane
# Shows 1-line rolling stats; full log in expanded mode

STATUS_FILE="${OLLAMA_LOG:-/tmp/claude-ollama.log}.status"
LOG_FILE="${OLLAMA_LOG:-/tmp/claude-ollama.log}"
MODEL="${OLLAMA_MODEL:-qwen3-coder:30b}"

# Colour codes
GRAY='\033[90m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RESET='\033[0m'

if [[ "${1}" == "--full" ]]; then
  # Full log mode (expanded pane)
  echo -e "${GRAY}━━━ ollama log ━━━ ${CYAN}${MODEL}${GRAY} ━━━ Ctrl+B G to collapse ━━━${RESET}"
  tail -f "$LOG_FILE" 2>/dev/null | while IFS= read -r line; do
    if [[ "$line" == *"←"* ]]; then
      echo -e "${GREEN}${line}${RESET}"
    elif [[ "$line" == *"error"* || "$line" == *"Error"* ]]; then
      echo -e "${YELLOW}${line}${RESET}"
    else
      echo -e "${GRAY}${line}${RESET}"
    fi
  done
else
  # Compact 1-line mode
  while true; do
    if [[ -f "$STATUS_FILE" ]]; then
      status=$(cat "$STATUS_FILE" 2>/dev/null)
    else
      status="waiting for first request..."
    fi
    cols=$(tput cols 2>/dev/null || echo 80)
    label=" ◆ ${MODEL}  "
    hint="  Ctrl+B G to expand"
    middle="${status}"
    # Truncate middle if too long
    max=$(( cols - ${#label} - ${#hint} - 2 ))
    if [[ ${#middle} -gt $max ]]; then
      middle="${middle:0:$max}"
    fi
    pad=$(( cols - ${#label} - ${#middle} - ${#hint} ))
    printf '\r\033[2K'"${GRAY}${label}${RESET}${GREEN}${middle}${RESET}%${pad}s${GRAY}${hint}${RESET}" ''
    sleep 0.5
  done
fi
