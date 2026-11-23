/** File names that are not UTF-8, in real repositories, and a replay of a repository that holds one. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { Options, run } from "../../src/replay/index.vibe"
import { bytesOf, notUtf8, unreadableName } from "../../src/replay/Names.ts"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (path: string): string => {
  created.push(path)
  return path
}
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Names", "-c", "user.email=names@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  })

/** `caf\xe9.txt`, the Latin-1 bytes of "café.txt": a name no UTF-8 reader can read. */
const latin1 = Buffer.from("caf\xe9.txt", "latin1")

/** A real repository whose second commit adds a file named by `name`'s bytes. */
const holding = (name: Buffer): string => {
  const root = track(makeSmallRepository([job("runs", "sh a.sh")]))
  writeFileSync(Buffer.concat([Buffer.from(`${root}/`), name]), "ok\n")
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "two")
  return root
}

/** The names of `root`'s newest commit as git prints them, the way a replay reads them. */
const listing = (root: string): string => git(root, "-c", "core.quotePath=true", "ls-tree", "-r", "--name-only", "HEAD")

describe("the bytes of a name as git shows it", () => {
  it("are the name itself when git needs no quotes", () => {
    expect([...bytesOf("dir/a.txt")]).toEqual([...Buffer.from("dir/a.txt")])
  })

  it("read octal escapes and C escapes back to the bytes", () => {
    expect([...bytesOf("\"caf\\351.txt\"")]).toEqual([...latin1])
    expect(Buffer.from(bytesOf("\"new\\nline\\ttab\\\"quote\\\\back\\a\\b\\v\\f\\r\"")).toString("latin1")).toBe(
      "new\nline\ttab\"quote\\back\x07\b\v\f\r"
    )
    expect(Buffer.from(bytesOf("\"\\303\\274.txt\"")).toString("utf8")).toBe("ü.txt")
  })
})

describe("a name that is not UTF-8", () => {
  it("is found in a real repository and shown as git shows it", () => {
    const root = holding(latin1)
    expect(notUtf8(listing(root))).toBe("\"caf\\351.txt\"")
    // What git showed gives the file's own bytes back.
    const onDisk = readdirSync(root, { encoding: "buffer" }).find((name) => name.includes(0xe9))
    expect(Buffer.from(bytesOf(notUtf8(listing(root)) as string))).toEqual(onDisk)
  })

  it("is not a name with a newline or with letters outside ASCII, which are UTF-8", () => {
    const root = holding(Buffer.from("new\nline ü.txt"))
    expect(listing(root)).toContain("\"new\\nline \\303\\274.txt\"")
    expect(notUtf8(listing(root))).toBeUndefined()
  })

  it("is named with its commit in the line that ends a replay", () => {
    expect(unreadableName("\"caf\\351.txt\"", "35bae0d1a2b3c4d5")).toBe(
      "the file \"caf\\351.txt\" at 35bae0d has a name that is not UTF-8, which Smithers build cannot read; rename the file to replay this repository"
    )
  })
})

const replay = (root: string, commits: number) =>
  Effect.runPromise(
    run({ root, commits, modes: ["normal"] }, parts("none") as unknown as ReplayParts<never>).pipe(
      Effect.provide(Layer.provideMerge(
        Layer.succeed(Options, {
          smthrs: [smthrs] as const,
          reruns: 0,
          prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
          confine: unconfined
        }) as never,
        NodeServices.layer
      ))
    ) as Effect.Effect<ReplayReport, Failure>
  )

describe("a replay", { timeout: 600_000 }, () => {
  it("of a repository with a file name that is not UTF-8 cannot run, and names the file and its commit", async () => {
    const root = holding(latin1)
    const head = git(root, "rev-parse", "HEAD").trim()
    const failed = await replay(root, 1).then(
      () => undefined,
      (cause: Failure) => cause
    )
    expect(failed).toEqual({ code: "unsupported", message: unreadableName("\"caf\\351.txt\"", head), part: "replay" })
    // The commit before the replayed ones is where the first run starts: a name there is found too.
    rmSync(Buffer.concat([Buffer.from(`${root}/`), latin1]))
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", "three")
    expect(await replay(root, 1).then(() => undefined, (cause: Failure) => cause.message)).toBe(
      unreadableName("\"caf\\351.txt\"", head)
    )
  })

  it("of a repository with a file name that holds a newline runs, as a replay of any other repository", async () => {
    const root = holding(Buffer.from("new\nline.txt"))
    const report = await replay(root, 1)
    expect(report.mismatches).toBe(0)
    expect(report.commits[0]?.baseline.ok).toBe(true)
    expect(report.commits[0]?.normal.ok).toBe(true)
  })
})
