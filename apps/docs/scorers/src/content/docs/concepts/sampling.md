---
title: "Replay-stable sampling"
description: "Why a sampling decision is a pure function of the target step, the scorer key, and a seed, and what the length-prefixed UTF-8 hash protects against."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/scorers/docs/concepts/sampling.md"
---

Scoring every step of a long-running flow is often too expensive, so a binding
carries a sampling policy. The hard requirement is not the arithmetic. It is
that the same step reaches the same decision every time it is asked, in every
process, on every replay. A run that resumes after a crash must not grade a
step it already skipped, or skip one it already graded.

## The vocabulary has one spelling per intent

`Sampling` is a union of three shapes:

- `"all"`: grade every candidate step.
- `"none"`: grade nothing.
- `{ ratio, seed }`: grade a deterministic fraction, where `ratio` is finite
  and strictly inside the open interval `(0, 1)` and `seed` is a non-empty
  string.

The interval is open on purpose. A `ratio` of `0` or `1` would be a second
spelling for `"none"` and `"all"`, and two spellings of one intent are two
things to keep in agreement. The bound lives in the schema, so a policy
`Sampling.decide` would reject cannot be constructed and carried into a run.

## The decision is a pure function

`Sampling.decide(sampling, targetStepKey, scorerKey)` reads nothing but its
arguments. There is no counter, no random source, and no clock:

```ts
import { Sampling } from "@smthrs/scorers"
import { Effect } from "effect"

const decision = Effect.gen(function*() {
  return yield* Sampling.decide({ ratio: 0.25, seed: "2026-01" }, "greet/ada", exactMatch.scorerKey)
})
```

The three components are combined into length-prefixed material, hashed with
FNV-1a over its UTF-8 bytes, scaled into `[0, 1)`, and compared against the
ratio. A step samples when the hash is strictly less than the ratio. Because
the target step key and the scorer key are both durable identities, and the
seed is yours, the same tuple always answers the same way.

## Two encoding rules that look like details

Both rules exist because breaking either one produces silent collisions, and
golden hash vectors freeze both.

**The hash runs over UTF-8 bytes.** Reading UTF-16 code units with
`charCodeAt(0)` sees only the high surrogate of an astral code point, so every
emoji in the same 1024-code-point block would hash identically and step keys
containing them would share one decision.

**The components are length-prefixed, not delimiter-joined.** With a `":"`
join, `("a:b", "c", "d")` and `("a", "b:c", "d")` produce the same material and
therefore the same decision, for two unrelated steps. Length prefixing removes
every such collision, because no character inside a component can imitate a
boundary.

A change to either rule moves every ratio decision already taken downstream, so
the encoding is a contract rather than an implementation detail. A release that
changed it would be a data migration, and the changelog would say so.

## Choosing a seed

The same subset is guaranteed only when target, ratio, seed, and `scorerKey`
all match. Different scorer keys can produce different subsets even with the
same ratio and seed. For paired scorer comparisons, use one host-owned
selection reused for both scorers, or sample everything with `"all"`. When
the host selects a subset, use `"all"` for both scorers on those selected steps
so their individual sampling policies do not filter it again.

Change the seed to re-roll a fixed target and scorer's sampling decisions.
Pin a seed per campaign, such as a month or a release name, rather than
generating one per process: a fresh seed each run introduces nondeterminism.

Sampling is advisory as far as this package is concerned. Nothing here calls
`decide` on your behalf; [`@smthrs/evals`](https://evals.smithers.sh/reference/api/) does, once per candidate
step, before it builds the jobs it hands to a runner. Attaching the policy is
covered in
[Attach a scorer to a flow](/guides/attach-a-scorer-to-a-flow/).
