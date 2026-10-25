import { Schema } from "effect"
import { ENDED_REASONS, FAILURES, STATUSES } from "./contract"

// The branch terminal's rows (decision 0013 §3, docs/features/branch-workspace.md#the-terminal): Postgres'
// `terminal_sessions` as Electric delivers it, what `POST /api/terminals` answers, and this tab's view of its terminal.
// A terminal's bytes are never a row.

/** One row of Postgres `terminal_sessions` as Electric delivers it: columns in camelCase. */
export const TerminalRow = Schema.Struct({
  id: Schema.String,
  branchId: Schema.String,
  ownerId: Schema.String,
  ownerLogin: Schema.String,
  generation: Schema.NullOr(Schema.Number),
  status: Schema.Literals(STATUSES),
  endedReason: Schema.NullOr(Schema.Literals(ENDED_REASONS)),
  failure: Schema.NullOr(Schema.Literals(FAILURES)),
  /** While `opening`: no machine is free under the sandbox limits, and it waits for one (worker/branch/Budget.ts). */
  waiting: Schema.optional(Schema.Boolean),
  lastScreen: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
})
export type TerminalRow = typeof TerminalRow.Type

/** What `POST /api/terminals` answers: the terminal to attach to, the one asked for or the person's open one. */
export const Opened = Schema.Struct({ terminalId: Schema.String })
export type Opened = typeof Opened.Type

/** A refusal's body: its code. */
export const Refused = Schema.Struct({ code: Schema.String })

/**
 * This tab's terminal on the branch its page shows. One row:
 * - `loading`: terminal rows are unknown; `idle`: no terminal yet; `opening` while the machine wakes;
 * - `connecting`, `open` (with `access`), `offline` (reconnecting) while attached;
 * - `ended` with why, `failed` with why, or `no_access`.
 */
export const PANEL = "panel"
export const Panel = Schema.Struct({
  id: Schema.Literal(PANEL),
  branchId: Schema.NullOr(Schema.String),
  terminalId: Schema.NullOr(Schema.String),
  phase: Schema.Literals(["loading", "idle", "opening", "connecting", "open", "offline", "ended", "failed", "no_access"]),
  access: Schema.NullOr(Schema.Literals(["write", "read"])),
})
export type Panel = typeof Panel.Type

/**
 * One live terminal on the branch the panel shows, as its tabs list it: whose it is, whether it is this person's,
 * whether it is open yet, and whether it waits for a free machine.
 */
export const Tab = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  ownerLogin: Schema.String,
  mine: Schema.Boolean,
  status: Schema.Literals(["opening", "open"]),
  waiting: Schema.Boolean,
  createdAt: Schema.String,
})
export type Tab = typeof Tab.Type
