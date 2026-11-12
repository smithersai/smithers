import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Schema from "effect/Schema"
import * as Repository from "../src/Repository.ts"

// Ids GitHub answered for these objects on 2026-11-10 (POST git/blobs, git/trees, git/commits on a test repository):
// the hashing below must agree with a real host byte for byte.
const HELLO_BLOB = "ce013625030ba8dba906f756967f9e9ca394464a"
const HELLO_TREE = "2e81171448eb9f2ee3821e3d447aa6b2fe3ddba1"
const FIRST_COMMIT = "c01568472a7d08c389e3c4ddc379055981074253"
const NO_NEWLINE_COMMIT = "b36f2e7d31670bd6c089857eb67d018ededd62c2"
const who: Repository.Person = { name: "VibeLang history", email: "history@vibelang.invalid", seconds: 1794009600 }
const first: Repository.CommitObject = {
  tree: HELLO_TREE,
  parents: [],
  author: who,
  committer: who,
  message: "m1 first\n\nMythical: m1\n"
}

const run = <A>(effect: Effect.Effect<A, Repository.RepositoryError>) => Effect.runPromise(effect)
const failure = <A>(effect: Effect.Effect<A, Repository.RepositoryError>) => Effect.runPromise(Effect.flip(effect))

describe("hashing", () => {
  it("hashes blobs, trees and commits as git and GitHub do", async () => {
    expect(await run(Repository.hashBlob("hello\n"))).toBe(HELLO_BLOB)
    expect(await run(Repository.hashTree([{ name: "a.txt", mode: "100644", oid: HELLO_BLOB }]))).toBe(HELLO_TREE)
    expect(await run(Repository.hashTree([]))).toBe(Repository.EMPTY_TREE)
    expect(await run(Repository.hashCommit(first))).toBe(FIRST_COMMIT)
    expect(await run(Repository.hashCommit({ ...first, parents: [FIRST_COMMIT], message: "no newline" })))
      .toBe(NO_NEWLINE_COMMIT)
  })

  it("sorts a tree as git does: a tree's name as if it ended in '/'", () => {
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes.filter((byte) => byte >= 0x20 && byte < 0x7f))
    const encoded = Repository.encodeTree([
      { name: "a.txt", mode: "100644", oid: HELLO_BLOB },
      { name: "a", mode: "040000", oid: HELLO_TREE },
      { name: "a-b", mode: "100755", oid: HELLO_BLOB },
      { name: "bb", mode: "100644", oid: HELLO_BLOB },
      { name: "b", mode: "100644", oid: HELLO_BLOB }
    ])
    // "a-b" < "a.txt" < "a/" bytewise ('-' 0x2d, '.' 0x2e, '/' 0x2f); a tree is written with mode 40000.
    expect(text(encoded).indexOf("100755 a-b")).toBeLessThan(text(encoded).indexOf("100644 a.txt"))
    expect(text(encoded).indexOf("100644 a.txt")).toBeLessThan(text(encoded).indexOf("40000 a"))
    // A name that is a prefix of another sorts first.
    expect(text(encoded).indexOf("100644 b")).toBeLessThan(text(encoded).indexOf("100644 bb"))
    expect(new TextDecoder().decode(Repository.encodeCommit({ ...first, parents: [FIRST_COMMIT] })))
      .toContain(`parent ${FIRST_COMMIT}\nauthor VibeLang history <history@vibelang.invalid> 1794009600 +0000\n`)
  })
})

