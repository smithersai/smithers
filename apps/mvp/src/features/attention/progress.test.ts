// Background progress as a projection of receipts (decision 0124, src/features/attention/progress.ts): what the stack
// shows for each receipt, which receipt wins, and the finding classes of the earlier designs' twelve review rounds that
// can't occur here. Pure: each case is the receipts a device holds at one moment.
import { describe, expect, test } from "vitest"
import type { Requested as IssueRequested, WriteRow } from "../issues/schema"
import type { Requested as TodoRequested } from "../todos/schema"
import { LISTED_FOR_MS } from "./contract"
import { feedOf } from "./entries"
import type { Notice } from "./schema"
import { type Input, merged, progressOf, type Receipts, repoOf, type RunSummary } from "./progress"

const NOW = Date.parse("2026-10-28T12:00:00Z")
const REPO = "octo/hello"

const none: Receipts = {
  inputs: [],
  runs: [],
  issueWrites: [],
  issueRequested: [],
  issueSending: [],
  todoRequested: [],
  todoSending: [],
  todos: [],
  dismissed: [],
  answered: new Map(),
  seen: new Set(),
}

const input = (fields: Partial<Input> & Pick<Input, "flow">): Input => ({ admitted: false, admitting: false, repo: REPO, stagedAt: NOW - 1_000, ...fields })

const run = (fields: Partial<RunSummary> & Pick<RunSummary, "runId" | "status">): RunSummary => ({
  flowName: "conversation/new",
  createdAtMs: NOW - 5_000,
  startedAtMs: null,
  finishedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  waiting: null,
  lastSeq: 1,
  origin: { door: "slash", actor: "person" },
  ...fields,
})

const issueRecovery = (fields: Partial<IssueRequested> & Pick<IssueRequested, "id" | "status">): IssueRequested => ({
  repo: REPO,
  repoId: `github/${REPO}`,
  op: "issue/create",
  title: "Crash",
  number: 0,
  body: "",
  queuedAt: NOW - 60_000,
  reason: null,
  ...fields,
})

const todoRecovery = (fields: Partial<TodoRequested> & Pick<TodoRequested, "id" | "status">): TodoRequested => ({
  repo: REPO,
  repoId: `github/${REPO}`,
  op: "commit",
  title: "Retry",
  prompt: "Retry it.",
  acceptance: [],
  number: 0,
  queuedAt: NOW - 60_000,
  reason: null,
  taken: null,
  ...fields,
})

const write = (fields: Partial<WriteRow> & Pick<WriteRow, "id" | "status">): WriteRow => ({
  repoId: `github/${REPO}`,
  op: "issue/create",
  failure: null,
  itemNumber: null,
  createdAt: "2026-10-28 11:59:50+00",
  settledAt: null,
  branchId: null,
  ...fields,
})

/** The one row the receipts give, as `[state, word or ref, action ref, href, time]`. */
const only = (receipts: Partial<Receipts>, now = NOW) => {
  const rows = progressOf({ ...none, ...receipts }, now).notices
  expect(rows).toHaveLength(1)
  const [row] = rows
  return { state: row!.state, ref: row!.ref, href: row!.href, at: Date.parse(row!.updatedAt), subject: row!.subject, quiet: row!.quiet, title: row!.title }
}

/** The feed entry the stack shows for those receipts, over the home conversation. */
const entryOf = (receipts: Partial<Receipts>, now = NOW) => feedOf(progressOf({ ...none, ...receipts }, now).notices, [], now, null).entries

/** The rows alone. */
const rowsOf = (receipts: Partial<Receipts>, now = NOW) => progressOf({ ...none, ...receipts }, now).notices

