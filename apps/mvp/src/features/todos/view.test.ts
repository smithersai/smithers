import { mayRetry } from "./view"
// What the stack's screens show (src/features/todos/view.ts) and the contract's helpers, as pure functions over rows;
// and how a send's refusal reads (writes.ts `reasonOf`). The rows they read
// come from real devices in todos.test.ts.
import { describe, expect, test } from "vitest"
import {
  clipPrompt,
  draftFromIssue,
  isAcceptance,
  isPrompt,
  isTitle,
  MAX_ACCEPTANCE,
  MAX_PROMPT_BYTES,
  MAX_TITLE_LENGTH,
  notSentOf,
  stackFilterOf,
  stackPath,
  stackRoute,
  TODO_STATES,
  titleOf,
  todoNumberOf,
  todoPath,
  todosChannel,
} from "./contract"
import type { Draft, Requested, Sending, Todo, TodoRequest } from "./schema"

import {
  accessFor,
  deliveredOf,
  draftsOfAnswer,
  draftsOfRepo,
  isDroppable,
  isoOf,
  mayChange,
  mayMakeTodo,
  notSentRows,
  runLinkOf,
  STATE_KINDS,
  stackItemsOf,
  stackRows,
  statusOf,
  type TodoCardProps,
  todoCardOf,
  todoPageOf,
  todoScreenOf,
  todosByIssue,
  withDrop,
  withTodos,
} from "./view"
import { reasonOf } from "./writes"

const REPO = "github/octo/hello"

const todo = (fields: Partial<Todo> & Pick<Todo, "id" | "number">): Todo => ({
  repoId: REPO,
  title: `T${fields.number}`,
  state: "queued",
  step: null,
  position: fields.number,
  revision: 1,
  attempt: 0,
  branch: null,
  prNumber: null,
  failure: null,
  note: null,
  createdLogin: "maya",
  createdAt: "2026-10-20 10:00:00+00",
  updatedAt: "2026-10-20 10:00:00+00",
  settledAt: null,
  issueNumber: null,
  runId: null,
  ...fields,
})

const sending = (fields: Partial<Sending> & Pick<Sending, "id" | "op">): Sending => ({
  repo: "octo/hello",
  title: "",
  prompt: "",
  acceptance: [],
  number: 0,
  repoId: REPO,
  queuedAt: 1,
  v: 2,
  ...fields,
})

const requested = (fields: Partial<Requested> & Pick<Requested, "id" | "op">): Requested => {
  const { v: _, ...row } = sending(fields)
  return { ...row, status: "requested", reason: null, taken: null, ...fields }
}

describe("stackRows", () => {
  test("open TODOs in order, then this device's unnumbered commits as made, then settled ones latest first", () => {
    const todos = [
      todo({ id: "c", number: 3, position: 1 }),
      todo({ id: "a", number: 1, state: "dropped", position: null }),
      todo({ id: "d", number: 4, position: 2 }),
      todo({ id: "b", number: 2, state: "merged", position: null }),
      todo({ id: "x", number: 9, repoId: "github/octo/other" }),
    ]
    const rows = stackRows(REPO, todos, [sending({ id: "late", op: "commit", title: "Late", queuedAt: 5 })], [
      requested({ id: "early", op: "commit", title: "Early", queuedAt: 2, status: "not_sent", reason: "stack_full" }),
      requested({ id: "elsewhere", op: "commit", title: "Elsewhere", repoId: "github/octo/other" }),
    ])
    expect(rows).toEqual([
      { id: "c", number: 3, title: "T3", state: "queued" },
      { id: "d", number: 4, title: "T4", state: "queued" },
      { id: "early", number: null, title: "Early", state: "queued", pending: "not_sent" },
      { id: "late", number: null, title: "Late", state: "queued", pending: "requested" },
      { id: "b", number: 2, title: "T2", state: "merged" },
      { id: "a", number: 1, title: "T1", state: "dropped" },
    ])
  })

  test("a commit the stack has shows once, as the stack's row; the outbox's copy of a kept change shows once", () => {
    const rows = stackRows(REPO, [todo({ id: "a", number: 1 })], [sending({ id: "a", op: "commit" })], [
      requested({ id: "a", op: "commit" }),
    ])
    expect(rows).toEqual([{ id: "a", number: 1, title: "T1", state: "queued" }])
  })

  test("a drop on its way shows on its TODO until the TODO is dropped", () => {
    const pending = [requested({ id: "drop-1", op: "drop", number: 1 })]
    expect(stackRows(REPO, [todo({ id: "a", number: 1 })], [], pending)).toEqual([
      { id: "a", number: 1, title: "T1", state: "queued", pending: "requested" },
    ])
    expect(stackRows(REPO, [todo({ id: "a", number: 1, state: "dropped", position: null })], [], pending)).toEqual([
      { id: "a", number: 1, title: "T1", state: "dropped" },
    ])
  })
})

