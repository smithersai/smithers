---
title: CI parity: path filters
status: todo
area: sdk
owner: none
updated: 2026-10-20 22:50 PDT
links: [../proposals/ci-cd-parity.md, ci-parity-triggers.md]
---

## What

`paths` and `pathsIgnore` on a trigger.

## Why

Smithers' `native-windows.yml` starts only when certain files change.

## Repositories

Smithers.

## Smallest slice

Match globs against the files a push's commits name, or the compare API for a pull request (`worker/github/Compare.ts`). Renames match both paths. When the diff can't be read, the flow runs.

## Disposition

Build now, 17 of 18. Matrix row 9. Design: [the CI/CD parity proposal](../proposals/ci-cd-parity.md).

## History

2026-10-20 22:50 PDT: written by the Claude Opus merger from the merged CI/CD parity proposal (Opus and Codex Sol designs, ruling FLOW-8).
