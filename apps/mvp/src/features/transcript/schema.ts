import { Schema } from "effect"

// A run's transcript as its socket delivers it and as this tab keeps it (decision 0141,
// docs/features/agent-transcripts.md#the-socket).

/**
 * One stored event: `n` is its place in the run's transcript (from 1, the replay cursor), `generation` and `seq` its
 * number on the runner, `at` when the runner received it (epoch ms), `kind` the agent's `sessionUpdate` or a runner's
 * `_smithers/*` kind, and the update itself.
 */
export const Row = Schema.Struct({
  n: Schema.Int,
  generation: Schema.Int,
  seq: Schema.Int,
  at: Schema.Number,
  kind: Schema.String,
  update: Schema.Record(Schema.String, Schema.Unknown),
})
export type Row = typeof Row.Type

/**
 * What the socket sends: `events`, in order (replay pages, then each event as it is stored), and once, after the
 * replay, `live` with the last event's `n` and the run's digest there, so the tab can check it holds the same events.
 */
export const Frame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("events"), events: Schema.Array(Row) }),
  Schema.Struct({ type: Schema.Literal("live"), n: Schema.Int, digest: Schema.String }),
])
export type Frame = typeof Frame.Type
export const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Frame))

/**
 * One thing the panel shows, folded from the events: a `message` (the agent's text, or a prompt it was given), a `tool`
 * call with its title and status, a `plan` as a checklist, the agent's `usage`, a `turn` that ended, or the session's
 * `end`. `order` is the `n` of its first event, so items keep the order they began in.
 */
export const Item = Schema.Struct({
  id: Schema.String,
  order: Schema.Int,
  kind: Schema.Literals(["message", "thought", "prompt", "tool", "plan", "usage", "turn", "end", "other"]),
  generation: Schema.Int,
  text: Schema.String,
  status: Schema.NullOr(Schema.String),
  entries: Schema.Array(Schema.Struct({ content: Schema.String, status: Schema.String })),
  at: Schema.Number,
})
export type Item = typeof Item.Type

/**
 * This tab's transcript panel. One row: the run it shows, its `phase` (`idle`, `connecting`, `replaying`, `live`,
 * `offline` while it dials again, `closed` for good with why), how many events it holds and the last one's `n`, the
 * digest of those events, whether that digest matched the run's at the end of the replay (`null` until then), and the
 * newest event's lag from the runner to this tab in ms.
 */
export const PANEL = "panel"
export const Panel = Schema.Struct({
  id: Schema.Literal(PANEL),
  runId: Schema.NullOr(Schema.String),
  phase: Schema.Literals(["idle", "connecting", "replaying", "live", "offline", "closed"]),
  closed: Schema.NullOr(Schema.Literals(["authentication", "forbidden", "not_found", "failed"])),
  events: Schema.Int,
  last: Schema.Int,
  digest: Schema.String,
  verified: Schema.NullOr(Schema.Boolean),
  lagMs: Schema.NullOr(Schema.Number),
})
export type Panel = typeof Panel.Type
