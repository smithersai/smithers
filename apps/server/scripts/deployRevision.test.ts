import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { judgeRevision, MESSAGE_MAX_BYTES, readRevisionFacts, type RevisionFacts, wranglerDeployArgs } from "./deployRevision"

const SHA = "0123456789abcdef0123456789abcdef01234567"

const facts = (overrides: Partial<RevisionFacts> = {}): RevisionFacts => ({
  sha: SHA,
  dirty: [],
  onOriginMain: true,
  subject: "fix(server): answer the probe",
  ...overrides
})

describe("judgeRevision", () => {
  const cases: ReadonlyArray<readonly [string, "dry-run" | "real", Partial<RevisionFacts>, true | "no-sha" | "dirty" | "not-on-origin-main"]> = [
    ["a pushed clean commit deploys", "real", {}, true],
    ["a real deploy refuses an unpushed or rewritten commit", "real", { onOriginMain: false }, "not-on-origin-main"],
    ["a real deploy refuses a dirty tree", "real", { dirty: ["M src/index.ts"] }, "dirty"],
    ["a real deploy refuses a missing sha", "real", { sha: "" }, "no-sha"],
    ["a real deploy refuses a short sha", "real", { sha: "0123456" }, "no-sha"],
    ["a dry run may be dirty", "dry-run", { dirty: ["M src/index.ts"] }, true],
    ["a dry run may be unpushed", "dry-run", { onOriginMain: false }, true],
    ["a dry run still needs a sha", "dry-run", { sha: "" }, "no-sha"]
  ]
  for (const [name, mode, overrides, expected] of cases) {
    test(name, () => {
      const verdict = judgeRevision(facts(overrides), mode)
      expect(verdict.ok ? true : verdict.reason).toBe(expected)
    })
  }

  test("the unpushed refusal tells the operator to push main", () => {
    const verdict = judgeRevision(facts({ onOriginMain: false }), "real")
    expect(verdict.ok ? "" : verdict.detail).toContain("origin/main")
  })

  test("the tag is the sha's first 12 hex and the message names the whole sha and the subject", () => {
    const verdict = judgeRevision(facts(), "real")
    if (!verdict.ok) throw new Error(verdict.detail)
    expect(verdict.tag).toBe("0123456789ab")
    expect(verdict.message).toBe(`${SHA} fix(server): answer the probe`)
    expect(wranglerDeployArgs(verdict)).toEqual(["deploy", "--tag", "0123456789ab", "--message", verdict.message])
  })

  test("a long subject is cut to the annotation limit on a character boundary, the sha intact", () => {
    const verdict = judgeRevision(facts({ subject: "🐛 ".repeat(80) }), "real")
    if (!verdict.ok) throw new Error(verdict.detail)
    expect(new TextEncoder().encode(verdict.message).length).toBeLessThanOrEqual(MESSAGE_MAX_BYTES)
    expect(verdict.message.startsWith(`${SHA} 🐛`)).toBe(true)
    // Tight: one more "🐛 " would not have fitted, and no half code point is left.
    expect(new TextEncoder().encode(verdict.message).length).toBeGreaterThan(MESSAGE_MAX_BYTES - new TextEncoder().encode("🐛 ").length)
    expect(() => encodeURIComponent(verdict.message)).not.toThrow()
  })
})

/*
 * The facts come from a real repository, not a stub: the defect was a deploy
 * from a checkout whose commit origin never had, and only the VCS can say that.
 * Each fixture has a bare origin, a pushed commit, and an unpushed one on top,
 * and runs about a dozen git and jj processes.
 */
const VCS_TIMEOUT_MS = 60_000

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
}, VCS_TIMEOUT_MS)

const identity = {
  GIT_AUTHOR_NAME: "deploy-test",
  GIT_AUTHOR_EMAIL: "deploy-test@example.invalid",
  GIT_COMMITTER_NAME: "deploy-test",
  GIT_COMMITTER_EMAIL: "deploy-test@example.invalid",
  JJ_USER: "deploy-test",
  JJ_EMAIL: "deploy-test@example.invalid"
}

