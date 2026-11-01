import type { APIRequestContext } from "@playwright/test"
import { expect, test } from "vitest"
import { allServerRows } from "./shape"

const row = (id: string, position: string) => ({ key: id, value: { id, position }, headers: { operation: "insert" as const } })

test("Electric's must-refetch starts the read again, keeping nothing of the handle it moved from", async () => {
  const asked: Array<string> = []
  const answers = [
    { status: 200, body: [row("old", "1")], headers: { "electric-offset": "0_0", "electric-handle": "gone" } },
    { status: 409, body: [{ headers: { control: "must-refetch" } }], headers: {} },
    { status: 200, body: [row("new", "2")], headers: { "electric-up-to-date": "" } },
  ]
  const request = {
    get: async (path: string) => {
      asked.push(path)
      const answer = answers.shift()!
      return { status: () => answer.status, json: async () => answer.body, headers: () => answer.headers }
    },
  } as unknown as APIRequestContext
  const rows = await allServerRows(request)
  expect(rows.map((each) => each.id)).toEqual(["new"])
  expect(asked[1]).toContain("handle=gone")
  expect(asked[2]).toMatch(/offset=-1&cache-buster=[0-9a-f-]{36}$/)
})
