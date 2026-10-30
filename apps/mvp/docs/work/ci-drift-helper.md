---
title: Install Drift's native filesystem helper
status: done
area: ci
owner: codex-drift-helper
updated: 2026-10-30
links:
  - ../decisions/0127-drift-runs-unprivileged.md
  - https://github.com/smithersai/smithers/actions/runs/41088938023
---

Run 41088938023 reaches all nine gates, but docsDrift refuses to load docs-sync
without smithers-jj-export. Use the library catalog's @smthrs/targets
GithubCiGen and CiToolchain cargoBinaries declaration already used by CI.
The helper builds and installs as the runner user, without secrets or root;
contents: read and persist-credentials: false remain required by decision 0127.

The generated helper step is the setup sentinel. Gates require its success,
including successful dependency installation before it. The contract rejects
a missing helper, changed CI command, misplaced step or bypassed sentinel.
Workflow regeneration uses generate-ci.mjs with the optional //:driftCi label.

Latitude reproduced the missing-helper refusal with no packaged, checkout or
global helper available, then built and installed it with the generated Bash
command and applied GITHUB_ENV. All nine exact workflow commands passed as
UID 1001 with a disposable HOME, the workflow's pinned Node/pnpm/npm/Bun, and
failing sudo, apt-get, sysctl and bwrap shims. No known-red entries changed.

The full targets suite passed 2,824 tests in 131 files, including all 115
GithubCiGen cases, with three existing skips and all coverage floors met.
The driftJob contract passed 11 tests with its existing live-GitHub skip;
its missing-helper regression failed against the old workflow before generation.
The strict //:driftCi and //:ci lint passed, and one read-only Codex Sol review
returned no findings.
These are command and contract receipts, not a hosted 20-minute wall-time receipt.
