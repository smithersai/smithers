import type { BrowserEngine } from "@smthrs/platform-browser"
import type { Requested as IssueRequested, Sending as IssueSending, WriteRow } from "../issues/schema"
import type { Requested as TodoRequested, Sending as TodoSending, Todo } from "../todos/schema"
import { HOME_HREF, LISTED_FOR_MS, LOCAL_RECIPIENT } from "./contract"
import { timeOf } from "./entries"
import type { Dismissed, Notice, NoticeState } from "./schema"

// Background progress (decision 0124): what the toast stack shows for `/new`, Make TODO, Create issue and Commit, worked
// out from the receipts those operations already write, and nothing else. Pure: the feed's store runs it whenever a
// receipt changes. Each state has one authority, and the strongest receipt of a subject decides it:
//
//   server   the person's notification, folded with the result (it replaces every row here, by subject)
//   device   the engine's run; the server's write row; a recovery row the route answered; the outbox's row
//   tab      this tab's staged input: Requested while it is admitted, Failed once the outbox or the engine refused it
//
// A recovery row `not_sent` without a reason is the receipt kept before admission, not evidence of anything: no tab
// toasts it, and the page keeps showing it as Not sent. A tab never reads another tab's input, so it never infers
// failure from what it can't see. Rows here are the device's own: the stack shows them, a failed one is listed, and
// none carries a version an act could reach on the server.

/** One run of the engine's, as `BrowserEngine.runs` reads it. */
export type RunSummary = (typeof BrowserEngine.RunList.Type)["runs"][number]

/** One of this tab's staged inputs (src/writeAdmission.ts), with what this tab knows of its admission. */
export interface Input {
  readonly flow: string
  readonly executionId?: string | undefined
  readonly writeId?: string | undefined
  /** The payload's repository, `owner/name`, when it names one. */
  readonly repo?: string | undefined
  readonly stagedAt?: number | undefined
  /** The outbox or the engine took it: it can say Requested at most, never this tab's refusal. */
  readonly admitted: boolean
  /** An admission of it is running in this tab. */
  readonly admitting: boolean
  /** When this tab's latest admission of it was refused, if it was and none runs since. */
  readonly refusedAt?: number | undefined
}

/** Every receipt the stack reads. Recovery rows are only those the device has stored (`isSynced`). */
export interface Receipts {
  readonly inputs: ReadonlyArray<Input>
  readonly runs: ReadonlyArray<RunSummary>
  readonly issueWrites: ReadonlyArray<WriteRow>
  readonly issueRequested: ReadonlyArray<IssueRequested>
  readonly issueSending: ReadonlyArray<Pick<IssueSending, "id" | "op" | "repo" | "queuedAt">>
  readonly todoRequested: ReadonlyArray<TodoRequested>
  readonly todoSending: ReadonlyArray<Pick<TodoSending, "id" | "op" | "repo" | "queuedAt">>
  /** The synced TODOs the device holds of the repositories this device's commits went to: a commit's TODO is its result. */
  readonly todos: ReadonlyArray<Pick<Todo, "id" | "number" | "createdAt">>
  readonly dismissed: ReadonlyArray<Dismissed>
  /** The engine's own answers to this tab's dispatches, by execution id (src/writeAdmission.ts `answered`). */
  readonly answered: ReadonlyMap<string, { readonly flow: string; readonly repo?: string | undefined; readonly state: "done" | "failed"; readonly at: number }>
  /**
   * The subjects this tab has already shown from a stronger receipt than its input: an admitted input of one says
   * nothing more, whether that receipt is still in view (an engine run past the read's page, a delivered row) or not.
   */
  readonly seen: ReadonlySet<string>
}

/**
 * The device's rows; the subjects among them that a receipt stronger than this tab's input decided; and the subjects the
 * device holds a result of, Done or Failed, whether or not the person dismissed it or the list still shows it: that
 * result outranks a synced row still saying live (`merged`).
 */
export interface Progress {
  readonly notices: ReadonlyArray<Notice>
  readonly decided: ReadonlySet<string>
  readonly results: ReadonlyMap<string, "done" | "failed">
}

/** The repository a staged input's payload names, `owner/name`, if it names one. */
export const repoOf = (payload: Readonly<Record<string, unknown>>): string | undefined =>
  typeof payload.repo === "string" ? payload.repo : undefined

