// What an entry the notifications panel expands shows (src/features/attention/detail.ts), and where a route shows the
// feed (contract.ts `surfaceOf`): pure, so every rule is a case here.
import { describe, expect, test } from "vitest"
import { floatsBell, surfaceOf } from "./contract"
import { type DetailSources, detailOf, FAILURE_WORDS, MAX_NOTE_LENGTH, STEPS_SHOWN } from "./detail"
import type { Entry } from "./schema"

const entry = (overrides: Partial<Entry> = {}): Entry => ({
  id: "run:r1",
  kind: "run",
  state: "working",
  mine: true,
  runId: "r1",
  conversationId: "c-home",
  actor: "ann",
  atMs: 0,
  word: null,
  detail: "Deploy the docs preview",
  action: "open",
  href: "/app",
  version: 1,
  unread: true,
  settled: false,
  stack: true,
  stackHere: false,
  listed: true,
  here: true,
  order: 0,
  ...overrides,
})

const step = (id: string, status: "running" | "done" | "failed") => ({ id, kind: "step" as const, flow: `app/${id}`, status })

const message = (overrides: Partial<NonNullable<DetailSources["message"]>> = {}): NonNullable<DetailSources["message"]> => ({
  text: "",
  status: "streaming",
  failure: null,
  ...overrides,
})

const wait = { execution: "ask/1", kind: "question" as const, prompt: "Which branch?", options: ["main", "docs-v2"] }

const run = (overrides: Partial<NonNullable<DetailSources["run"]>> = {}): NonNullable<DetailSources["run"]> => ({
  status: "needs_you",
  wait,
  version: 2,
  answeredAt: null,
  ...overrides,
})

const of = (sources: Partial<DetailSources>) =>
  detailOf({ entry: entry(), message: undefined, run: undefined, local: undefined, ...sources })

describe("detailOf", () => {
  test("a run this device holds nothing of: nothing more than its row", () => {
    expect(of({})).toEqual({ id: "run:r1", meta: null, steps: [], note: null, question: null, retry: false })
  })

  test("a live run: its last three steps, in order, as the flow it called and how that went", () => {
    const parts = [step("a", "done"), step("b", "done"), step("c", "failed"), step("d", "running")]
    expect(of({ message: message({ parts }) }).steps).toEqual([
      { id: "b", label: "app/b", state: "done" },
      { id: "c", label: "app/c", state: "failed" },
      { id: "d", label: "app/d", state: "running" },
    ])
    expect(STEPS_SHOWN).toBe(3)
    // A row the device kept from before parts were read has none; a working answer's text isn't a note.
    expect(of({ message: message({ text: "Deploying" }) })).toMatchObject({ steps: [], note: null })
  })

  test("done: the answer's text, trimmed, cut at the limit; an empty answer says nothing", () => {
    const done = entry({ state: "done", settled: true })
    expect(of({ entry: done, message: message({ status: "done", text: "  Deployed docs-v2.\n" }) }).note).toBe(
      "Deployed docs-v2.",
    )
    const long = "x".repeat(MAX_NOTE_LENGTH + 10)
    const note = of({ entry: done, message: message({ status: "done", text: long }) }).note!
    expect(note).toHaveLength(MAX_NOTE_LENGTH)
    expect(note.endsWith("…")).toBe(true)
    expect(of({ entry: done, message: message({ status: "done", text: "x".repeat(MAX_NOTE_LENGTH) }) }).note).toHaveLength(
      MAX_NOTE_LENGTH,
    )
    expect(of({ entry: done, message: message({ status: "done", text: "   " }) }).note).toBeNull()
  })

  test("failed: why, in a word, and Retry only for the person's own run in the conversation the tab shows", () => {
    const failed = entry({ state: "failed", settled: true })
    for (const failure of ["quota", "rate_limited", "model_error", "empty", "abandoned", "unfinished"] as const) {
      expect(of({ entry: failed, message: message({ status: "failed", failure }) })).toMatchObject({
        note: FAILURE_WORDS[failure],
        retry: true,
      })
    }
    // A failure with no reason reads as the model's.
    expect(of({ entry: failed, message: message({ status: "failed" }) }).note).toBe("Model error")
    expect(of({ entry: { ...failed, here: false }, message: message({ status: "failed" }) }).retry).toBe(false)
    expect(of({ entry: { ...failed, mine: false }, message: message({ status: "failed" }) }).retry).toBe(false)
    // The run's row says failed, but this device's answer doesn't (yet): nothing to ask again.
    expect(of({ entry: failed, message: message({ status: "streaming" }) }).retry).toBe(false)
    expect(of({ entry: failed }).retry).toBe(false)
    // A failed answer under an entry that still reads live says why, and offers no Retry.
    expect(of({ message: message({ status: "failed", failure: "empty" }) })).toMatchObject({ note: "No answer", retry: false })
  })

  test("needs you: the person's open question with this tab's draft of the same question", () => {
    const asks = entry({ state: "needs_you", action: "answer" })
    const local = { version: 2, draft: "docs", sending: true }
    expect(of({ entry: asks, run: run(), local }).question).toEqual({
      kind: "question",
      prompt: "Which branch?",
      options: ["main", "docs-v2"],
      draft: "docs",
      sending: true,
    })
    // A draft of an older question starts fresh.
    expect(of({ entry: asks, run: run(), local: { ...local, version: 1 } }).question).toMatchObject({
      draft: "",
      sending: false,
    })
    expect(of({ entry: asks, run: run() }).question).toMatchObject({ draft: "", sending: false })
    expect(of({ entry: asks, run: run({ wait: { ...wait, kind: "approval", options: [] } }) }).question).toMatchObject({
      kind: "approval",
      options: [],
    })
  })

  test("no question once it is answered, the run moved on, it isn't the person's, or the row has none", () => {
    const asks = entry({ state: "needs_you", action: "answer" })
    expect(of({ entry: asks, run: run({ answeredAt: "2026-10-20 12:00:00+00" }) }).question).toBeNull()
    expect(of({ entry: asks, run: run({ status: "working" }) }).question).toBeNull()
    expect(of({ entry: { ...asks, mine: false }, run: run() }).question).toBeNull()
    expect(of({ entry: { ...asks, state: "working" }, run: run() }).question).toBeNull()
    expect(of({ entry: asks, run: run({ wait: null }) }).question).toBeNull()
    expect(of({ entry: asks }).question).toBeNull()
  })

  test("main and a release: who pushed or published; a run's launcher is the person and isn't repeated", () => {
    const main = entry({ id: "main:r", kind: "main", state: "update", runId: null, actor: "dana", mine: false })
    expect(of({ entry: main })).toEqual({ id: "main:r", meta: "dana", steps: [], note: null, question: null, retry: false })
    expect(of({ entry: { ...main, kind: "release", actor: null } }).meta).toBeNull()
    expect(of({}).meta).toBeNull()
  })
})

