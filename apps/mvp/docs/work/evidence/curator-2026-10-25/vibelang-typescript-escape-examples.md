---
title: VibeLang TypeScript escapes and Promise examples
status: done
area: process
owner: Codex documentation job assigned by lead; Codex curates tracker
updated: 2026-10-23 12:35 PDT
links: [vibelang-generated-docs.md, vibelang-website-continuity.md, vibelang-latitude-deploy.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-23 12:35 PDT

**What:** Replace unnecessary TypeScript escapes with ordinary VibeLang and demonstrate external Promises and await.

**Why:** Will rejected the slug escape because the computation belongs in ordinary VibeLang.

**Current state:** At 12:26 PDT the lead confirms revision 962226c7 live on vibelang.sh, on both onboarding and the home page. Slug is plain VibeLang; the escape example awaits a fetched todo in try(async …) and maps failure to TodoFailed. The earlier 12:10 receipt reports all 700 runnable examples passing and about 20 unnecessary escapes removed or replaced with real Promise boundaries. The guidance is in docs/user/STYLE.md.

**Next step:** Retain the runnable-example checks and apply the documented escape guidance to future examples.

**Open questions for Will:** None.

Evidence: script-extracted user-typed text and lead text replies, 17:34–19:34 UTC on 2026-10-23. Both supplied transcript paths were checked; only the original exists. Automated notifications and compaction summaries are excluded as authority. Rulings and queue answers govern older decisions, proposals and surviving briefs. Reboot-wiped briefs are not pending work. Receipts are lead-reported; execution ownership is retained and Codex curates this tracker update.

## Earlier tracker history (retained)

## Tracker reconciliation — 2026-10-23 12:14 PDT

**What:** Replace unnecessary TypeScript escapes with ordinary VibeLang and demonstrate external Promises and await.

**Why:** Will rejected the slug escape because the same computation belongs in ordinary VibeLang.

**Current state:** At 12:10 PDT the lead reports rewrite 962226c7 pushed. The unchanged slug compiles and runs as ordinary VibeLang. The new escape awaits a fetch in try(async …), maps failures to TodoFailed and shows a caller retrying twice before a fallback. About 20 unnecessary escapes were removed or replaced with real Promise boundaries. The rule is recorded in docs/user/STYLE.md; all 700 runnable examples pass. Live deployment is not yet verified.

**Next step:** Confirm the Latitude deploy includes 962226c7; redeploy if needed, then verify the onboarding and home-page examples live.

**Open questions for Will:** None newly required.

Evidence: script-extracted user-typed text and lead text replies for 17:13–19:13 UTC on 2026-10-23. Both transcript paths were checked; the continuation path is absent. Automated notifications, compaction summaries and tool payloads are excluded as authority. Current rulings and queue answers govern older plans. Surviving briefs were consulted; reboot-wiped files are not outstanding work. Execution ownership is retained; Codex curates the tracker. Implementation and validation receipts are lead-reported.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-23 11:54 PDT

**What:** Replace the slug TypeScript escape with an external Promise example on onboarding and the home page; audit sync, try and callback examples.

**Why:** Will says slug should be ordinary VibeLang and asks for a real external-library, await and Promise example informed by Effect documentation.

**Current state:** At 11:49 PDT the lead reports a Codex job running. It first compiles slug as ordinary VibeLang, then uses the Effect tryPromise fetch-todo example as the basis for try(async …), a declared error and an ordinary VibeLang caller. It will report a language gap rather than silently alter the language. No completed patch or compile receipt is reported.

**Next step:** Validate examples, rewrite unnecessary escapes, add the documentation guidance, push VibeLang main and deploy with the share image.

**Open questions for Will:** None.

Evidence: Will’s typed feedback at 18:47 UTC and lead text replies through 18:53 UTC on 2026-10-23, script-extracted from the last two hours of the available original transcript. The requested continuation transcript is absent on disk; no raw transcript was read. Rulings and queue answers govern older plans. Reboot-wiped briefs are not outstanding work. Implementation receipts are lead-reported; Codex curates the tracker.
