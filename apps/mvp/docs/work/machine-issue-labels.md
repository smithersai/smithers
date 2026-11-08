---
title: Ensure machine issue labels before creation
status: done
area: github
owner: codex-labels
updated: 2026-11-03
links:
  - ../features/machine-tokens.md
---

Create missing repository labels through MachineWrite's existing GitHub seam,
one mutation per dispatcher tick, before creating the issue. Retain string
labels and add validated metadata. This extends the existing core write
admission and dispatcher, not a new plugin feature.

Library catalog: @smthrs/integrations for GitHub and @smthrs/flow for durable
execution. The existing direct call seam retains GitHub's complete rate-limit
headers and shared User-Agent; no new client or retry loop is introduced.

Validation on cfbox's pg image:
- Tests first: 8 new failures, 128 existing passes.
- Final focused suite: 141 passed across 6 files, coverage disabled as requested.
- App, worker, infrastructure and eval typechecks passed.
- Cases cover missing/existing labels, User-Agent, 422 races, lost answers,
  stored 403 causes, metadata admission and scrubbing, twenty labels, lookup
  failures and rate limits. The production deployment was not exercised.

Astra review runs against the committed change and keeps its receipt outside
the repository. No landing or push authorized.
