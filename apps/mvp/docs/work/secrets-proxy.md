---
title: Secrets through an egress proxy (feature 6)
status: in-progress
area: infra
owner: Codex GPT-6 Astra (e2e-secrets)
updated: 2026-11-04
links: [../decisions/0005-sandboxes-secrets-and-the-forge.md, ../../../../AGENTS.md, sandboxes.md, design-questions.md, branch-terminal.md, connect-agents-sandboxes-forge.md, decisions-for-will.md, ../features/secrets.md, docs-truth-pass.md]
---

## Production proof — 2026-11-04

Auditing the production gate and building a real controlled-receiver proof. Keep the local container inspection.
Production is not proven: repository-secret egress defaults off, and writes remain fenced to the deployment's own
repository. No deployment or permission widening is part of this lane. Private configuration and execution receipts
stay in the lane's private status file. Library catalog entries: `@smthrs/secrets` for egress and `@smthrs/platform-cloudflare`
for the real branch machine; the tests exercise their existing public HTTP and terminal boundaries.

## Rebase validation — 2026-10-22

Rebased the six secrets commits onto `998199dc6263`. Preserved the plugin host, device authority, offline recovery, attention and TODO admission wiring. Terminal provisioning uses main's session boundary and the catalog's `@smthrs/platform-cloudflare` runner; the check-job and secrets paths share `SandboxEgress.SETUP`. Both terminal regression suites remain intact. The device lock was generated on Latitude at epoch 64 without rewriting schema history. No new migration or decision number is required.

Typecheck and import rules passed on Latitude. The secrets E2E passed on the mini with `SANDBOX_SECRETS=true` and its fixture repository, using the existing flag-aware builder wrapper. The full app run passed 3,225 tests and reported seven failures: the missing target prerequisite, missing header auth provider and telemetry-contract drift were fixed without weakening assertions, and all seven failing files passed follow-up runs (the other four failures did not recur). Platform-cloudflare passed 165 tests and secrets passed 107, both at 100% coverage. Latitude lacks Docker for five container tests; the mini secrets E2E passed against a real container. The API baseline was regenerated on Latitude: only SandboxObject changed. Final receipts and commit IDs are in `~/smithers-builders/rb22-secrets-REPORT.md`.

## Tracker reconciliation — 2026-10-21 22:43 PDT

**What:** Manage opaque repository secrets with Admin-only writes.

**Why:** Keep credentials out of sandboxes and diagnostics.

**Current state:** At 22:42 the lead reports two commits: mixed-case repository secret delivery and the Secrets page for add/list/rotate/delete with Admin-only mutations. Builder remains active; E2E is blocked by current-main terminal startup, assigned to the sandbox builder.

**Next step:** Land validated changes and prove the secrets E2E after terminal repair.

**Open questions for Will:** None newly required.

Evidence: script-filtered recent human messages and lead text replies in 6253ecf2, through 22:43 PDT; the supplied continuation path is absent, with continuation-era text in the available session. Current rulings and queue answers prevail. Existing execution ownership retained; Codex curates this note. Reported product receipts were not rerun here. Wiped briefs are not missing work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 20:55 PDT

**What:** Manage opaque secret names and authorize credential substitution only at egress.

**Why:** Keep secret values outside sandbox code, cards and diagnostics.

**Current state:** At 20:54 the lead reports the secrets builder running on the mini. The prior authentication launch blocker is cleared for this builder. No allowed-egress, denial, revocation or UI acceptance receipt establishes the full feature works; the existing switched-off gate still applies.

**Next step:** Complete and prove the UI and egress journey, including refusal and leak checks, before enabling it.

**Open questions for Will:** None newly identified.

Evidence: script-filtered user-typed messages and lead text replies from session 6253ecf2, latest two hours through 20:55 PDT; synthetic notifications and tool blocks excluded. Current rulings and queue answers govern over historical decisions and proposals. Available recovered briefs were read; wiped scratch files are not missing work. Product results are lead-reported; Codex curates documentation and runs the maintainer-site build. Previous implementation ownership is retained below.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 20:47 PDT

**What:** Provide secrets by opaque name through controlled egress and a usable UI.

**Why:** Sandbox code must never receive secret values.

**Current state:** At 20:46 the secrets Opus builder has an isolated mini clone and brief but cannot start until background Claude authentication is restored. The 20:32 lead lists secret egress and UI among unproven product gaps.

**Next step:** Start the prepared builder; prove allowed egress, denial, revocation and the secrets UI without exposing values.

**Open questions for Will:** No new product decision; mini background login is required.

Evidence: script-filtered human text and lead replies, 18:46–20:46 PDT, session 6253ecf2; current rulings and queue answers prevail. Runner results are recovered report receipts. Codex curates this update; existing implementation ownership is retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-21 20:34 PDT

**What:** Keep secret values opaque and substitute credentials only at allowed-host egress.

**Why:** No secret value may enter a sandbox or diagnostics.

**Current state:** The 20:32 lead update still lists production egress and a secrets UI as major gaps. Earlier wired-but-disabled backend work does not establish this feature works; keep it switched off until the browser and leak/refusal proofs pass.

**Next step:** Complete the secret-management UI and validate allowed egress, disallowed hosts, response scrubbing and absence of plaintext from sandbox and telemetry before enabling.

**Open questions for Will:** None.

Evidence: lead text replies script-filtered from session 6253ecf2, approximately 18:34–20:34 PDT, and recovered briefs where named. Automated notifications and tool content are excluded. Current rulings and queue answers prevail over older plans. Existing implementation ownership is retained; Codex curates the tracker. Product results are reported evidence, not tests rerun by this refresh.

## Earlier tracker history (retained)

## Current specification — 2026-10-20, 16:35 PDT

