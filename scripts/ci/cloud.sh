#!/usr/bin/env bash
# Each Cloud task gets its own checkout. Keep tool installs and caches local.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export CI=true
tools_dir="$PWD/.flows/cloud-tools"
export PATH="$tools_dir/bin:$PATH"

ensure_js() {
  local package_manager
  package_manager="$(node -p 'require("./package.json").packageManager')"
  if [[ ! "$package_manager" =~ ^pnpm@[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Expected an exact pnpm pin in package.json: $package_manager" >&2
    exit 1
  fi
  # Match ci.yml's certified npm, with a writable task-local global prefix.
  npm install --global --prefix "$tools_dir" npm@11.16.0 --ignore-scripts --no-audit --no-fund
  hash -r
  npm install --global --prefix "$tools_dir" "$package_manager" --ignore-scripts --no-audit --no-fund
  pnpm install --frozen-lockfile --ignore-scripts
}

apt_install() {
  local elevate=()
  if [ "$(id -u)" -ne 0 ]; then elevate=(sudo); fi
  "${elevate[@]}" apt-get update -qq
  "${elevate[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@"
}

download() {
  curl --proto '=https' --tlsv1.2 --retry 3 -fsSL "$1" -o "$2"
}

ensure_jj() {
  apt_install ca-certificates curl git xz-utils bubblewrap
  local arch
  case "$(uname -m)" in
    x86_64) arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo 'Unsupported Cloud CI architecture' >&2; exit 1 ;;
  esac
  mkdir -p "$tools_dir/bin"
  if ! command -v jj >/dev/null || [ "$(jj --version)" != 'jj 0.39.0' ]; then
    download "https://github.com/jj-vcs/jj/releases/download/v0.39.0/jj-v0.39.0-${arch}-unknown-linux-musl.tar.gz" "$tools_dir/jj.tar.gz"
    tar -xzf "$tools_dir/jj.tar.gz" -C "$tools_dir/bin" ./jj
  fi
  # rg's native implementation is exercised by the std conformance suite.
  if ! command -v rg >/dev/null || [[ "$(rg --version)" != 'ripgrep 14.1.1'* ]]; then
    local rg_target="${arch}-unknown-linux-gnu"
    if [ "$arch" = x86_64 ]; then rg_target=x86_64-unknown-linux-musl; fi
    download "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${rg_target}.tar.gz" "$tools_dir/rg.tar.gz"
    tar -xzf "$tools_dir/rg.tar.gz" -C "$tools_dir"
    ln -sf "$tools_dir/ripgrep-14.1.1-${rg_target}/rg" "$tools_dir/bin/rg"
  fi
  if [ ! -d .jj ]; then jj git init --colocate; fi
}

ensure_foundry() {
  local arch
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo 'Unsupported Foundry architecture' >&2; exit 1 ;;
  esac
  download "https://github.com/foundry-rs/foundry/releases/download/v1.8.1/foundry_v1.8.1_linux_${arch}.tar.gz" "$tools_dir/foundry.tar.gz"
  tar -xzf "$tools_dir/foundry.tar.gz" -C "$tools_dir/bin"
}

ensure_rust() {
  # The image has no Rust. Cargo metadata is also needed by the script suite.
  apt_install ca-certificates curl build-essential pkg-config libssl-dev
  export CARGO_HOME="$tools_dir/cargo" RUSTUP_HOME="$tools_dir/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
  if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    local arch
    case "$(uname -m)" in
      x86_64) arch=x86_64 ;;
      aarch64|arm64) arch=aarch64 ;;
      *) echo 'Unsupported Rust architecture' >&2; exit 1 ;;
    esac
    download "https://static.rust-lang.org/rustup/archive/1.28.2/${arch}-unknown-linux-gnu/rustup-init" "$tools_dir/rustup-init"
    chmod +x "$tools_dir/rustup-init"
    "$tools_dir/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
  fi
  # Reads the channel, components and wasm target from rust-toolchain.toml.
  rustup toolchain install
}

