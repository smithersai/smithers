---
title: Investigate production agent and Jev assertion failures
status: in-progress
area: app
owner: Codex Sol investigation assigned by production deployer; Codex tracker curates note
updated: 2026-10-22 00:44 PDT
links: [production-e2e.md, agent-jev.md, agent-evals.md]
---

## Tracker reconciliation — 2026-10-22 00:44 PDT

**What:** Keep production agent and Jev assertions scoped to their own calls.

**Why:** Concurrent model activity must not contaminate a journey’s expectations.

**Current state:** At 00:38 the lead reports the test fixes landed on main e326b151: agent ask and Jev now count only their own model calls. No deployed rerun pass is reported.

**Next step:** Collect deployment and real production rerun receipts before closing.

**Open questions for Will:** None newly required.

Evidence: script-filtered user-typed text and lead text replies, 22:43–00:43 PDT across both supplied transcript paths; automated notifications, tool results and local commands excluded. The continuation path is absent; recent continuation-era replies survive in 6253ecf2. Current rulings and queue answers govern older plans. Reboot-wiped artifacts are not missing work. Product receipts are lead-reported; Codex curates tracker documentation and retains execution ownership.

## Earlier tracker history (retained)

## Tracker reconciliation — 2026-10-22 00:24 PDT

**What:** Keep agent ask and Jev production assertions aligned with intended behavior.

**Why:** Real memory selection can legitimately add a judge call.

**Current state:** The surviving deployer handoff updated 00:45 reports both spec fixes done and pushed as e326b1517b60. The extra judge call is the intended opening-memory selection in memory.ts. No post-fix production rerun receipt is recorded; this later handoff supersedes its stale deployment-blocker section.

**Next step:** Rerun both specs against a deployment containing e326b1517b60.

**Open questions for Will:** None newly required.

Evidence: script-filtered human text and lead replies across the supplied transcript paths, latest two hours through 00:23 PDT; the continuation path is absent at this refresh and recent replies survive in 6253ecf2. Current rulings and queue answers take precedence. Later surviving handoffs are explicitly dated where used. Reboot-wiped briefs are not missing work. Product receipts are reported, not rerun here; Codex curates documentation and retains execution ownership.

## Earlier tracker history (retained)


**What:** Determine whether the extra judge role in agent ask and Jev step-count mismatch are product bugs or stale assertions.

**Why:** The full production suite fails these two journeys despite earlier local evidence.

**Current state:** At 00:06 the lead assigns investigation; neither failure is yet classified. No fix or rerun receipt.

**Next step:** Inspect real run records, retain meaningful behavior assertions, fix the product or justified expectation, and rerun against production.

**Open questions for Will:** None.

History: Added by Codex from script-filtered lead replies in the latest two transcript hours. Rulings and queue answers govern; reported product receipts were not rerun by the tracker.
