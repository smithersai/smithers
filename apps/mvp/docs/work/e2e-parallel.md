---
title: Parallel production e2e resource isolation
status: blocked
area: testing
owner: Codex GPT-6 Astra
updated: 2026-11-04
links:
  - ../infrastructure.md#against-a-deployment
---

Replace the account-wide run lock with declared resource locks and leased scratch repositories. Isolate each run's session snapshot, setup metadata, conversation and artifacts. Prove disjoint concurrency and shared-resource serialization on production before landing.

Library catalog: this is the existing Node/Playwright test-runner boundary, not a product plugin. GitHub provisioning uses the catalog's `@smthrs/integrations` GitHub client where its public API supports the required requests.


Implemented resource admission, leased stack/factory pools with verified installation coverage and locked fallback,
per-run session/metadata/branch/artifacts, concurrent refresh, and process-group-safe interruption. Twenty real
filesystem/process/fault tests, 102 targeted compatibility tests and the four-project ES2022 typecheck pass. Production disjoint specs overlap and pass;
shared configured scratch runs serialize and pass. Media for the focused disjoint proof passes on the compute host.
Astra and Fable reviews completed; their concrete failure-path findings have regression coverage.

Live pool creation awaits a real test-account App user token and the target App ID. The model bootstrap reached the
real provider, which refused Test with quota exhaustion (HTTP 429); successful bootstrap needs a usable test-account
model credential/quota. No credential/installation assumption, provider-quota change or deployment was made. Detailed
timings and receipts are in the lane's private status report.
