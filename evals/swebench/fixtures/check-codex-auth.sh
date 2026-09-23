#!/bin/bash
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/chatgpt" "$TMP/key"
cat > "$TMP/bin/codex" <<'EOF'
#!/bin/sh
if [ "$1" = login ] && [ "$2" = status ]; then
  printf '%s\n' "$FAKE_CODEX_LOGIN_STATUS"
  exit 0
fi
exit 1
EOF
chmod +x "$TMP/bin/codex"
export PATH="$TMP/bin:$PATH"

SWB_CODEX_AUTH=chatgpt SWB_CODEX_HOME="$TMP/chatgpt" \
  FAKE_CODEX_LOGIN_STATUS='Logged in using ChatGPT' \
  bash -c 'set -e; S="$1"; source "$S/lib/codex-auth.sh"; swb_codex_auth; test "$CODEX_HOME" = "$2"' \
  _ "$S" "$TMP/chatgpt"

if SWB_CODEX_AUTH=chatgpt SWB_CODEX_HOME="$TMP/key" \
  FAKE_CODEX_LOGIN_STATUS='Logged in using an API key' \
  bash -c 'set -e; S="$1"; source "$S/lib/codex-auth.sh"; swb_codex_auth' _ "$S"; then
  echo 'chatgpt mode accepted API-key auth' >&2
  exit 1
fi
echo 'check-codex-auth.sh: ChatGPT auth selected; API-key login rejected.'
