# Portable native control and authority

Configured native module hosts and the ordinary Node CLI share one private `internal/NativeControl` factory. It composes existing Control, Registry, AgentSession, executable catalog, flow runtime, workspace routing, memory and gateway services. It defines no new public control service or persistence model.

## Inject the platform at the boundary

Each boundary exports a `platform` record and calls `NativeControl.make(platform)`. The Node boundary selects NodeRuntime, NodeJj, the Node gateway and a rebuildable Undici model transport. The private Bun boundary selects BunRuntime, BunDatabase, BunJj, the Bun gateway and Bun's fixed fetch `RequestExecutor`, because Bun exposes no replaceable dispatcher. The Bun composition does not launch a Node sidecar.

The Node boundary's HTTP client and model transport respect the egress proxy named by the environment, so a host inside a default-deny sandbox reaches the network only through that proxy.

The control database is materialized once in the host scope and its SQL client is reused by runtime, journal, memory and admission readers. Native execution keeps its separate engine database and native journal. AgentSession receives the captured control journal for approval and run lifecycle events.

## Admit only the owning module host

`ModuleAdmission` runs before a run is claimed. It reads the native `agent/run` state, its associated control run and approved plan, and the live registry. A run whose plan, digest or approval does not match is refused. A configured executable whose execution digest differs, or whose delegate the approved envelope does not name, is also refused, so an ordinary CLI leaves that module work for its owning host. Unexpected read failures are logged and refuse admission.

Catalogs are pinned to the process lifetime; deploying a new module definition requires restarting the configured host.

## Keep authority in the existing runtime

Module handlers account approved root usage in the native execution journal, separately from control lifecycle events. Authority refusal runs around registered execution, outside the action retry ladder, and becomes a terminal result. Detached module children are unsupported: module work stays under the approved live root and its shared budget lifetime.

## Observe native evidence without replacing it

The same host scope owns `EngineJournalSupervisor`. It wraps accepted launch and resume operations and recovers existing observations at startup. Control completion keeps its real status while the UI waits for a matching projection-settled marker. A terminal status write is held for that marker for at most a 30 second grace; after that the status is written anyway. A run this host is not observing is not held.
