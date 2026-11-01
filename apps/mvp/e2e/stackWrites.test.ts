import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "vitest"
import { cleanScratch, dropWord } from "./stackWrites"

type Row = Record<string, unknown> & { readonly key: string }

/** ChatApi as a scratch repository's cleanup meets it: its shapes, and every write it was sent, in order. */
const app = (shapes: Record<string, ReadonlyArray<Row>>, refuses?: (path: string) => number | undefined) => {
  const writes: Array<string> = []
  const answer = (status: number, body: unknown) => ({ status: () => status, json: async () => body, headers: () => ({}) })
  const request = {
    get: async (path: string) => {
      const name = /\/api\/shapes\/([a-z-]+)/.exec(path)![1]!
      return answer(200, [
        ...(shapes[name] ?? []).map(({ key, ...value }) => ({ key, value, headers: { operation: "insert" } })),
        { headers: { control: "up-to-date" } },
      ])
    },
    delete: async (path: string) => {
      writes.push(`DELETE ${path}`)
      return answer(refuses?.(path) ?? 202, {})
    },
    post: async (path: string, options: { readonly data: Record<string, unknown> }) => {
      writes.push(`${options.data.op} ${options.data.number ?? `${options.data.lanes} ${options.data.base}`}`)
      return answer(refuses?.(String(options.data.op)) ?? 202, {})
    },
  } as unknown as APIRequestContext
  return { page: { request }, writes }
}

const REPO = "owner/scratch"
const todo = (number: string, state: string, title: string) => ({ key: `t${number}`, number, state, title })

test("a dirty scratch repository goes back: runners and agents first, then its open TODOs, then one stacked lane", async () => {
  const { page, writes } = app({
    machines: [
      { key: "a", name: "e2e-dead", removed_at: null },
      { key: "b", name: "e2e-gone", removed_at: "2026-11-01" },
      { key: "c", name: "someone-elses", removed_at: null },
    ],
    todos: [
      todo("7", "working", "Quick 23 fxyz"),
      todo("8", "in_review", "Note alpha"),
      todo("9", "failed", "Oldest"),
      todo("6", "dropped", "Long gone"),
      todo("5", "merged", "Long done"),
    ],
  })
  expect(await cleanScratch(page, REPO)).toEqual({
    runners: ["e2e-dead"],
    todos: ["T7 working: Quick 23 fxyz", "T8 in_review: Note alpha", "T9 failed: Oldest"],
  })
  expect(writes).toEqual([
    `DELETE /api/repos/${REPO}/agents/e2e-dead`,
    `DELETE /api/repos/${REPO}/runners/e2e-dead`,
    "drop 7",
    "drop 8",
    "drop 9",
    "configure 1 stacked",
  ])
})

test("a clean one reports nothing and still sets its lanes, which no route reads back", async () => {
  const { page, writes } = app({ machines: [], todos: [] })
  expect(await cleanScratch(page, REPO)).toEqual({ runners: [], todos: [] })
  expect(writes).toEqual(["configure 1 stacked"])
})

test("a refusal stops the run at once, naming what stayed dirty", async () => {
  const dirty = { machines: [{ key: "a", name: "e2e-dead", removed_at: null }], todos: [todo("7", "working", "x")] }
  await expect(cleanScratch(app(dirty, (path) => (path.endsWith("runners/e2e-dead") ? 403 : undefined)).page, REPO))
    .rejects.toThrow("DELETE runners/e2e-dead answered 403")
  await expect(cleanScratch(app(dirty, (path) => (path === "drop" ? 503 : undefined)).page, REPO))
    .rejects.toThrow("dropping T7 answered 503")
  await expect(cleanScratch(app({}, (path) => (path === "configure" ? 403 : undefined)).page, REPO))
    .rejects.toThrow("configuring the stack answered 403")
})

test("a test's word drops its own open TODOs, one whose commit answer was lost included, and no one else's", async () => {
  const { page, writes } = app({ todos: [todo("7", "working", "Quick 23 fxyz"), todo("8", "working", "Other"), todo("9", "dropped", "Quick 1 fxyz")] })
  await dropWord(page, REPO, "fxyz")
  expect(writes).toEqual(["drop 7"])
})
