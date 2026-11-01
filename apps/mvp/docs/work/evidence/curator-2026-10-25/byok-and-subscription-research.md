---
title: Research bring-your-own-key and subscription model access
status: done
area: app
owner: Opus research agent assigned by lead; Codex tracker curator owns documentation
updated: 2026-10-24 10:14 PDT
links: [../rulings.md, model-endpoint.md, mac-mini-subscription-routing.md, cerebras-eval-quota-exhaustion.md, ../features/secrets.md]
---

## Tracker reconciliation — 2026-10-24 10:14 PDT

**What:** Compare customer-owned API keys and subscription access in Amp and similar coding products.

**Why:** Will requested the comparison at 09:44 PDT before asking for production implementation at 10:04.

**Current state:** Research is complete: the lead's 10:04 reply says the self-contained HTML report is open in the local research folder. Its recommendation is server-sealed BYOK through the existing vault and model proxy. Vendor terms and subscription claims are research findings reported by the lead, not independently verified by this tracker. Will then said “impleent it and get it working please in production.” At 10:05 the lead assigned BYOK implementation to Opus; that execution is tracked separately in [personal model keys](personal-model-keys.md). Research completion does not mean the product is deployed.

**Next step:** Use the report to guide the authorized BYOK implementation and retain production acceptance receipts in its note. Subscription login remains a separate proposed extension.

**Open questions for Will:** Whether to make an exception to PROC-23 for an OpenAI subscription-login plugin, subject to provider approval. No exception is inferred: the lead explicitly excluded it from the assigned build.

Evidence: script-filtered user-typed messages and assistant text replies from both supplied transcript paths, combined latest two-hour window 2026-10-24 15:13–17:13 UTC. Automated notifications are not user authority. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs; reboot-wiped files are not outstanding work. Checks and implementation progress are lead-reported; Codex curates documentation only and validates the maintainer-site build. Existing execution ownership and earlier history are retained.

## Earlier tracker history (retained)


## What

Research how Amp and other coding products support bring-your-own-key (BYOK) and personal subscriptions, then propose the smallest Smithers design that can replicate the supported behavior.

## Why

Will explicitly requested this research at 09:44 PDT on October 24. Distinguish customer-owned API keys from subscription access before choosing a product design.

## Current state

At 09:44 PDT the lead reports an Opus researcher working from primary vendor documentation, terms, changelogs and open-source code. Coverage includes Amp, OpenCode, Cline, Roo Code, Kilo Code, Zed, Cursor, Copilot, JetBrains, Continue, Aider, Factory, Warp, Claude Code, Codex and Gemini. The requested comparison covers providers, credential storage, direct versus proxied calls, subscription login, billing and vendor restrictions or enforcement. The planned report is ~/Desktop/smithers-research/byok-subscriptions.html; The lead confirms at 10:03 PDT that this research is tracked as in progress; report completion is still not reported. No product implementation or validated provider-support claim is established.

The lead suggests the existing secrets egress and model proxy as possible BYOK seams; this is a research hypothesis, not an approved architecture. PROC-23 still records vendor-neutral role seams and no Claude/Codex-specific product buttons or adapters. Will’s new request establishes research intent; whether the eventual design changes that product ruling remains unresolved. Internal Mac mini subscription routing stays a separate workstream. This research does not restore exhausted production quota.

## Next step

Finish the sourced comparison and self-contained HTML report. Separate supported integrations from uncertain or restricted subscription reuse, then propose minimal BYOK and subscription options through the public plugin interface, injected Effect services and durable model calls. Present any required change to PROC-23 to Will before treating it as settled. Retain report and decision receipts before claiming implementation.

## Open questions for Will

After reviewing the research, should Smithers retain only vendor-neutral external-agent seams, or change PROC-23 to support specific subscription login integrations? No answer or implementation approval is inferred yet.

Evidence: user message at 2026-10-24T16:44:19Z and lead replies at 16:44:57Z, 16:53:39Z and 17:03:39Z, extracted by script as text only from the latest combined two-hour window, 15:03–17:03 UTC. The original supplied transcript exists; the continuation path is absent. Automated notifications are excluded as user authority. Rulings, all available queue answers, decisions, proposals, TODOs, rules and surviving briefs were consulted; reboot-wiped briefs are not outstanding work. Execution ownership remains with the assigned researcher; Codex curates this note. Tracker validation is the maintainer-site build only.
