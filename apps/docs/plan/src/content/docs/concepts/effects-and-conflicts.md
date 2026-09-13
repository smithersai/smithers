---
title: "Declared effects and conflicts"
description: "How declared reads and writes become ordering: the overlap pass, the reader-after-writer pass, the three verdicts, and the cycles both passes refuse."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/concepts/effects-and-conflicts.md"
---

Every node declares what it does to the workspace, as paths. Two plan-time
passes read those declarations and turn them into edges, so a scheduler never
has to guess whether two pieces of work can run at once.

```ts
import * as Plan from "@smthrs/plan/Plan"

const effects: Plan.NodeEffects = {
  reads: [{ _tag: "Glob", include: ["src/**/*.ts"] }],
  writes: ["dist/bundle.js"],
  removes: ["dist/stale.js"],
  boundaryMode: "hard"
}
```

Bare string entries are literal paths at both overlap analysis and execution,
even when they contain `*` or `**`. Wildcards belong in `Glob.include` and
`Glob.exclude`.

Measuring a path is run-time work, so a digest here would break the no-I/O law
that makes a plan reproducible.

## What a node produces

`removes` is optional, and a removal mutates the world exactly as a write does.
Both passes therefore fold `writes` and `removes` into one produced set. A path
declared as both is refused as `invalid_effects`, because the declaration
contradicts itself.

`boundaryMode` is `hard` or `expected`. It travels with the declaration into the
measured boundary at execution time; the plan passes do not interpret it.

## The overlap pass

Declared write sets make overlap detectable before anything runs. The pass
compares every pair of producing nodes and skips a pair the graph already
orders, including one ordered through an ordering edge this same pass just
inferred. Every other overlapping pair is annotated on both members with the
resolved verdict.

| Verdict     | Effect                                                                            |
| ----------- | --------------------------------------------------------------------------------- |
| `serialize` | The default. The later writer gains an ordering edge.                             |
| `lane`      | Both writers get lane annotations when either asks for one, and no ordering edge. |
| `fail`      | `compile` fails with `overlap_forbidden`, for flows that promise disjointness.    |

`fail` dominates `lane`, which dominates `serialize`. A flow that promised
disjointness must not be quietly serialized, and a pair where either side asked
for a lane must not be silently ordered.

Each annotation also carries the runtime strategy the pair resolved to, where
`stop-merge` dominates `delay-rebase`. That is what the scheduler does when the
predicted overlap actually bites.

A node states its own preferences on its draft, through `conflictStrategy` and
`runtimeStrategy`. The annotation is a property of the _pair_, not of one
declaration, which is why both preferences are recorded on the node and resolved
per pair.

Nodes frozen by an earlier generation are annotated on the new node only,
because their rows are append-only.

## The reader-after-writer pass

The overlap pass compares write sets against write sets, so a node that _reads_
a path another node _writes_ is ordered by nothing. Reader and writer could be
admitted in the same wavefront round; the reader would then measure pre-producer
bytes and, because the dispatch key honestly folds the digest it measured, cache
that wrong execution as a legitimate one.

The second pass closes that. A reader whose read set overlaps a producer's
produced set gains an ordering edge to the producer, unless the graph already
orders it there or an explicit `Ref`/`Pending` dependency path selects a read
before that writer.

Like a `serialize` edge, the edge enters `dependsOn` and never key material. The
reader computes the same result either way, and its content dependence is
already keyed by the hermetic boundary digests measured at dispatch.

## When an edge would close a cycle

An explicit `Ref`/`Pending` dependency path that orders the writer after the
reader is accepted, including a transitive path. It selects earlier bytes: the
initial source or an earlier producer's output. The pass preserves that order
instead of adding a reverse edge.

If only inferred producer or `serialize` edges order the writer after the
reader, there is no explicit selection of earlier bytes. Adding the required
reader-after-writer edge closes a cycle, so the plan is refused with `cycle`.
The message names the reader, the overlapping paths, the producer, and the
contradictory dependency chain. For example, if the chain contains inferred
edges and no declared-only path selects the earlier read:

```text
Plan cycle: node lint reads dist/bundle.js, which node bundle produces, so lint must
follow bundle, but bundle already depends on lint through bundle -> report -> lint
```

Reachability through declared `Ref`/`Pending` edges establishes explicit
sequencing. Declaration order alone does not select earlier bytes.

## Overlap is conservative

`FileSet.overlaps` answers `true` whenever two declarations _might_ share a
path. Over-serializing costs latency; under-serializing costs correctness, so
the comparison is deliberately asymmetric: `false` proves that no path can
belong to both declarations.

Two globs always overlap, and so do a glob and a tree artifact, because
comparing pattern languages exactly is not worth the risk of being wrong.

Exact paths compare in canonical form: every separator rewritten to `/` and
Unicode normalized to NFC. Without that, `dist\bundle.js` and `dist/bundle.js`
would be two spellings of one file that the overlap check could not see, which
is the same class of hole that `.` segments and empty segments would open.
[Declare the files a node touches](/guides/declare-file-effects/) covers the
vocabulary and the forms `workspaceRelative` refuses.

## What this buys the scheduler

A plan arrives at the scheduler with every predictable conflict already
resolved into an edge or an annotation. Two nodes with no path between them and
no annotation between them are safe to run at once, and that fact was
established before a single byte was read.

The annotations that remain describe the cases a plan cannot resolve alone: two
lane writers that a runtime has to keep apart, and the runtime strategy each
pair agreed on if the predicted overlap turns real.
