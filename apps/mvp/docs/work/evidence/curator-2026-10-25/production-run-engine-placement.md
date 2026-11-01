---
title: Place remote run engines near the database
status: done
area: infra
owner: production database builder assigned by lead; Codex curates tracker
updated: 2026-10-22 04:04 PDT
links: [production-database-pooler.md, journal-deployment-lock-contention.md, private-hosted-infrastructure.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 04:04 PDT

**What:** Place already-remote run engines near their database through injected configuration.

**Why:** Reduce locked-transaction latency and the wait before a remote action starts.

**Current state:** Push 16 has been live since 03:49 PDT. At 04:03 the lead reports production terminal opens, sandbox calls and agent tools reaching their first step in 3.4 seconds versus 10–13 seconds previously. The earlier 5–20 minute waits coincided with the database outage. These are lead-reported observations; no reproducible benchmark artifact is supplied in the recent replies.

**Next step:** Retain measurement method, sample sizes and artifacts before publishing a benchmark claim; monitor concurrency and recovery. Keep deployment-specific details private.

**Open questions for Will:** None newly required; rulings supersede historical questions below.

Evidence: script-extracted user-typed text and lead replies for the latest two hours through 04:03 PDT. Both requested transcript paths checked; the continuation file is absent, while recent replies survive in 6253ecf2. Automated notifications, tool payloads and continuation summaries excluded. Current rulings and queue answers govern decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped files are not outstanding work. Implementation ownership retained; Codex curates tracker documentation. Product receipts are lead-reported; this refresh validates the site build only.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 03:55 PDT

**What:** Place already-remote engine hosts near their database through injected configuration.

**Why:** Shorter locked transactions reduce connection occupancy.

**Current state:** At 03:52 the lead confirms push 16 live since 03:49 with the run engine placed near the database. The earlier 1,000 ms to 70 ms result remains an experiment, not a new production benchmark.

**Next step:** Monitor deployed concurrency and recovery; retain reproducible methods before publishing any performance claim. Keep deployment details private.

**Open questions for Will:** None newly required; rulings supersede older questions retained below.

Evidence: script-filtered human text and lead replies across both requested transcript paths, 01:53–03:53 PDT. Automated notifications and tool payloads excluded. Current rulings and queue answers govern decisions, proposals, TODOs and rules; surviving lander/deployer briefs supplement reported receipts. Reboot-wiped briefs are not outstanding work. Implementation ownership is retained; Codex owns tracker curation. Product checks are reported, not rerun here.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 03:34 PDT

**What:** Place already-remote engine hosts near the database through injected configuration.

**Why:** Shorter locked transactions reduce connection occupancy.

**Current state:** The 02:35 experiment reports 1,000 ms reduced to 70 ms per locked transaction. The surviving lander state now includes host placement in the push-16 database stack and says it takes effect at the first deploy containing that change. No landed or deployed measurement is reported; the experiment is not a production benchmark claim.

**Next step:** Finish gates and deployment, retain reproducible measurement method and limitations, then measure concurrent runs and recovery. Keep the hosted location and operational configuration private.

**Open questions for Will:** None newly required; earlier questions remain in the retained history where not superseded by rulings.

Evidence: script-filtered user-typed text and lead replies in the latest two session hours, 01:33–03:33 PDT on 2026-10-22; automated notifications and tool payloads excluded. Both transcript paths were checked; the continuation file is absent, and recent replies survive in 6253ecf2. Surviving deployer/lander briefs supplement the replies; rulings and queue answers take precedence. Product results are reported receipts, not rerun here. Implementation owners are retained; Codex curates documentation. Reboot-wiped files are not outstanding work.

## Earlier tracker history (retained)

**What:** Place the remote run-engine host near its database through injected host configuration.

**Why:** Cross-region locked transactions lengthen connection occupancy and durable execution latency.

**Current state:** At 02:35 the lead authorizes this follow-up and reports a measured reduction from 1,000 ms to 70 ms per locked transaction. This is a reported experiment, not a deployed performance claim. No separate completion receipt exists.

**Next step:** Retain the reproducible method and limits, capture deployment-specific placement privately, land and deploy through the standing deployer, then measure real concurrent runs and recovery. Preserve local-first flow placement; this concerns already-remote execution only.

**Open questions for Will:** None; the lead assigned the operational follow-up within existing authority.

Evidence: script-extracted user-typed messages and lead text replies across both supplied transcript paths, 01:03–03:03 PDT on 2026-10-22. Automated notifications, relayed agent messages, tool payloads and compaction summaries excluded from status evidence. Current rulings and queue answers govern historical docs and surviving briefs. Reboot-wiped files are not outstanding work. Product results are lead-reported; Codex curates documentation and preserves execution ownership.
