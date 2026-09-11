---
title: "API reference"
description: "Every public export of @smthrs/gateway: the assembled server and its Node host, the served read path, the wire schemas and folds, the RPC group, the diagnosis renderer, the failure vocabulary, and the supervision port."
---

The gateway declares `effect` and `@effect/platform-node` as exact
`4.0.0-rc.112` peers; `@effect/platform-node` is optional and only
`node/NodeGateway` imports it. Use the same Effect version in the host.

The root entry point exports one namespace per module, and every local module is
also importable from `@smthrs/gateway/<Module>`.

A UI depends on this package and on [`@smthrs/control`](/api/control). It never
depends on [`@smthrs/engine-store`](/api/engine-store), and it never reads a
store table: a projection is the contract, and a store row is an implementation
detail. [`smthrs serve`](/cli/serve) composes the assembly with
`@smthrs/control` and [`@smthrs/sync`](/api/smithers-sync) to host it.

The model behind these signatures is in [Projections](./concepts/projections.md),
[Subscriptions and cursors](./concepts/subscriptions.md), and
[The trust boundary](./concepts/trust-boundary.md).

## `GatewayServer`

The whole HTTP surface as one application layer a host serves.

### Mounts

`GatewayServer.layer` mounts seven routes, and `NodeGateway.layer` binds them
to a socket.

| Path                | Protocol           | Serves                                          |
| ------------------- | ------------------ | ----------------------------------------------- |
| `POST /rpc`         | RPC over HTTP      | `@smthrs/control` `ControlRpcs`                 |
| `/rpc/ws`           | RPC over WebSocket | `ControlRpcs`, including a kept-alive `Watch`   |
| `POST /projections` | RPC over HTTP      | `GatewayRpcs`                                   |
| `/projections/ws`   | RPC over WebSocket | `GatewayRpcs`, including `Projection.Subscribe` |
| `POST /sync`        | RPC over HTTP      | `@smthrs/sync` `SyncRpcs`                       |
| `/sync/ws`          | RPC over WebSocket | `SyncRpcs`                                      |
| `GET /health`       | JSON               | `GatewayServer.Health`                          |

### Types and constants

| Export                       | Signature                                                                                            | Meaning                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `Health`                     | `Schema.Struct` and its type                                                                         | What `GET /health` answers: `GatewaySchema.GatewayHealth` plus the `version` of the package serving it.         |
| `LayerOptions`               | `{ heartbeatMillis?: number; ingress?: IngressOptions }`                                             | How an assembled gateway is configured. `heartbeatMillis` re-times both the `Watch` and projection keepalives.  |
| `IngressOptions`             | `{ maxRequestBodyBytes?: number; loopbackOnly?: boolean; authorize?: (headers) => Effect<boolean> }` | The ingress policy the RPC mounts run behind.                                                                   |
| `rpcPaths`                   | `ReadonlyArray<string>`                                                                              | `["/rpc", "/projections", "/sync"]`: the `POST` mounts that carry RPC request messages.                         |
| `protectedPaths`             | `ReadonlyArray<string>`                                                                              | `["/projections", "/sync", "/rpc/ws", "/projections/ws", "/sync/ws"]`: paths that pass edge authentication.     |
| `defaultMaxRequestBodyBytes` | `number`                                                                                             | 1,048,576. The default maximum request body accepted by an RPC mount.                                           |
| `loopbackHostNames`          | `ReadonlyArray<string>`                                                                              | `["127.0.0.1", "localhost", "::1"]`: the names that mean this machine only, as a bind address is spelled.       |
| `loopbackHostHeaderNames`    | `ReadonlyArray<string>`                                                                              | `["127.0.0.1", "localhost", "[::1]"]`: the same names as a Host header spells them; the default `allowedHosts`. |
| `watchHeartbeatKind`         | `"control.gateway.heartbeat"`                                                                        | The `ControlEvent` kind a `Watch` keepalive carries.                                                            |

`POST /rpc` is deliberately not in `protectedPaths`, and `GET /health` is
deliberately unauthenticated. Both decisions, and the alias handling behind
`routedPath`, are explained in
[the trust boundary](./concepts/trust-boundary.md).