/** The engine operations the stack follows, by flow: what their toast says. */
export const OPERATION_RUNS: Readonly<Record<string, string>> = {
  "conversation/new": "New conversation",
  "todo/issue": "Make TODO",
}

/** The outbox operations the stack follows, by flow: what their toast says. */
export const OPERATION_WRITES = { "issue/create": "Create issue", "todo/commit": "Commit TODO" } as const

/**
 * A local row's `ref`: Requested; Requested with Try again (`unanswered`: this tab's attempt got no answer, and none
 * runs); Failed with Try again; or anything else.
 */
export type LocalRef = "requested" | "unanswered" | "retry" | "local"

/** What a local row needs; the rest is the same for all of them. */
interface Row {
  readonly subject: string
  readonly kind: "run" | "write"
  readonly state: NoticeState
  readonly ref: LocalRef
  readonly title: string
  readonly href: string
  readonly at: number
  readonly repo?: string | undefined
}

const noticeOf = (row: Row): Notice => {
  const at = new Date(row.at).toISOString()
  return {
    recipient: LOCAL_RECIPIENT,
    subject: row.subject,
    kind: row.kind,
    state: row.state,
    mine: true,
    // Live and finished rows are toasts only, as 0009's launch rows were; a failure stays listed until dismissed.
    quiet: row.state !== "failed",
    // Open goes to its href; a local row has no conversation's run to scroll to.
    runId: null,
    repoId: row.repo === undefined ? null : `github/${row.repo}`,
    conversationId: null,
    actor: null,
    title: row.title,
    ref: row.ref,
    href: row.href,
    // The receipt's time: a new receipt of the same subject, such as a Retry's, is a new toast.
    version: row.at,
    readVersion: 0,
    dismissedVersion: 0,
    hiddenVersion: 0,
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
  }
}

/** The state an engine run's status says. */
const RUN_STATES: Readonly<Record<RunSummary["status"], { readonly state: NoticeState; readonly ref: LocalRef }>> = {
  pending: { state: "waiting", ref: "requested" },
  running: { state: "working", ref: "local" },
  suspended: { state: "waiting", ref: "local" },
  completed: { state: "done", ref: "local" },
  failed: { state: "failed", ref: "local" },
  cancelled: { state: "failed", ref: "local" },
}

/** When a run last changed, as its summary says. */
const runAt = (run: RunSummary) => run.finishedAtMs ?? run.startedAtMs ?? run.createdAtMs

/**
 * This tab's input: nothing once this tab showed a stronger receipt of its subject; Requested while an attempt runs or
 * once the outbox or the engine took it; else its last attempt's refusal, Failed with Try again; else, its attempt got
 * no answer, Requested with Try again, which admits the same identity.
 */
const inputRow = (input: Input, row: Omit<Row, "state" | "ref" | "at">, seen: ReadonlySet<string>): Row | undefined =>
  seen.has(row.subject)
    ? undefined
    : input.admitted || input.admitting
    ? { ...row, state: "waiting", ref: "requested", at: input.stagedAt ?? 0 }
    : input.refusedAt !== undefined
    ? { ...row, state: "failed", ref: "retry", at: input.refusedAt }
    : { ...row, state: "waiting", ref: "unanswered", at: input.stagedAt ?? 0 }

/** The issue outbox's create for `id`, from the strongest receipt the device holds. */
const issueRow = (
  id: string,
  write: WriteRow | undefined,
  recovery: IssueRequested | undefined,
  sending: Receipts["issueSending"][number] | undefined,
  input: Input | undefined,
  seen: ReadonlySet<string>,
): Row | undefined => {
  const repo = recovery?.repo ?? sending?.repo ?? input?.repo ?? write?.repoId.slice("github/".length)
  const base = { subject: `write:${id}`, kind: "write" as const, title: OPERATION_WRITES["issue/create"], repo, href: `/${repo}/issues` }
  if (write !== undefined) {
    const at = timeOf(write.settledAt ?? write.createdAt) || 0
    if (write.status === "done") {
      return { ...base, state: "done", ref: "local", at, href: write.itemNumber === null ? base.href : `/${repo}/issues/${write.itemNumber}` }
    }
    return { ...base, state: write.status === "pending" ? "working" : "failed", ref: "local", at }
  }
  if (recovery !== undefined && answered(recovery)) {
    const at = recovery.answeredAt ?? recovery.queuedAt
    return recovery.status === "requested"
      ? { ...base, state: "waiting", ref: "requested", at }
      : { ...base, state: "failed", ref: "local", at }
  }
  if (sending !== undefined) return { ...base, state: "waiting", ref: "requested", at: sending.queuedAt }
  return input === undefined ? undefined : inputRow(input, base, seen)
}