describe("this tab's input", () => {
  test("is Requested while it is admitted, and Requested still when its reply never came: no reply proves nothing", () => {
    expect(only({ inputs: [input({ flow: "issue/create", writeId: "w1", admitting: true })] }))
      .toMatchObject({ state: "waiting", ref: "requested", subject: "write:w1", title: "Create issue", quiet: true })
    // Unconfirmed: the admission ended without an answer (R12: a lost Start reply is no failure). Requested still, with
    // Try again under the same identity, since nothing else will answer it before a reload.
    expect(only({ inputs: [input({ flow: "conversation/new", executionId: "e1" })] }))
      .toMatchObject({ state: "waiting", ref: "unanswered", subject: "run:e1", title: "New conversation", href: "/app" })
    expect(entryOf({ inputs: [input({ flow: "conversation/new", executionId: "e1" })] })[0])
      .toMatchObject({ word: "Requested", action: "retry", stack: true, listed: false })
  })

  test("is Failed with Try again once refused, timed from the refusal, so a slow refusal still shows its 4 s (R10)", () => {
    const refusedAt = NOW - 1_000
    const refused = input({ flow: "todo/commit", writeId: "op1", stagedAt: NOW - 60_000, refusedAt })
    expect(only({ inputs: [refused] })).toMatchObject({ state: "failed", ref: "retry", at: refusedAt, quiet: false, href: `/${REPO}/stack` })
    const [entry] = entryOf({ inputs: [refused] })
    expect(entry).toMatchObject({ stack: true, stackHere: true, listed: true, action: "retry", local: true })
  })

  test("a Retry running wins over its earlier refusal, and its refusal is a new receipt a past Dismiss can't hide (R2, R11)", () => {
    const first = NOW - 30_000
    expect(only({ inputs: [input({ flow: "issue/create", writeId: "w1", refusedAt: first, admitting: true })] }))
      .toMatchObject({ state: "waiting", ref: "requested" })
    const dismissed = [{ id: "write:w1", at: first }]
    expect(rowsOf({ inputs: [input({ flow: "issue/create", writeId: "w1", refusedAt: first })], dismissed })).toEqual([])
    expect(only({ inputs: [input({ flow: "issue/create", writeId: "w1", refusedAt: NOW - 500 })], dismissed }))
      .toMatchObject({ state: "failed", at: NOW - 500 })
  })

  test("a Make TODO's Requested opens its stack; one not yet identified, or of a flow the stack doesn't follow, shows nothing", () => {
    expect(only({ inputs: [input({ flow: "todo/issue", executionId: "e2", admitting: true })] }))
      .toMatchObject({ subject: "run:e2", href: `/${REPO}/stack`, title: "Make TODO" })
    expect(rowsOf({ inputs: [input({ flow: "todo/issue", admitting: true })] })).toEqual([])
    expect(rowsOf({ inputs: [input({ flow: "issue/comment", writeId: "c1", admitting: true })] })).toEqual([])
    expect(rowsOf({ inputs: [input({ flow: "issue/create", admitting: true })] })).toEqual([])
  })
})

describe("an input the outbox or the engine took", () => {
  test("is Requested until a stronger receipt of its subject showed, whatever an earlier attempt's refusal said (stale responses)", () => {
    // An earlier attempt's refusal arriving after a later one was admitted proves nothing.
    expect(only({ inputs: [input({ flow: "issue/create", writeId: "w1", admitted: true, refusedAt: NOW })] }))
      .toMatchObject({ state: "waiting", ref: "requested" })
    // Once this tab showed a stronger receipt, an admitted input says nothing more: a delivered row, or a run past the
    // read's page, never brings Requested back.
    expect(rowsOf({ inputs: [input({ flow: "issue/create", writeId: "w1", admitted: true })], seen: new Set(["write:w1"]) })).toEqual([])
    expect(rowsOf({ inputs: [input({ flow: "todo/commit", writeId: "op1", admitted: true })], seen: new Set(["write:op1"]) })).toEqual([])
    expect(rowsOf({ inputs: [input({ flow: "todo/issue", executionId: "e1", admitted: true })], seen: new Set(["run:e1"]) })).toEqual([])
    // Whatever its own state: an unanswered attempt whose run this tab read (R12: its Start was recorded after all), or
    // a refusal after another tab delivered it, the stronger receipt speaks.
    expect(rowsOf({ inputs: [input({ flow: "todo/issue", executionId: "e1" })], seen: new Set(["run:e1"]) })).toEqual([])
    expect(rowsOf({ inputs: [input({ flow: "issue/create", writeId: "w1", refusedAt: NOW })], seen: new Set(["write:w1"]) })).toEqual([])
  })

  test("the subjects a receipt stronger than the input decided are the ones it retires", () => {
    const decided = progressOf({
      ...none,
      inputs: [
        input({ flow: "issue/create", writeId: "only-input", admitting: true }),
        input({ flow: "issue/create", writeId: "sent", admitted: true }),
        input({ flow: "todo/commit", writeId: "op-input", admitting: true }),
        input({ flow: "todo/commit", writeId: "op-answered", admitted: true }),
        input({ flow: "todo/issue", executionId: "e-input", admitting: true }),
      ],
      issueSending: [{ id: "sent", op: "issue/create", repo: REPO, queuedAt: NOW }],
      todoRequested: [todoRecovery({ id: "op-answered", status: "requested", taken: 2, answeredAt: NOW })],
      runs: [run({ runId: "e-run", status: "running", flowName: "todo/issue" })],
    }, NOW).decided
    // The outbox's row can still roll back: it decides nothing for good.
    expect([...decided].sort()).toEqual(["run:e-run", "write:op-answered"])
  })

  test("only a settled run is a result: a running one neither outranks a synced row nor retires its input", () => {
    const progress = progressOf({ ...none, runs: [
      run({ runId: "running", status: "running", flowName: "todo/issue" }),
      run({ runId: "done", status: "completed", flowName: "todo/issue", finishedAtMs: NOW }),
    ] }, NOW)
    expect([...progress.results]).toEqual([["run:done", "done"]])
  })

  test("an unanswered input staged before inputs kept their time sorts as the oldest", () => {
    expect(only({ inputs: [input({ flow: "todo/issue", executionId: "e1", stagedAt: undefined })] })).toMatchObject({ ref: "unanswered", at: 0 })
  })
})