### Layers

| Export                      | Signature                                                                   | Provides                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `layer`                     | `(health: Health, options?: LayerOptions) => Layer<..., GatewayError, ...>` | The whole surface. Fails with `bind_failed` for a non-positive cadence or body limit.                    |
| `layerHealth`               | `(health: Health) => Layer<never, never, HttpRouter>`                       | The unauthenticated `GET /health` probe.                                                                 |
| `layerHandlers`             | `Layer<Handler<...>, never, Control \| Projections>`                        | The gateway's own RPC handlers over the read path and the approval mutation.                             |
| `layerControlHttp`          | `(millis?: number) => Layer<RpcServer.Protocol, never, ...>`                | `/rpc` and `/rpc/ws`, with the keepalive merged into `watch`.                                            |
| `layerProjectionsHttp`      | `Layer<RpcServer.Protocol, never, ...>`                                     | `/projections` and `/projections/ws`. Both protocols mount together so they cannot disagree.             |
| `layerSyncHttp`             | `Layer<RpcServer.Protocol, never, ...>`                                     | `/sync` and `/sync/ws`.                                                                                  |
| `layerIngress`              | `(options?: IngressOptions) => Layer<...>`                                  | The global middleware: local Host/Origin policy, edge authentication, body limit, and RPC-message check. |
| `layerKeepAlive`            | `(millis?: number) => Layer<Control, never, Control>`                       | Wraps the ambient `Control` so `watch` emits a keepalive when idle.                                      |
| `layerProjectionsKeepAlive` | `(millis: number) => Layer<Projections, never, Projections>`                | Wraps the ambient `Projections` so a followed subscription beats at the bind's cadence.                  |

`layerKeepAlive` wraps the service rather than re-declaring handlers, which
keeps `@smthrs/control` `ControlServer` the single definition of what every
procedure does, including the principal it stamps on mutations.

### Functions

| Export              | Signature                                                                                     | Answers                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `routedPath`        | `(url: string) => string`                                                                     | The mount a request target reaches, spelled the way `rpcPaths` and `protectedPaths` spell it.          |
| `exceededBodyLimit` | `(error: unknown) => boolean`                                                                 | Whether a failed body read hit the configured size limit rather than failing for another reason.       |
| `bodyRefusal`       | `(path: string, maxBytes: number, error: unknown) => { error: GatewayError; status: number }` | 413 `request_too_large` for an overflow, 400 `malformed_request` for every other read failure.         |
| `carriesRpcRequest` | `(serialization: RpcSerialization["Service"], body: string) => boolean`                       | Whether a body carries at least one RPC message the server can act on. A binary framing is always yes. |

## `node/NodeGateway`

The Node host: bind policy, credential policy, and the socket.

