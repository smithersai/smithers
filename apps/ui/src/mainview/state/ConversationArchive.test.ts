import { describe, expect, test } from "bun:test"
import type { AppTransition, WorldDocument } from "./AppState"
import { conversationNotes } from "./ConversationArchive"

/*
 * conversationNotes turns a model's chosen note titles into wiki records, and
 * a model chooses titles freely: two identical ones in a sweep, one that
 * already exists in another case, one made entirely of characters Windows
 * reserves. Nothing here was pinned, so dropping either de-duplication loop
 * or the character scrub was silent.
 */

type Notes = Extract<AppTransition, { readonly type: "conversation.cleared" }>["notes"]

const note = (title: string, body = "a fact recorded nowhere else"): Notes[number] => ({ title, body, confidence: 0.9 })

const document = (id: string, path: string): WorldDocument => ({
  id,
  path,
  title: path,
  body: "",
  links: [],
  tags: [],
  sources: [],
  confidence: 1,
  updatedBy: "smithers",
  updatedAt: 1_700_000_000_000,
  revision: 1
})

const sweep = (notes: Notes, existing: ReadonlyArray<WorldDocument> = []): WorldDocument[] =>
  conversationNotes(notes, existing, "branch-old", 7, "branch-new", 8, 1_700_000_000_000)

describe("conversation notes", () => {
  test("titles repeated inside one sweep take (2), (3) instead of overwriting each other", () => {
    const written = sweep([note("Deploy notes"), note("Deploy notes"), note("Deploy notes")])
    expect(written.map((record) => record.path)).toEqual([
      "Chat notes/Note - Deploy notes.md",
      "Chat notes/Note - Deploy notes (2).md",
      "Chat notes/Note - Deploy notes (3).md"
    ])
    // Every record is its own document; the title the model chose is kept verbatim.
    expect(new Set(written.map((record) => record.id)).size).toBe(3)
    for (const record of written) expect(record.title).toBe("Deploy notes")
  })

  test("a title colliding with an existing document in another case or normal form takes a suffix", () => {
    const cased = sweep([note("Deploy notes")], [document("w1", "chat notes/note - deploy notes.md")])
    expect(cased[0]?.path).toBe("Chat notes/Note - Deploy notes (2).md")
    // NFKC: the fullwidth D normalizes onto the ASCII one, so the paths collide on disk.
    const normalized = sweep([note("Deploy notes")], [document("w1", "Chat notes/Note - Ｄeploy notes.md")])
    expect(normalized[0]?.path).toBe("Chat notes/Note - Deploy notes (2).md")
  })

  test("reserved characters and trailing dots never reach the path", () => {
    const written = sweep([note("CON."), note("a/b:c"), note("what? <now> |then| \"quoted\"  ")])
    expect(written.map((record) => record.path)).toEqual([
      "Chat notes/Note - CON.md",
      "Chat notes/Note - a-b-c.md",
      "Chat notes/Note - what- -now- -then- -quoted-.md"
    ])
    // One separator only: a title can never write outside the Chat notes folder.
    for (const record of written) expect(record.path.split("/")).toHaveLength(2)
    for (const record of written) expect(record.path.endsWith("..md")).toBe(false)
  })

  test("an id already taken by an existing document is never reused", () => {
    const written = sweep(
      [note("First"), note("Second")],
      [document("world-sweep-branch-new-0", "other.md"), document("world-sweep-branch-new-0-new", "other-2.md")]
    )
    expect(written[0]?.id).toBe("world-sweep-branch-new-0-new-new")
    expect(written[1]?.id).toBe("world-sweep-branch-new-1")
  })

  test("the archive records where the notes came from and the revision they were written at", () => {
    const [written] = sweep([note("Wiring", "see [[Deploy notes]] for the rest")])
    expect(written?.sources).toEqual(["chat-sweep", "conversation:branch-old@7"])
    expect(written?.links).toEqual(["Deploy notes"])
    expect(written?.revision).toBe(8)
    expect(written?.updatedBy).toBe("smithers")
  })
})
