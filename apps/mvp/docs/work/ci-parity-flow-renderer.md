---
title: CI parity: render flows from target declarations
status: idea
area: sdk
owner: none
updated: 2026-10-20 22:50 PDT
links: [../proposals/ci-cd-parity.md, ../../../../packages/smithers/build/targets/docs/rules.md]
---

## What

Write `.smithers/flows/<name>/flow.ts` from the same declarations that render GitHub workflows today.

## Why

Smithers renders `ci.yml` and `drift.yml` from `Smithers.GithubCiGen` (`PACKAGE.ts:553-660`), and Tevm renders ten workflows from `S.Github.Workflow` (`tevm-monorepo/.github/PACKAGE.ts:1-202`). A flow renderer would keep one declaration during migration. Hand-written flows reach parity without it.

## Repositories

Smithers, Tevm.

## Smallest slice

A `Smithers.FlowCiGen` target that renders one `flow.ts` per declared workflow, drift-checked like the YAML.

## Disposition

Ticket only (Will, FLOW-8: advanced features are ticketed, not built now). Matrix row 52. Design: [the CI/CD parity proposal](../proposals/ci-cd-parity.md).

## History

2026-10-20 22:50 PDT: written by the Claude Opus merger from the merged CI/CD parity proposal (Opus and Codex Sol designs, ruling FLOW-8).
