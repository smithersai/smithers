#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TOOLS="$ROOT/.tools"
command -v node >/dev/null
command -v npm >/dev/null
mkdir -p "$TOOLS/npm" "$TOOLS/downloads" "$TOOLS/bin"
cp "$ROOT/toolchain-package.json" "$TOOLS/npm/package.json"
cp "$ROOT/toolchain-package-lock.json" "$TOOLS/npm/package-lock.json"
npm ci --prefix "$TOOLS/npm" --no-audit --no-fund
URL="https://github.com/dafny-lang/dafny/releases/download/v4.11.0/$ASSET"
bash "$ROOT/fetch.sh" "$URL" "$SHA256" "$TOOLS/downloads/$ASSET"
# Only replace our own install directory; no global changes.
rm -rf "$TOOLS/dafny"
unzip -q "$TOOLS/downloads/$ASSET" -d "$TOOLS"
chmod +x "$TOOLS/dafny/dafny"
ln -sfn ../dafny/dafny "$TOOLS/bin/dafny"
ln -sfn ../npm/node_modules/.bin/lsc "$TOOLS/bin/lsc"
if [[ $(uname -s) == Darwin ]]; then xattr -dr com.apple.quarantine "$TOOLS/dafny" 2>/dev/null || true; fi
node --version
npm --version
"$TOOLS/bin/lsc" version
"$TOOLS/bin/dafny" --version