describe("notSentRows and deliveredOf", () => {
  test("names each refused change, a commit by its title and a drop as Drop Tn, in the order made", () => {
    expect(
      notSentRows(REPO, [
        requested({ id: "b", op: "drop", number: 4, queuedAt: 3, status: "not_sent", reason: "merged" }),
        requested({ id: "a", op: "commit", title: "Retry", queuedAt: 1, status: "not_sent", reason: "forbidden" }),
        requested({ id: "c", op: "commit", status: "requested" }),
        requested({ id: "d", op: "commit", status: "not_sent", reason: "invalid", repoId: "github/octo/other" }),
      ]),
    ).toEqual([
      { id: "a", op: "commit", label: "Retry", reason: "Not allowed" },
      { id: "b", op: "drop", label: "Drop T4", reason: "Merged" },
    ])
  })

  test("delivered: a commit whose TODO is there, a drop whose TODO is dropped, this repository's only", () => {
    const todos = [todo({ id: "a", number: 1 }), todo({ id: "b", number: 2, state: "dropped", position: null })]
    expect(
      deliveredOf(REPO, todos, [
        requested({ id: "a", op: "commit" }),
        requested({ id: "z", op: "commit" }),
        requested({ id: "d1", op: "drop", number: 1 }),
        requested({ id: "d2", op: "drop", number: 2 }),
        requested({ id: "o", op: "commit", repoId: "github/octo/other" }),
      ]),
    ).toEqual(["a", "d2"])
  })
})

describe("todoCardOf", () => {
  const request = (fields: Partial<TodoRequest> = {}): TodoRequest => ({
    todoId: "a",
    revision: 1,
    repoId: REPO,
    prompt: "Do it",
    acceptance: ["done"],
    byLogin: "maya",
    createdAt: "2026-10-20 10:00:00+00",
    ...fields,
  })

  test("the TODO the route names with its latest prompt, once the device has both", () => {
    const todos = [todo({ id: "a", number: 1, revision: 2 })]
    const rows = [{ id: "a", number: 1, title: "T1", state: "queued" as const, pending: "requested" as const }]
    expect(todoCardOf(1, rows, todos, [request(), request({ revision: 2, prompt: "Do it better" })])).toEqual({
      id: "a",
      number: 1,
      title: "T1",
      state: "queued",
      prompt: "Do it better",
      acceptance: ["done"],
      createdLogin: "maya",
      createdAt: "2026-10-20 10:00:00+00",
      updatedAt: "2026-10-20 10:00:00+00",
      settledAt: null,
      branch: null,
      prNumber: null,
      issueNumber: null,
      runId: null,
      failure: null,
      pending: "requested",
    })
    expect(todoCardOf(1, [], todos, [request({ revision: 2 })])).not.toHaveProperty("pending")
    expect(todoCardOf(1, rows, todos, [request()])).toBeUndefined()
    expect(todoCardOf(2, rows, todos, [request()])).toBeUndefined()
    expect(todoCardOf(null, rows, todos, [request()])).toBeUndefined()
  })
})

