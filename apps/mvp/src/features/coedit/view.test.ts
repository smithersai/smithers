// Which open text a repository page edits in place (docs/features/repo.md#the-browser): pure, over rows as the store
// keeps them.
import { describe, expect, test } from "vitest"
import type { Shared } from "./schema"
import { markdownInPlace } from "./view"

const row = (overrides: Partial<Shared>): Shared => ({
  id: "t",
  kind: "file",
  key: "c1/docs/guide.md",
  status: "ready",
  shown: true,
  stored: true,
  failure: null,
  text: "# Guide\n",
  selection: null,
  collaborators: [],
  saving: false,
  saved: false,
  saveFailed: false,
  ...overrides,
})

describe("a Markdown file edited in place", () => {
  test("a writer's page of a Markdown file whose text loaded edits it", () => {
    const file = row({})
    expect(markdownInPlace([row({ id: "p", kind: "prompt", key: "c1" }), file], "c1", "blob", "docs/guide.md")).toBe(file)
  })

  test("no conversation (anyone who may not write), a directory, code, another branch's text or none: read-only", () => {
    const texts = [row({})]
    expect(markdownInPlace(texts, undefined, "blob", "docs/guide.md")).toBeUndefined()
    expect(markdownInPlace(texts, "c1", "tree", "docs/guide.md")).toBeUndefined()
    expect(markdownInPlace([row({ key: "c1/src/app.ts" })], "c1", "blob", "src/app.ts")).toBeUndefined()
    expect(markdownInPlace(texts, "c2", "blob", "docs/guide.md")).toBeUndefined()
    expect(markdownInPlace([], "c1", "blob", "docs/guide.md")).toBeUndefined()
  })

  test("a text still loading, or one that failed, leaves the read-only document", () => {
    expect(markdownInPlace([row({ status: "loading", text: "" })], "c1", "blob", "docs/guide.md")).toBeUndefined()
    expect(markdownInPlace([row({ status: "failed", failure: "forbidden" })], "c1", "blob", "docs/guide.md")).toBeUndefined()
  })
})
