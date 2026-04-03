#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCAL_NODE_MODULES_DIR="${DESKTOP_ROOT}/node_modules"
LOCAL_ELECTROBUN_PATH="${LOCAL_NODE_MODULES_DIR}/electrobun"
HOISTED_ELECTROBUN_PATH="${DESKTOP_ROOT}/../../node_modules/electrobun"

if [[ -f "${LOCAL_ELECTROBUN_PATH}/package.json" ]]; then
  exit 0
fi

if [[ ! -d "${HOISTED_ELECTROBUN_PATH}" ]]; then
  echo "Could not find hoisted electrobun dependency at: ${HOISTED_ELECTROBUN_PATH}" >&2
  echo "Run 'bun install' at repository root and retry." >&2
  exit 1
fi

mkdir -p "${LOCAL_NODE_MODULES_DIR}"

if [[ -e "${LOCAL_ELECTROBUN_PATH}" || -L "${LOCAL_ELECTROBUN_PATH}" ]]; then
  find "${LOCAL_ELECTROBUN_PATH}" -depth -delete
fi

if ln -s "../../../node_modules/electrobun" "${LOCAL_ELECTROBUN_PATH}" 2>/dev/null; then
  echo "[desktop] linked local electrobun dependency -> ../../../node_modules/electrobun"
  exit 0
fi

cp -R "${HOISTED_ELECTROBUN_PATH}" "${LOCAL_ELECTROBUN_PATH}"
echo "[desktop] copied hoisted electrobun dependency into apps/desktop/node_modules"
