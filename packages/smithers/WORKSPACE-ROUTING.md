# Portable history admission

`src/internal/WorkspaceRouting.ts` is the native host's private admission reader.
It accepts the control and engine `SqlClient` services already captured by the
host and uses Effect's injected `Path` service. It opens no SQLite connection,
creates no tables and imports neither `node:sqlite` nor `bun:sqlite`.

The internal composition is:

```ts
const routing = yield * WorkspaceRouting.make({ root, engine: engineSql, control: controlSql })
const allowed = yield * routing.canExecute(executionRoot, runId)
```

`workspaceFor(runId)` resolves the nearest explicit history-workspace route.
An unlinked fork refuses inherited routing; an ordinary root with no route stays
on the host root. `canExecute(workspace, runId)` also requires the bound fork's
committed control identity and every applicable history audit's applied marker.
A descendant's own control identity is insufficient. Cyclic ancestry produces a
typed private `WorkspaceRoutingError`, which the host must fail closed on.

The old synchronous exports in `src/history/Workspace.ts` remain for the existing
Node CLI. Their independent read-only handles observe committed control state.
The portable reader preserves that barrier: if a control transaction is ambient
and admission requires a control identity/audit check, it returns false rather
than accepting uncommitted writes or waiting on its own held connection. Ordinary
roots that need no control proof do not acquire that barrier. A caller can retry
after the control transaction commits.
An ambient engine transaction also refuses execution: a provisional route or
route deletion cannot grant entry before its transaction commits. The two clients
have distinct transaction tags, so a control transaction does not accidentally
select the engine connection or vice versa.

`test/WorkspaceRouting.test.ts` launches the same admission scenarios in actual
Node and Bun processes over each platform's existing database adapter. It checks
rollback and commit visibility, inherited and unlinked forks, complete audit
acknowledgment, cycle refusal and absence of read-side writes. These prove the
portable reader; they do not by themselves prove that the complete gateway host
runs on both platforms.