describe("another tab, or this one after its input is gone", () => {
  test("never toasts a recovery row kept before admission: it proves no failure (R7, R8, R9, R11, R12)", () => {
    // Tab A admits while tab B, holding no input, sees A's first receipt; or A closed before admission.
    expect(rowsOf({ issueRequested: [issueRecovery({ id: "w1", status: "not_sent" })] })).toEqual([])
    expect(rowsOf({ todoRequested: [todoRecovery({ id: "op1", status: "not_sent" })] })).toEqual([])
    // With this tab's own input it is that input's Requested, never Failed.
    expect(only({
      issueRequested: [issueRecovery({ id: "w1", status: "not_sent" })],
      inputs: [input({ flow: "issue/create", writeId: "w1", admitting: true })],
    })).toMatchObject({ state: "waiting", ref: "requested" })
  })
})

describe("the device's receipts", () => {
  test("the outbox's row is Requested, and beats its earlier recovery row", () => {
    expect(only({
      issueSending: [{ id: "w1", op: "issue/create", repo: REPO, queuedAt: NOW - 2_000 }],
      issueRequested: [issueRecovery({ id: "w1", status: "not_sent" })],
    })).toMatchObject({ state: "waiting", ref: "requested", at: NOW - 2_000 })
    expect(only({ todoSending: [{ id: "op1", op: "commit", repo: REPO, queuedAt: NOW - 2_000 }] }))
      .toMatchObject({ state: "waiting", ref: "requested", subject: "write:op1" })
  })

  test("the route's numbered answer to a commit is Done on its TODO; its refusal is Failed, at the answer's time", () => {
    expect(only({ todoRequested: [todoRecovery({ id: "op1", status: "requested", taken: 27, answeredAt: NOW - 1_000 })] }))
      .toMatchObject({ state: "done", href: `/${REPO}/stack/27`, at: NOW - 1_000, quiet: true })
    expect(only({ todoRequested: [todoRecovery({ id: "op1", status: "requested", answeredAt: NOW - 1_000 })] }))
      .toMatchObject({ state: "waiting", ref: "requested" })
    expect(only({ todoRequested: [todoRecovery({ id: "op1", status: "not_sent", reason: "forbidden", answeredAt: NOW - 1_000 })] }))
      .toMatchObject({ state: "failed", ref: "local", at: NOW - 1_000, quiet: false })
    // Kept before the route answered with a time: its queue time.
    expect(only({ todoRequested: [todoRecovery({ id: "op1", status: "not_sent", reason: "forbidden", queuedAt: NOW - 3_000 })] }))
      .toMatchObject({ at: NOW - 3_000 })
    // The answer beats the outbox row and this tab's input.
    expect(only({
      todoRequested: [todoRecovery({ id: "op1", status: "requested", taken: 3, answeredAt: NOW })],
      todoSending: [{ id: "op1", op: "commit", repo: REPO, queuedAt: NOW - 2_000 }],
      inputs: [input({ flow: "todo/commit", writeId: "op1", admitting: true })],
    })).toMatchObject({ state: "done" })
    // The stack's TODO under its id is the result: once the device dropped its answered row, a lingering outbox row
    // never brings Requested back.
    expect(only({
      todos: [{ id: "op1", number: 4, createdAt: "2026-10-28 11:59:59+00" }],
      todoSending: [{ id: "op1", op: "commit", repo: REPO, queuedAt: NOW - 2_000 }],
    })).toMatchObject({ state: "done", href: `/${REPO}/stack/4`, at: Date.parse("2026-10-28T11:59:59Z") })
    expect(progressOf({ ...none, todos: [{ id: "op1", number: 4, createdAt: "x" }], inputs: [input({ flow: "todo/commit", writeId: "op1", admitted: true })] }, NOW).decided)
      .toEqual(new Set(["write:op1"]))
    // A TODO no commit of this device's names is no row.
    expect(rowsOf({ todos: [{ id: "someone-else", number: 5, createdAt: "2026-10-28 11:59:59+00" }] })).toEqual([])
    // A drop is no Commit.
    expect(rowsOf({ todoRequested: [todoRecovery({ id: "op2", op: "drop", status: "requested", taken: 3 })] })).toEqual([])
  })

  test("an issue the route took is Requested; one it refused is Failed", () => {
    expect(only({ issueRequested: [issueRecovery({ id: "w1", status: "requested", answeredAt: NOW - 1_000 })] }))
      .toMatchObject({ state: "waiting", ref: "requested", href: `/${REPO}/issues` })
    expect(only({ issueRequested: [issueRecovery({ id: "w1", status: "not_sent", reason: "forbidden", answeredAt: NOW - 1_000 })] }))
      .toMatchObject({ state: "failed", at: NOW - 1_000 })
  })

  test("the server's row of a new issue beats every device receipt: Working, Done on its issue, or Failed", () => {
    const device = {
      issueRequested: [issueRecovery({ id: "w1", status: "requested" })],
      inputs: [input({ flow: "issue/create", writeId: "w1", refusedAt: NOW })],
    }
    expect(only({ ...device, issueWrites: [write({ id: "w1", status: "pending" })] }))
      .toMatchObject({ state: "working", at: Date.parse("2026-10-28T11:59:50Z") })
    expect(only({ ...device, issueWrites: [write({ id: "w1", status: "done", itemNumber: 60, settledAt: "2026-10-28 11:59:58+00" })] }))
      .toMatchObject({ state: "done", href: `/${REPO}/issues/60`, at: Date.parse("2026-10-28T11:59:58Z") })
    expect(only({ issueWrites: [write({ id: "w1", status: "done", settledAt: "2026-10-28 11:59:58+00" })] }))
      .toMatchObject({ href: `/${REPO}/issues` })
    expect(only({ issueWrites: [write({ id: "w1", status: "refused", settledAt: "2026-10-28 11:59:58+00" })] }))
      .toMatchObject({ state: "failed" })
    // Another write of the person's is no Create issue.
    expect(rowsOf({ issueWrites: [write({ id: "c1", op: "issue/comment", status: "pending" })] })).toEqual([])
  })
})

