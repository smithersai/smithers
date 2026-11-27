---
title: Smithers Cloud Coding Factory
tags: [factory, mcp, object-store, trust, uphill, mythical]
---

# Smithers Cloud Coding Factory

`smithersai/smithers` builds itself publicly on Smithers Cloud at `smithers.sh/smithersai/smithers`, mirroring continuously to GitHub.

## Shared Smithers Cloud Object Store

Every artifact, Lighthouse backpressure audit report, project wiki snapshot, mythical history record, changeset bundle, and trusted build cache object lives in one shared Cloudflare R2 + Postgres metadata store (`/api/repos/:owner/:repo/objects`).

- **Public reads on public repos**: Audit reports, wiki pages, mythical history, changeset stacks, and read-only build cache entries are open to contributors and viewers.
- **Private & ops isolation**: Private repositories and `smithersai/Smithers-Ops` remain strictly locked to authorized principals (`roninjin10` in person for ops).

## Execution Trust Model

Smithers encourages community contributors to run checks and submit results untrusted while preventing cache poisoning or gate bypass:

| Tier | Who | Shared Build Cache | Merge & Release Gates |
| --- | --- | --- | --- |
| `trusted_sandbox` | Controlled Cloudflare Sandbox (`GateMachine` / `BranchSandbox`) | Read + Write | Gate eligible |
| `trusted_maintainer` | Live repository Maintainer or Admin (`roninjin10`) | Read + Write | Gate eligible |
| `untrusted_contributor` | Non-maintainer contributors and community runners | Read only (Write refused 403) | Informational only (`untrusted/<login>/`) |

## Authenticated Cloud MCP & One-Time Sandbox Auth

Agents interact with Smithers through `https://smithers.sh/smithersai/smithers/mcp`:

- **Objects & Artifacts**: `artifact_list`, `artifact_get`, `artifact_put`
- **Public TODOs & Issues**: `todo_list`, `todo_draft`, `issues_list`, `issue_create`, `issue_comment`
- **Changeset Stacks & PRs**: `changeset_stack_list`, `changeset_create`, `pulls_list`, `pull_get`, `pull_files`
- **Wiki & Mythical History**: `wiki_list`, `wiki_read`, `wiki_write`, `mythical_history_list`, `mythical_history_record`
- **Backpressure Audits**: `audit_report_list`, `audit_report_get`, `audit_report_publish`
- **One-Time Sandbox Auth**: `auth_one_time_mint` and `POST /api/repos/:owner/:repo/auth/one-time` print single-use `smot_` tokens redeemed atomically once at `POST /api/auth/one-time/redeem`.

## Automatic Post-Merge Pipeline

Merging from Smithers Cloud to GitHub on `main` automatically dispatches trusted post-merge flows:

1. `backpressure-audit` — runs Uphill metrics and publishes a fresh trusted Lighthouse scorecard
2. `wiki-refresh` — syncs `.smithers/wiki/` into the shared Cloud Object Store and live wiki feed
3. `mythical-fold` — folds landed commits into the clean linear Mythical History verified tree-equal to `main`
4. `docs-publish` — builds and verifies documentation updates
5. `release` — runs release verification and package publication

See also [[start-here]], [[flows]], [[build-graph]], and [[wiki-generation]].
