---
title: Recover route imports across a release
status: done
area: pwa
owner: codex-artifact-repair
updated: 2026-11-27
links: []
---

A two-release Chromium test removes an uncached route module. TanStack’s default import-error reload discarded the earlier Vite event before the new worker activated. The route now shows Retry. The shell remembers recent online delivery failures, waits for activation and checks editor writes and unsaved inputs before reloading. The production reports did not retain their exception or failed asset.
