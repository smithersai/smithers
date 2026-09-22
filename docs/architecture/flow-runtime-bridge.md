# Flow runtime bridge

The product backend admits work; the TypeScript Flow host executes it. The
boundary is `smithers.flow-runtime/v1` on `/runtime/v1/command` and
`/runtime/v1/observe`.

## Authority

| Fact | Authority | Backup |
| --- | --- | --- |
| Product request, actor, admission receipt | PostgreSQL | PostgreSQL backup and WAL policy |
| Flow plan, approval, steps, waits, cancellation, output, terminal status | TypeScript Control/engine journal | The owning host's durable state volume (`control.db`, `engine.db`, WAL companions) |
| Product run card/status | PostgreSQL projection of authenticated runtime receipts/events | Rebuild from product admission plus runtime replay |
| Executable identity | Packaged host SHA-256 and source revision | Release artifact plus digest sidecar; source repository revision |

Go does not read or edit runtime SQLite. A ready socket, successful HTTP
launch response, or exited host process is not a completed run. Completion is
only a canonical runtime projection with `completed`, `failed`, or
`cancelled`.

## Receipts and reconnect

Product admission is committed before launch. Runtime launch then returns a
canonical Control receipt and, when accepted, a runtime execution ID. The
product stores the application request ID, execution ID, delivery attempt,
owner generation, source revision, artifact digest, and last event cursor.

Reconnect calls `observe` strictly after the stored cursor. Runtime sequences
are monotonic; repeated pages and repeated command delivery are safe. Planning
is idempotent by application request. Launch delivery is idempotent by
application request plus attempt. Control owns action replay and Flow retries.

## Failure and uncertainty

- A lost launch acknowledgment remains pending. Reconciliation probes host
  identity, repeats the same attempt, then observes any returned execution.
- A version, artifact, source, or owner-generation mismatch refuses before
  execution. A new owner generation is a new fenced delivery attempt.
- Authentication is bearer-token based and required for every bridge request,
  including loopback. The token is never placed in request identity, receipts,
  health, logs, or errors.
- Approval, denial, signal, steer, cancellation, and resume are durable Control
  mutations. Interrupted callers repeat the same application request ID.
- An unreachable runtime is uncertainty, not failure. Product state remains
  pending/running until replay observes a canonical terminal status.
- Runtime event duplicates are discarded by `(runtime execution ID, sequence)`.
  A cursor gap is retried from the last committed cursor; it is never filled by
  inference.

## Ownership and deployment

One active process owns a runtime state directory. SQLite WAL files stay on
that process's durable local volume; replicas do not share them over a network
filesystem. The single-owner self-hosted adapter and Plue's isolated adapter
start the same packaged TypeScript artifact with the same protocol, credential,
source revision, owner generation, and durable-state contract. No runtime
bundle is fetched from GCS.

The trusted product host registers bundled declarations only. Repository code
is loaded only by the workspace execution host behind the deployment adapter;
the trusted product process never dynamically imports it.
