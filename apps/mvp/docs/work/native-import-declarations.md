---
title: Native import declaration paths
status: done
area: app
owner: Codex
updated: 2026-11-08
links: [../infrastructure.md, vibelang-package-migration.md]
---

The private native import aliases in `package.json` expose the declarations produced by each source project. Frontend declarations use the configured declaration directory. Worker declarations use the compiler's default adjacent `*.d.vibe.ts` files.

Worker aliases previously named files beneath the frontend declaration directory. Ordinary TypeScript resolution then fell through to JavaScript and treated those imports as untyped. The aliases now name the Worker declarations, so the app's frontend, Worker, infrastructure, and evaluation typechecks resolve the same types.

`tests/native-aliases.test.ts` checks every Worker declaration target and exercises TypeScript resolution across frontend, Worker, infrastructure, evaluation, and benchmark callers, TypeScript file extensions, and runtime conditions. The regression fails with the previous targets and passes with the corrected targets.

