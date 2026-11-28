---
title: Diagnose hosted job checkout failures
status: in-progress
area: runs
owner: antigravity-checkout-forge
updated: 2026-11-27
links: [../features/ci.md, ../features/branch-workspace.md, ../observability.md]
---

Two production landing-check jobs stopped at checkout before a user step ran. Preserve bounded checkout failure details in the durable job receipt and verify the hosted checkout path.

The historical receipt lost its checkout stage. The library catalog's existing `@smthrs/sandbox` `CiJob`, `@smthrs/effect-code-storage` `GitProxy`, `@smthrs/platform-cloudflare` `SandboxObject`, and `@smthrs/flow` actions own the typed result, proxy, journal, and retry policy.

On a signed-in hosted run, the durable checkout completed, the readiness command exited 0 and the parent run reached done. The first two failures recorded neither an exit code nor a checkout stage.

A later hosted parity job returned 72. The old script used that code for three commands. Two local Docker checkouts of that exact revision through the production Git proxy implementation succeeded. Distinguished repository initialization (73), remote setup (74), fetch (75), and working copy checkout (76) in the durable receipt.

Stage 5 public production runs (`evmts/tevm` `parity:6a7c05c1-e7f9-569e-9a58-c9f01ea7ea34`, `evmts/guillotine` `ci:3c0a2506-51cf-507e-aaee-93ebb5352522`, and `smithersai/smithers-ci` `audit:0dc2fcae-72d3-5044-94a8-75eed41c2673`) all failed at pinned public fetch (`exitCode: 75`, `checkoutFailure: "clone"`). Landed bounded machine-side transport classification (`CheckoutTransportCause` + `CheckoutHttpStatus`) in `f7396e27d176`.

Stage 7 and Stage 8 production runs on `f7396e27d176` / `e63cb9943eb7` produced the first transport discriminator: both `evmts/guillotine` jobs (`ci:85fc53a8-fa2d-5087-af5a-a80ec40a6d94`, SHA `5ea1eba2`), `smithersai/smithers-ci` PR 2 (`audit:5763adac-7b33-59a0-885a-e3bfdfd754df`, SHA `8cb71bfe`), and `smithersai/smithers` (`landing-readiness`, SHA `e63cb994`, 2.1 s) failed at pinned fetch (`exitCode: 75`) with `checkoutTransportCause: "http_status"`, `checkoutHttpStatus: 404`, while `evmts/tevm` (`parity:f48a9278-b36a-5ac7-b8c9-6ceff791a478`, SHA `c2a8c83d`) passed checkout on the same release. Earlier Stage 5–6 runs also showed intermittent pass/fail on identical repo+SHA (including 2/4 passing vs 2/4 failing in parallel on `evmts/voltaire`).

Local verification against live GitHub ruled out repository visibility, missing SHAs, VibeLang compilation, `workerd` (`Miniflare` v5) + Effect `Forge.proxy`/`GitProxy.uploadPack`/`FetchHttpClient`/`fromCloudflareFetcher`, and the `smithers-branch-sandbox:test` container (`git 2.47.3` + `curl 8.14.1`): all three failing repos checked out cleanly locally. Because the deploy credential's Workers Observability query returned HTTP 403, server-side `sandbox.forge` / `git.proxy` logs were unavailable.

Audit of the hosted routing path found one concrete masking bug and one observability gap:
1. In `ChatApiProgram.ts`, requests targeting sandbox-only internal hosts (`forge.smithers.internal`, `artifacts.smithers.internal`) that arrived without valid `ctx.props` (`boxOf(props) === undefined`) fell through to external routes (`runnerAdmin` / `signIn` / `chat.fetch`) and returned a misleading HTTP `404`. Added `BranchSandboxes.routeBox` / `internalHostOf` to fail closed with HTTP `502` and log `sandbox.box_request` (`outcome: missing_box_props`).
2. Added bounded per-stage host-side forge proxy observation (`GitProxy.uploadPack` `onResponse`, `Forge.proxy` `onResponse`, `CiJob.CheckoutForgeReceipt` on `CheckoutRefused` and `StepResult`, wired through `BranchSandboxes`, `CiJobMachine`, and `RunJobResults`). On the next production repro, one durable receipt immediately distinguishes: (a) missing `ctx.props` at ChatApi (`checkoutHttpStatus: 502`, `routing: "unreached"`), (b) pre-object 404 (`checkoutHttpStatus: 404`, `routing: "unreached"`), (c) host mismatch (`routing: "host_mismatch"`), (d) branch/namespace proxy refusal (`no_branch` / `unscoped`), or (e) upstream (`github` vs `deployment`) 404 at `info-refs` vs `upload-pack`, with zero raw stderr, URLs, paths, or secrets.
