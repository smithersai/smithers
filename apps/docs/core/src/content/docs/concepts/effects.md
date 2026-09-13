---
title: "Effect envelopes"
description: "How a declaration says what it reads and writes, the coverage grammar behind that claim, how a step narrows the envelope it inherits, and what the planner does with two writers of the same path."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/concepts/effects.md"
---

An effect declaration is a claim: this flow, or this step, touches these
resources and no others. The planner does two things with the claim. It checks
that a step stays inside the envelope it inherited, and it compares every pair
of writers to find the ones that would race.

Both happen at plan time, on data. Nothing here opens a file or asks a host
what a path means.

## What a declaration says

```ts
import { Effects } from "@smthrs/core"

const envelope = Effects.make({
  reads: ["src/**"],
  writes: ["out/**"],
  mode: "expected",
  onConflict: "serialize",
  tier: "compensable"
})
```

| Field             | What it means                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `reads`, `writes` | The paths and patterns this declaration claims. Normalized into sorted, duplicate-free arrays.      |
| `mode`            | `hermetic` means these are all of them. `expected` means these are the ones worth declaring.        |
| `onConflict`      | What the planner should do about another writer of the same path: `serialize`, `lane`, or `fail`.   |
| `tier`            | How reversible the effect is: `sealed`, `compensable`, or `irreversible`. Absent reads as `sealed`. |

`Effects.make` normalizes, and normalization is exactly sorting and
deduplication. It performs no separator rewriting and no dot-segment
resolution, because those rules belong to a host that knows what the paths
name. Hand it paths that are already normalized.

## The coverage grammar

`Effects.covers(envelope, path)` answers whether one envelope entry covers one
path. The grammar is short and exhaustive, and deliberately not minimatch:

| Entry             | Covers                                                       |
| ----------------- | ------------------------------------------------------------ |
| `out/report.json` | Exactly itself.                                              |
| `*` or `**`       | Everything.                                                  |
| `out*`            | Every path starting with `out`, including `out` itself.      |
| `out/**`          | `out/` and everything below it, but not the bare path `out`. |

```ts
Effects.covers("out/**", "out/report.json") // true
Effects.covers("out/**", "out") // false
Effects.covers("out*", "out") // true
```

One rule overrides all of them: a path containing a whole `.` or `..` segment
is never covered. A declaration that names `out/../secret.txt` therefore fails
its envelope check with `effect_outside_envelope` rather than quietly
escaping through an unresolved segment. The escape is refused, not resolved.

`Effects.overlaps` is stricter about the same paths in the opposite direction:
two writers naming the identical literal path always overlap, dot segments
included. An unnormalized path escapes no envelope, and two writers of it are
still detected as writing the same resource.

## Narrowing, not widening

An envelope is inherited lexically. A flow's declaration is the envelope for
everything inside its body, and a node's declaration narrows the envelope for
everything under that node. A step may claim less than it inherited; it may
never claim more. `Effects.narrow(envelope, step)` checks the three rules and
`Graph.build` applies the same check at every enclosed node:

| Rule                                                                           | Violation                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Every read and write path must be covered by the matching envelope list.       | `effect_outside_envelope`, with the uncovered paths. |
| `expected` may tighten to `hermetic`; `hermetic` may not loosen to `expected`. | `effect_mode_widening`.                              |
| The tier may narrow: `irreversible`, then `compensable`, then `sealed`.        | `effect_tier_widening`.                              |

For a flow call, a `Node.withEffects` annotation must narrow the caller's
envelope. The callee's own declaration must then narrow that call envelope.
The body inherits the resulting restriction, including reads, writes, mode
and tier. Missing declarations inherit the preceding envelope; an annotation
cannot hide a broader callee declaration.

All three are fatal diagnostics: a graph carrying one has no key material,
because a step that claimed more than it was granted is not a step this package
will let a host key and cache.

`Flow.sealed()` is the shorthand at the strict end. It returns a copy of the
flow whose declaration is `hermetic` and `sealed`, and a flow with no
declaration gets an empty one with those two values.

## Only work nodes conflict

Just one node kind is a writer for conflict purposes: `Dynamic`, the
model-backed step. A container such as `All` or a flow call carries a
declaration that narrows the envelope for its children and enters that
container's own identity, but it is not counted a second time against the
children it encloses.

The practical consequence is worth stating plainly: a plan built entirely from
`Node.succeed` records no conflicts, however its declarations overlap, because
it contains no work. Conflict analysis needs `Node.dynamic` nodes, or flows
whose bodies reach them.

## Two writers of the same path

When two work nodes' effective write declarations overlap, the planner records
a `Conflict` naming both nodes and the overlapping paths, and picks one
strategy from the two declarations. The stricter one wins: `fail` beats `lane`,
and `lane` beats `serialize`.

**`serialize`** adds a `conflict` edge from the first writer to the second, so
a scheduler runs them in a fixed order instead of at the same time. The graph
stays valid and keys fine.

```text
{ nodes: [ 'root.all.a', 'root.all.b' ], paths: [ 'out/report.json' ], strategy: 'serialize' }
```

**`lane`** gives each writer its own lane and synthesizes one `LaneMerge` node
downstream of both. Each writer gets an implicit lane id derived from its node
id when it declared none, `lane-merge` edges join both to the merge, and the
conflict records the merge node's id:

```text
{
  nodes: [ 'root.all.a', 'root.all.b' ],
  paths: [ 'out/report.json' ],
  strategy: 'lane',
  mergeNodeId: 'lane.merge.0'
}
```

**`fail`** records a `write_conflict` diagnostic. It is fatal, so
`Graph.keyMaterial` refuses the graph. This is the right choice when two
writers of one path is a bug in the declaration, not a scheduling problem.

## Lanes are vocabulary, not a scheduler

`Node.lane`, `Annotations.Lane`, and the synthesized `LaneMerge` node are
plan-time vocabulary. No runtime in this release executes a lane, and the
elaboration deliberately stops at this package's boundary. Treat a lane as a
declaration a future scheduler may honor, not as a guarantee that two writers
will be isolated.

## Where to go next

- [Declare what a step reads and writes](/guides/declare-reads-and-writes/):
  the procedure, with each diagnostic and its fix.
- [Build limits](/concepts/limits/): what bounds a declaration's paths and patterns,
  and why.