describe("the engine's runs", () => {
  test("a run's status is its state, timed from its last change, and opens its run page", () => {
    const states = (["pending", "running", "suspended", "completed", "failed", "cancelled"] as const).map((status) =>
      only({ runs: [run({ runId: "r1", status, startedAtMs: NOW - 4_000, finishedAtMs: status === "completed" || status === "failed" || status === "cancelled" ? NOW - 1_000 : null })] })
    )
    expect(states.map(({ state, ref }) => [state, ref])).toEqual([
      ["waiting", "requested"], ["working", "local"], ["waiting", "local"], ["done", "local"], ["failed", "local"], ["failed", "local"],
    ])
    expect(states[0]!.at).toBe(NOW - 4_000)
    expect(states[3]).toMatchObject({ at: NOW - 1_000, href: "/app/runs/r1", subject: "run:r1", title: "New conversation" })
    expect(only({ runs: [run({ runId: "r2", status: "pending" })] }).at).toBe(NOW - 5_000)
  })

  test("the engine's record beats this tab's input: a lost Start reply resolves from the run (R12), a stale Working never returns (R4, R9)", () => {
    const lost = input({ flow: "conversation/new", executionId: "r1" })
    expect(only({ inputs: [lost], runs: [run({ runId: "r1", status: "running" })] })).toMatchObject({ state: "working" })
    // The run settled while no read reached it: the next read shows it settled, whatever the input said.
    expect(only({ inputs: [{ ...lost, refusedAt: NOW }], runs: [run({ runId: "r1", status: "completed", finishedAtMs: NOW - 10 })] }))
      .toMatchObject({ state: "done" })
  })

  test("only the person's own operations: child runs and other flows show nothing", () => {
    expect(rowsOf({ runs: [
      run({ runId: "child", status: "running", parentRunId: "answer" }),
      run({ runId: "chat", status: "running", flowName: "chat/Answer" }),
    ] })).toEqual([])
    expect(only({ runs: [run({ runId: "t1", status: "running", flowName: "todo/issue" })] })).toMatchObject({ title: "Make TODO" })
  })
})