| Export                 | Signature                                                                                                                                             | Meaning                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ServerOptions`        | `ListenOptions & { allowedHosts?: readonly string[]; listen?: boolean; credential?: string; heartbeatMillis?: number; maxRequestBodyBytes?: number }` | Bind address, explicitly admitted Host names, authentication, and request limits.                                         |
| `defaultServerOptions` | `ServerOptions`                                                                                                                                       | `{ host: "127.0.0.1", port: 7331 }`: loopback, no credential.                                                             |
| `isLoopbackHost`       | `(host: string) => boolean`                                                                                                                           | True for `127.0.0.1`, `::1`, and `localhost`, and nothing else.                                                           |
| `bindRefusal`          | `(options: ServerOptions) => GatewayError \| undefined`                                                                                               | The typed `bind_failed` refusal a requested bind earns, or `undefined` when it is allowed.                                |
| `listenOptions`        | `(options: ServerOptions) => Effect<ListenOptions, GatewayError>`                                                                                     | The admitted `node:net` options, with this module's own fields removed, or that refusal in the error channel.             |
| `ingressOptions`       | `(options: ServerOptions) => GatewayServer.IngressOptions`                                                                                            | The Host policy for a bind: the loopback names, `allowedHosts`, and the concrete bind host; a wildcard bind adds nothing. |
| `layerAuth`            | `(options: ServerOptions) => Layer<ControlRpcs.ControlAuth>`                                                                                          | Bearer authentication when a credential is configured, and the loopback-only local operator when none is.                 |
| `bearerPrincipal`      | `Readonly<{ id: string; kind: string }>`                                                                                                              | The frozen `{ id: "gateway", kind: "bearer" }` identity stamped by shared-bearer authentication.                          |
| `layer`                | `(health: GatewayServer.Health, options?: ServerOptions) => Layer<..., GatewayError, Control \| SyncAuth \| SyncServer \| Projections>`               | The assembled gateway on a Node HTTP server.                                                                              |

`layer` supplies the bind policy, the shared-credential authentication both RPC
mounts run under, and newline-delimited JSON as the wire serialization. The
caller supplies `Control`, `Projections`, `SyncServer`, and `SyncAuth`. The
returned layer retains the concrete `HttpServer` service, so a caller that
bound port 0 can read the ephemeral address it got. Policy refusals and
operating-system listen failures both fail the layer as sanitized `bind_failed`
values.

### Bind and credential policy

Two rules decide whether a bind is allowed, and both fail closed.

1. A non-loopback host requires an explicit `listen` opt-in.
2. A non-loopback bind requires a bearer credential.

A loopback bind with no credential is allowed and is the local default. One
shared bearer authenticates every mount as `bearerPrincipal`. This does not
grant approval authority. The owning Control runtime must explicitly delegate
the allowed approval target kinds and scopes through `ApprovalAuthority`;
without that delegation, bearer approve and deny requests are unauthorized.
Every holder of the shared credential has the same delegated authority. See
[Serve beyond loopback](./guides/serve-beyond-loopback.md).

Without that bearer, `NodeGateway.layer` enables `loopbackOnly`: every request
must carry a loopback `Host`. With or without a bearer, a supplied browser
`Origin` must be a canonical HTTP(S) origin whose host and port equal the
request's `Host`; serve a browser client from the gateway's origin or through a
same-origin proxy. An Origin-less CLI request remains accepted. The same guard runs on HTTP and WebSocket
upgrades before any mount handles them.

## `Projections`

The read path, served as bounded snapshots and followed deltas.

| Export                    | Signature                                                                                                      | Meaning                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Projections`             | `Context.Service` tagged `@smthrs/gateway/Projections`                                                         | The service tag the mounts read through.                                                                           |
| `Service`                 | `{ snapshot; subscribe }`                                                                                      | Read-path operations served by the gateway.                                                                        |
| `Service.snapshot`        | `<S extends ProjectionSelector>(selector: S, after?: ProjectionCursor) => Effect<SnapshotOf<S>, GatewayError>` | Current rows, or the run-events suffix after `after`, with the current cursor.                                     |
| `Service.subscribe`       | `<S extends ProjectionSelector>(selector: S, after?: ProjectionCursor) => Stream<FrameOf<S>, GatewayError>`    | A snapshot followed by deltas and keepalives, or, with `after`, the deltas after that cursor alone.                |
| `make`                    | `(control: ControlService, options?: { heartbeatMillis?: number }) => Effect<Service, GatewayError>`           | Builds the read path over a control plane. Invalid settings are `bind_failed` failures; construction never throws. |
| `layer`                   | `Layer<Projections, GatewayError, Control>`                                                                    | The read path over the ambient control plane, at the default cadence.                                              |
| `layerWith`               | `(options: { heartbeatMillis?: number }) => Layer<Projections, GatewayError, Control>`                         | The same under an explicit keepalive cadence.                                                                      |
| `heartbeatIntervalMillis` | `30_000`                                                                                                       | How often an idle subscription emits a keepalive frame.                                                            |
| `maxWorkspaceRuns`        | `500`                                                                                                          | The most runs one workspace projection folds. Equals `ControlSchema.maxPageSize`.                                  |
| `maxEventsPerRun`         | `10_000`                                                                                                       | The most journal events one run projection admits.                                                                 |
| `maxProjectionBytes`      | `4 * 1024 * 1024`                                                                                              | The largest encoded event history, or projected row set, one run admits.                                           |

