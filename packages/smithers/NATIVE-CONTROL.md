# Native control composition

Configured native module hosts and the ordinary Node CLI share one private `internal/NativeControl` factory. It composes the existing Control, Registry, AgentSession, executable catalog, flow runtime, workspace routing, memory and gateway services. It does not define a new public control service or persistence model.

## Inject the platform at the boundary

The Node boundary chooses the existing NodeRuntime, NodeDatabase, NodeJj, Node HTTP gateway and rebuildable Undici model transport. The private Bun boundary chooses BunRuntime, BunDatabase, BunJj, Bun HTTP gateway and Bun's existing fetch RequestExecutor. Bun does not expose a replaceable Undici dispatcher; its transport retains that existing platform limitation. Both use Effect platform filesystem, path, process and crypto services. Compatible process containment and descriptor-relative filesystem equipment is shared. Neither a Node sidecar nor a direct `node:sqlite` import exists in the Bun composition.

`@smthrs/gateway/bun/BunGateway` is a new concrete platform adapter API. Its TCP `layer(health, options)` and authenticated `bearerPrincipal` match the existing Node gateway protocol. The private router and policy are shared. Host binding, Origin/Host checks, bearer credentials, HTTP RPC, WebSocket RPC, projections and health semantics therefore have one implementation.

The control database is materialized once in the host scope. Runtime, journal, memory and admission readers reuse the captured SqlClient and DurableWriter. Asynchronous platform directory creation sits inside a memoized Layer.suspend boundary, so repeated consumers cannot construct independent client graphs. Native execution retains its existing separate engine database and native journal. Module registration receives those native engine services; AgentSession receives the captured control journal for approval and run lifecycle events.

## Admit the owning module host

The private `ModuleAdmission` predicate reads the existing native agent/run wrapper, its associated control run and approved plan, and the live registry. An ordinary CLI without a matching configured executable catalog must leave intact module work for its owning host. A frozen catalog or delegate mismatch also refuses adoption. Catalogs are pinned to the process lifetime; deploying a new module definition requires restarting the configured host. Source changes or removal after approval retain AgentSession's explicit approved-source failure, since a host restart cannot repair that invalid plan. The existing sweeper retries parked work after final registration installs the routing policy. No extra timer, connection, lease table or execution-ID naming convention participates in this decision.

The private `WorkspaceRouting` reader uses captured existing SQL clients. It refuses routing that relies on an uncommitted workspace fork identity or unfinished audit. Failed reads leave work parked. Plue separately provides one lifetime OS lock per bound workspace: shared root budget accounting assumes one configured coding executor at a time, including gateway replacement overlap.

## Preserve native revision ownership

The generic factory obtains the existing `Jj` service from its injected platform. The configured coding host supplies `flows/coding/snapshots.ts`: the private Plue adapter implements snapshot, restore and diff through the contained spawner. A snapshot retains an exact immutable commit ID in the existing receipt's `changeId` field while remaining on the same native JJ Change. Its label belongs to the journal. Restore validates ownership and the recorded parent before applying that preimage; a stable Change ID alone is not a snapshot receipt.

Compensable standard file tools use this existing snapshot contract. The coding host also wraps the already guarded filesystem with native path eligibility checks, including the final destination of a Preserve rename. Newly ignored or otherwise untrackable writes are refused before mutation; ignored tracked paths use native eligibility. This does not make arbitrary shell execution rollback-safe. Native coding flow actions remain the explicit owners of new Changes and restacking.

## Keep authority in the existing runtime


Module handlers intentionally account approved root usage in the native execution journal. This is separate from control lifecycle events. Authority refusal runs around registered execution, outside the action retry ladder, and becomes an honest terminal result. The shared root allowance map lives in the host scope and has no arbitrary capacity limit that could defect on a valid root. Detached module children are unsupported: module work must stay under the approved live root and its shared budget lifetime.

Model-backed native actions receive the existing AgentAction.Host, assembled from the same guarded sources, registry and cell limits as AgentSession. This adds an existing service to the ModuleRegistration dependency union; it does not introduce a second model or tool host.

## Observe native evidence through the control journal

The same host scope owns EngineJournalSupervisor. It captures native services before AgentSession selects the control journal, wraps accepted launch/resume operations, and recovers existing observations at startup. Control completion keeps its real status while the UI waits for a matching projection-settled marker. Observation reuses existing journals and generation markers; it creates no store, polling service or public endpoint.
