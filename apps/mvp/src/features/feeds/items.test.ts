// A document's items (src/features/feeds/items.ts): the elements of its body array that carry a string id, as
// `core/feed-items` serves them, each with an answer id that stays the same for the same element.
import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { itemsOf } from "./items"

const items = (body: unknown, repo = "octo/hello", document = "decisions") => Effect.runPromise(itemsOf(repo, document, body))

describe("a document's items", () => {
  test("every object with a string id, in order, the first of an id only; its string options; the element itself", async () => {
    const rows = await items([
      { id: "a", title: "First", options: ["accept", 2, "changes"] },
      "not an item",
      null,
      ["a list"],
      { title: "no id" },
      { id: "" },
      { id: 7 },
      { id: "b" },
      { id: "a", title: "a repeat" },
    ])
    expect(rows.map(({ answer: _, ...row }) => row)).toEqual([
      {
        key: "octo/hello:decisions:a",
        repo: "octo/hello",
        owner: "octo",
        name: "hello",
        document: "decisions",
        index: 0,
        item: "a",
        options: ["accept", "changes"],
        chooses: true,
        body: { id: "a", title: "First", options: ["accept", 2, "changes"] },
      },
      {
        key: "octo/hello:decisions:b",
        repo: "octo/hello",
        owner: "octo",
        name: "hello",
        document: "decisions",
        index: 1,
        item: "b",
        options: [],
        chooses: false,
        body: { id: "b" },
      },
    ])
  })

  test("a body that is not an array has none", async () => {
    expect(await items({ id: "a" })).toEqual([])
    expect(await items(undefined)).toEqual([])
  })

  test("an answer id is a UUID, the same for the same element, another for a changed one or another place", async () => {
    const [first] = await items([{ id: "a", title: "First" }])
    const [again] = await items([{ id: "a", title: "First" }])
    const [changed] = await items([{ id: "a", title: "First, reworded" }])
    const [elsewhere] = await items([{ id: "a", title: "First" }], "octo/other")
    const [otherDocument] = await items([{ id: "a", title: "First" }], "octo/hello", "reviews")
    expect(first!.answer).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(again!.answer).toBe(first!.answer)
    expect(new Set([first!.answer, changed!.answer, elsewhere!.answer, otherDocument!.answer]).size).toBe(4)
  })
})
