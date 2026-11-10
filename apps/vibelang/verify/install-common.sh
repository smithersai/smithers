#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TOOLS="$ROOT/.tools"
command -v node >/dev/null
command -v pnpm >/dev/null
mkdir -p "$TOOLS/downloads" "$TOOLS/bin"
# LemmaScript is the workspace package @smthrs/lemmascript (decision 0018).
LEMMASCRIPT=$(cd -- "$ROOT/../../../packages/lemmascript" && pwd)
pnpm --dir "$LEMMASCRIPT" run build
URL="https://github.com/dafny-lang/dafny/releases/download/v4.11.0/$ASSET"
bash "$ROOT/fetch.sh" "$URL" "$SHA256" "$TOOLS/downloads/$ASSET"
# Only replace our own install directory; no global changes.
rm -rf "$TOOLS/dafny"
unzip -q "$TOOLS/downloads/$ASSET" -d "$TOOLS"
chmod +x "$TOOLS/dafny/dafny"
ln -sfn ../dafny/dafny "$TOOLS/bin/dafny"
# A relative link: a packed tree (run-heavy on a box) keeps it a link (lsc_fresh.py repairs a copied one).
python3 "$ROOT/lsc_fresh.py"
if [[ $(uname -s) == Darwin ]]; then xattr -dr com.apple.quarantine "$TOOLS/dafny" 2>/dev/null || true; fi
node --version
"$TOOLS/bin/lsc" version
"$TOOLS/bin/dafny" --version
