---
title: "Assert what a run journaled"
description: "Read an engine journal in index order and assert on steps, ordering, terminal status, and journaled external effects, then attribute the first difference between two journals."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/testing/docs/guides/assert-a-journal.md"
---

A journal is the durable evidence a run leaves behind, and it is the only
evidence that survives a restart. `JournalAssertions.expectJournal` reads a
list of `JournalEntryLike` entries and answers about them.

## Assert on one journal

```ts
import { JournalAssertions } from "@smthrs/testing"
import * as Effect from "effect/Effect"

const check = Effect.gen(function*() {
  const journal = JournalAssertions.expectJournal(yield* engine.journal(executionId))

  yield* journal.executed("read")
  yield* journal.executedInOrder(["read", "review", "publish"])
  yield* journal.terminal("completed")
})
```

Entries are sorted by `entry.index` before anything is answered, never by the
order the caller supplied them. Ordering is data: an engine that reads its
journal from a store with no `ORDER BY`, or a caller that filtered and
re-concatenated, hands over the same entries in another order, and every
assertion must still answer about the same entry.

Two details about the vocabulary:

- `executedInOrder` asserts the keys appear as a **subsequence**. Every key in
  turn, in that relative order, with any other entries allowed between and
  around them. It is not a contiguous match and not an exhaustive one.
- `terminal` asserts the outcome of the entry with the highest `index`, which
  is `completed`, `aborted`, `failed`, or `suspended`.

`journal.prefix(untilIndex)` returns the raw entries up to and including an
index, for a test that wants to assert something this vocabulary does not
cover.

## Assert on a journaled external effect

`journal.effect(key)` answers about journaled **effect** entries only. An
ordinary step entry that happens to share the key never satisfies them: it
fails with `effect_kind_mismatch`.

```ts
yield * journal.effect("publish").atLeastOnce()
yield * journal.effect("publish").journaledAtMostOnce()
yield * journal.effect("publish").idempotencyKey("publish-1")
```

That separation is the whole point of the sub-vocabulary. A journal carrying
the key only as an ordinary step fails `journaledAtMostOnce` with
`effect_kind_mismatch` rather than passing on zero effect entries. Passing
would let a test claim an at-most-once external effect was journaled when the
engine journaled no effect at all under that key, which is the exact claim the
vocabulary exists to make.

A key that appears nowhere still satisfies `journaledAtMostOnce`: nothing was
journaled more than once.

`idempotencyKey` reports three distinct situations with three distinct codes:
`effect_not_executed` when the effect never ran, `missing_idempotency_key` when
an entry carries none, and `idempotency_key_mismatch` when it carries a
different one.

## Exactly-once always fails, on purpose

```ts
yield * journal.effect("publish").exactlyOnce()
// Effect.fail(ExactlyOnceUnsupportedError)
```

An engine can prove at-least-once delivery and at-most-once journaling. It
cannot prove exactly-once external effect execution. The method is kept and
kept failing so the test vocabulary cannot claim a guarantee the engine does
not provide.

## Attribute a difference between two journals

`Divergence` answers "where did these two runs first differ?", which is the
question a replay or a fixture regression actually asks.

```ts
import { Divergence } from "@smthrs/testing"

const identical = Divergence.assertNoDivergence(recorded, replayed)
```

`Divergence.firstDivergence` returns an `Option` of the first differing entry:
its `index`, the `field` that differed, and both values.
`Divergence.assertNoDivergence` is the same comparison as an assertion, failing
with `FixtureDivergenceError`.

Every field a `JournalEntryLike` carries is compared, `index` included. Values
are compared through a shared canonical rendering that distinguishes two
different `Date`s, a `Map` from a `Set`, `-0` from `0`, `NaN` from `Infinity`,
and ordinary records from internal special-value markers. Record and array
accessors are compared by getter/setter identity without invoking them. Cycles
use markers; sparse array holes remain distinct from `undefined`.
Objects at the 128-level depth limit or whose inspection throws, such as
revoked proxies, compare by process-local reference identity.

Rendering journal values does not throw. A differing value fails with
`FixtureDivergenceError`. This comparison accepts values that fixture JSON
cannot store: the fixture encoder rejects accessors and sparse array holes
with `FixtureEncodingError` (`unsupported-type`). Journal entries themselves
must still satisfy the `JournalEntryLike` data shape.

CI callers must report a divergence rather than silently re-recording the
fixture. A re-record turns a regression into a green run and deletes the
evidence.

## Related

- [The engine subject seam](/concepts/engine-subject/) describes the entry
  shape and why `index` is carried explicitly.
- [`@smthrs/journal`](https://journal.smithers.sh/reference/api/) owns the production journal and its
  `TestJournal` double; see [its testing page](https://journal.smithers.sh/guides/testing/).
