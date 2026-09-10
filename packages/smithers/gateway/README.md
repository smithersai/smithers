# @smthrs/gateway

This package declares `effect`, `@effect/platform-node`, and `@effect/platform-node-shared` as exact
`4.0.0-rc.112` peer dependencies. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://gateway.smithers.sh

The assembled workspace gateway: one HTTP surface carrying the control plane, the sync read path, the served projections, and a health probe. It also defines the gateway wire schemas and the stale-run supervision port, and re-exports the durable journal synchronization package gateway hosts use.

The mounts, the bind and credential policy, the projections and their rows, the subscription and cursor semantics, every failure code with the status it answers, and the resource limits are documented once, on [the API page](https://gateway.smithers.sh/reference/api/). This file lists what the package exports and shows how a host composes it.

`smthrs serve`, from [`@smthrs/cli`](https://cli.smithers.sh), is a host over this package: it resolves a project on disk, builds the control plane and the journal over that project's database, and hands the assembly here to bind and serve. Install the CLI when you want a gateway without writing code; install this package when you are writing a client against the wire, or embedding the surface in a process of your own.

## Install

```sh
pnpm add @smthrs/gateway@1.0.0-rc.0
```

Node 22.19.0 or later is required. `effect@4.0.0-rc.112` is a required peer.
The root and protocol subpaths install no Node adapter. The optional peer
`@effect/platform-node@4.0.0-rc.112` is required by `node/NodeGateway`,
including the hosting example below:

```sh
pnpm add effect@4.0.0-rc.112 @effect/platform-node@4.0.0-rc.112
```

Name the version. This README describes 1.0.0-rc.0, and until that release candidate reaches the registry the unqualified package name still resolves to the 0.x line, whose exports and wire format it does not describe.

## Public API

The root entry point exports these namespaces; local modules are also importable from `@smthrs/gateway/<Module>`.

| Module                      | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Description                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GatewayError`              | `GatewayErrorCode`, `GatewayError`, `settingRefusal`                                                                                                                                                                                                                                                                                                                                                                                                                           | Defines the stable failure codes, including local Host/Origin refusals, and the refusal a bad setting earns. |
| `GatewaySchema`             | `Workspace`, `GatewayConfig`, `GatewayStatus`, `GatewayHealth`, `ProjectionName`, `WorkspaceRunsSelector`, `RunSummarySelector`, `RunEventsSelector`, `TranscriptSelector`, `RunTreeSelector`, `ApprovalsSelector`, `NodeOutputSelector`, `ProjectionSelector`, `rowSchemaFor`, `ProjectionCursor`, `ProjectionSnapshot`, `SnapshotStartFrame`, `RowFrame`, `SnapshotEndFrame`, `DeltaFrame`, `HeartbeatFrame`, `GatewayFrame`, `SingletonRecord`, `TokenScope`, `TokenRecord` | Supplies the wire schemas for projections, cursors, snapshots, and frames.                                   |
| `Diagnosis`                 | `RunStatus`, `Refusal`, `Digest`, `clip`, `digest`, `duration`, `verdict`, `Subject`, `render`                                                                                                                                                                                                                                                                                                                                                                                 | Computes and renders what happened to a run, from that run's own control events.                             |
| `GatewayProjection`         | `RunSummaryRow`, `RunTreeRow`, `ApprovalRow`, `NodeOutputRow`, `TranscriptRow`, `runSummary`, `runTree`, `approvals`, `nodeOutput`, `transcript`                                                                                                                                                                                                                                                                                                                               | Defines the served wire rows and the pure folds that compute them.                                           |
| `GatewayRpcs`               | `Decision`, `SubmitApprovalInput`, `SubmitApprovalOutput`, `GatewayRpcs`                                                                                                                                                                                                                                                                                                                                                                                                       | Declares the served read path and the composite approval mutation.                                           |
| `GatewayServer`             | `Health`, `layerHealth`, `layerHandlers`, `watchHeartbeatKind`, `layerKeepAlive`, `layerControlHttp`, `layerProjectionsHttp`, `layerSyncHttp`, `rpcPaths`, `protectedPaths`, `routedPath`, `defaultMaxRequestBodyBytes`, `loopbackHostNames`, `loopbackHostHeaderNames`, `IngressOptions`, `exceededBodyLimit`, `bodyRefusal`, `carriesRpcRequest`, `layerIngress`, `LayerOptions`, `layer`                                                                                    | Assembles the whole HTTP surface as one application layer a host serves.                                     |
| `Projections`               | `heartbeatIntervalMillis`, `maxWorkspaceRuns`, `maxEventsPerRun`, `maxProjectionBytes`, `Service`, `Projections`, `make`, `layer`, `layerWith`                                                                                                                                                                                                                                                                                                                                 | Serves the bounded read path as snapshots and followed deltas.                                               |
| `SuperviseRuntime`          | `StaleRunningCandidate`, `QuotaDueCandidate`, `StaleClaimCandidate`, `Candidate`, `ResumeLease`, `ResumeErrorCode`, `ResumeError`, `Service`, `SuperviseRuntime`, `make`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                                                                              | Declares the host seam used to discover and resume stale or quota-due work.                                  |
| `Sync`                      | `RunCatalog`, `SyncClient`, `SyncError`, `SyncProtocol`, `SyncRpcs`, `SyncServer`                                                                                                                                                                                                                                                                                                                                                                                              | Re-exports `@smthrs/sync`, the read-only journal replication protocol.                                       |
| `node/NodeGateway`          | `ServerOptions`, `defaultServerOptions`, `isLoopbackHost`, `bindRefusal`, `listenOptions`, `ingressOptions`, `layerAuth`, `bearerPrincipal`, `layer`                                                                                                                                                                                                                                                                                                                           | Binds the assembled gateway to a Node HTTP server under the bind and credential policy.                      |
| `bun/BunGateway`            | `ServerOptions`, `layer`, `bearerPrincipal`                                                                                                                                                                                                                                                                                                                                                                                                                                    | Bun HTTP/WebSocket adapter using the same bind, bearer, ingress and RPC policies.                            |
| `test/TestSuperviseRuntime` | `TestSuperviseRuntimeOptions`, `TestSuperviseRuntime`, `make`, `layer`                                                                                                                                                                                                                                                                                                                                                                                                         | Provides a controllable supervision test service.                                                            |

## Hosting it

```ts
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"

// The composition `smthrs serve` hosts. The caller supplies
// `Control`, `Projections`, `SyncServer`, and the `SyncAuth` middleware.
const gateway = NodeGateway.layer(
  { workspaceHash: "…", gatewayId: "…", protocolVersion: "1", version: "1.0.0-rc.0" },
  { host: "0.0.0.0", port: 7331, listen: true, credential: process.env.SMITHERS_API_KEY }
)
```

A bind the policy or operating system refuses fails the layer with a sanitized `bind_failed` `GatewayError`. A host can inspect policy before composing the layer:

```ts
const refusal = NodeGateway.bindRefusal({ host: "0.0.0.0", port: 7331 })
// => GatewayError { code: "bind_failed", message: "Refusing non-loopback gateway bind 0.0.0.0 without an explicit --listen opt-in" }
```

A credential-less loopback host also enables the request guard: `Host` must be
loopback, and a supplied browser `Origin` must be HTTP(S) on `localhost`,
`127.0.0.1`, or `[::1]`. Origin-less CLI requests remain accepted. Refusals
are typed `GatewayError` bodies with stable `invalid_host` or `invalid_origin`
codes, and the same rule runs on HTTP and WebSocket upgrades.

## Supervision posture at 1.0.0-rc.0

`SuperviseRuntime` is a declared seam, not an installed feature. The package ships `make`, `makeNoop`, and `layerNoop` only, and the no-ops are closed stubs: unless a host overrides them, scanning returns no candidates and resuming performs no work. Nothing here watches for a run whose owner died, so a run abandoned through the gateway is not automatically discovered, reclaimed, or resumed.

Recovery is a reclaim rather than a supervisor. A run becomes reclaimable once the heartbeat its owner stopped renewing is older than 30 seconds, and any running `smthrs` process with the flow registered takes it over. Bring up a host composition running the durable engine driver with the relevant flows registered, or recover the run explicitly.

```ts
import { SuperviseRuntime } from "@smthrs/gateway"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const runtime = yield* SuperviseRuntime.SuperviseRuntime
  return yield* runtime.scan(Date.now())
}).pipe(Effect.provide(SuperviseRuntime.layerNoop()))
```

`@smthrs/gateway/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

The concrete Bun adapter serves the same protocol without a Node sidecar:

```ts
import * as BunGateway from "@smthrs/gateway/bun/BunGateway"

const server = BunGateway.layer(health, { host: "127.0.0.1", port: 7331 })
// Supply the same Control, Projections, SyncServer and SyncAuth layers.
```

`bun/BunGateway` supports TCP host/port binds. Platform adapters share one private
policy/router implementation; neither adapter automatically advertises coding
capabilities. Those belong to a configured host after its catalog and workspace
binding have been validated.