`ControlService` is `@smthrs/control` `Control`'s service interface, the shape
the tag carries.

## `GatewaySchema`

The wire schemas the read path and its subscriptions speak. Every entry is an
`effect` `Schema` with a same-named type. Every schema here is served: the
gateway mints, reads, or answers with each one.

### Identity

| Export          | Fields                                          |
| --------------- | ----------------------------------------------- |
| `GatewayHealth` | `workspaceHash`, `gatewayId`, `protocolVersion` |

### Selectors

| Export                  | Shape                                    |
| ----------------------- | ---------------------------------------- |
| `ProjectionName`        | the seven served projection names        |
| `WorkspaceRunsSelector` | `{ _tag: "workspace-runs" }`             |
| `RunSummarySelector`    | `{ _tag: "run-summary", runId }`         |
| `RunEventsSelector`     | `{ _tag: "run-events", runId }`          |
| `TranscriptSelector`    | `{ _tag: "transcript", runId }`          |
| `RunTreeSelector`       | `{ _tag: "run-tree", runId }`            |
| `ApprovalsSelector`     | `{ _tag: "approvals", runId? }`          |
| `NodeOutputSelector`    | `{ _tag: "node-output", runId, nodeId }` |
| `ProjectionSelector`    | the union of the seven                   |

`ApprovalsSelector` without `runId` lists the workspace's pending gates, which
is the approvals inbox. With one it lists that run's gates including the decided
ones, which is what a run card renders.

`rowSchemaFor<S extends ProjectionSelector>(selector: S)` answers the schema of
the rows that selector projects, so a client decodes a snapshot instead of
casting it. A literal selector keeps its own row: `rowSchemaFor({ _tag:
"approvals" })` is `ApprovalRow`, not the union of every row. `RowOf<S>` is that
row's type.

### Cursors, snapshots, and frames

`Projection.Snapshot` accepts optional `after: ProjectionCursor` for
`run-events` only. It returns rows strictly after that sequence and offset,
with the current journal cursor. An unchanged journal returns no rows.
The cursor must belong to the same selector and run and cannot be ahead of
the journal. Other selectors with `after` return `malformed_request`.
Omit `after` for the full snapshot and when no journal rows are retained:
the empty cursor `0:0` also names the first sequence-zero event.
This bounds transferred rows; the gateway still reconciles the full source
journal before producing the suffix.

| Export               | Shape                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| `ProjectionCursor`   | `{ selector, projection, runId: string \| null, value: int, offset: int }` |
| `ProjectionSnapshot` | `{ selector, cursor, rows }`, correlated on the selector                   |
| `SnapshotStartFrame` | `{ _tag: "snapshot-start", selector, cursor }`                             |
| `RowFrame`           | `{ _tag: "row", selector, cursor, row }`                                   |
| `SnapshotEndFrame`   | `{ _tag: "snapshot-end", selector, cursor }`                               |
| `DeltaFrame`         | `{ _tag: "delta", selector, cursor, delta }`                               |
| `HeartbeatFrame`     | `{ _tag: "heartbeat", atMs }`                                              |
| `GatewayFrame`       | the union of all five frame kinds                                          |

`ProjectionSnapshot`, `RowFrame`, and `DeltaFrame` are unions correlated on the
selector, so a payload whose rows do not belong to its selector does not decode.
One table in `GatewaySchema` pairs each selector with its row, and those three
unions, `ProjectionName`, and `rowSchemaFor` all derive from it.
`runId` is `null` for a workspace cursor, whose `value` is always 0, because
control journal sequences belong to per-run partitions and no workspace-wide
sequence exists.

`SnapshotOf<S>` is the snapshot one selector answers with and `FrameOf<S>` the
frames its subscription emits, so a literal selector keeps its own rows. A
selector chosen at runtime maps to the full `ProjectionSnapshot` and
`GatewayFrame` unions, which is what it can be answered with.

## `GatewayProjection`

The stable wire rows and the pure folds that compute them. Nothing here exposes
a store row, a database column, or an engine type.

### Rows

