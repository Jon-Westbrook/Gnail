#!/bin/sh
if [ -n "$GOG_CALL_LOG" ]; then printf '%s\n' "$*" >> "$GOG_CALL_LOG"; fi
case "$*" in *"gmail thread modify"*) sleep "${GOG_MOCK_ACTION_DELAY:-0}" ;; esac
case "$*" in
  *"auth credentials list"*) printf '{"clients":[]}\n' ;;
  *"auth list"*) printf '{"accounts":[{"email":"test@example.test"}]}\n' ;;
  *"gmail labels list"*) if [ -n "$GOG_MOCK_AUTH_ERROR" ]; then printf 'invalid_grant: token expired or revoked\n' >&2; exit 1; else printf '{"labels":[]}\n'; fi ;;
  *"gmail settings filters list"*) printf '{"filters":[]}\n' ;;
  *"gmail search"*) printf '{"threads":[]}\n' ;;
  *) printf '{}\n' ;;
esac
