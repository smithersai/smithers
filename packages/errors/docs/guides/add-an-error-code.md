---
title: "Add an error code"
description: "The procedure for adding a sixth code: decide whether it belongs here at all, add the row, update the tests and the reference page, then verify."
sidebar:
  order: 4
---

The vocabulary is closed, so a sixth code exists only once this package's
source carries it. This guide is for a contributor to Smithers or to a fork of
it. Adding a code changes a vocabulary other packages branch on, so the first
step is deciding not to.

## Decide whether the code belongs here

Add a code only when an integration adapter in
[`@smthrs/integrations`](/api/integrations) raises it. That is the entire
membership rule.

If the failure belongs to any other package, state it as a `Schema.TaggedError`
class on the effect that can fail. That is the convention everywhere else in
Smithers, and it gives you a checked failure channel instead of a string a
caller has to look up.
[The closed code vocabulary](../concepts/error-codes.md) has the reasoning.

If an existing code already fits, use it. A failure that a caller handles the
same way as `INVALID_INPUT` does not need a code of its own; it needs a better
summary and, where there is a field to name, a `details` key.

## Add the row

`smithersErrorDefinitions` in [`src/ErrorCode.ts`](../../src/ErrorCode.ts) is
the runtime source of truth. Add one row:

```ts
export const smithersErrorDefinitions = {
  // ...
  YOUR_CODE: {
    when: "The condition that raises it, in one sentence a caller can act on.",
    details: "The shape of the details record, or omit the field when there is none."
  }
} as const satisfies Record<string, SmithersErrorDefinition>
```

`SmithersErrorCode` and `smithersErrorCodes` are both derived from the keys, so
the type and the runtime list update themselves. No other source file changes.

Write `when` as the condition, not as the fix. The fix belongs in the reference
page, where there is room for it.

## Update the tests

Three tests in [`SmithersError.test.ts`](../../test/SmithersError.test.ts) pin
the vocabulary:

- One asserts the sorted code list, and fails until you add your code to the
  expected array.
- Two walk the table and require a non-empty `when` on every row, and a
  non-empty `details` string on every row that declares one. A row you filled
  in passes both without an edit.

If your code's `details` string is one a caller must be able to rely on, add an
assertion for it next to the two that already pin `INVALID_INPUT` and
`TELEGRAM_INIT_DATA_INVALID`.

## Update the documentation

The code list is hand-maintained in three places, and none of them derives from
the runtime table:

- [Error code reference](../reference/error-codes.md): add a summary row and a
  section with the meaning, current construction sites, the `details` each attaches, and
  what the caller should do.
- [Overview](../README.md): add the code to its list of five.
- The [package README](../../README.md), which is what npm renders: add a row
  to its code table.

Each page on this site carries an "Edit this page" link to its source file on
GitHub.

The reference section is the one that earns its length. A caller who has caught
your code needs to know which call produced it and what to do next, and
`when` alone cannot carry that.

## Verify

The repository is a pnpm workspace. From `packages/errors` in a clone of
[smithersai/smithers](https://github.com/smithersai/smithers):

```bash
pnpm test
pnpm check
pnpm lint
```

Then update every caller. A closed union means an exhaustive `switch` over
`error.code` becomes a type error the moment your row lands, which is the
friction the closed vocabulary is for.
