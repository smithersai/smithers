---
title: "State and event authority"
description: "Bounded identities, versioned engine history, explicit consumer admission, and the limits of projection recovery."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/journal/docs/concepts/state-event-authority.md"
---

The journal owns committed history. Engine stores still own executable run,
attempt, deferred and clock state. The additive `EngineEvent` contracts make
history safer to consume; they do not move recovery into the journal.

| Durable concern                           | Authority                        | History relationship                                           |
| ----------------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| Control admission, approvals and signals  | Control records and local events | Separate outbox and receipt contract.                          |
| Execution, attempts, deferreds and clocks | Engine-owned stores              | State and required events share a `DurableWriter` transaction. |
| Ownership leases and fences               | Arbitration store                | Never restored from an old projection.                         |
| Engine history and time-travel evidence   | Typed journal families           | Consumers validate family, version, source and lineage.        |
| Cache and artifacts                       | Validated content and provenance | Cache loss does not erase authoritative completion.            |
| UI and listing summaries                  | Read projections                 | Rebuildability must be demonstrated for each projection.       |

## Shared boundary primitives

`JournalEvent` exports `RunId`, `LineageId`, `WaitId`, `CommandId`, `PlanId`,
`DispatchId` and `ArtifactId`. Each offers a validating `.make(value)`
constructor and a named Effect decoder, such as `decodeRunId(unknown)`.
Identifiers preserve bytes, require 1 through 1,024 UTF-16 code units, and
refuse NUL and unpaired surrogates. Plan, dispatch and artifact brands are
distinct, even when their encoded strings happen to match.

`NonNegativeQuantity` and `TimestampMs` admit safe integers from zero through
`Number.MAX_SAFE_INTEGER`. `PositiveQuantity` starts at one. Fractions,
infinity, string coercion and missing-value defaults are refused. Existing
journal sequences retain their stricter exclusive upper bound.

## Engine families and consumer admission

`@smthrs/journal/EngineEvent` keeps the journal's generic envelope open while
defining two version-2 families:

| Event type                          | Typed payload                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `flows.engine.v2.attempt-lifecycle` | Execution, dispatch, attempt number and running, suspended, succeeded or failed lifecycle. |
| `flows.engine.v2.state-event`       | Execution lifecycle, deferred completion or an absolute clock schedule.                    |

Both payloads require version, run, lineage id, root run, round and parent
where applicable. The committed journal envelope supplies global sequence,
source identity, source sequence and emission time. Root runs have round zero
and no parent; derived runs name a distinct parent and root. A continuation
requires a positive round. Diagnostic `meta` is encoded JSON and grants no
semantic authority.

`decodeEntry(input, consumer)` requires an explicit expected run, lineage,
root, round, parent and source allowlist. It returns a typed `Attempt` or
`State`. Conflicting identity fails `EventError` with code `foreign`.
Malformed supported families fail `malformed`, preserving the original
schema or accessor error in `cause`. Unsupported families and versions in
`flows.engine.*` fail `unsupported`. Other namespaces follow the consumer's
explicit `unknown: "ignore" | "surface"` policy. Source and run admission
still applies to those extensions.

Running and suspended attempts cannot contain completion fields. A terminal
attempt requires its timestamp and a matching encoded success or failure.
Failure reasons distinguish typed error, defect, interruption and encoding
failure. Values must be JSON after the value's own codec has run; a class
instance accepted by `Schema.Unknown` is not an encoded result. Wall clocks
can move backwards, so completion timestamps need not exceed start time.
Suspended executions require at least one typed wait; completed executions
require a result. Ownership and cancellation remain separate facts.

## Node and plan records

Two executors drive a graph: the plan scheduler and the flow interpreter. Both
write the same six records, and `EngineEvent` publishes a schema for each so a
reader decodes one shape rather than guessing per writer.