# Gate commands below are copied from .github/workflows/ci.yml. Remote cache
# credentials are optional for checks; no task receives publishing credentials.
# Docker integration cases retain their existing no-daemon skip behavior.
# Omitted: credentialed cache publishing/model reviews, the macOS/Windows
# matrix, and wasm byte reproducibility (requires its canonical x86_64 host).
case "${1:-}" in
  workspace)
    ensure_js
    ensure_jj
    ensure_foundry
    pnpm exec smthrs ci '//packages/...' --jobs 2 --verbose
    ;;
  examples)
    ensure_js
    ensure_jj
    pnpm exec smthrs ci '//examples/...' --verbose
    ;;
  scripts)
    ensure_js
    ensure_jj
    ensure_rust
    pnpm exec smthrs test '//scripts/...' --verbose
    ;;
  flows)
    ensure_js
    pnpm exec smthrs test '//flows:pack' --verbose
    ;;
  jsdoc)
    ensure_js
    pnpm exec smthrs lint '//:jsdocTree' --verbose
    ;;
  script-lint)
    ensure_js
    pnpm exec smthrs lint '//scripts:lint' --verbose
    ;;
  jsdoc-rules)
    ensure_js
    pnpm exec smthrs test '//:jsdocRules' --verbose
    ;;
  factory-harness)
    ensure_js
    ensure_jj
    pnpm exec smthrs test '//:factoryHarness' --verbose
    ;;
  agent-eval)
    ensure_js
    pnpm exec smthrs test '//evals/agent:test' --verbose
    ;;
  agent-check)
    ensure_js
    pnpm exec smthrs build '//evals/agent:check' --verbose
    ;;
  authoring-eval)
    ensure_js
    pnpm exec smthrs test '//evals/authoring:test' --verbose
    ;;
  authoring-check)
    ensure_js
    pnpm exec smthrs build '//evals/authoring:check' --verbose
    ;;
  swebench)
    ensure_js
    ensure_jj
    pnpm exec smthrs test '//evals/swebench:offline' --jobs 1 --verbose
    ;;
  swebench-check)
    ensure_js
    pnpm exec smthrs build '//evals/swebench:check' --verbose
    ;;
  server)
    ensure_js
    ensure_jj
    pnpm exec smthrs ci '//apps/server/...' --verbose
    ;;
  review-app)
    ensure_js
    pnpm exec smthrs ci '//apps/review/...' --verbose
    ;;
  bug-worker)
    ensure_js
    pnpm exec smthrs ci '//apps/bug-worker/...' --verbose
    ;;
  status-site)
    ensure_js
    pnpm exec smthrs ci '//apps/status-site/...' --verbose
    ;;
  project-copy)
    ensure_js
    pnpm exec smthrs lint '//:projectCopy' --verbose
    ;;
  site)
    ensure_js
    pnpm exec smthrs ci '//apps/site/...' --verbose
    ;;
  docs)
    ensure_js
    pnpm exec smthrs ci '//apps/docs/...' --verbose
    ;;
  review-eval)
    ensure_js
    pnpm exec smthrs test '//evals/review-seeded-bugs/...' --verbose
    ;;
  review-check)
    ensure_js
    pnpm exec smthrs build '//evals/review-seeded-bugs:check' --verbose
    ;;
  recommend-eval)
    ensure_js
    pnpm exec smthrs test '//evals/recommend/...' --verbose
    ;;
  recommend-check)
    ensure_js
    pnpm exec smthrs build '//evals/recommend:check' --verbose
    ;;
  workflow-drift)
    ensure_js
    pnpm exec smthrs lint '//:ci' --verbose
    ;;
  factory-drift)
    ensure_js
    pnpm exec smthrs lint '//:factoryProjection' --verbose
    ;;
  target-index)
    ensure_js
    pnpm exec smthrs lint '//:targetIndex' --verbose
    ;;
  ui-check)
    ensure_js
    ensure_jj
    pnpm exec smthrs build '//apps/app:check' --verbose
    ;;
  ui-tests)
    ensure_js
    ensure_jj
    pnpm exec smthrs test '//apps/app:unitTests' --verbose
    ;;
  ui-browser)
    ensure_js
    ensure_jj
    pnpm exec smthrs test '//apps/app:browserE2e' --verbose
    ;;
  rust-lint)
    ensure_js
    ensure_rust
    pnpm exec smthrs lint '//crates/flows-jj/...' --verbose
    ;;
  third-party-notices)
    ensure_js
    ensure_rust
    pnpm exec smthrs test '//scripts:thirdPartyNotices' --verbose
    ;;
  rust-test)
    ensure_js
    ensure_rust
    pnpm exec smthrs test '//crates/flows-jj:cargoTest' --verbose
    ;;
  wasm-build-script)
    ensure_js
    pnpm exec smthrs test '//crates/flows-jj:buildScript' --verbose
    ;;
  faults)
    ensure_js
    ensure_jj
    pnpm exec smthrs test '//packages/...:faults' --jobs 1 --verbose
    ;;
  web-bundle)
    ensure_js
    pnpm exec smthrs test '//scripts:webBundleContract' --verbose
    ;;
  packages)
    ensure_js
    ensure_jj
    ensure_foundry
    pnpm exec smthrs test '//packages/...' --jobs 2 --verbose
    ;;
  cloud-contract)
    ensure_js
    bun test scripts/ci/cloud.test.ts
    ;;
  *) echo "Unknown Cloud CI gate: ${1:-missing}" >&2; exit 2 ;;
esac
printf 'GATE-OK %s\n' "$1"
