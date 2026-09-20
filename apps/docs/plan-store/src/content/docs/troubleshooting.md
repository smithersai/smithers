---
title: "Troubleshooting"
description: "Every refusal @smthrs/plan-store raises, what causes it, and what to change: store errors, the append-only triggers, and the blocked migration paths."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan-store/docs/troubleshooting.md"
---

Every failure this package reports is typed and carries a code. Find the code
and read the matching section. The full error schemas are in the
[API reference](/reference/api/).

`PlanStoreError` is the one error type, raised by recording, appending, and
reading rows. A plan that fails before it reaches a row raises
[`@smthrs/plan`](https://plan.smithers.sh/reference/api/)'s `PlanError` or `KeyMaterialError` instead; its
[troubleshooting page](https://plan.smithers.sh/troubleshooting/) covers those.

## PlanStoreError

### invalid_plan

**What happened.** The plan does not satisfy what the operation requires:

- `record` accepts generation 0 only, whose `baseDigest` equals its `digest` and
  every one of whose nodes is at generation 0.
- `append` refuses a plan whose newest generation adds no nodes.
- Either can fail if a node is not encodable.

**What to change.** Pass the value `Plan.compile` or `Plan.append` returned. All
of these hold by construction; a plan that fails them was assembled by hand or
mutated after compiling.

### constraint

**What happened.** One of two checks in `append` refused.

The compare-and-swap matched no row:

```text
plan review-4821 was never recorded, or generation 3 was skipped or moved under the append
```

Either the plan was never recorded, another writer already advanced it, or the
generation you are appending is not the next one.

The persisted-prefix check found divergence:

```text
plan review-4821 recorded plan's nodes diverge from the plan this append was grown from
```

Two callers elaborated the same recorded plan independently, and this one is
grafting nodes onto a history it never saw.

**What to change.** Read the stored plan with `get`, append to that value, and
retry. Both refusals roll the whole transaction back, so no partial rows
survive, which matters because the append-only triggers mean stray rows could
never be removed.

`constraint` also covers a SQL uniqueness or constraint violation, including the
`(plan_id, ordinal)` uniqueness that keeps recorded node order deterministic.

### decode_failed

**What happened.** A stored row did not decode: either a `flows_plans` row or a
node's JSON.

**What to change.** The `flows_plans` CHECK constraints require nonempty digest
strings, not the stored-key syntax the row decoder requires, so a row written
outside this package can satisfy every constraint and still fail to decode.
Rows this package wrote always decode. Suspect a schema version older or newer
than the running code, or a database written by something else.

### persistence_failed and unknown

**What happened.** The SQL layer failed for a reason that is not a constraint
violation: the file is locked, the disk is full, the connection dropped.

**What to change.** Read `cause`, which carries the underlying error. These are
infrastructure failures, not contract violations.

## SQLite raises "a plan only grows"

**What happened.** A caller tried to rewrite plan history: an UPDATE or DELETE
of a node or edge row, a DELETE of a plan row, or an UPDATE of a plan row that
would change its id, flow, base digest, or creation time, or move its generation
backwards.

**What to change.** Grow the plan instead. `Plan.append` plus
`PlanStore.append` is the only supported way to add to a recorded plan, and
[Append a generation](/guides/append-a-generation/) covers it. Append-only is
enforced in SQL rather than by convention, because a plan an operator approved
has to be the plan the run executed.

## ERR_PACKAGE_PATH_NOT_EXPORTED for a migration step

**What happened.** Something imported `@smthrs/plan-store/internal/migrations/0001_initial`
or the path the steps once shipped from,
`@smthrs/plan-store/migrations/0001_initial`. The export map blocks the first and the
second does not exist, so Node reports `ERR_PACKAGE_PATH_NOT_EXPORTED` and
`ERR_MODULE_NOT_FOUND` respectively.

**What to change.** Import `@smthrs/plan-store/Migrations` and use `set`. A step
imported on its own would run outside the namespaced ordering
[`@smthrs/database`](https://database.smithers.sh/reference/api/)'s migrator relies on to decide what has
already been applied.
