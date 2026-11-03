---
title: Authorize every repository before syncing historical feed rows
status: done
area: repository-access
owner: codex
updated: 2026-11-02
links: [../features/notifications.md]
---

Finding 3. Deployment membership and recipient identity do not authorize historical private launcher prompts. Feed reads discover distinct repositories in the reader's eligible rows, resolve each through BranchRoles, and pass Electric a parameterized repository allowlist. Unknown authority refuses the shape; unscoped own rows retain their existing policy. A repository added after discovery is excluded until the next request.

Cost: one indexed DISTINCT query plus one role resolution per distinct repository, with concurrency four; no check per notification. Existing resolver freshness remains five minutes for other repositories. Read duration, repository count, permitted count and per-outcome check counts are recorded without titles or private names.

Library catalog: existing `@smthrs/effect-electric` ShapeProxy and injected Effect BranchRoles; authorization is core infrastructure.

Baseline: `feed read rechecks each repository before disclosing historical private launcher prompts` failed with `expected [ 'run:private-1', …(20) ] to deeply equal [ 'run:unscoped' ]`. Twenty private prompts escaped; zero permission requests; fixture wall time 99 ms. This is local integration evidence, not production latency.

Latitude verification: Notifications and Notifications.access suites: 42 passed, 0 failed, 0 skipped. For 20 allowed rows on one repository: cold read 62 ms with one GitHub permission request; warm read 27 ms with zero additional requests. The denied 21-row fixture took 151 ms with one request and returned only its unscoped row. Measured end to end through ChatApi, real Postgres and Electric, with scripted GitHub; these single samples are not production latency claims. The positive case also verifies that a subsequent unavailable permission read returns 503 without contacting Electric.