describe("surfaceOf", () => {
  test("the home conversation and a branch's page show a conversation; every other route, or none, is a page", () => {
    expect(surfaceOf("/app")).toBe("conversation")
    expect(surfaceOf("/$owner/$repo/tree/$ref/$")).toBe("conversation")
    expect(surfaceOf("/app/runs")).toBe("page")
    expect(surfaceOf("/$owner/$repo")).toBe("page")
    expect(surfaceOf(undefined)).toBe("page")
  })
})

describe("floatsBell", () => {
  test("a page floats the bell unless its header holds it: the home conversation's or the repository header; no route yet, none", () => {
    for (const route of ["/", "/app/runs", "/app/flows", "/$owner/$repo/stack/$number"]) {
      expect(floatsBell(route)).toBe(true)
    }
    for (const route of [
      "/app", "/$owner/$repo", "/$owner/$repo/tree/$ref/$", "/$owner/$repo/blob/$ref/$", "/$owner/$repo/raw/$ref/$", "/$owner/$repo/docs",
      "/$owner/$repo/docs/$", "/$owner/$repo/issues", "/$owner/$repo/issues/new", "/$owner/$repo/runs", "/$owner/$repo/pulls",
      "/$owner/$repo/stack", "/$owner/$repo/settings/secrets", "/$owner/$repo/issues/$number", "/$owner/$repo/pull/$number", "/$owner/$repo/pull/$number/$tab", "/$owner/$repo/branches",
      "/$owner/$repo/-/$plugin", "/$owner/$repo/-/$plugin/$",
    ]) {
      expect(floatsBell(route)).toBe(false)
    }
    expect(floatsBell(undefined)).toBe(false)
  })
})

describe("a clone's detail", () => {
  test("Retry shows on the person's failed clone wherever the tab is, with no run of its own", () => {
    const clone = entry({ id: "clone:github/acme/widgets", kind: "clone", state: "failed", runId: null, actor: null, action: "retry" })
    expect(detailOf({ entry: clone, message: undefined, run: undefined, local: undefined })).toMatchObject({
      meta: null,
      steps: [],
      note: null,
      question: null,
      retry: true,
    })
    expect(
      detailOf({ entry: { ...clone, action: "open", state: "done" }, message: undefined, run: undefined, local: undefined })
        .retry,
    ).toBe(false)
  })
})