| Export          | Carries                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunSummaryRow` | `runId`, `flowId`, `status`, `createdAt`, `updatedAt`, the optional plan, lineage, waiting, steering, cancellation, and seat fields, the activity and token counters, `verdict`, `diagnosis`, and `finalOutput`. |
| `RunTreeRow`    | `runId`, `nodeId`, `label`, `status` (`running`, `completed`, `failed`), `seat?`, `startedAt`, `endedAt?`, `parentRunId?`.                                                                                       |
| `ApprovalRow`   | `runId`, `requestId`, `title`, `request`, `payload` (the `ControlSchema.ApprovalPayload` a client submits back), `requestedAt`, `status`.                                                                        |
| `NodeOutputRow` | `runId`, `nodeId`, `outcome` (`success` or `failure`), `output`, `settledAt`.                                                                                                                                    |
| `TranscriptRow` | `runId`, `sequence`, `turn`, `at`, `kind`, `text`. Each `text` is one display line.                                                                                                                              |

### Folds

| Export       | Signature                                                              | Notes                                                                                                       |
| ------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `runSummary` | `(run: ControlSchema.RunSummary, events) => RunSummaryRow`             | Status comes from the run row, everything else from the events.                                             |
| `runTree`    | `(run: ControlSchema.RunSummary, events) => ReadonlyArray<RunTreeRow>` | Keys each call by the ordinal it opened on; pairs a settlement with the oldest open call of that flow name. |
| `approvals`  | `(events) => ReadonlyArray<ApprovalRow>`                               | A decision closes the gate its `tokenId` names; one naming neither field closes the oldest pending gate.    |
| `nodeOutput` | `(events) => ReadonlyArray<NodeOutputRow>`                             | Keyed the way `runTree` keys its rows, so both agree on a node id.                                          |
| `transcript` | `(events) => ReadonlyArray<TranscriptRow>`                             | One row per `control.run.*`, `control.agent.*`, and approval-request event, numbered by turn.               |

Every fold takes `ReadonlyArray<ControlSchema.ControlEvent>` in run order and is
total: an unknown kind contributes nothing.

## `GatewayRpcs`

The gateway's own remote procedures. Control mutations are not re-declared here:
`@smthrs/control` `ControlRpcs` is the mutation contract, and the gateway mounts
it unchanged on `/rpc`. The group shares `ControlRpcs.ControlAuth`, so one
bearer credential authenticates both mounts.

| Procedure              | Payload                           | Success                | Error                                                                                                                                                                           |
| ---------------------- | --------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Projection.Snapshot`  | `{ selector }`                    | `ProjectionSnapshot`   | `GatewayError`                                                                                                                                                                  |
| `Projection.Subscribe` | `{ selector, after? }`, streaming | `GatewayFrame`         | `GatewayError`                                                                                                                                                                  |
| `Approval.Submit`      | `SubmitApprovalInput`             | `SubmitApprovalOutput` | `PlanDigestMismatch`, `EnvelopeMismatch`, `AlreadyResolved`, `PlanNotFound`, `RunNotFound`, `InvalidInput`, `Unauthorized`, `PersistenceError`, `Unavailable`, `TransportError` |

| Export                 | Shape                                                     |
| ---------------------- | --------------------------------------------------------- |
| `Decision`             | `"approve" \| "deny"`                                     |
| `SubmitApprovalInput`  | `ControlSchema.ApprovalPayload` fields plus `decision`    |
| `SubmitApprovalOutput` | `{ decision: ControlSchema.Receipt }`                     |
| `GatewayRpcs`          | the `RpcGroup`, with `ControlRpcs.ControlAuth` middleware |

`Approval.Submit` is the transport form of Control's single decision command.
Control records the decision and its durable resume delegation as one domain
command; the gateway never composes a second mutation, and its error union is
exactly the one `Control.approve` and `Control.deny` declare. See
[Submit an approval from a client](./guides/submit-an-approval.md).

## `Diagnosis`

What happened to a run, computed from that run's own control events. This is
the one fold both surfaces read: `@smthrs/cli` `Forensics` calls `digest` and
adds what a terminal card needs on top of it, so the served row and
[`smthrs status`](/cli/status) cannot disagree about a run's counts, refusals,
or clipping.

