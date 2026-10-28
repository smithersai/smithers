import { Action, Flow, RetryPolicy } from "@smthrs/flow"
import { Node, Placement } from "@smthrs/plan"
import { Schema } from "effect"
import { Opened } from "./schema"

// `terminal/open { branchId, terminalId, cols, rows }` (decision 0013 §2, docs/features/branch-workspace.md#the-terminal):
// asks ChatApi to open the person's terminal on a branch's machine. ChatApi admits it and starts the remote
// `terminal/Open`, which wakes the machine and starts the shell; the terminal's row says when it is open. A terminal is
// the person's own shell, so only the person opens one: the agent runs commands as jobs instead (decision 0005).

/**
 * ChatApi refused the open: signed out (`sign_in`), not a Member (`forbidden`), a locked branch (`locked`), no such
 * branch (`not_found`), or a request it couldn't read (`invalid`).
 */
export class TerminalOpenRefused extends Schema.TaggedError<TerminalOpenRefused>()(
  "@smthrs/mvp/terminal/TerminalOpenRefused",
  { reason: Schema.Literals(["sign_in", "members_only", "forbidden", "locked", "not_found", "invalid"]) },
) {}

/** ChatApi couldn't open the terminal now: unreachable, or Postgres or the remote host didn't answer. */
export class TerminalOpenUnavailable extends Schema.TaggedError<TerminalOpenUnavailable>()(
  "@smthrs/mvp/terminal/TerminalOpenUnavailable",
  {},
) {}

/** What opening can fail with. */
export const OpenFailure = Schema.Union([TerminalOpenRefused, TerminalOpenUnavailable])
export type OpenFailure = typeof OpenFailure.Type

const Uuid = Schema.String.check(Schema.isUUID())
const payload = {
  branchId: Uuid,
  terminalId: Uuid,
  cols: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
}

/**
 * While ChatApi is unreachable or restarting, the step tries again: 500 ms doubling to 8 s, for at most 2 minutes. The
 * same terminal's id again is the same open, so a request that landed before is answered as it was.
 */
export const OPEN_RETRY = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 8_000,
  expirationMs: 2 * 60_000,
  nonRetryable: ["@smthrs/mvp/terminal/TerminalOpenRefused"],
})

/** The step: ask ChatApi to open the terminal. */
export const RequestOpen = Action.make("terminal/open/request", {
  payload,
  success: Opened,
  error: OpenFailure,
  retryPolicy: OPEN_RETRY,
})

/** `terminal/open { branchId, terminalId, cols, rows }`: opens the person's terminal on a branch's machine. */
export const TerminalOpenRequest = Flow.make("terminal/open", {
  description: "Open the person's own terminal on a branch's machine. Answers { terminalId }: the one asked for, or " +
    "the person's terminal already open there.",
  modelInvocable: false,
  payload,
  success: Opened,
  error: OpenFailure,
  body: Node.capture({ action: RequestOpen.name }, (request) => RequestOpen.call(request)),
}).annotate(Flow.Placement, Placement.client())
