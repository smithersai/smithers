# HumanTask stringifies React prompts to `[object Object]`

## Problem

`HumanTask.prompt` accepts `string | React.ReactNode`, but the new durable
human-request path persists non-string prompts with `String(props.prompt)`. For
real JSX/MDX prompts, that collapses to `[object Object]` instead of readable
operator instructions.

## Evidence

`HumanTask` currently derives `promptText` like this:

- string prompts pass through unchanged
- everything else becomes `String(props.prompt ?? "")`

[src/components/HumanTask.ts](/Users/williamcory/smithers/src/components/HumanTask.ts#L46)

The rest of the human-request flow stores and renders that exact string in the
inbox:

- [src/effect/deferred-state-bridge.ts](/Users/williamcory/smithers/src/effect/deferred-state-bridge.ts#L129)
- [src/cli/index.ts](/Users/williamcory/smithers/src/cli/index.ts#L3525)

There is already a correct prompt-rendering path for normal tasks via
`renderToStaticMarkup()` in `Task.ts`:

- [src/components/Task.ts](/Users/williamcory/smithers/src/components/Task.ts#L88)

## Why this matters

1. Rich human prompts lose all useful content in the operator inbox.
2. The bug is silent: requests still exist and can be answered, but the human
   sees corrupted instructions.
3. This is a regression specific to the new durable request persistence path;
   plain string prompts keep working, so it is easy to miss in basic testing.

## Proposed solution

1. Extract the existing task prompt renderer into a shared helper and use it in
   `HumanTask`.
2. Preserve markdown/MDX prompt text instead of coercing React nodes with
   `String(...)`.
3. Add a test that creates a `HumanTask` with a JSX prompt and asserts the
   stored inbox prompt contains the rendered text, not `[object Object]`.

## Severity

**MAJOR** — operator-facing human prompts become unreadable for any non-string
workflow.

## Files

- [src/components/HumanTask.ts](/Users/williamcory/smithers/src/components/HumanTask.ts)
- [src/components/Task.ts](/Users/williamcory/smithers/src/components/Task.ts)
- [src/effect/deferred-state-bridge.ts](/Users/williamcory/smithers/src/effect/deferred-state-bridge.ts)
- [src/cli/index.ts](/Users/williamcory/smithers/src/cli/index.ts)
