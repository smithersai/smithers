# Smithers Runtime Capability Contract

> Target repo: **jjhub** (`/Users/williamcory/jjhub`)
> Source: memo §3 · roadmap Phase 1

## Problem

Smithers runs execute in whatever environment the operator cobbles
together: raw host, bubblewrap, docker, sysbox, or a bespoke VM. There is
no shared contract for what a runtime must provide (filesystem,
suspend/resume, secrets, browser, VCS, network policy). The field report
spent most of its effort on runtime discovery rather than workflow
authoring.

## Goal

Publish a typed capability contract that Smithers requires of any
runtime, and make JJHub workspaces the reference implementation (see
jjhub/0002).

## Scope

### Contract (this ticket)

Define, in a doc + `.ts` interface, the runtime capabilities Smithers
uses:

```ts
interface SmithersRuntime {
  readonly id: string

  // Lifecycle
  start(spec: RuntimeSpec): Promise<RuntimeHandle>
  suspend(handle: RuntimeHandle): Promise<void>
  resume(handle: RuntimeHandle): Promise<void>
  stop(handle: RuntimeHandle, mode: "graceful" | "force"): Promise<void>

  // Filesystem + VCS
  fs: {
    read(path): Promise<Buffer>
    write(path, data, opts): Promise<void>
    persist(paths: string[]): Promise<PersistRef>  // snapshot
    restore(ref: PersistRef): Promise<void>
  }
  vcs: {
    backend: "jj" | "git"
    pointer(): Promise<VcsPointer>
    capture(label: string): Promise<VcsPointer>
  }

  // Execution
  exec(cmd: string, opts: ExecOpts): Promise<ExecResult>
  spawn(cmd: string, opts: ExecOpts): AsyncIterable<ExecChunk>

  // Browser (optional but declared)
  browser?: {
    newContext(opts: BrowserOpts): Promise<BrowserContext>
  }

  // Secrets + auth
  secrets: {
    set(name: string, value: string): Promise<void>
    withSecrets(names: string[]): ExecEnv  // never exposes raw values
  }

  // Network policy
  network: {
    policy: "open" | "denylist" | "allowlist"
    allow(host: string): Promise<void>
    deny(host: string): Promise<void>
  }

  // Observability
  logs(handle): AsyncIterable<LogChunk>       // stdout/stderr stream
  metrics(handle): AsyncIterable<MetricPoint> // cpu/mem/io
}
```

### Spec doc

`docs/runtime/contract.mdx` in jjhub:
- What each capability means (semantics, error modes).
- Which are required vs optional.
- How suspend/resume interacts with Smithers' lease model (0017) —
  suspended runtime = engine heartbeat paused, lease renewal suspended
  via server-side grace period.
- Failure domains: distinguish runtime failure from engine failure from
  tool failure.

### Conformance suite

`e2e/runtime-conformance/` — an executable test suite any runtime must
pass to claim compliance:

- FS persist/restore round-trip across suspend/resume.
- VCS pointer stable across suspend/resume.
- Secrets not readable from exec stdout even if caller tries.
- Network policy enforced (denylist mode blocks known host).
- Browser context survives suspend/resume.
- `exec` respects timeouts; `spawn` yields incremental chunks.
- Logs + metrics streams don't drop under load.

The suite is published as `@jjhub/smithers-runtime-conformance` so other
runtime authors (local, bwrap, docker) can run it.

## Files

- `packages/smithers-runtime/` (new package in jjhub)
- `packages/smithers-runtime/src/contract.ts`
- `packages/smithers-runtime/src/conformance/*.ts`
- `docs/runtime/contract.mdx`

## Testing

- Contract type-tests (type-level): given a `SmithersRuntime`, every
  method signature compiles.
- The conformance suite runs against a stub in-memory runtime to prove
  the suite itself is well-formed.

## Acceptance

- [ ] Contract published and versioned (`runtime/v1`).
- [ ] Conformance suite runs green against the stub.
- [ ] Failure-domain doc distinguishes runtime / engine / tool failures.
- [ ] Contract is imported, not redefined, by Smithers core.

## Blocks

- jjhub/0002 (implementation against JJHub workspaces)
- smithers side: runtime selection in `smithers.config.ts` depends on
  this; coordinate with smithers 0020 (`doctor run` checks runtime).
