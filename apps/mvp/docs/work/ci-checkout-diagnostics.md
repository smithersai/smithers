---
title: Diagnose hosted job checkout failures
status: in-progress
area: runs
owner: antigravity-checkout-transport
updated: 2026-11-27
links: [../features/ci.md, ../features/branch-workspace.md, ../observability.md]
---

Two production landing-check jobs stopped at checkout before a user step ran. Preserve bounded checkout failure details in the durable job receipt and verify the hosted checkout path.

The historical receipt lost its checkout stage. The library catalog’s existing `@smthrs/sandbox` CiJob and `@smthrs/flow` actions own the typed result, journal and retry policy.

On a signed-in hosted run, the durable checkout completed, the readiness command exited 0 and the parent run reached done. The first two failures recorded neither an exit code nor a checkout stage.

A later hosted parity job returned 72. The old script used that code for three commands. Two local Docker checkouts of that exact revision through the production Git proxy implementation succeeded. Distinguish repository initialization, remote setup, fetch, and working copy checkout in the durable receipt.

Stage 5 public production runs (`evmts/tevm` `parity:6a7c05c1-e7f9-569e-9a58-c9f01ea7ea34`, `evmts/guillotine` `ci:3c0a2506-51cf-507e-aaee-93ebb5352522`, and `smithersai/smithers-ci` `audit:0dc2fcae-72d3-5044-94a8-75eed41c2673`) all failed at pinned public fetch (`exitCode: 75`, `checkoutFailure: "clone"`) before installation, while admission and public SHA existence already checked out. Added bounded machine-side transport classification (`CheckoutTransportCause`: `http_status` with `CheckoutHttpStatus` `100`–`599`, `dns`, `missing_object`, `pack_storage`, `interrupted`, or `unknown`) via `@smthrs/platform-cloudflare`'s `SandboxObject.runWithStderr`, `@smthrs/sandbox`'s `CiJob`, `BranchSandboxes`, `CiJobMachine`, and `RunJobResults`, preserving historical decoding and keeping raw stderr, customer content, and secrets out of logs and durable records. Next: deploy and run a production repro to discriminate the shared fetch (75) root cause.