| Export      | Signature                                                  | Answers                                                                                                                            |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `Digest`    | interface                                                  | Status, cause, seat, turn and call counts, edits, refusals, tokens, final output, pending question, and the span the events cover. |
| `Refusal`   | `{ message: string; count: number }`                       | One refused flow call, aggregated by its message.                                                                                  |
| `Subject`   | `{ runId: string; flowId?: string }`                       | The identity a diagnosis is rendered for.                                                                                          |
| `RunStatus` | `ControlSchema.RunStatus`                                  | The run statuses a digest may report.                                                                                              |
| `digest`    | `(events) => Digest`                                       | The facts. Total: an unknown kind contributes nothing, including its timestamp.                                                    |
| `verdict`   | `(value: Digest) => string`                                | One line: the status plus the reason that most explains it.                                                                        |
| `duration`  | `(span: Pick<Digest, "startedAt" \| "endedAt">) => string` | The wall-clock span the handled events cover, as `12s` or `3m 04s`.                                                                |
| `render`    | `(subject: Subject, value: Digest) => string`              | The whole card: verdict, activity evidence, tokens, refusals, cause, and output.                                                   |
| `asRecord`  | `(value: unknown) => Record<string, unknown>`              | A wire payload as a record, or an empty record when it is not one.                                                                 |
| `asString`  | `(value: unknown) => string \| undefined`                  | A payload field as a string, or nothing.                                                                                           |
| `asNumber`  | `(value: unknown) => number \| undefined`                  | A payload field as a number, or nothing.                                                                                           |
| `timeOf`    | `(event) => number`                                        | When an event occurred: its payload's own stamp, else journal admission time.                                                      |
| `firstLine` | `(text: string) => string`                                 | The first line, whichever line ending produced it, so a CRLF cause loses its carriage return.                                      |
| `clip`      | `(text: string, width: number) => string`                  | Truncation on code points, never on UTF-16 code units, marking the cut with an ellipsis.                                           |

`RunSummaryRow.verdict` and `RunSummaryRow.diagnosis` are `verdict` and `render`
already applied, so a client rendering a run card calls neither. See
[Diagnose what happened to a run](./guides/diagnose-a-run.md).

## `GatewayError`

| Export             | Signature                                                                 | Meaning                                                                                     |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GatewayErrorCode` | nine literals                                                             | The whole failure vocabulary.                                                               |
| `GatewayError`     | `Schema.TaggedError` tagged `@smthrs/gateway/GatewayError`                | `{ code, message, cause? }`, where `cause` is a `{ _tag, code? }` summary and nothing more. |
| `settingRefusal`   | `(name: string, value: number \| undefined) => GatewayError \| undefined` | The refusal a numeric setting earns when it is not a positive safe integer.                 |

Every code is constructed by a real path, and the declared vocabulary is exactly
the set those paths produce.

| Code                | Status | Produced by                                                                                                                                              |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bind_failed`       | none   | `NodeGateway.bindRefusal`, `NodeGateway.listenOptions`, `GatewayServer.layer`, `GatewayServer.layerIngress`, and `Projections.make`, at composition time |
| `invalid_host`      | 421    | the ingress guard, when `Host` is not in `allowedHosts`, or under `loopbackOnly` does not name `localhost`, `127.0.0.1`, or `[::1]`                      |
| `invalid_origin`    | 403    | the ingress guard, when a supplied browser `Origin` is not a canonical HTTP(S) origin whose host and port equal the request's `Host`                     |
| `unauthorized`      | 401    | the ingress guard, on any protected path without the configured credential                                                                               |
| `malformed_request` | 400    | the ingress guard, for a `POST` body carrying no RPC request message or a body it could not read, and the read path, for an invalid resume cursor        |
| `request_too_large` | 413    | the ingress guard, for a body over the configured limit                                                                                                  |
| `resource_limit`    | none   | the read path, when one run or projected row set exceeds its event or encoded-byte allowance                                                             |
| `run_unavailable`   | none   | the read path, when listing runs, reading a run's events, or following a run or the workspace failed                                                     |
| `run_not_found`     | none   | the read path, for a run the control plane does not have, identically for every run-scoped selector                                                      |