describe("errors and validation", () => {
  it("builds errors with a stable message and refines them", () => {
    const error = Repository.repositoryError("conflict", "updateRefs", "moved", ["refs/heads/a"])
    expect(error.message).toBe("conflict: Repository.updateRefs: moved")
    expect(error.refs).toEqual(["refs/heads/a"])
    expect(Repository.repositoryError("invalid", "x", "y").refs).toBeUndefined()
    expect(Repository.isRepositoryError(error)).toBe(true)
    expect(Repository.isRepositoryError(new Error("no"))).toBe(false)
    expect(Repository.isRepositoryError(null)).toBe(false)
    const journaled = JSON.parse(JSON.stringify(Schema.encodeUnknownSync(Repository.RepositoryError)(error)))
    expect(Schema.decodeUnknownSync(Repository.RepositoryError)(journaled).refs).toEqual(["refs/heads/a"])
  })

  it("keeps a rate limit's wait as the retry policy's retryAfterMillis, and drops a wait that is not one", () => {
    const limited = Repository.repositoryError("unavailable", "writeBlob", "rate limited", undefined, 90_000)
    expect(limited.retryAfterMillis).toBe(90_000)
    expect(Object.getOwnPropertyDescriptor(limited, "retryAfterMillis")?.value).toBe(90_000)
    for (const wait of [-1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(
        Object.hasOwn(Repository.repositoryError("unavailable", "writeBlob", "x", undefined, wait), "retryAfterMillis")
      ).toBe(false)
    }
    const journaled = JSON.parse(JSON.stringify(Schema.encodeUnknownSync(Repository.RepositoryError)(limited)))
    expect(Schema.decodeUnknownSync(Repository.RepositoryError)(journaled).retryAfterMillis).toBe(90_000)
  })

  it("accepts only refs under refs/ that follow git's rules", () => {
    for (const ref of ["refs/heads/mythical", "refs/notes/mythical", "refs/heads/smithers/history"]) {
      expect(Repository.isRefName(ref)).toBe(true)
    }
    for (
      const ref of [
        "mythical",
        "refs/heads",
        "refs/heads/a..b",
        "refs/heads/.x",
        "refs/heads/x.lock",
        "refs//x",
        "refs/heads/a b",
        `refs/heads/${"x".repeat(250)}`,
        7
      ]
    ) {
      expect(Repository.isRefName(ref)).toBe(false)
    }
  })

  it("refuses malformed ids, revisions, entries, commits, refs and transactions as invalid", async () => {
    const codes = async (effects: ReadonlyArray<Effect.Effect<unknown, Repository.RepositoryError>>) =>
      Promise.all(effects.map(async (effect) => (await failure(effect)).code))
    const entry = { name: "a", mode: "100644", oid: HELLO_BLOB } as const
    expect(
      await codes([
        Repository.requireObjectId("m", "abc"),
        Repository.requireRevision("m", "abc"),
        Repository.requireRevision("m", 7),
        Repository.requireEntries("m", "x" as never),
        Repository.requireEntries("m", [{ ...entry, name: "a/b" }]),
        Repository.requireEntries("m", [{ ...entry, name: "." }]),
        Repository.requireEntries("m", [{ ...entry, mode: "100600" as never }]),
        Repository.requireEntries("m", [{ ...entry, oid: "x" }]),
        Repository.requireEntries("m", [null as never]),
        Repository.requireEntries("m", [entry, entry]),
        Repository.requireCommit("m", null as never),
        Repository.requireCommit("m", { ...first, tree: "x" }),
        Repository.requireCommit("m", { ...first, parents: ["x"] }),
        Repository.requireCommit("m", { ...first, parents: "x" as never }),
        Repository.requireCommit("m", { ...first, author: { ...who, name: "a <b>" } }),
        Repository.requireCommit("m", { ...first, author: { ...who, name: " padded" } }),
        Repository.requireCommit("m", { ...first, author: { ...who, email: "", name: "" } }),
        Repository.requireCommit("m", { ...first, committer: { ...who, seconds: -1 } }),
        Repository.requireCommit("m", { ...first, committer: { ...who, seconds: 1.5 } }),
        Repository.requireCommit("m", { ...first, committer: null as never }),
        Repository.requireCommit("m", { ...first, message: 7 as never }),
        Repository.requireRefs("m", []),
        Repository.requireRefs("m", ["refs/heads/a", "refs/heads/a"]),
        Repository.requireRefs("m", "refs/heads/a" as never),
        Repository.requireRefs("m", Array.from({ length: 26 }, (_, i) => `refs/heads/r${i}`)),
        Repository.requireTransaction("m", { operation: "", updates: [] }),
        Repository.requireTransaction("m", { operation: "a b", updates: [] }),
        Repository.requireTransaction("m", null as never),
        Repository.requireTransaction("m", { operation: "op", updates: "x" as never }),
        Repository.requireTransaction("m", {
          operation: "op",
          updates: [{ ref: "refs/heads/a", before: "x", after: null }]
        }),
        Repository.requireTransaction("m", {
          operation: "op",
          updates: [{ ref: "refs/heads/a", before: null, after: "x" }]
        }),
        Repository.requireTransaction("m", { operation: "op", updates: [null as never] }),
        Repository.requireTransaction("m", { operation: "op", updates: [] }),
        Repository.requireAnswer("m", HELLO_BLOB, HELLO_TREE)
      ])
    ).toEqual(Array(34).fill("invalid"))
    expect(await run(Repository.requireAnswer("m", HELLO_BLOB, HELLO_BLOB))).toBe(HELLO_BLOB)
    expect(await run(Repository.requireRevision("m", "ce01"))).toBe("ce01")
  })
})

describe("makeMemory", () => {
  it("stores objects under git's ids, reads them back, and writes an object twice once", async () => {
    const repo = Repository.makeMemory()
    expect(await run(repo.writeBlob("hello\n"))).toBe(HELLO_BLOB)
    expect(await run(repo.writeBlob("hello\n"))).toBe(HELLO_BLOB)
    expect(await run(repo.readBlob(HELLO_BLOB))).toBe("hello\n")
    const tree = await run(repo.writeTree([{ name: "a.txt", mode: "100644", oid: HELLO_BLOB }]))
    expect(tree).toBe(HELLO_TREE)
    expect(await run(repo.readTree(tree))).toEqual([{ name: "a.txt", mode: "100644", oid: HELLO_BLOB }])
    const nested = await run(repo.writeTree([
      { name: "z", mode: "100644", oid: HELLO_BLOB },
      { name: "dir", mode: "040000", oid: tree },
      { name: "module", mode: "160000", oid: FIRST_COMMIT }
    ]))
    expect((await run(repo.readTree(nested))).map((entry) => entry.name)).toEqual(["dir", "module", "z"])
    expect(await run(repo.writeCommit(first))).toBe(FIRST_COMMIT)
    const second = await run(repo.writeCommit({ ...first, parents: [FIRST_COMMIT], message: "no newline" }))
    expect(second).toBe(NO_NEWLINE_COMMIT)
    expect(await run(repo.readCommit(FIRST_COMMIT.slice(0, 12)))).toEqual({
      oid: FIRST_COMMIT,
      tree: HELLO_TREE,
      parents: [],
      message: first.message
    })
    expect((await run(repo.readCommit(second))).parents).toEqual([FIRST_COMMIT])
  })

  it("holds git's empty tree before anything is written, as git does", async () => {
    const repo = Repository.makeMemory()
    expect(await run(repo.readTree(Repository.EMPTY_TREE))).toEqual([])
    const commit = await run(repo.writeCommit({ ...first, tree: Repository.EMPTY_TREE }))
    expect((await run(repo.readCommit(commit))).tree).toBe(Repository.EMPTY_TREE)
  })

  it("answers not_found for a missing or mistyped object and invalid for a write naming one", async () => {
    const repo = Repository.makeMemory()
    const blob = await run(repo.writeBlob("x"))
    expect((await failure(repo.readBlob(HELLO_BLOB))).code).toBe("not_found")
    expect((await failure(repo.readTree(blob))).code).toBe("not_found")
    expect((await failure(repo.readCommit(blob))).code).toBe("not_found")
    expect((await failure(repo.readCommit("ffff"))).code).toBe("not_found")
    expect((await failure(repo.readBlob("x"))).code).toBe("invalid")
    expect((await failure(repo.readTree("x"))).code).toBe("invalid")
    expect((await failure(repo.writeBlob(7 as never))).code).toBe("invalid")
    expect((await failure(repo.writeTree([{ name: "a", mode: "040000", oid: blob }]))).code).toBe("invalid")
    expect((await failure(repo.writeTree([{ name: "a", mode: "100644", oid: HELLO_BLOB }]))).code).toBe("invalid")
    expect((await failure(repo.writeCommit(first))).code).toBe("invalid")
    const tree = await run(repo.writeTree([]))
    expect((await failure(repo.writeCommit({ ...first, tree, parents: [HELLO_BLOB] }))).code).toBe("invalid")
    expect((await failure(repo.writeCommit({ ...first, tree: "x" }))).code).toBe("invalid")
  })

  it("resolves a prefix to one commit and refuses one that names several", async () => {
    const repo = Repository.makeMemory({
      commits: [{ id: "abcd0001", tree: Repository.EMPTY_TREE }, { id: "abcd0002", tree: Repository.EMPTY_TREE }]
    })
    expect(await run(repo.readCommit("abcd0001"))).toEqual({
      oid: "abcd0001",
      tree: Repository.EMPTY_TREE,
      parents: [],
      message: ""
    })
    expect((await failure(repo.readCommit("abcd"))).code).toBe("invalid")
  })

  it("moves every ref of a transaction or none, checking each old value", async () => {
    const repo = Repository.makeMemory()
    const tree = await run(repo.writeTree([]))
    const a = await run(repo.writeCommit({ ...first, tree }))
    const b = await run(repo.writeCommit({ ...first, tree, parents: [a] }))
    const mythical = "refs/heads/mythical"
    const notes = "refs/notes/mythical"
    await run(repo.updateRefs({
      operation: "export/1",
      updates: [
        { ref: mythical, before: null, after: a },
        { ref: notes, before: null, after: a }
      ]
    }))
    expect(await run(repo.readRefs([mythical, notes, "refs/heads/other"]))).toEqual([
      { ref: mythical, oid: a },
      { ref: notes, oid: a },
      { ref: "refs/heads/other", oid: null }
    ])
    const conflict = await failure(repo.updateRefs({
      operation: "export/2",
      updates: [
        { ref: mythical, before: a, after: b },
        { ref: notes, before: b, after: b }
      ]
    }))
    expect([conflict.code, conflict.refs]).toEqual(["conflict", [notes]])
    expect(await run(repo.readRefs([mythical]))).toEqual([{ ref: mythical, oid: a }])
    expect(
      (await failure(repo.updateRefs({ operation: "x", updates: [{ ref: mythical, before: a, after: HELLO_BLOB }] })))
        .code
    ).toBe("invalid")
    await run(repo.updateRefs({
      operation: "export/3",
      updates: [
        { ref: mythical, before: a, after: b },
        { ref: notes, before: a, after: a }
      ]
    }))
    await run(repo.updateRefs({ operation: "drop", updates: [{ ref: notes, before: a, after: null }] }))
    expect(await run(repo.readRefs([mythical, notes]))).toEqual([{ ref: mythical, oid: b }, { ref: notes, oid: null }])
    expect((await failure(repo.readRefs(["heads/x"]))).code).toBe("invalid")
    expect((await failure(repo.updateRefs({ operation: "", updates: [] }))).code).toBe("invalid")
  })

  it("serves as a layer, and a fresh one per build", async () => {
    const program = Effect.gen(function*() {
      const repo = yield* Repository.Repository
      return yield* repo.writeBlob("hello\n")
    })
    expect(await Effect.runPromise(Effect.provide(program, Repository.layerMemory()))).toBe(HELLO_BLOB)
    expect(Repository.make(Repository.makeMemory()).readBlob).toBeTypeOf("function")
  })
})

describe("makeUnsupported", () => {
  it("answers every call unsupported with its reason", async () => {
    const repo = Repository.makeUnsupported("publishing is off")
    const calls: ReadonlyArray<Effect.Effect<unknown, Repository.RepositoryError>> = [
      repo.readBlob(HELLO_BLOB),
      repo.writeBlob("x"),
      repo.readTree(HELLO_TREE),
      repo.writeTree([]),
      repo.readCommit(FIRST_COMMIT),
      repo.writeCommit(first),
      repo.readRefs(["refs/heads/a"]),
      repo.updateRefs({ operation: "x", updates: [] })
    ]
    for (const call of calls) {
      const error = await failure(call)
      expect(error.code).toBe("unsupported")
      expect(error.message).toContain("publishing is off")
    }
    const layered = Effect.gen(function*() {
      const repo = yield* Repository.Repository
      return yield* repo.writeBlob("x")
    })
    expect((await failure(Effect.provide(layered, Repository.layerUnsupported("off")))).code).toBe("unsupported")
  })
})
