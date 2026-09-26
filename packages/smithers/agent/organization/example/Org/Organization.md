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
# Per repository: a prepared base (dependencies installed once per lockfile),
# the network builders and checks get (default none), and the checks every
# change runs. For a pnpm repository:
# repositories:
#   owner/name:
#     prepare:
#       run: npm install -g pnpm@11.25.0 && pnpm install --frozen-lockfile
#       key: [pnpm-lock.yaml, pnpm-workspace.yaml, package.json]
#       network: [registry.npmjs.org]
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
