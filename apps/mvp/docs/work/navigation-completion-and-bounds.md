---
title: Navigation completion and call bounds
status: done
area: navigation
owner: codex
updated: 2026-10-21
links: []
---

Reproduce asynchronous router completion/failure and the GoCall path bound. Use the existing @smthrs/flow and @smthrs/platform-browser catalog entries; no new library.

Validation on Latitude: `pnpm test src/features/navigation/navigation.test.ts --coverage.enabled=false` reproduced three regression failures with 15 existing tests passing, then all 18 passed after the fix. Repeating with `--coverage.include=src/features/navigation/*.ts` measured 100% statements, branches, functions and lines across navigation logic. The tests exercise the real engine, tab channel and device; router rejection retains the existing failure log and counter.

Mac mini: `pnpm e2e navigate.spec.ts` recorded two passes (slash-command and hover navigation) and two failures (agent cases showed “Couldn't answer”). Browser validation is not green. A duplicate run was cancelled while queued and executed no tests.
