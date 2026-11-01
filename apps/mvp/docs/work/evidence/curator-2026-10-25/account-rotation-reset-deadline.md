---
title: Honor reported account reset times in the rotation script
status: done
area: process
owner: Codex repair job assigned by lead; Codex curates tracker documentation
updated: 2026-10-22 03:14 PDT
links: [agent-task-routing.md, mac-mini-subscription-routing.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 03:14 PDT

**What:** Honor provider-reported account reset times.

**Why:** A flat cooldown unnecessarily prevents builders resuming.

**Current state:** The surviving rr-reset-report.md reports an atomic claude-rr repair: zoned reset time plus one minute for account and per-model cooldowns, preserving fallback behavior. Parser self-tests and both rotation status commands passed. Claude itself was not invoked.

**Next step:** Retain the repair receipt and observe the next real reset; reopen if runtime behavior differs. This closes the script repair, not account capacity management.

**Open questions for Will:** None newly required; earlier questions remain in the retained history.

Evidence: script-filtered human messages and lead text replies, 01:14–03:14 PDT in session 6253ecf2; surviving shared briefs and reports, rulings, queue answers, decisions, proposals, TODOs and rules. The continuation transcript was not found under the supplied Claude projects directory; recent replies survive in the original transcript. Automated notifications and tool payloads excluded. Reboot-wiped artifacts are not outstanding work. Product results are reported evidence; tracker validation is the site build. Execution ownership is unchanged.

## Earlier tracker history (retained)

**What:** Use the provider limit message reset time for account cooldown.

**Why:** A flat hour can block authorized builders after their limits have reset.

**Current state:** At 01:51 the lead reports both accounts still marked cooling after reset because the script parks any limited account for one hour. Cooldowns were cleared manually and the Markdown-flow builder resumed. A Codex fix is running; the original script is backed up. The agent-evals restart remains with the watcher.

**Next step:** Fix parsing and cooldown selection, test time boundaries and fallback behavior, and verify builders resume after the actual reset.

**Open questions for Will:** None.

Evidence: script-filtered lead text replies in session 6253ecf2, latest two hours through 01:53 PDT. Current rulings and queue answers govern. Product results are reported, not rerun by this tracker refresh.