**What:** Keep secrets opaque and inject allowed-host credentials through egress.

**Why:** ARCH-16 forbids secret values in a sandbox or diagnostic.

**Current state:** At 16:25 the lead confirmed the sandbox egress connection is wired but switched off. The earlier missing-seam blocker is superseded; the browser proof is still missing.

**Next step:** Prove an allowed host answers without exposing the secret to the sandbox, including refusal and leak regressions, before enabling egress.

**Open questions for Will:** None.

Evidence: lead text replies extracted by script from the session’s latest two hours through 23:34:16 UTC; current rulings and queue answers take precedence over older designs. Reported product-test receipts only; this tracker ran no product tests.

## Prior tracker record (retained)


## What

No secret value enters a sandbox. The sandbox holds placeholders. One `Egress` Worker entrypoint intercepts all its HTTP and HTTPS traffic, checks each request against the sandbox's grant, injects credentials into headers only, and scrubs echoed values from responses. Values are sealed in Postgres under a key only the Worker holds.

The 13:22 walking skeleton (best guess from the builder's brief):

```
sandbox / flow step ──HTTP with placeholder──▶ egress proxy ──real value, allowed host only──▶ outside API
                                                  │
                                                  └─ any other host: no substitution
```

- **SDK first, host-agnostic:** in the existing package `docs/libraries.md` names for the job (extend before adding one), with the Cloudflare implementation behind an injected service.
- **App:** store a secret encrypted at rest, write-only from the UI (set, replace, delete; never read back); a host allowlist per secret; audit records without values.
- **Proof in tests:** the value never reaches the sandbox, a log, a span or an error; a disallowed host gets no substitution; a redirect to another host doesn't leak it; header and body substitution limits.
- **Hard rule:** if any property can't be met in this slice, the feature ships switched off and the hole is listed.

## Why

Will: "Also done on side we must support secrets iron proxy style". Root `AGENTS.md`: a secret's value never appears in a card, log, trace or diagnostic.

## State

- Designed in decision 0005 (proposed). Nothing is built.
- 0005 also found the in-sandbox token from 0008 isn't needed.
- 22:45 on 2026-10-19: **all three of 0005's questions are settled** (Q1 Cloudflare at 22:41, Q2 the sandbox as a tool provider at 22:42, Q3 budgets deferred until we ship at 22:45), none about secrets. This item moves from designing to todo with [sandboxes](sandboxes.md). 0005's file status still reads "proposed". Nothing is built.
- 23:02 on 2026-10-19: the lead's board: features 5 to 7 (sandboxes, secrets, and Qwen in sandboxes) are not started; they "wait for disk space and the agent". The Mac had about 10 GB free at 23:01, and the agent's first slice depends on B1 and the [model endpoint](model-endpoint.md).
- 13:19:52 on 2026-10-20: the lead's list puts "secrets via an egress proxy" under "Your feature list, not started yet".
- 13:21:12: the lead: it can start now, "new SDK code, no app files".
- **13:21:41: Will: "start the ones that can start now we are trying to ship faster".**
- **13:22:52: the lead started the secrets builder** (Claude Opus) on scratchpad `final/BUILD-COMMON.md`. It must review its own diff against the four properties above before reporting. The [branch terminal](branch-terminal.md) builder owns the container and terminal code (`platform-cloudflare` container terminal, the `worker/` terminal pump), so this builder injects at a seam and tells the lead which seam it needs.
- 13:23:33, the lead to Will: "code in a sandbox never holds a secret; the proxy adds it only for that secret's allowed hosts; ships switched off if any leak path is left open".
- **Status moved from todo to in-progress.**
- On disk by 14:12 on 2026-10-20: [`features/secrets.md`](../features/secrets.md). `PUT /api/repos/<owner>/<name>/secrets/<NAME>` sets or replaces a secret (Admin in person only; an agent, flow or sandbox is refused), `DELETE` removes it; values sealed with AES-256-GCM under a key derived from `SECRETS_KEY`, bound to repository, name and key version; `secret/Put` and `secret/Delete` run on the Cloudflare host and write `secret_events` audit rows; nobody reads a value back. The box holds `smthrs-secret-<64 hex>` placeholders; `Egress.forward` checks host, method and HTTPS, puts the value only in a header, returns redirects unfollowed and scrubs every echo of the value. The sandbox's outbound HTTP isn't wired to it yet.
- **14:27:52, the lead to Will:** "The secrets egress proxy is built but switched off. A sandbox never holds a secret's value. The value goes only to the hosts that secret allows, redirects aren't followed, and any copy of a secret is removed from responses. The sandbox agent connects it to the sandbox next, and it stays off until a browser test proves it works."
- **14:30, the lead:** a new private package `@smthrs/secrets`, migration `0021` (applied to the shared dev database at 14:26), a write-only secrets API with audit, and 106 SDK tests at 100% coverage. It waits on a seam in `SandboxObject`, which the [agent-in-the-sandbox](connect-agents-sandboxes-forge.md) builder wires. Status stays `in-progress` until the box's traffic goes through it in a browser test.

## Next

From 14:30 on 2026-10-20: the sandbox builder wires `SandboxEgress.forward` in `SandboxObject`; then a browser e2e proves a sentinel secret reaches only its allowed host and never the box, a log, a span or an error; then it is switched on. The Secrets card, main-only secrets and secret files come later.

Until 14:30 on 2026-10-20 the next step was, from 13:22 on 2026-10-20: the builder's report: which package it extended, the four leak tests and their results, the seam it needs from the branch terminal code, and whether it ships on or switched off with a listed hole.

Until 13:22 on 2026-10-20 the next step was: prove it in the sandbox spike: a sentinel secret never appears inside the container, in logs or in traces.

## Questions for Will

None.