describe("drafts, access and who may change a stack", () => {
  const draft = (fields: Partial<Draft> & Pick<Draft, "id">): Draft => ({
    repo: "octo/hello",
    repoId: REPO,
    title: "",
    prompt: "",
    acceptance: [],
    answerId: null,
    createdAt: 1,
    ...fields,
  })

  test("a repository's drafts newest first; an answer's in the order made", () => {
    const drafts = [
      draft({ id: "a", createdAt: 1, answerId: "answer" }),
      draft({ id: "b", createdAt: 3 }),
      draft({ id: "c", createdAt: 2, answerId: "answer" }),
      draft({ id: "d", createdAt: 4, repoId: "github/octo/other" }),
    ]
    expect(draftsOfRepo(REPO, drafts).map(({ id }) => id)).toEqual(["b", "c", "a"])
    expect(draftsOfAnswer("answer", drafts).map(({ id }) => id)).toEqual(["a", "c"])
  })

  test("access is unknown until the shape says", () => {
    expect(accessFor(REPO, [])).toBe("unknown")
    expect(accessFor(REPO, [{ id: REPO, status: "forbidden" }, { id: "x", status: "allowed" }])).toBe("forbidden")
  })



  test("a Member and above on the repository may change its stack, as ChatApi answered for it (decision 0079)", () => {
    const session = (status: "loading" | "signed_in" | "signed_out" | "unreachable", role: "member" | "guest" | null = null) => ({
      status,
      role,
    })
    const on = (role: "maintainer" | "member" | "guest" | null) => ({ role, own: false })
    expect(mayChange(session("signed_in"), undefined, on("member"))).toBe(true)
    expect(mayChange(session("signed_in"), undefined, on("guest"))).toBe(false)
    expect(mayChange(session("signed_in"), undefined, on(null))).toBe(false)
    // A Member of the deployment's own repository is only a Guest here; before ChatApi answers, nobody may.
    expect(mayChange(session("signed_in", "member"), undefined, on("guest"))).toBe(false)
    expect(mayChange(session("signed_in", "member"), undefined, undefined)).toBe(false)
    expect(mayChange(session("signed_out"), { role: "member" }, on("member"))).toBe(false)
    // Offline after an answer, the session this device confirmed is still signed in.
    expect(mayChange(session("unreachable"), { role: "maintainer" }, on("maintainer"))).toBe(true)
    expect(mayChange(session("loading"), undefined, on("member"))).toBe(false)
  })
})

