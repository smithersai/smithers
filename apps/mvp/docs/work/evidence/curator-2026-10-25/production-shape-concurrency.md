---
title: Repair concurrent production live-data feeds
status: done
area: app
owner: Claude shape-concurrency builder assigned by lead; Codex curates documentation
updated: 2026-10-22 08:34 PDT
links: [production-branch-page-performance.md, production-live-data-recovery.md, observability.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 08:34 PDT

**What:** Keep production live-data feeds responsive after idle periods.

**Why:** Container shutdown caused cold branch loads of roughly forty seconds.

**Current state:** At 08:25 PDT the lead reports the deployed fix passed its production idle check: after twelve quiet minutes the conversation appeared 1.2 seconds after the frame with no live-data errors, versus over thirty seconds previously. Push 20 deployed at 08:09. This closes the immediate cold-container defect; the separate beyond-six-hour scheduled keep-alive remains todo.

**Next step:** Retain the production idle-test receipt and track longer quiet periods in electric-scheduled-keepalive.md.

**Open questions for Will:** None newly required; historical questions remain below.

Evidence: script-filtered human text and lead replies, 06:33–08:33 PDT across both requested transcript paths. Only 6253ecf2 exists at this refresh; continuation-era replies survive there. Automated notifications and tool payloads excluded. Current rulings and all queue answers take precedence over decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not outstanding work. Product receipts are lead-reported; tracker validation is the site build. Implementation ownership retained; Codex curates documentation.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 08:13 PDT

**What:** Keep production live-data feeds responsive after idle periods.

**Why:** Container shutdown caused cold branch loads of roughly forty seconds.

**Current state:** Push 20 is deployed in main 9dac89c7 at 08:09. The lead reports a thirty-second service restart followed by recovery; a sixteen-minute production test is running to verify the six-hour active window. No completed idle-test receipt exists.

**Next step:** Collect the idle-test and branch-load receipts; keep the separate scheduled keep-alive work open.

**Open questions for Will:** None newly required.

Evidence: lead text replies script-extracted from the latest two hours through 08:13 PDT in session 6253ecf2; current rulings and queue answers govern. The supplied continuation file is absent; post-reboot replies survive in the original session. Automated notifications and tool payloads excluded. Product checks are reported receipts, not rerun here. Implementation ownership is retained; Codex owns tracker curation. Reboot-wiped briefs are not outstanding work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 07:44 PDT

**What:** Repair delayed concurrent live-data loading.

**Why:** The earlier feed failures accompanied a slow branch screen.

**Current state:** The 07:42 lead update replaces the suspected concurrency cause with Electric container shutdown after about two minutes idle. A repair extends the active window to six hours per request, Cloudflare’s maximum, for an estimated $7/month. It is with lander 1; no deployed result is reported.

**Next step:** Deploy the repair and verify concurrent feeds plus cold/warm branch loading; track scheduled keep-alive separately.

**Open questions for Will:** None newly required.

Evidence: lead text replies extracted by script from both supplied transcript paths, latest session window 05:43–07:43 PDT. Automated task notifications and tool payloads are excluded. Rulings and queue answers govern older docs and surviving briefs; reboot-wiped files are not outstanding work. Product receipts are lead-reported; this curator runs the site build only. Existing execution ownership is retained.

## Earlier tracker history (retained)


**What:** Find and repair the component refusing concurrent live-data feeds.

**Why:** A branch conversation still takes 25–30 seconds to appear after reload on push 18.

**Current state:** At 06:36–06:37 the lead reports 52 feed errors when many feeds load together, while each feed works alone. A Claude builder is tracing the refusal. This is a new concurrency investigation; the separate recovery repair remains queued to land.

**Next step:** Reproduce concurrent loading, identify the refusing component from records, retain a regression, deploy and measure production reload behavior.

**Open questions for Will:** None.

Evidence: script-filtered lead replies from session 6253ecf2, latest two hours through 06:43 PDT. Current rulings and queue answers govern. No passing repair or deployment receipt is claimed.
