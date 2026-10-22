#!/bin/sh
if [ -n "$GOG_CALL_LOG" ]; then printf '%s\n' "$*" >> "$GOG_CALL_LOG"; fi
case "$*" in *"gmail thread modify"*) sleep "${GOG_MOCK_ACTION_DELAY:-0}" ;; esac
case "$*" in
  *"auth credentials list"*) printf '{"clients":[]}\n' ;;
  *"auth list"*) printf '{"accounts":[]}\n' ;;
  *"gmail labels list"*) printf '{"labels":[]}\n' ;;
  *"gmail settings filters list"*) printf '{"filters":[]}\n' ;;
  *"gmail search"*) printf '{"threads":[]}\n' ;;
  *) printf '{}\n' ;;
esac
