---
owner: owner
assistant: assistant
rosterDir: Org
skillsDir: Org/Skills
casesDir: Org/Cases
policyFile: Org/Policy/Gates.md
connectionsFile: Org/Connections.md
meetingsFile: Org/Meetings.md
seats:
  default: openai:gpt-6-sol
  light: openai:gpt-6-luna
judge: none
vm:
  provider: microsandbox
  image: node:26-bookworm
  cpus: 4              # per VM; sized for a 14-core, 64 GiB Mac
  memoryMib: 8192
  diskMib: 32768       # sparse root disk of image-booted VMs
  maxConcurrentVMs: 2  # a builder and its check VM; raise for parallel tasks
# Per repository: the ref tasks start from (default the checkout's HEAD; a
# remote branch is fetched first), a prepared base (dependencies and pinned,
# checksummed tools installed once per lockfile; a base missing a listed tool
# is not captured), the network builders and checks get (default none), and
# the checks every change runs. For a pnpm repository on an Apple silicon host:
# repositories:
#   owner/name:
#     base: origin/main
#     prepare:
#       run: >-
#         npm install -g pnpm@11.25.0 && pnpm install --frozen-lockfile &&
#         curl -fsSL -o /tmp/rg.tgz https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz &&
#         echo "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f  /tmp/rg.tgz" | sha256sum -c - &&
#         tar -xzf /tmp/rg.tgz -C /usr/local/bin --strip-components=1 ripgrep-14.1.1-aarch64-unknown-linux-gnu/rg &&
#         curl -fsSL -o /tmp/fd.tgz https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-aarch64-unknown-linux-musl.tar.gz &&
#         echo "4e8e596646d047d904f2c5ca74b39dccc69978b6e1fb101094e534b0b59c1bb0  /tmp/fd.tgz" | sha256sum -c - &&
#         tar -xzf /tmp/fd.tgz -C /usr/local/bin --strip-components=1 fd-v10.2.0-aarch64-unknown-linux-musl/fd &&
#         curl -fsSL -o /usr/local/bin/jq https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-arm64 &&
#         echo "4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5  /usr/local/bin/jq" | sha256sum -c - &&
#         chmod +x /usr/local/bin/jq && rm /tmp/rg.tgz /tmp/fd.tgz
#       key: [pnpm-lock.yaml, pnpm-workspace.yaml, package.json]
#       network: [registry.npmjs.org, github.com, "*.githubusercontent.com"]
#       tools: [git, node, pnpm, rg, fd, jq]
#     network: none
#     checks:
#       - name: changed packages
#         run: CI=1 pnpm --filter '[HEAD]' run test
wiki:
  generatedDir: Org/Runs
  statusFile: Org/Status.md
  commit: false
  push: false
---

# Example organization

A four-role example used by tests and documentation. A real installation keeps its
own roster, skills, policies and connections in its private repository.