describe("the engine's answer to this tab's dispatch", () => {
  test("shows how the run ended where no read shows the run, outranks the input, and yields to a read of the run", () => {
    const answered = new Map([["e1", { flow: "todo/issue", repo: REPO, state: "done" as const, at: NOW - 100 }]])
    expect(only({ answered, inputs: [input({ flow: "todo/issue", executionId: "e1", admitted: true })] }))
      .toMatchObject({ subject: "run:e1", state: "done", at: NOW - 100, title: "Make TODO", href: "/app/runs/e1" })
    // A read that last saw the run live is older than the answer: the answer's end shows, Done or Failed.
    expect(only({ answered, runs: [run({ runId: "e1", status: "running", flowName: "todo/issue" })] })).toMatchObject({ state: "done", at: NOW - 100 })
    const failed = new Map([["e1", { flow: "todo/issue", state: "failed" as const, at: NOW - 50 }]])
    expect(only({ answered: failed, runs: [run({ runId: "e1", status: "pending", flowName: "todo/issue" })] })).toMatchObject({ state: "failed", at: NOW - 50, quiet: false })
    // A read that saw it end has the run's own finish time.
    expect(only({ answered, runs: [run({ runId: "e1", status: "completed", flowName: "todo/issue", finishedAtMs: NOW - 900 })] })).toMatchObject({ state: "done", at: NOW - 900 })
    expect(progressOf({ ...none, answered }, NOW).results).toEqual(new Map([["run:e1", "done"]]))
    expect(rowsOf({ answered: new Map([["e2", { flow: "chat/Answer", state: "failed" as const, at: NOW }]]) })).toEqual([])
  })
})

describe("failures", () => {
  test("stay listed until the list's age or a Dismiss of that receipt; Done and live rows are toasts only", () => {
    const failed = run({ runId: "r1", status: "failed", finishedAtMs: NOW - 1_000 })
    expect(only({ runs: [failed] })).toMatchObject({ quiet: false })
    expect(rowsOf({ runs: [{ ...failed, finishedAtMs: NOW - LISTED_FOR_MS - 1 }] })).toEqual([])
    expect(rowsOf({ runs: [failed], dismissed: [{ id: "run:r1", at: NOW - 1_000 }] })).toEqual([])
    expect(only({ runs: [failed], dismissed: [{ id: "run:r1", at: NOW - 2_000 }] })).toMatchObject({ state: "failed" })
    // A dismissal of one subject hides no other.
    expect(only({ runs: [failed], dismissed: [{ id: "run:r2", at: NOW }] })).toMatchObject({ state: "failed" })
  })

  test("a Done toast shows for 4 s after its receipt, then leaves the stack and was never listed", () => {
    const done = { runs: [run({ runId: "r1", status: "completed" as const, finishedAtMs: NOW - 1_000 })] }
    expect(entryOf(done)).toEqual([expect.objectContaining({ id: "run:r1", stack: true, listed: false, local: true })])
    expect(entryOf(done, NOW + 10_000)).toEqual([])
  })
})

