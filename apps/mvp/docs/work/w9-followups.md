---
title: W9 visitor runs and intermittent About
status: done
area: app
owner: Codex w9-followups
updated: 2026-10-26
links:
  - ../features/actions.md
  - ../features/repo.md
---

Gate repository runs on current Member authority; diagnose the intermittent curated About refusal with production records.
Library catalog: @smthrs/effect-electric ShapeSource.gated; Effect services for authority and diagnostics.

Production: ten signed-out browser loads reproduced cached rate_limited About refusals. A subsequent read after the
hold expired used deployment authentication and answered with rateRemaining 8674, followed by cache hits. Legacy
refusals have no quota provenance; migration 0070 records it. Curated homes with no usable answer can recover from
an anonymous or legacy rate limit with one authenticated claim, without a retry loop or bypassing authenticated holds.

Latitude: typecheck, importRules and lint pass; 133 focused tests pass. All six changed production files reach 100% statements, branches, functions and lines. The Mac mini was skipped as instructed; patched production e2e belongs to the lander.
