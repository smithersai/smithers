#!/usr/bin/env bash
if [[ -f ~/lanes/env.sh ]]; then source ~/lanes/env.sh >/dev/null 2>&1; fi
set -euo pipefail
case "$(uname -sm)" in
  'Linux x86_64')
    ASSET=dafny-4.11.0-x64-ubuntu-22.04.zip
    SHA256=a46a9ff7cdd720f7955854c78e95df13f4cfe6b80691b05f8654fe19e8267179 ;;
  'Darwin arm64')
    ASSET=dafny-4.11.0-arm64-macos-13.zip
    SHA256=c90c75e7d5db9c6ccbb7127840dfe43f0ac938b039a7ebed146d8ead383a572f ;;
  *) echo 'Supported: Linux x86_64 and macOS Apple Silicon' >&2; exit 1 ;;
esac
source "$(cd -- "$(dirname -- "$0")" && pwd)/install-common.sh"