`GatewayError.cause` carries only a redacted summary of an internal failure: its
tag and its stable code. Projection warnings log an allowlisted operation
identifier and known control error tag/code pairs. Backend messages, nested
causes, SQL, and file paths are omitted from projection logs.

## `SuperviseRuntime`

The host seam a supervisor would implement to recover abandoned work.

| Export                  | Signature                                                                                                                | Meaning                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `StaleRunningCandidate` | `{ _tag: "stale-running", run, livenessEvidence }`                                                                       | A running run whose owner is proven dead.                  |
| `QuotaDueCandidate`     | `{ _tag: "quota-due", run, resetAtMs }`                                                                                  | A quota-parked run whose reset time has arrived.           |
| `StaleClaimCandidate`   | `{ _tag: "stale-claim", run, claimantDeathEvidence }`                                                                    | A run whose unactivated claim holder is proven dead.       |
| `Candidate`             | the union of the three                                                                                                   | A run supervision may recover or resume.                   |
| `ResumeLease`           | `{ runId, claimant, candidate }`                                                                                         | A fenced request to resume one candidate.                  |
| `ResumeErrorCode`       | `"claim_lost" \| "resume_failed"`                                                                                        | Stable resume failures.                                    |
| `ResumeError`           | `Schema.TaggedError` tagged `@smthrs/gateway/ResumeError`                                                                | `{ code, message, cause }`.                                |
| `Service`               | `{ scan: (now: number) => Effect<ReadonlyArray<Candidate>>; resume: (lease: ResumeLease) => Effect<void, ResumeError> }` | Engine-facing supervision operations.                      |
| `SuperviseRuntime`      | `Context.Service` tagged `@smthrs/gateway/SuperviseRuntime`                                                              | The service tag.                                           |
| `make`                  | `(service: Service) => Service`                                                                                          | Constructs a supervision runtime.                          |
| `makeNoop`              | `(overrides?: Partial<Service>) => Service`                                                                              | No candidates, successful resumes, overridable per member. |
| `layerNoop`             | `(overrides?: Partial<Service>) => Layer<SuperviseRuntime>`                                                              | Provides that no-op.                                       |

A candidate names a run by its `@smthrs/control` `RunSummary` rather than by a
store row, which keeps the promise the rest of the package makes: a projection
is the contract and a store row is an implementation detail.

This release ships `make`, `makeNoop`, and `layerNoop` only. Nothing in the
package implements the seam, so unless a host passes its own `Service` the port
does nothing. Recovery is a reclaim rather than a supervisor: a running engine
process with the flow registered takes over a run whose owner stopped renewing
its heartbeat. See [Recovery](./troubleshooting.md#recovery).

## `Sync`

The root entry re-exports [`@smthrs/sync`](/api/smithers-sync) whole, so a gateway host
gets the read-only journal replication protocol from the same import:
`SyncClient`, `SyncServer`, `SyncProtocol`, `SyncRpcs`, `SyncError`,
`RunCatalog`, and the rest of that package's namespaces.

Sync is read-only in both senses: a follower cannot mutate a run, and it cannot
resume one. See [Sync and read-only followers](/docs/concepts/sync/).

## `test/TestSuperviseRuntime`

A controllable in-memory supervision runtime for tests.

| Export                        | Signature                                                                                                         | Meaning                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `TestSuperviseRuntimeOptions` | `{ candidates?: ReadonlyArray<Candidate>; resumeError?: ResumeError }`                                            | Its initial configuration.                             |
| `TestSuperviseRuntime`        | `{ runtime, resumes, setCandidates, setResumeError }`                                                             | The runtime plus the recorded leases and the controls. |
| `make`                        | `(options?: TestSuperviseRuntimeOptions) => TestSuperviseRuntime`                                                 | Constructs one.                                        |
| `layer`                       | `(options?: TestSuperviseRuntimeOptions, onReady?: (t: TestSuperviseRuntime) => void) => Layer<SuperviseRuntime>` | Provides one and hands the controls to `onReady`.      |

See [Test against a real gateway](./guides/testing.md).
