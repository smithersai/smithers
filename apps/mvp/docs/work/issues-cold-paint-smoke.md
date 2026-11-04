---
title: Issues cold paint without a loading state
status: done
area: app
owner: Codex
updated: 2026-11-03
links:
  - ../features/navigation.md
---

Continue change `orvnokou`: verify the five deploy-smoke runs without the temporary document route hook, comparing the fix with its recorded main parent `0d94668b`. Keep the no-loading-state assertion intact. Run focused unit tests, typecheck and the requested Astra review. Do not land or push.

The Issues pending shell no longer announces a loading state; routes with loading screens retain their pending delay. Native WebKit exposed a second cause: the app could arrive before the shell's Web Lock grant and revoke the first paint. The app now waits for that same grant, with wipe, revocation and refusal ending the wait safely. Timing marks record the wait and readiness. No loading-state assertion was relaxed.

Validation: 72 focused unit tests and the full app, worker, infrastructure and eval typechecks pass. The pending-lock regression failed before the fix. On the mini, a normal HTTPS server served both compiled revisions against the real hosted API, without the temporary Playwright document hook. This is a local frontend comparison, not an isolated local backend or a deployment. The five deploy-smoke groups passed on the fix (nine cases); the recorded main parent failed Chromium cold-path/first-paint and WebKit cold-path/first-paint, and passed runner-registration. Earlier diagnostic runs also encountered intermittent telemetry transport failures and an issue-paint handover timing failure; the final complete run passed. Private logs retain those attempts and the harness settings.

The coldload2 scratch specs and original fixture backup were archived outside the repository, and its fixture restored to its jj snapshot. No landing, push or deployment. Review receipts and validation evidence remain in the private operations scratchpad and default review store.