describe("receipts as they come", () => {
  test("an input's repository is its payload's, when it names one", () => {
    expect(repoOf({ repo: REPO, issue: 7 })).toBe(REPO)
    expect(repoOf({ branch: "topic" })).toBeUndefined()
  })

  test("a server row whose time doesn't read counts from long ago: its Done toast is past", () => {
    expect(only({ issueWrites: [write({ id: "w1", status: "done", createdAt: "not a time" })] })).toMatchObject({ state: "done", at: 0 })
  })
})

describe("beside the synced rows", () => {
  const synced = (subject: string, state: Notice["state"]): Notice => ({
    ...rowsOf({ inputs: [input({ flow: "issue/create", writeId: "x", admitting: true })] })[0]!,
    recipient: "person-maya", subject, state, ref: null, quiet: false,
  })
  const own = (receipts: Partial<Receipts>) => progressOf({ ...none, ...receipts }, NOW)
  const both = (...parts: ReadonlyArray<ReturnType<typeof own>>) => ({
    notices: parts.flatMap((part) => part.notices),
    results: new Map(parts.flatMap((part) => [...part.results])),
  })

  test("a synced row replaces the device's, unless it still says live while the device holds the result (R9: no stale Working)", () => {
    const done = own({ issueWrites: [write({ id: "w1", status: "done", itemNumber: 3, settledAt: "2026-10-28 11:59:58+00" })] })
    const failed = own({ issueWrites: [write({ id: "w2", status: "failed", settledAt: "2026-10-28 11:59:58+00" })] })
    const requested = own({ inputs: [input({ flow: "issue/create", writeId: "w3", admitting: true })] })
    const rows = merged(
      [synced("write:w1", "working"), synced("write:w2", "waiting"), synced("write:w3", "working"), synced("write:w4", "done")],
      [],
      both(done, failed, requested),
    )
    expect(rows.map((row) => [row.subject, row.state, row.recipient === "" ? "device" : "synced"])).toEqual([
      ["write:w3", "working", "synced"],
      ["write:w4", "done", "synced"],
      ["write:w1", "done", "device"],
      ["write:w2", "failed", "device"],
    ])
    // Once the notification says the result too, it is the one shown, with its acts.
    expect(merged([synced("write:w1", "done")], [], done).map((row) => row.recipient)).toEqual(["person-maya"])
  })

  test("this tab's refusal is no result: a synced row saying live outranks it, as when another tab sent the same write", () => {
    const refused = own({ inputs: [input({ flow: "issue/create", writeId: "w1", refusedAt: NOW })] })
    expect(refused.results).toEqual(new Map())
    expect(merged([synced("write:w1", "working")], [], refused).map((row) => [row.state, row.recipient])).toEqual([["working", "person-maya"]])
  })

  test("a result the person dismissed still outranks a synced row saying live: dismissing never brings Working back", () => {
    const failed = own({
      issueWrites: [write({ id: "w1", status: "failed", settledAt: "2026-10-28 11:59:58+00" })],
      dismissed: [{ id: "write:w1", at: Date.parse("2026-10-28T11:59:58Z") }],
    })
    expect(failed.notices).toEqual([])
    expect(merged([synced("write:w1", "working")], [], failed)).toEqual([])
  })

  test("a launch row shows until a synced row of its subject arrives", () => {
    const launch = { ...synced("write:p1", "waiting"), recipient: "" }
    const nothing = { notices: [], results: new Map<string, "done" | "failed">() }
    expect(merged([], [launch], nothing).map((row) => row.subject)).toEqual(["write:p1"])
    expect(merged([synced("write:p1", "working")], [launch], nothing).map((row) => row.state)).toEqual(["working"])
  })
})

describe("as the feed shows them", () => {
  test("a local row is no conversation's run: it shows over the home conversation, says Requested, and opens its page", () => {
    const [entry] = entryOf({ inputs: [input({ flow: "conversation/new", executionId: "e1", admitting: true })] })
    expect(entry).toMatchObject({ id: "run:e1", word: "Requested", detail: "New conversation", stack: true, stackHere: true, here: false, local: true, action: "open" })
  })
})
