/**
 * The revision a host records its sources at.
 *
 * Two halves are proved here. The decision — which tool answers, and when no
 * tool may — is proved against a scripted reader, so every branch is reached
 * without a repository. The commands themselves are proved against real
 * repositories in a temporary directory, because a decision table cannot
 * catch a wrong flag, and a wrong flag answers `undefined` forever.
 */
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as SourceRevision from "../src/internal/SourceRevision.ts"

const ID = "a".repeat(40)

/** A reader that answers from a table, and records what it was asked. */
const scripted = (answers: Readonly<Record<string, string | undefined>>) => {
  const asked: Array<string> = []
  const reader: SourceRevision.Reader = (file, args) => {
    const command = [file, ...args].join(" ")
    asked.push(command)
    return answers[command]
  }
  return { reader, asked }
}

const JJ = "jj log -r @ --no-graph --color=never -T commit_id"
const STATUS = "git status --porcelain"
const HEAD = "git rev-parse HEAD"

describe("which tool names the tree", () => {
  it("takes jj's working-copy commit, which holds uncommitted work", () => {
    const { reader, asked } = scripted({ [JJ]: `${ID}\n` })

    expect(SourceRevision.read("/repo", reader)).toBe(ID)
    /* git is never asked: jj already named the tree on disk. */
    expect(asked).toEqual([JJ])
  })

  it("falls to git's HEAD only where the tree still matches it", () => {
    const clean = scripted({ [JJ]: undefined, [STATUS]: "", [HEAD]: `${ID}\n` })

    expect(SourceRevision.read("/repo", clean.reader)).toBe(ID)
    expect(clean.asked).toEqual([JJ, STATUS, HEAD])
  })

  it("names nothing for a git tree that has moved off its commit", () => {
    const edited = scripted({ [JJ]: undefined, [STATUS]: " M flows/a/flow.ts\n", [HEAD]: `${ID}\n` })
    const untracked = scripted({ [JJ]: undefined, [STATUS]: "?? flows/new/flow.ts\n", [HEAD]: `${ID}\n` })

    expect(SourceRevision.read("/repo", edited.reader)).toBeUndefined()
    expect(SourceRevision.read("/repo", untracked.reader)).toBeUndefined()
    /* HEAD is not even asked for: there is no answer it could make honest. */
    expect(edited.asked).toEqual([JJ, STATUS])
  })

  it("names nothing where neither tool answers", () => {
    const { reader } = scripted({})

    expect(SourceRevision.read("/repo", reader)).toBeUndefined()
  })

  it("refuses an answer that is not an object id", () => {
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

describe("against a real repository", () => {
  it("reads git's HEAD, and stops naming it once the tree moves", async () => {
    const { root, head } = await gitRepository()
    try {
      expect(SourceRevision.read(root)).toBe(head)

      await writeFile(join(root, "flow.ts"), "export const flow = 2\n")
      expect(SourceRevision.read(root)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it("names no revision for a directory under no version control", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-source-revision-bare-"))
    try {
      expect(SourceRevision.read(root)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
