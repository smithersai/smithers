---
title: "Build limits"
description: "Why Graph.build refuses an oversized plan instead of overflowing the stack, the ten exported bounds and the codes they refuse with, and what a build costs inside them."
sidebar:
  order: 4
---

`Graph.build` walks structure two different parties control. An author writes
one declaration; an agent generates another. Neither is trusted to be small.
Without bounds, a deep declaration overflows the host stack and a wide one
exhausts memory, and both failures arrive as a crash with no useful name
attached.

So every axis is bounded, every bound is exported, and crossing one produces a
`GraphBuildError` naming the node or the value path that crossed it.

## The ten bounds

| Constant                        | Value   | Bounds                                                        | Refuses with        |
| ------------------------------- | ------- | ------------------------------------------------------------- | ------------------- |
| `Graph.maximumGraphDepth`       | 512     | Nested node structure.                                        | `graph_too_deep`    |
| `Graph.maximumPayloadDepth`     | 128     | Nesting inside one reflected plan value.                      | `payload_too_deep`  |
| `Graph.maximumGraphNodes`       | 4,096   | Nodes, synthesized lane merges included.                      | `plan_too_large`    |
| `Graph.maximumGraphEdges`       | 65,536  | Edges, conflict and lane-merge edges included.                | `plan_too_large`    |
| `Graph.maximumGraphConflicts`   | 65,536  | Recorded write conflicts.                                     | `plan_too_large`    |
| `Graph.maximumPayloadMembers`   | 100,000 | Members one plan value expands to, summed across every level. | `payload_too_large` |
| `Graph.maximumEffectPaths`      | 1,024   | Read and write paths, summed, in one declaration.             | `plan_too_large`    |
| `Graph.maximumPlanEffectPaths`  | 65,536  | Effect paths admitted across the whole plan.                  | `plan_too_large`    |
| `Graph.maximumEffectPathLength` | 4,096   | UTF-16 code units in one effect path.                         | `plan_too_large`    |
| `Graph.maximumEffectGlobs`      | 128     | Patterns, entries ending in `*`, in one read or write list.   | `plan_too_large`    |

These five codes are thrown by `Graph.build`, not recorded in
`Graph.diagnostics`. A plan that crosses a limit is not an invalid plan to
inspect; it is a plan the package declined to materialize.

## Where the numbers come from

`maximumEffectPathLength` is 4,096 because that is `PATH_MAX` on Linux, the
longest path a supported host can open. No path that names a real file is
refused by it.

`maximumPayloadMembers` counts everything one plan value expands to: object
keys, array items and holes, map entries, set and chunk values, and bytes. A
flow call's input and a declaration body are budgeted separately, and the
effect paths of a flow placed inside a plan value count as that value's
members.

Schema identity uses the same budget as its containing value. The walk counts
AST records, structural child arrays, annotations, checks, transformation links,
and the schema identity wrappers. Recursive ASTs use references to active
ancestors; repeated non-recursive children are charged at each occurrence.
Structural depth is checked before generating JSON Schema. The generated
document then counts against the remaining member budget and the same depth
limit, including its `schema` and `definitions`. Document limit failures remain
typed build errors even when JSON Schema generation supports a fallback.

`maximumPlanEffectPaths` counts a declaration where it is declared and again at
every work node that inherits it as its effective envelope, because each such
node is a writer the conflict pass compares. That is why the plan-wide bound is
64 times the per-declaration one rather than equal to it.

`maximumEffectGlobs` is 128 for a cost reason worth knowing. A pattern's prefix
is located by binary search, at most 16 comparisons over a plan at
`maximumPlanEffectPaths`, each comparison reading up to
`maximumEffectPathLength` code units. 128 patterns keeps that term below the
sort that admits a full list of literal paths, while still letting one
declaration name a subtree per package of a large monorepo.

## Every limit is checked before it allocates

A limit that fires after the structure it guards has been built protects
nothing. So each one is read from the cheapest available fact, first:

- An array-backed declaration is refused by its lengths, without reading a
  member.
- A caller-assembled iterable, which has no length to refuse by, is copied one
  path at a time and refused as soon as it exceeds the limit.
- A path's length is read before any character of it is scanned, so an
  over-long path costs one property read.
- Whether an entry is a pattern is read from its last character as it is
  admitted, so a pattern past the limit costs one character read.

## What a build costs inside the limits

Inside the bounds the cost is bounded on every axis an author or an agent
controls.

Each distinct effect path is scanned once for a dot segment and sorted once, so
the character work of a build is at most `maximumPlanEffectPaths` paths of
`maximumEffectPathLength` code units, plus the comparisons that sort them. As a
concrete figure, 64 writers of 1,024 such paths sharing a 4,000-character
prefix build in about one second on an idle developer machine. A loaded machine
takes two to three times longer; the bound is the contract, not the figure.

Pattern matching does not change the shape of that cost. A pattern's prefix is
located once by binary search, patterns nested under another collapse into the
outermost before the paths they cover are enumerated, and every match after
that is an integer comparison. `Effects.overlaps` therefore costs the two
declarations plus their matches, however many patterns nest: two declarations
of 1,024 nested patterns overlap in milliseconds.

`Effects.narrow` inside a build prepares each envelope once, putting its exact
entries in a set and collapsing its covering patterns to disjoint sorted
prefixes, then checks every enclosed node against the prepared form. An
envelope of 1,024 longest paths narrowed by 4,095 nodes builds in well under a
second.

The write-conflict pass marks candidate pairs from one index of every writer's
paths, so disjoint literal writers cost linear time and each recorded
conflict's overlap is computed at most once. Its pattern term is one step per
path a pattern covers per writer holding that path: at most
`maximumGraphNodes` times `maximumPlanEffectPaths` steps for a plan of
universal writers, about two seconds before the conflict limit refuses it. The
widest shared-literal conflict set the limits admit, 362 writers sharing 181
paths under `onConflict: "fail"`, builds in about two seconds including its
65,341 diagnostics.

## Where to go next

- [Troubleshooting](../troubleshooting.md): what to change when a build refuses
  your plan.
- [Effect envelopes](./effects.md): the declarations these bounds are mostly
  about.