/** The stack's commit `id`, from the strongest receipt the device holds. Its route's numbered answer is Done. */
const commitRow = (
  id: string,
  todo: Receipts["todos"][number] | undefined,
  recovery: TodoRequested | undefined,
  sending: Receipts["todoSending"][number] | undefined,
  input: Input | undefined,
  seen: ReadonlySet<string>,
): Row | undefined => {
  const repo = recovery?.repo ?? sending?.repo ?? input?.repo
  const base = { subject: `write:${id}`, kind: "write" as const, title: OPERATION_WRITES["todo/commit"], repo, href: `/${repo}/stack` }
  // The stack's TODO under the commit's id: the stack took it, whatever the device's own rows still say.
  if (todo !== undefined) return { ...base, state: "done", ref: "local", at: timeOf(todo.createdAt) || 0, href: `/${repo}/stack/${todo.number}` }
  if (recovery !== undefined && answered(recovery)) {
    const at = recovery.answeredAt ?? recovery.queuedAt
    if (recovery.status === "not_sent") return { ...base, state: "failed", ref: "local", at }
    return recovery.taken === null
      ? { ...base, state: "waiting", ref: "requested", at }
      : { ...base, state: "done", ref: "local", at, href: `/${repo}/stack/${recovery.taken}` }
  }
  if (sending !== undefined) return { ...base, state: "waiting", ref: "requested", at: sending.queuedAt }
  return input === undefined ? undefined : inputRow(input, base, seen)
}

/**
 * The device's rows for the stack at `nowMs`: one per operation subject, from its strongest receipt. A failed row
 * leaves once its receipt is older than the list keeps one, or once the person dismissed that receipt.
 */
