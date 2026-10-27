---
title: Electric survives app deployments
status: in-progress
area: infrastructure
owner: electric-s7
updated: 2026-10-26
links: ["../decisions/0118-electric-runtime-worker.md"]
---

## Design A: separate owner Worker

Move ElectricObject and its container into ElectricRuntime. The gateway binds the namespace exported by that Worker. Its bundle excludes request caching and ChatApi; its props include only Electric hosting configuration. Inspect Alchemy's namespace binding, Worker diff and migration implementation before choosing. A one-time namespace transfer must precede removal of the original class. Ongoing app deploys must leave the runtime bundle and resource props byte-identical.

## Design B: retain the combined Worker

Make gateway bundling deterministic and rely on Alchemy skipping unchanged uploads. This avoids a namespace move, but a gateway request-handling change necessarily changes the owner script and restarts Electric. Persistent Electric disk could reduce recovery work, but requires a supported durable filesystem and does not prevent restarts. Neither meets the stated gateway-change requirement as directly as A.

## Evidence and choice

Investigation in progress: read installed Alchemy source on Latitude, then record exact update triggers and migration support before implementation.

Alchemy beta.83 source inspected in installed node_modules on Latitude: `WorkerProvider.js:3368-3476` compares canonical metadata and bundle hashes, `:3524-3730` returns noop for identical normalized props. `Sources/Rolldown.js:166-215` generates a stable entry from class exports and stack/stage, with no timestamp. `Bundle/Bundle.js:365-385` hashes emitted file contents. The combined Worker necessarily uploads when gateway code changes because that changes its bundle hash; there is no unconditional deploy/build stamp in these paths. Historical ChatApi-only upload causality cannot be inferred without the deployed resource's old hash/props; do not claim that shared app imports or a stamp caused those observed restarts. The new regression proves independence rather than relying on that attribution.

Choose A. `DurableObject.d.ts:195-204` supplies `.from(worker)` and `.make`, plus `transferredFrom` for a namespace-preserving move. WorkerProvider observes existing ownership, transfers at the destination before the gateway's cross-script binding converges, and excludes foreign classes from local delete/create migrations. No SDK feature is missing. Library catalog entry: `@smthrs/mvp` (Effect-native Alchemy infrastructure); existing `@smthrs/observability` structured logger for lifecycle records.

Additional migration evidence: `ContainerConfiguration.js:90,137-139` distinguishes the existing default/fleet
container from `schedulingPolicy: "durable_object"`. Electric uses the former. `ContainerPlatform.js:29-58`
binds that existing root `Electric` resource directly to the namespace; its application is NOT keyed under the
host Worker. Preserve its root logical id and namespace id, so the application attachment is unchanged. A
host-keyed `ElectricObject-Containers` alias would incorrectly create a second application resource; do not add it.
The graph regression checks exactly Electric, ElectricRuntime and ElectricGateway, with one namespace owner.

## Verification and handoff

Latitude executes typecheck, importRules, configured app lint, safe-receipt parser tests, Alchemy bundle tests and
real workerd → cross-script Durable Object → farm Electric tests (scoped snapshots, stale-handle recovery, aborts
and empty live rounds). The V8 coverage gate measures changed logic in ElectricAwake, ElectricCache and
ElectricConfig at 100% statements/branches/functions/lines. Alchemy Worker entrypoints are host boundaries,
verified by actual bundle output and declaration discovery, not included in that logic coverage claim.

The namespace-transfer plan, first deploy, unchanged placement receipt, browser deployment specs and 15-minute
zero-503 gate are lander work. No deployment, mini run or production load run was performed by this builder.