| Event type                       | Typed payload                                                    |
| -------------------------------- | ---------------------------------------------------------------- |
| `flows.engine.plan-recorded`     | `PlanRecordedPayload`: the flow, the generation, the node count. |
| `flows.engine.subgraph-appended` | `SubgraphAppendedPayload`: the ids a generation or a page added. |
| `flows.engine.node-scheduled`    | `NodeScheduledPayload`: the node, its kind, attempt and tag.     |
| `flows.engine.node-settled`      | `NodeSettledPayload`: the outcome, the attempts, the join.       |
| `flows.engine.node-invalidated`  | `NodeInvalidatedPayload`: the re-keying and the reason for it.   |
| `flows.engine.node-reconciled`   | `NodeReconciledPayload`: the verdict for one deviation.          |

`nodes` on a plan record is the node COUNT it has always been. The node list
rides beside it as `graph`, optional and paged, because a journal entry has a
byte bound and a record that clipped its list would lose nodes silently.
`graph.edges` is optional for the same reason a fact is optional anywhere here:
a plan names its edges through each node's `dependsOn` and knows no reason for
them, while an interpreted graph knows the reason it drew each one.

A node's `declaredAt` is where its action was written. It is repo-relative by
contract and the schema refuses an absolute path: a journal is read on machines
that did not write it, so an absolute path is at best noise and at worst an
operator's home directory published into a run's history. A writer that cannot
make a path relative omits the field. `EngineEvent.relativePath(root, path)` is
how a writer obeys that rule: it answers the path relative to the root, or
nothing at all for a path outside the root, for no root, and for a root that
names the whole filesystem. Every writer of a declaration site uses it, the
engine's node records and a control plan card alike.

The five settlement words are `built`, `clean`, `failed`, `skipped` and
`deferred`. `clean` means a recorded result served the node and no executor
ran, which covers same-run durable replay as well as a cross-run cache hit.

A settlement's `attempts` is the executor's own count. For the plan scheduler
it is the node's; for the interpreter it is the highest durable attempt any of
the node's dispatches ran as, because the interpreter settles each node once
and a retry happens underneath it inside one dispatch.

`stepKeyDigests` is the join. An attempt record carries a step key digest and
no node id, so before it an attempt belonged to no node and "attempt 2" could
not be attributed. A settlement now names the distinct step keys its node
dispatched under, and an attempt record belongs to the node of the same
execution whose settlement claims its digest. A retried dispatch keeps ONE
digest, because the attempt is folded into no key, so the list counts
dispatches and not attempts. A node that dispatched nothing records an empty
list, which is a different statement from a writer that derives no digests and
omits the field.

`result` is what the node settled with: the success value for `built` and
`clean`, the typed failure for `failed`. It is a bounded, redacted `preview`
of the value's JSON, the `bytes` of the encoding that preview was cut from,
and a `truncated` flag that is also the warning that the text is a prefix of
JSON and no longer parses. The writer redacts before it truncates, because
cutting first can split a credential across the boundary and the textual rules
would no longer recognise what is left; a value too large to redact at all is
named by the size of its own encoding, with an empty preview. A writer that
kept no summary omits the field.

## Additive cutover and retained history

Current engine writers are unchanged. `decodeCurrentAttempt` validates their
actual started/finished markers, using the recorded metadata lineage. It does
not invent a root, round, timestamp or result absent from an old row. That
adapter is explicitly separate from version-2 admission. Generic store
extension points remain generic.

A writer cutover must persist complete lineage and completion evidence,
introduce the new family identity, and write state plus event in the same
transaction. Old histories retain their original bytes and decoder. Backfill
requires authoritative state evidence and an explicit migration; an old
finished marker alone cannot backfill a result. No database column or journal
migration is needed for the additive schemas themselves.

The engine's additive attempt projection demonstrates full-history and
snapshot-plus-suffix equality against real attempt rows at 2 and 70 attempts.
Its tests drop the projection in a subprocess, kill that process, reopen
SQLite with a fresh connection and rebuild it. A version-2 snapshot binds its
rows to lineage and a covering sequence; duplicate identities, foreign runs
and rows past the covering sequence are refused. Compaction requires that
validated snapshot before reading the surviving suffix.

This proof covers the disclosed attempt projection. Journal redaction can
change result content, so it does not prove executable recovery of arbitrary
private values. Retain the authoritative stores, their backup, and operational
fences. A concrete sync consumer still owns atomic snapshot application and
its applied cursor. Extending retention to a public sync projection requires
its own authorization and retention policy.
