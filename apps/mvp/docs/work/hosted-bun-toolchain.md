---
title: Run Bun-based repository checks in a hosted sandbox
status: in-progress
area: ci
owner: codex
updated: 2026-11-27
links:
  - https://smithers.sh/smithersai/smithers-ci/actions/runs/audit%3A4a8315e6-6a8c-55a2-86e6-1a7621dde9b8
---

The Smithers CI audit checked out its pinned commit, then `bun install --frozen-lockfile` exited 127. The branch sandbox image omitted Bun. Pin the build sandbox’s Bun release for both supported CPU architectures, verify the normal workspace user can run a frozen install and package script, and rerun the real hosted audit.

On Linux amd64 and arm64 the candidate ran a local dependency with a nonempty frozen lockfile, verified its digest, and returned 5 from the package script. On the Mini the actual Smithers CI script ran from checkout 268dbdf0. Its trust and example-commit output needs a separate repository correction.

The complete real Docker egress/toolchain suite passed all seven cases on the candidate. Running that single file under the whole-app coverage configuration does not cover the rest of the app. Production verification remains pending.