export const progressOf = (receipts: Receipts, nowMs: number): Progress => {
  const rows: Array<Row> = []
  const fromInputs = new Set<Row>()
  // Engine operations: the run the engine holds, else this tab's input.
  const runs = new Map(
    receipts.runs.filter((run) => run.parentRunId === null && OPERATION_RUNS[run.flowName] !== undefined).map((run) => [run.runId, run]),
  )
  for (const run of runs.values()) {
    const row = { ...RUN_STATES[run.status], at: runAt(run) }
    // The engine's answer to this tab's dispatch says the run ended though the last read saw it live: the answer is
    // the newer receipt. A read that saw it end has its own finish time.
    const answer = receipts.answered.get(run.runId)
    const ended = answer !== undefined && row.state !== "done" && row.state !== "failed"
    rows.push({
      subject: `run:${run.runId}`,
      kind: "run",
      ...(ended ? { state: answer.state, ref: "local" as const, at: answer.at } : row),
      title: OPERATION_RUNS[run.flowName]!,
      href: `/app/runs/${encodeURIComponent(run.runId)}`,
    })
  }
  // The engine's answer to this tab's dispatch, where no read shows the run (yet, or any more).
  for (const [executionId, answer] of receipts.answered) {
    if (runs.has(executionId) || OPERATION_RUNS[answer.flow] === undefined) continue
    rows.push({
      subject: `run:${executionId}`,
      kind: "run",
      state: answer.state,
      ref: "local",
      title: OPERATION_RUNS[answer.flow]!,
      href: `/app/runs/${encodeURIComponent(executionId)}`,
      at: answer.at,
    })
  }
  for (const input of receipts.inputs) {
    if (OPERATION_RUNS[input.flow] === undefined || input.executionId === undefined || runs.has(input.executionId) || receipts.answered.has(input.executionId)) continue
    const row = inputRow(input, {
      subject: `run:${input.executionId}`,
      kind: "run",
      title: OPERATION_RUNS[input.flow]!,
      repo: input.repo,
      href: input.flow === "todo/issue" && input.repo !== undefined ? `/${input.repo}/stack` : HOME_HREF,
    }, receipts.seen)
    if (row !== undefined) {
      rows.push(row)
      fromInputs.add(row)
    }
  }
  // Outbox operations: the server's row, a recovery row the route answered, the outbox's row, else this tab's input.
  const inputsOf = (flow: string) => new Map(receipts.inputs.filter((input) => input.flow === flow && input.writeId !== undefined).map((input) => [input.writeId!, input]))
  const issueInputs = inputsOf("issue/create")
  const writes = new Map(receipts.issueWrites.filter((row) => row.op === "issue/create").map((row) => [row.id, row]))
  const issueRecovery = new Map(receipts.issueRequested.filter((row) => row.op === "issue/create").map((row) => [row.id, row]))
  const issueSending = new Map(receipts.issueSending.filter((row) => row.op === "issue/create").map((row) => [row.id, row]))
  for (const id of new Set([...writes.keys(), ...issueRecovery.keys(), ...issueSending.keys(), ...issueInputs.keys()])) {
    const input = issueInputs.get(id)
    const row = issueRow(id, writes.get(id), issueRecovery.get(id), issueSending.get(id), input, receipts.seen)
    if (row === undefined) continue
    rows.push(row)
    // The outbox's row can still roll back, so it decides nothing for good: only stored and server receipts do.
    if (!writes.has(id) && !answered(issueRecovery.get(id))) fromInputs.add(row)
  }
  const commitInputs = inputsOf("todo/commit")
  const todos = new Map(receipts.todos.map((row) => [row.id, row]))
  const commitRecovery = new Map(receipts.todoRequested.filter((row) => row.op === "commit").map((row) => [row.id, row]))
  const commitSending = new Map(receipts.todoSending.filter((row) => row.op === "commit").map((row) => [row.id, row]))
  for (const id of new Set([...commitRecovery.keys(), ...commitSending.keys(), ...commitInputs.keys()])) {
    const input = commitInputs.get(id)
    const row = commitRow(id, todos.get(id), commitRecovery.get(id), commitSending.get(id), input, receipts.seen)
    if (row === undefined) continue
    rows.push(row)
    if (!todos.has(id) && !answered(commitRecovery.get(id))) fromInputs.add(row)
  }
  const dismissed = new Map(receipts.dismissed.map((row) => [row.id, row.at]))
  return {
    notices: rows
      .filter((row) =>
        row.state !== "failed" ||
        (row.at >= nowMs - LISTED_FOR_MS && !(row.at <= (dismissed.get(row.subject) ?? Number.NEGATIVE_INFINITY)))
      )
      .map(noticeOf),
    decided: new Set(rows.filter((row) => !fromInputs.has(row)).map((row) => row.subject)),
    // A result the device holds; this tab's refusal of an attempt is none.
    results: new Map(
      rows.flatMap((row) => !fromInputs.has(row) && (row.state === "done" || row.state === "failed") ? [[row.subject, row.state as "done" | "failed"] as const] : []),
    ),
  }
}

/** A recovery row the route answered: the route took or refused it. The pre-admission receipt is no answer. */
const answered = (row: { readonly status: string; readonly reason: unknown } | undefined) =>
  row !== undefined && (row.status === "requested" || row.reason !== null)

/**
 * The rows the feed shows: every synced row, unless it still says live while the device holds that operation's result
 * (`progress.results`: the notification and the result arrive on different shapes, in either order, and a result the
 * person dismissed still outranks it), then the launch rows and the device's own rows no synced row replaces.
 */
export const merged = (
  synced: ReadonlyArray<Notice>,
  launches: ReadonlyArray<Notice>,
  progress: Pick<Progress, "notices" | "results">,
): ReadonlyArray<Notice> => {
  const known = new Set(synced.map((row) => row.subject))
  const own = progress.notices
  const behind = new Set(
    synced.filter((row) => (row.state === "working" || row.state === "waiting") && progress.results.has(row.subject)).map((row) => row.subject),
  )
  return [
    ...synced.filter((row) => !behind.has(row.subject)),
    ...launches.filter((row) => !known.has(row.subject)),
    ...own.filter((row) => !known.has(row.subject) || behind.has(row.subject)),
  ]
}
