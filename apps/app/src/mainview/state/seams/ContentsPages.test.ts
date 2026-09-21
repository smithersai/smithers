import { describe, expect, test } from "bun:test"
import { MAX_CONTENTS_ENTRIES, readContentsPages } from "./ContentsPages"
const COMMIT = "a".repeat(40)

describe("public contents pages", () => {
  test("refuses a directory above the card cap instead of showing a partial listing", async () => {
    const seen: string[] = []
    const result = await readContentsPages(async (url) => {
      seen.push(url)
      const page = seen.length
      return new Response(JSON.stringify(Array.from({ length: 1000 }, (_, index) => ({ name: `file-${page}-${index}`, type: "file" }))), {
        headers: { "X-Next-Cursor": `file-${page}-999`, "X-Contents-Commit": COMMIT }
      })
    }, "/api/repos/a/b/contents")
    expect(result).toEqual({ kind: "error", error: "Directory listing exceeds 10,000 entries." })
    expect(seen).toHaveLength(MAX_CONTENTS_ENTRIES / 1000 + 1)
  })

  test("refuses a repeated cursor", async () => {
    const result = await readContentsPages(async () => new Response("[{}]", { headers: { "X-Next-Cursor": "same", "X-Contents-Commit": COMMIT } }), "/api/repos/a/b/contents")
    expect(result).toEqual({ kind: "error", error: "Directory listing cursor did not advance." })
  })

  test("refuses a moving commit on a later page", async () => {
    let calls = 0
    const requests: string[] = []
    const result = await readContentsPages(async (url) => {
      requests.push(url)
      calls++
      return new Response("[{}]", { headers: {
        "X-Next-Cursor": `path-${calls}`,
        "X-Contents-Commit": calls === 1 ? COMMIT : "b".repeat(40)
      } })
    }, "/api/repos/a/b/contents?ref=main")
    expect(result).toEqual({ kind: "error", error: "Directory changed while listing." })
    expect(calls).toBe(2)
    expect(requests[1]).toBe(`/api/repos/a/b/contents?ref=${COMMIT}&after=path-1`)
  })

  test("returns a later-page HTTP failure without partial data", async () => {
    let calls = 0
    const result = await readContentsPages(async () => {
      calls++
      return calls === 1
        ? new Response("[{\"name\":\"first\"}]", { headers: { "X-Next-Cursor": "first", "X-Contents-Commit": COMMIT } })
        : new Response("{\"message\":\"unavailable\"}", { status: 503 })
    }, "/api/repos/a/b/contents")
    expect(result.kind).toBe("response")
    if (result.kind === "response") {
      expect(result.response.status).toBe(503)
      expect(result.body).toBeNull()
    }
  })
})
