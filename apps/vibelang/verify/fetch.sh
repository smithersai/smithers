#!/usr/bin/env bash
# Fetch a pinned release archive to DEST. A copy in the host's shared cache is reused when its SHA-256 matches;
# otherwise the archive is downloaded, with retries and exponential backoff, verified, then cached for other installs.
# Usage: fetch.sh URL SHA256 DEST
#   VIBELANG_VERIFY_CACHE           shared cache directory (default: ${XDG_CACHE_HOME:-$HOME/.cache}/vibelang-verify)
#   VIBELANG_VERIFY_FETCH_ATTEMPTS  downloads to try (default 6)
#   VIBELANG_VERIFY_FETCH_BACKOFF   seconds before the second try, doubled after each failure (default 2)
set -euo pipefail
URL=$1
SHA256=$2
DEST=$3
CACHE=${VIBELANG_VERIFY_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/vibelang-verify}
ATTEMPTS=${VIBELANG_VERIFY_FETCH_ATTEMPTS:-6}
BACKOFF=${VIBELANG_VERIFY_FETCH_BACKOFF:-2}
CACHED="$CACHE/$SHA256-$(basename -- "$DEST")"

sha256() {
  python3 - "$1" <<'PY'
import hashlib, sys
h = hashlib.sha256()
with open(sys.argv[1], 'rb') as f:
    for block in iter(lambda: f.read(1048576), b''): h.update(block)
print(h.hexdigest())
PY
}
# Copy through a temporary name in the destination's directory, so DEST is never a partial file.
deliver() {
  mkdir -p "$(dirname -- "$DEST")"
  cp "$CACHED" "$DEST.partial.$$"
  mv -f "$DEST.partial.$$" "$DEST"
}

mkdir -p "$CACHE"
if [[ -f $CACHED ]]; then
  if [[ $(sha256 "$CACHED") == "$SHA256" ]]; then
    deliver
    echo "Archive SHA256 verified from cache: $SHA256"
    exit 0
  fi
  echo "Cached archive has the wrong SHA256; downloading it again" >&2
  rm -f "$CACHED"
fi

# Download beside the cache entry; only a verified archive is renamed into place, so concurrent installs never read a
# partial or unverified file.
PARTIAL=$(mktemp "$CACHE/.download.XXXXXX")
trap 'rm -f "$PARTIAL"' EXIT
delay=$BACKOFF
for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  if curl --fail --location --silent --show-error "$URL" -o "$PARTIAL"; then
    actual=$(sha256 "$PARTIAL")
    if [[ $actual == "$SHA256" ]]; then
      chmod 0644 "$PARTIAL"
      mv -f "$PARTIAL" "$CACHED"
      deliver
      echo "Archive SHA256 verified: $actual"
      exit 0
    fi
    echo "Download $attempt of $ATTEMPTS has the wrong SHA256: $actual" >&2
  else
    echo "Download $attempt of $ATTEMPTS failed" >&2
  fi
  if ((attempt < ATTEMPTS)); then
    sleep "$delay"
    delay=$((delay * 2))
  fi
done
echo "Could not download $URL after $ATTEMPTS attempts" >&2
exit 1
