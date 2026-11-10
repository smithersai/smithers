/**
 * The revision a host records its sources at.
 *
 * Two halves are proved here. The decision — which tool answers, and when no
 * tool may — is proved against a scripted reader, so every branch is reached
 * without a repository. The commands themselves are proved against real
 * repositories in a temporary directory, because a decision table cannot
 * catch a wrong flag, and a wrong flag answers `undefined` forever.
 */
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as SourceRevision from "../src/internal/SourceRevision.vibe"

const ID = "a".repeat(40)

/** A reader that answers from a table, and records what it was asked. */
const scripted = (answers: Readonly<Record<string, string | undefined>>) => {
  const asked: Array<string> = []
  const reader: SourceRevision.Reader = (file, args) => {
    const command = [file, ...args].join(" ")
    asked.push(command)
    return Effect.succeed(answers[command])
  }
  return { reader, asked }
}

const JJ = "jj log -r @ --no-graph --color=never -T commit_id"
const STATUS = "git --no-optional-locks status --porcelain"
const HEAD = "git rev-parse HEAD"

describe("which tool names the tree", async () => {
  it("takes jj's working-copy commit, which holds uncommitted work", async () => {
    const { reader, asked } = scripted({ [JJ]: `${ID}\n` })

    expect(await Effect.runPromise(SourceRevision.read("/repo", reader))).toBe(ID)
    /* git is never asked: jj already named the tree on disk. */
    expect(asked).toEqual([JJ])
  })

  it("falls to git's HEAD only where the tree still matches it", async () => {
    const clean = scripted({ [JJ]: undefined, [STATUS]: "", [HEAD]: `${ID}\n` })

    expect(await Effect.runPromise(SourceRevision.read("/repo", clean.reader))).toBe(ID)
    expect(clean.asked).toEqual([JJ, STATUS, HEAD])
  })

  it("names nothing for a git tree that has moved off its commit", async () => {
    const edited = scripted({ [JJ]: undefined, [STATUS]: " M flows/a/flow.ts\n", [HEAD]: `${ID}\n` })
    const untracked = scripted({ [JJ]: undefined, [STATUS]: "?? flows/new/flow.ts\n", [HEAD]: `${ID}\n` })

    expect(await Effect.runPromise(SourceRevision.read("/repo", edited.reader))).toBeUndefined()
    expect(await Effect.runPromise(SourceRevision.read("/repo", untracked.reader))).toBeUndefined()
    /* HEAD is not even asked for: there is no answer it could make honest. */
    expect(edited.asked).toEqual([JJ, STATUS])
  })

  it("names nothing where neither tool answers", async () => {
    const { reader } = scripted({})

    expect(await Effect.runPromise(SourceRevision.read("/repo", reader))).toBeUndefined()
  })

  it("refuses an answer that is not an object id", async () => {
    expect(SourceRevision.objectId(undefined)).toBeUndefined()
    expect(SourceRevision.objectId("")).toBeUndefined()
    expect(SourceRevision.objectId("Error: not a repository")).toBeUndefined()
    /* An abbreviated id is not the id: a ref the far end cannot resolve. */
    expect(SourceRevision.objectId(ID.slice(0, 12))).toBeUndefined()
    expect(SourceRevision.objectId(`  ${ID}\n`)).toBe(ID)
  })
})

/** A git repository with one commit, and nothing else in the tree. */
const gitRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-source-revision-"))
  const git = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [
      "-c",
      "user.email=test@smithers.test",
      "-c",
      "user.name=Test",
      "-c",
      "commit.gpgsign=false",
      ...args
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
  git("init", "--quiet")
  await writeFile(join(root, "flow.ts"), "export const flow = 1\n")
  git("add", "-A")
  git("commit", "--quiet", "-m", "one")
  return { root, head: git("rev-parse", "HEAD").trim() }
}

describe("against a real repository", async () => {
  it("reads git's HEAD, and stops naming it once the tree moves", async () => {
    const { root, head } = await gitRepository()
    try {
      expect(await Effect.runPromise(SourceRevision.read(root))).toBe(head)

      await writeFile(join(root, "flow.ts"), "export const flow = 2\n")
      expect(await Effect.runPromise(SourceRevision.read(root))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it("never takes the index lock: a stale index stays unwritten, and a held lock doesn't block the read", async () => {
    const { root, head } = await gitRepository()
    try {
      // A tracked file touched but unchanged: a status that may take `.git/index.lock` refreshes its stat data and
      // writes the index, holding the lock every other git and jj command in the checkout then fails on.
      const index = join(root, ".git", "index")
      const later = new Date(Date.now() + 60_000)
      await utimes(join(root, "flow.ts"), later, later)
      const before = await readFile(index)

      expect(await Effect.runPromise(SourceRevision.read(root))).toBe(head)
      expect((await readFile(index)).equals(before)).toBe(true)

      // Another process holds the lock: the revision is read all the same.
      await writeFile(join(root, ".git", "index.lock"), "")
      expect(await Effect.runPromise(SourceRevision.read(root))).toBe(head)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it("names no revision for a directory under no version control", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-source-revision-bare-"))
    try {
      expect(await Effect.runPromise(SourceRevision.read(root))).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("the scoped revision reader", () => {
  it("drains stderr and returns only successful stdout", async () => {
    const output = await Effect.runPromise(
      SourceRevision.spawnReader(process.execPath, [
        "-e",
        "process.stderr.write('diagnostic'.repeat(10000)); process.stdout.write('résumé\\n')"
      ], process.cwd())
    )
    expect(output).toBe("résumé\n")
  })

  it("refuses a nonzero exit and output exceeding the byte limit", async () => {
    for (
      const program of [
        "process.stdout.write('not a revision'); process.exitCode=2",
        "process.stdout.write('x'.repeat(1000001))"
      ]
    ) {
      expect(await Effect.runPromise(SourceRevision.spawnReader(process.execPath, ["-e", program], process.cwd())))
        .toBeUndefined()
    }
  })
})
