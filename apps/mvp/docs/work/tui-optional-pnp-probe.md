---
title: Keep the optional Yarn PnP probe from blocking the CLI build
status: done
area: cli
owner: Codex
updated: 2026-11-11
links:
  - ../../../../packages/smithers/scripts/build-tui.mjs
---

The workspace remote loader introduced in c72e767d3179 reaches the declaration
loader, then tsx and esbuild. The TUI bundle now permits esbuild's guarded
CommonJS probe of Yarn's virtual module while rejecting every other undeclared
import, including the same specifier from application code.

Build tooling uses the existing esbuild and VibeLang integration; no dependency
is added.

Validation: the introducing commit's parent bundles successfully and that commit
fails on the probe. The real-entry regression fails before the fix; all six
bundler tests pass after it. The CLI build, type check, lint, circular check and
target index generation pass.
