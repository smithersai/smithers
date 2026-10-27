---
title: "Render a run status"
description: "Turn a status string into a pill, a stage strip, or a tinted surface using the shared vocabulary, and tell an unrecognized status apart from a deliberately neutral one."
---

A status arrives from a control plane as a plain string, and every Smithers UI
has to agree on what it means. This package owns that agreement: one table maps
a status spelling to a tone, one function humanizes it into a label, and the
components read both.

Reach for these helpers rather than writing a `switch` in each surface. A
hand-written mapping drifts, and two panels on the same page end up disagreeing
about what `succeeded-with-failures` looks like.

## Render a pill

`StatusPill` takes the raw string and derives everything else:

```tsx
import { StatusPill } from "@smthrs/ui"

<StatusPill status="waiting-approval" /> // a warning-tinted pill reading "Waiting for approval"
<StatusPill status="succeeded-with-failures" /> // "Completed with failures"
<StatusPill status={undefined} /> // a neutral pill reading "Unknown"
```

Override the text with `label` when the surface needs different words, and hide
the leading dot with `withDot={false}`. `CollapsiblePanel` renders a pill in its
header from the same `status` prop, so a panel and its rows never disagree.

## The five tones

`statusClass` buckets a status into one of five tones, and `statusColor` returns
the token expression that tone paints with:

| Tone    | Meaning                           | Examples                                                     |
| ------- | --------------------------------- | ------------------------------------------------------------ |
| `ok`    | Finished successfully             | `completed`, `succeeded`, `done`, `ready`, `fixed`, `closed` |
| `run`   | In flight                         | `running`, `active`, `streaming`, `retrying`, `launching`    |
| `warn`  | Waiting on the world, or partial  | `parked`, `waiting-approval`, `paused`, `partial`, `quiet`   |
| `bad`   | Failed                            | `failed`, `error`, `blocked`, `denied`, `stalled`, `stale`   |
| `muted` | Neutral, and the unknown fallback | `queued`, `pending`, `accepted`, `cancelled`, `stopped`      |

Matching is forgiving about spelling. `normalizeStatus` trims, lowercases, and
maps `_` to `-` before the lookup, so `WAITING_APPROVAL` and `waiting-approval`
are the same status. Any status starting with `waiting-` is a warning, whether
or not the table names it, which is what lets the control plane add a new wait
reason without a change here.

```ts
import { normalizeStatus, statusClass, statusColor } from "@smthrs/ui"

normalizeStatus(" WAITING_QUOTA ") // "waiting-quota"
statusClass("waiting-quota") // "warn"
statusColor("failed") // the danger token expression
```

## Tell "neutral" apart from "unrecognized"

`statusClass` answers `"muted"` for two different situations: a status the table
deliberately buckets as neutral, such as `queued`, and a status it has never
heard of. `hasStatusTone` is the distinction:

```ts
import { hasStatusTone, statusClass } from "@smthrs/ui"

statusClass("queued") // "muted"
hasStatusTone("queued") // true, deliberately neutral

statusClass("frobnicated") // "muted"
hasStatusTone("frobnicated") // false, the vocabulary does not know it
```

Use it when an unknown status should be surfaced rather than rendered as a
neutral pill, for example in a development build or a conformance check between
a producer and this table.

The lookup is safe against hostile input. Every table is a frozen
null-prototype container, so `statusClass("constructor")` returns `"muted"`
instead of resolving the `Object` constructor through the prototype chain, which
is truthy, survives `??`, and throws "Functions are not valid as a React child"
the moment it reaches the DOM.

## Stop polling on a terminal status

`isTerminalRunStatus` answers whether there is anything left to stream:

```ts
import { isTerminalRunStatus } from "@smthrs/ui"

const shouldPoll: boolean = !isTerminalRunStatus("parked")
```

It is a narrower question than `statusClass(status) !== "run"`. A parked run is
not running and is not terminal.

## Render a pipeline

`StageStrip` renders an ordered set of stages from the same vocabulary, and
`stageTone` is the mapping it uses:

```tsx
import { StageStrip } from "@smthrs/ui"

<StageStrip
  showSummary
  stages={[
    { label: "Plan", status: "completed" },
    { label: "Build", status: "running" },
    { label: "Review", status: "pending" }
  ]}
/>
```

`showSummary` adds a `done/total` header counted from the stages in a terminal
status.

## Label a status yourself

`formatStatus` is the humanizer, exported for surfaces that render text rather
than a pill:

```ts
import { formatStatus } from "@smthrs/ui"

formatStatus("waiting-approval") // "Waiting for approval"
formatStatus("succeeded-with-failures") // "Completed with failures"
formatStatus("no-capacity") // "No capacity"
formatStatus("frobnicated") // "Frobnicated", from the mechanical title-case fallback
formatStatus(undefined) // "Unknown"
```

A status with no entry falls through to a title-cased rendering of its own
spelling, so a new status reads sensibly before anyone adds a label for it.

## Import the vocabulary alone

Everything on this page is also available from `@smthrs/ui/status`, which
carries no React dependency. Reach for it from a non-React module that needs to
agree with the UI on what a status means:

```ts
import { isTerminalRunStatus, statusClass } from "@smthrs/ui/status"
```

## Related

- [Theme tokens](../concepts/theming.md): what the tone colors resolve to.
- [API reference](../api.md): the full export list.

A failed `StepInspector` shows its recorded attempt reasons above the tabs.