describe("a send's refusal", () => {
  test("reads the code its body names, else its status; the rest is sent again", () => {
    expect(reasonOf(409, "stack_full")).toBe("stack_full")
    expect(reasonOf(409, "merged")).toBe("merged")
    expect(reasonOf(503, "unavailable")).toBeUndefined()
    expect([400, 401, 403, 404, 409, 413].map((status) => reasonOf(status, undefined))).toEqual([
      "invalid",
      "authentication",
      "forbidden",
      "not_found",
      "conflict",
      "too_large",
    ])
    expect([undefined, 429, 500, 502].map((status) => reasonOf(status, undefined))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(notSentOf("nope")).toBeUndefined()
  })
})

describe("the contract", () => {
  test("paths and routes", () => {
    expect(stackRoute("o w", "n")).toBe("/api/repos/o%20w/n/stack")
    expect(stackPath("octo", "hello")).toBe("/octo/hello/stack")
    expect(stackPath("octo", "hello", "open")).toBe("/octo/hello/stack")
    expect(stackPath("octo", "hello", "closed")).toBe("/octo/hello/stack?state=closed")
    expect(todoPath("octo", "hello", 4)).toBe("/octo/hello/stack/4")
    expect(todosChannel("engine")).toBe("engine/todos")
  })

  test("a route's ?state= is the closed list only when it says closed", () => {
    expect(["closed", "open", undefined, "Closed", 1, ""].map(stackFilterOf)).toEqual(["closed", "open", "open", "open", "open", "open"])
  })

  test("a route's number is 1 to the integer limit, written plainly", () => {
    expect(["1", "42", "2147483647"].map(todoNumberOf)).toEqual([1, 42, 2_147_483_647])
    expect(["0", "01", "-1", "1.5", "x", "2147483648", "12345678901"].map(todoNumberOf)).toEqual(
      Array.from({ length: 7 }, () => undefined),
    )
  })

  test("a draft's title is its prompt's first line without heading marks, cut to the limit", () => {
    expect(titleOf("  ## Retry webhooks\n\nThree times.")).toBe("Retry webhooks")
    expect(titleOf("x".repeat(MAX_TITLE_LENGTH + 5))).toBe(`${"x".repeat(MAX_TITLE_LENGTH - 1)}…`)
    expect(titleOf("x".repeat(MAX_TITLE_LENGTH))).toHaveLength(MAX_TITLE_LENGTH)
  })

  test("bounds on titles, prompts and criteria", () => {
    expect([isTitle("ok"), isTitle("  "), isTitle("x".repeat(MAX_TITLE_LENGTH + 1))]).toEqual([true, false, false])
    expect([isPrompt("ok"), isPrompt(" \n"), isPrompt("é".repeat(MAX_PROMPT_BYTES / 2 + 1))]).toEqual([true, false, false])
    expect([
      isAcceptance([]),
      isAcceptance(["a"]),
      isAcceptance([" "]),
      isAcceptance(["x".repeat(301)]),
      isAcceptance(Array.from({ length: MAX_ACCEPTANCE + 1 }, () => "a")),
    ]).toEqual([true, true, false, false, false])
  })
})

describe("the stack as GitHub's issue list", () => {
  const OWNER = "octo"
  const NAME = "hello"

  test("every state has an icon; Working runs, live; a TODO not numbered yet is Requested", () => {
    expect(Object.keys(STATE_KINDS)).toEqual([...TODO_STATES])
    expect(STATE_KINDS.working).toBe("running")
    expect(TODO_STATES.map((state) => statusOf(1, state))).toEqual([
      { kind: "queued", label: "Queued" },
      { kind: "running", label: "Working", live: true },
      { kind: "in_review", label: "In review" },
      { kind: "merged", label: "Merged" },
      { kind: "dropped", label: "Dropped" },
      { kind: "failed", label: "Failed" },
    ])
    expect(statusOf(null, "queued")).toEqual({ kind: "requested", label: "Requested" })
  })

  test("Postgres's timestamps read as ISO 8601", () => {
    expect(isoOf("2026-10-20 10:00:00+00")).toBe("2026-10-20T10:00:00+00:00")
    expect(isoOf("2026-10-20 10:00:00.123456-07")).toBe("2026-10-20T10:00:00.123456-07:00")
    expect(isoOf("2026-10-20T10:00:00Z")).toBe("2026-10-20T10:00:00Z")
    expect(Date.parse(isoOf("2026-10-20 10:00:00+00"))).toBe(Date.parse("2026-10-20T10:00:00Z"))
  })

  test("a TODO may be dropped once numbered, while on the stack, with no change of it pending here", () => {
    expect(TODO_STATES.filter((state) => isDroppable({ number: 1, state }))).toEqual([
      "queued",
      "working",
      "in_review",
      "failed",
    ])
    expect(isDroppable({ number: null, state: "queued" })).toBe(false)
    expect(isDroppable({ number: 1, state: "queued", pending: "requested" })).toBe(false)
    expect(isDroppable({ number: 1, state: "queued", pending: "not_sent" })).toBe(false)
  })

  test("rows: icon, T<n>, who and when, branch and pull request links, pending chip; open on the stack, else closed", () => {
    const todos = [
      todo({ id: "a", number: 4, position: 1, createdLogin: "ann", branch: "smithers/t4-retry", prNumber: 42, state: "in_review" }),
      todo({ id: "b", number: 2, position: null, state: "dropped", settledAt: "2026-10-20 11:00:00+00" }),
    ]
    const rows = stackRows(REPO, todos, [], [requested({ id: "c", op: "commit", title: "New", queuedAt: 3 })])
    const items = stackItemsOf(rows, todos, OWNER, NAME)
    expect(items).toEqual([
      {
        id: "a",
        number: 4,
        title: "T4",
        state: "open",
        status: { kind: "in_review", label: "In review" },
        droppable: true,
        author: "ann",
        updatedAt: "2026-10-20T10:00:00+00:00",
        links: [
          { label: "smithers/t4-retry", href: "/octo/hello/tree/smithers/t4-retry" },
          { label: "#42", href: "/octo/hello/pull/42" },
        ],
      },
      {
        id: "c",
        number: null,
        title: "New",
        state: "open",
        status: { kind: "requested", label: "Requested" },
        droppable: false,
        pending: "requested",
      },
      {
        id: "b",
        number: 2,
        title: "T2",
        state: "closed",
        status: { kind: "dropped", label: "Dropped" },
        droppable: false,
        author: "maya",
        updatedAt: "2026-10-20T11:00:00+00:00",
      },
    ])
  })

  test("a working or failed TODO links to its run; Queued, Merged and Dropped do not", () => {
    const RUN = "todo:6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f"
    const watch = { label: "Watch", href: `/app/runs/${encodeURIComponent(RUN)}` }
    expect(TODO_STATES.map((state) => runLinkOf({ state, runId: RUN }))).toEqual([
      undefined,
      watch,
      watch,
      undefined,
      undefined,
      { label: "Open", href: `/app/runs/${encodeURIComponent(RUN)}` },
    ])
    expect(runLinkOf({ state: "working", runId: null })).toBeUndefined()
    const todos = [
      todo({ id: "a", number: 4, position: 1, state: "working", branch: "smithers/t4-retry", runId: RUN }),
      todo({ id: "b", number: 5, position: 2, runId: null }),
    ]
    const items = stackItemsOf(stackRows(REPO, todos, [], []), todos, OWNER, NAME)
    expect(items.map((item) => [item.status, item.links])).toEqual([
      [
        { kind: "running", label: "Working", live: true },
        [watch],
      ],
      [{ kind: "queued", label: "Queued" }, undefined],
    ])
  })

  test("Drop goes in the menu of each droppable row, only for a person who may change the stack; it asks first", () => {
    const todos = [todo({ id: "a", number: 4, position: 1 }), todo({ id: "b", number: 2, position: null, state: "merged" })]
    const items = stackItemsOf(stackRows(REPO, todos, [], []), todos, OWNER, NAME)
    const dropped: Array<number> = []
    const shown = withDrop(items, true, (number) => dropped.push(number))
    expect(shown.map((item) => item.menu?.map(({ label, destructive, confirm }) => ({ label, destructive, confirm })))).toEqual([
      [{ label: "Drop", destructive: true, confirm: { title: "Drop T4?", description: "T4", action: "Drop" } }],
      undefined,
    ])
    shown[0]!.menu![0]!.onSelect()
    expect(dropped).toEqual([4])
    expect(shown.every((item) => !("droppable" in item))).toBe(true)
    expect(withDrop(items, false, () => {}).map((item) => item.menu)).toEqual([undefined, undefined])
    expect(withDrop([{ ...items[0]!, number: null }], true, () => {})[0]!.menu).toBeUndefined()
  })
})

describe("a TODO's page as GitHub's issue page", () => {
  const card = (fields: Partial<TodoCardProps> = {}): TodoCardProps => ({
    id: "a",
    number: 4,
    title: "Retry webhooks",
    state: "queued",
    prompt: "Retry each **failed** delivery.",
    acceptance: [],
    createdLogin: "ann",
    createdAt: "2026-10-20 10:00:00+00",
    updatedAt: "2026-10-20 10:05:00+00",
    settledAt: null,
    branch: null,
    prNumber: null,
    issueNumber: null,
    runId: null,
    ...fields,
  })

  test("a queued TODO: its prompt as the body, Queued, and who committed it when", () => {
    expect(todoPageOf(card(), "octo", "hello")).toEqual({
      number: 4,
      title: "Retry webhooks",
      state: "open",
      status: { kind: "queued", label: "Queued" },
      author: "ann",
      createdAt: "2026-10-20T10:00:00+00:00",
      body: "Retry each **failed** delivery.",
      events: [{ id: "committed", kind: "queued", author: "ann", text: "committed", createdAt: "2026-10-20T10:00:00+00:00" }],
      droppable: true,
    })
  })

  test("criteria follow the prompt as a list; a later state joins the timeline at when it changed or settled", () => {
    const working = todoPageOf(card({ state: "working", acceptance: ["three tries", "logged"] }), "octo", "hello")
    expect(working.body).toBe("Retry each **failed** delivery.\n\n**Acceptance criteria**\n\n- three tries\n- logged")
    expect(working.events.at(-1)).toEqual({ id: "working", kind: "running", text: "Working", createdAt: "2026-10-20T10:05:00+00:00" })
    const dropped = todoPageOf(card({ state: "dropped", settledAt: "2026-10-20 11:00:00+00" }), "octo", "hello")
    expect([dropped.state, dropped.status.kind, dropped.droppable]).toEqual(["closed", "dropped", false])
    expect(dropped.events.at(-1)).toEqual({ id: "dropped", kind: "dropped", text: "Dropped", createdAt: "2026-10-20T11:00:00+00:00" })
  })

  test("a failed TODO shows its safe failure reason and retains the run for diagnosis", () => {
    const RUN = "todo:6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f"
    const page = todoPageOf(card({ state: "failed", failure: "empty_change", branch: "smithers/t4-retry", runId: RUN, settledAt: "2026-10-20 11:00:00+00" }), "octo", "hello")
    expect(page.events.at(-1)).toEqual({ id: "failed", kind: "failed", text: "No changes", createdAt: "2026-10-20T11:00:00+00:00" })
    expect(page.run).toEqual({ label: "Open", href: `/app/runs/${encodeURIComponent(RUN)}` })
    expect(page).not.toHaveProperty("branch")
    expect(todoPageOf(card({ state: "failed", failure: null }), "octo", "hello").events.at(-1)?.text).toBe("Failed")
  })

  test("its branch and pull request, and this device's pending drop, which hides Drop", () => {
    const page = todoPageOf(card({ branch: "smithers/t4-retry", prNumber: 42, pending: "requested" }), "octo", "hello")
    expect([page.branch, page.pullRequest, page.pending, page.droppable]).toEqual([
      { label: "smithers/t4-retry", href: "/octo/hello/tree/smithers/t4-retry" },
      { label: "#42", href: "/octo/hello/pull/42" },
      "requested",
      false,
    ])
  })

  test("a Working TODO's page blinks its pill and links its run; In review links it steady; a merged one links none", () => {
    const RUN = "todo:6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f"
    const watch = { label: "Watch", href: `/app/runs/${encodeURIComponent(RUN)}` }
    const working = todoPageOf(card({ state: "working", runId: RUN }), "octo", "hello")
    expect([working.status, working.run]).toEqual([{ kind: "running", label: "Working", live: true }, watch])
    const review = todoPageOf(card({ state: "in_review", runId: RUN, prNumber: 42 }), "octo", "hello")
    expect([review.status, review.run]).toEqual([{ kind: "in_review", label: "In review" }, watch])
    const merged = todoPageOf(card({ state: "merged", runId: RUN, settledAt: "2026-10-20 11:00:00+00" }), "octo", "hello")
    expect(merged).not.toHaveProperty("run")
    expect(todoPageOf(card({ state: "working" }), "octo", "hello")).not.toHaveProperty("run")
  })

  test("the route shows the page once the device has it, Not found once the stack answered without it, else waits", () => {
    const todos = [todo({ id: "a", number: 4 })]
    expect(todoScreenOf(card(), 4, todos, "allowed", "octo", "hello").kind).toBe("page")
    expect(todoScreenOf(undefined, 9, todos, "allowed", "octo", "hello")).toEqual({ kind: "missing" })
    // The TODO is there and its prompt isn't yet, or the shape hasn't answered: the frame only.
    expect(todoScreenOf(undefined, 4, todos, "allowed", "octo", "hello")).toEqual({ kind: "waiting" })
    expect(todoScreenOf(undefined, 9, [], "unknown", "octo", "hello")).toEqual({ kind: "waiting" })
  })
})

describe("TODOs made from issues", () => {
  test("a draft from an issue takes the issue's title, and its body or else its title, cut to a TODO's limits", () => {
    const draft = { id: "d", title: "", prompt: "" }
    expect(draftFromIssue(draft, { title: "Fix the README", body: "It says **hello**." })).toEqual({
      id: "d",
      title: "Fix the README",
      prompt: "It says **hello**.",
    })
    expect(draftFromIssue(draft, { title: "Fix the README", body: " \n" }).prompt).toBe("Fix the README")
    expect(draftFromIssue({ id: "d", title: "Mine", prompt: "Kept" }, { title: "T", body: "B" })).toEqual({ id: "d", title: "Mine", prompt: "Kept" })
    expect(draftFromIssue(draft, { title: "x".repeat(MAX_TITLE_LENGTH + 10), body: "b" }).title).toHaveLength(MAX_TITLE_LENGTH)
  })

  test("a body over the prompt's limit is cut at a whole character and marked; one within it is kept whole", () => {
    expect(clipPrompt("short")).toBe("short")
    const fits = "é".repeat(MAX_PROMPT_BYTES / 2)
    expect(clipPrompt(fits)).toBe(fits)
    const clipped = clipPrompt("é".repeat(MAX_PROMPT_BYTES))
    expect(clipped.endsWith("…")).toBe(true)
    expect(isPrompt(clipped)).toBe(true)
    expect(new TextEncoder().encode(clipped).length).toBeLessThanOrEqual(MAX_PROMPT_BYTES)
    expect(clipped.slice(0, -1)).toBe("é".repeat(clipped.length - 1))
  })

  test("a TODO's row and page link the issue it was made from", () => {
    const todos = [todo({ id: "a", number: 4, issueNumber: 7 })]
    const [item] = stackItemsOf(stackRows(REPO, todos, [], []), todos, "octo", "hello")
    expect(item!.links).toEqual([{ label: "#7", href: "/octo/hello/issues/7" }])
    const card = todoCardOf(4, [], todos, [{ todoId: "a", revision: 1, repoId: REPO, prompt: "P", acceptance: [], byLogin: "maya", createdAt: "x" }])!
    expect(todoPageOf(card, "octo", "hello").issue).toEqual({ label: "#7", href: "/octo/hello/issues/7" })
  })

  test("each issue's TODOs, newest first, and whether one is still on the stack; other repositories' don't count", () => {
    const todos = [
      todo({ id: "a", number: 1, issueNumber: 7, state: "dropped", position: null }),
      todo({ id: "b", number: 3, issueNumber: 7 }),
      todo({ id: "c", number: 2, issueNumber: 9, state: "merged", position: null }),
      todo({ id: "d", number: 4 }),
      todo({ id: "e", number: 5, issueNumber: 9, repoId: "github/octo/other" }),
    ]
    const made = todosByIssue(REPO, todos, "octo", "hello")
    expect([...made.keys()].sort()).toEqual([7, 9])
    expect(made.get(7)).toEqual({
      links: [{ label: "T3 · T3", href: "/octo/hello/stack/3" }, { label: "T1 · T1", href: "/octo/hello/stack/1" }],
    })
    expect(made.get(9)).toEqual({ links: [{ label: "T2 · T2", href: "/octo/hello/stack/2" }] })
  })

  test("Make TODO shows for a person who may change the stack on any open issue, its TODOs open or not", () => {
    expect(mayMakeTodo(true, { state: "open" })).toBe(true)
    expect(mayMakeTodo(false, { state: "open" })).toBe(false)
    expect(mayMakeTodo(true, { state: "closed" })).toBe(false)
  })

  test("the issues list: each issue's TODOs after its own links, and Make TODO in its menu when it may be made", () => {
    const made = todosByIssue(REPO, [todo({ id: "b", number: 3, issueNumber: 7 })], "octo", "hello")
    const making: Array<number> = []
    const rows = withTodos(
      [
        { number: 7, title: "Seven", state: "open" },
        { number: 8, title: "Eight", state: "open", links: [{ label: "x", href: "/x" }] },
        { number: 9, title: "Nine", state: "closed" },
        { number: null, title: "Mine", state: "open", pending: "requested" },
      ],
      made,
      true,
      (number) => making.push(number),
    )
    // Issue 7's TODO is open, and Make TODO still shows: one issue can become a stack of TODOs.
    expect(rows.map((row) => [row.links, row.menu?.map((item) => item.label)])).toEqual([
      [[{ label: "T3 · T3", href: "/octo/hello/stack/3" }], ["Make TODO"]],
      [[{ label: "x", href: "/x" }], ["Make TODO"]],
      [undefined, undefined],
      [undefined, undefined],
    ])
    rows[0]!.menu![0]!.onSelect()
    rows[1]!.menu![0]!.onSelect()
    expect(making).toEqual([7, 8])
    expect(withTodos([{ number: 8, title: "Eight", state: "open" }], made, false, () => {})[0]!.menu).toBeUndefined()
  })
})


describe("TODO boundary regressions", () => {
  test("titles count Unicode characters and truncate without a lone surrogate", () => {
    expect(isTitle("😀".repeat(MAX_TITLE_LENGTH))).toBe(true)
    expect(isTitle("😀".repeat(MAX_TITLE_LENGTH + 1))).toBe(false)
  })

  test("title truncation preserves surrogate pairs", () => {
    expect(titleOf("a".repeat(118) + "😀bc")).toBe("a".repeat(118) + "😀…")
    expect(titleOf("😀".repeat(MAX_TITLE_LENGTH))).toBe("😀".repeat(MAX_TITLE_LENGTH))
  })

  test("delivery ignores another repository's matching TODO number and id", () => {
    const mine = [requested({ id: "drop", op: "drop", number: 1 }), requested({ id: "commit", op: "commit" })]
    expect(deliveredOf(REPO, [todo({ id: "commit", number: 1, state: "dropped", repoId: "github/other/repo" })], mine)).toEqual([])
    expect(deliveredOf(REPO, [todo({ id: "commit", number: 1, state: "dropped" })], mine)).toEqual(["drop", "commit"])
  })

  test("a refused change with no reason still has a badge label", () => {
    expect(notSentRows(REPO, [requested({ id: "refused", op: "drop", status: "not_sent", reason: null })])[0]?.reason).toBe("Not sent")
  })
})

test("Retry names the least role on the TODO's repository: own Member or anyone Maintainer", () => {
  const todo = { state: "failed" as const, createdLogin: "maya" }
  const session = { status: "signed_in", login: "maya" }
  const on = (role: "admin" | "maintainer" | "member" | "guest" | null) => ({ role, own: false })
  expect(mayRetry(todo, session, on("member"))).toBe(true)
  expect(mayRetry(todo, session, on("guest"))).toBe(false)
  expect(mayRetry(todo, { ...session, login: "other" }, on("member"))).toBe(false)
  expect(mayRetry(todo, { ...session, login: "other" }, on("maintainer"))).toBe(true)
  expect(mayRetry(todo, { ...session, login: "other" }, on("admin"))).toBe(true)
  expect(mayRetry({ ...todo, state: "working" }, session, on("member"))).toBe(false)
  // Before ChatApi answers for the repository, or signed out: no Retry.
  expect(mayRetry(todo, session, undefined)).toBe(false)
  expect(mayRetry(todo, { ...session, status: "signed_out" }, on("maintainer"))).toBe(false)
})

test("retry requests show Retry and leave the optimistic list only after the route took them", () => {
  const row: Requested = { ...sending({ id: "retry", op: "retry", number: 3 }), status: "not_sent", reason: "forbidden", taken: null }
  expect(notSentRows(REPO, [row])).toEqual([{ id: "retry", op: "retry", label: "Retry T3", reason: "Not allowed" }])
  expect(deliveredOf(REPO, [], [row])).toEqual([])
  expect(deliveredOf(REPO, [], [{ ...row, status: "requested", reason: null }])).toEqual(["retry"])
})

test.each(["commit", "drop"] as const)("a restored %s outbox receipt overrides a stale admission row without hiding a real refusal", op => {
  const outgoing = sending({ id: "same", op, title: "Pending", number: op === "drop" ? 1 : 0 })
  const stale = requested({ ...outgoing, status: "not_sent", reason: null })
  const todos = op === "drop" ? [todo({ id: "todo", number: 1 })] : []
  expect(stackRows(REPO, todos, [outgoing], [stale])[0]!.pending).toBe("requested")
  expect(notSentRows(REPO, [stale], [outgoing])).toEqual([])
  expect(stackRows(REPO, todos, [], [stale])[0]!.pending).toBe("not_sent")
  expect(notSentRows(REPO, [stale], [])).toHaveLength(1)
  const refusal = { ...stale, reason: "forbidden" as const }
  expect(stackRows(REPO, todos, [outgoing], [refusal])[0]!.pending).toBe("not_sent")
  expect(notSentRows(REPO, [refusal], [outgoing])).toHaveLength(1)
})
