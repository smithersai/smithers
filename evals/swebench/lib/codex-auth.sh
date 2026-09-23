#!/bin/bash
# Select and verify the Codex login before a benchmark starts a container.
# Subscription runs use the operator's signed-in home unless SWB_CODEX_HOME
# names another signed-in seat. API-key runs retain the rig's isolated home.
swb_codex_auth() {
  local mode="${SWB_CODEX_AUTH:-api-key}"
  local login
  case "$mode" in
    chatgpt)
      CODEX_HOME="${SWB_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
      if [ ! -d "$CODEX_HOME" ]; then
        echo "codex auth: missing ChatGPT home at $CODEX_HOME" >&2
        return 1
      fi
      login="$(CODEX_HOME="$CODEX_HOME" codex login status 2>&1)" || {
        echo "codex auth: login status failed for $CODEX_HOME" >&2
        return 1
      }
      if [ "$login" != 'Logged in using ChatGPT' ]; then
        echo "codex auth: $CODEX_HOME is not logged in using ChatGPT" >&2
        return 1
      fi
      ;;
    api-key)
      CODEX_HOME="${SWB_CODEX_HOME:-$S/.codex-home}"
      mkdir -p "$CODEX_HOME"
      login="$(CODEX_HOME="$CODEX_HOME" codex login status 2>&1)" || login=''
      if [ "$login" != 'Logged in using an API key' ]; then
        if [ -z "${OPENAI_API_KEY:-}" ]; then
          echo "codex auth: no API-key login at $CODEX_HOME" >&2
          return 1
        fi
        printenv OPENAI_API_KEY | CODEX_HOME="$CODEX_HOME" codex login --with-api-key >/dev/null 2>&1 || {
          echo "codex auth: API-key login failed" >&2
          return 1
        }
        login="$(CODEX_HOME="$CODEX_HOME" codex login status 2>&1)" || login=''
        if [ "$login" != 'Logged in using an API key' ]; then
          echo "codex auth: API-key login not verified" >&2
          return 1
        fi
      fi
      ;;
    *)
      echo "codex auth: SWB_CODEX_AUTH must be api-key or chatgpt, got '$mode'" >&2
      return 2
      ;;
  esac
  export CODEX_HOME
  echo "codex auth: $mode login verified at $CODEX_HOME"
}
