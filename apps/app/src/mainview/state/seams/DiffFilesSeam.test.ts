import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { createDiffFilesSeam, PRACTICE_DIFF_CARD } from "./DiffFilesSeam"
import { practiceImplementation, PRACTICE_REPO } from "../practice/PracticeRepository"

const setup = async (http: (url: string) => Promise<Response> = async () => { throw new Error("unexpected network") }) => {
  const data = new Map<string, string>()
  const store = await createAppStore({ kind: "localStorage", storage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } } })
  let ordinal = 0
  return { store, seam: createDiffFilesSeam({ store, dispatch: store.dispatch, actor: () => "user", nextOrdinal: () => ++ordinal, http, baseUrl: "https://app.test" }) }
}

test("recorded implementation applies actual patches and preserves the rest of each file", () => {
  const result = practiceImplementation()
  expect(result.contents["src/hello.ts"]).toContain('name || "world"')
  expect(result.contents["README.md"]).toStartWith("# hello-server")
  expect(result.files).toHaveLength(3)
})

test("diff file navigation keeps one frame, records revision and supports back/forward", async () => {
  const { store, seam } = await setup()
  const result = practiceImplementation()
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: PRACTICE_DIFF_CARD, kind: "diff", title: "Diff", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: PRACTICE_REPO, changeId: result.changeId, from: result.base, to: result.commitId, pin: { changeId: result.changeId, commitId: result.commitId, seq: null }, files: result.files } } }).isPersisted.promise
  expect(typeof await seam.openDiffFile(PRACTICE_DIFF_CARD, "src/hello.ts")).toBe("object")
  let card = store.collections.cards.get(PRACTICE_DIFF_CARD)!
  expect(card.kind).toBe("file")
  if (card.kind === "file") { expect(card.payload.content).toContain('name || "world"'); expect(card.payload.readAt?.commitId).toBe(result.commitId) }
  expect(card.ordinal).toBe(1)
  expect(store.collections.cards.size).toBe(1)
  await store.dispatch({ type: "card.history.moved", actor: "user", id: card.id, delta: -1 }).isPersisted.promise
  expect(store.collections.cards.get(card.id)?.kind).toBe("diff")
  await store.dispatch({ type: "card.history.moved", actor: "user", id: card.id, delta: 1 }).isPersisted.promise
  expect(store.collections.cards.get(card.id)?.kind).toBe("file")
})

test("real diff reads the pinned SHA and leaves the diff intact on failure", async () => {
  const seen: string[] = []
  const { store, seam } = await setup(async url => { seen.push(url); return new Response("{}", { status: 404 }) })
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "diff", kind: "diff", title: "Diff", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "owner/repo", changeId: "change", from: "parent", to: "current", pin: { changeId: "change", commitId: "abc123", seq: null }, files: [{ path: "src/my file.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1 }] } } }).isPersisted.promise
  expect(await seam.openDiffFile("diff", "src/my file.ts")).toContain("404")
  expect(seen).toEqual(["https://app.test/api/repos/owner/repo/contents/src/my%20file.ts?ref=abc123"])
  expect(store.collections.cards.get("diff")?.kind).toBe("diff")
})

test("real file projection records the diff commit instead of the current head", async () => {
  const { store, seam } = await setup(async () => new Response(JSON.stringify({ content: btoa("pinned content\n"), encoding: "base64" })))
  await store.dispatch({ type: "card.upsert", actor: "user", card: { id: "diff", kind: "diff", title: "Diff", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: "owner/repo", changeId: "change", from: "1", to: "2", pin: { changeId: "change", commitId: "abc123", seq: 2 }, files: [{ path: "file.ts", changeType: "modified", isBinary: false, additions: 1, deletions: 1 }] } } }).isPersisted.promise
  await seam.openDiffFile("diff", "file.ts")
  const card = store.collections.cards.get("diff")!
  expect(card.kind).toBe("file")
  if (card.kind === "file") {
    expect(card.payload.content).toBe("pinned content\n")
    expect(card.payload.readAt).toEqual({ changeId: "change", commitId: "abc123" })
  }
})