const sh = (cwd: string, ...cmd: string[]): string => {
  const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...identity, PWD: cwd }, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString().trim()
}

/** A clone of a bare origin whose main holds one commit, plus one unpushed commit. */
const fixture = (): { clone: string; pushed: string; unpushed: string } => {
  const root = mkdtempSync(join(tmpdir(), "deploy-revision-"))
  scratch.push(root)
  const origin = join(root, "origin.git")
  const clone = join(root, "clone")
  sh(root, "git", "init", "--quiet", "--bare", "--initial-branch=main", origin)
  sh(root, "git", "clone", "--quiet", origin, clone)
  writeFileSync(join(clone, "a.txt"), "a\n")
  sh(clone, "git", "add", "a.txt")
  sh(clone, "git", "commit", "--quiet", "-m", "pushed subject")
  sh(clone, "git", "push", "--quiet", "origin", "main")
  const pushed = sh(clone, "git", "rev-parse", "HEAD")
  writeFileSync(join(clone, "b.txt"), "b\n")
  sh(clone, "git", "add", "b.txt")
  sh(clone, "git", "commit", "--quiet", "-m", "unpushed subject")
  const unpushed = sh(clone, "git", "rev-parse", "HEAD")
  return { clone, pushed, unpushed }
}

describe("readRevisionFacts on git", () => {
  test("an unpushed commit is not on origin/main", async () => {
    const { clone, unpushed } = fixture()
    const read = await readRevisionFacts({ cwd: clone, vcs: "git" })
    expect(read).toEqual({ sha: unpushed, dirty: [], onOriginMain: false, subject: "unpushed subject" })
  }, VCS_TIMEOUT_MS)

  test("a pushed commit is on origin/main, and an uncommitted edit is dirty", async () => {
    const { clone, pushed } = fixture()
    sh(clone, "git", "reset", "--quiet", "--hard", pushed)
    writeFileSync(join(clone, "a.txt"), "edited\n")
    const read = await readRevisionFacts({ cwd: clone, vcs: "git" })
    expect(read.sha).toBe(pushed)
    expect(read.onOriginMain).toBe(true)
    expect(read.dirty).toEqual(["M a.txt"])
    expect(judgeRevision(read, "real").ok).toBe(false)
  }, VCS_TIMEOUT_MS)
})

describe("readRevisionFacts on jj", () => {
  /** jj deploys `@-`: the working-copy commit's parent. */
  const colocate = (clone: string): void => {
    sh(clone, "jj", "git", "init", "--colocate", "--quiet")
  }

  test("an unpushed parent is not on main@origin", async () => {
    const { clone, unpushed } = fixture()
    colocate(clone)
    const read = await readRevisionFacts({ cwd: clone, vcs: "jj" })
    expect(read).toEqual({ sha: unpushed, dirty: [], onOriginMain: false, subject: "unpushed subject" })
  }, VCS_TIMEOUT_MS)

  test("a rewritten commit that origin never had is refused, the pushed one deploys", async () => {
    const { clone, pushed } = fixture()
    colocate(clone)
    sh(clone, "jj", "new", "--quiet", pushed)
    let read = await readRevisionFacts({ cwd: clone, vcs: "jj" })
    expect(read.sha).toBe(pushed)
    expect(judgeRevision(read, "real").ok).toBe(true)

    sh(clone, "jj", "describe", "--quiet", "-r", "@-", "-m", "rewritten subject", "--ignore-immutable")
    read = await readRevisionFacts({ cwd: clone, vcs: "jj" })
    expect(read.sha).not.toBe(pushed)
    expect(read.subject).toBe("rewritten subject")
    expect(judgeRevision(read, "real")).toMatchObject({ ok: false, reason: "not-on-origin-main" })
  }, VCS_TIMEOUT_MS)
})
