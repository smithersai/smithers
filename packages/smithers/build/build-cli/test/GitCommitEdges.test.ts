import { Smithers as S } from "@smthrs/targets"
import type * as Target from "@smthrs/targets/Target"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GitCommit from "../src/GitCommit.ts"
import { writeExecutable } from "./helpers/Executable.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})
const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

const git = (root: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile("git", [...args], { cwd: root }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })

/** A repository with identity configured and, unless `unborn`, one seed commit. */
const repository = async (options: { readonly unborn?: boolean } = {}): Promise<string> => {
  const root = await temporaryDirectory("smthrs-git-commit-edges-")
  await git(root, ["init", "--quiet", "--initial-branch=main"])
  await git(root, ["config", "core.autocrlf", "false"])
  await git(root, ["config", "user.name", "smthrs test"])
  await git(root, ["config", "user.email", "test@example.invalid"])
  await git(root, ["config", "commit.gpgsign", "false"])
  await Fs.writeFile(NodePath.join(root, "README.md"), "seed\n", "utf8")
  if (options.unborn === true) return root
  await git(root, ["add", "-A"])
  await git(root, ["commit", "--quiet", "-m", "seed"])
  return root
}

const head = (root: string): Promise<string> => git(root, ["rev-parse", "HEAD"]).then((sha) => sha.trim())
const greenGates: GitCommit.GateRunner = { run: async () => [] }
const fixedCommit = (): Target.AnyTarget =>
  S.Git.Commit({ gates: [S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["gate"] })], message: "chore: fixed" })

const failure = (work: Promise<unknown>): Promise<GitCommit.GitCommitError> =>
  work.then(
    () => {
      throw new Error("expected a GitCommitError")
    },
    (cause) => {
      if (GitCommit.isGitCommitError(cause)) return cause
      throw cause
    }
  )

describe("option bounds", () => {
  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])(
    "refuses timeoutMs %s before running git",
    async (timeoutMs) => {
      // The root is not a repository: a refusal from git would be a GitCommitError instead.
      const root = await temporaryDirectory("smthrs-git-commit-bounds-")
      await expect(GitCommit.commit({ root, target: fixedCommit(), gateRunner: greenGates, timeoutMs })).rejects
        .toThrow(new RangeError("Git.Commit timeoutMs must be positive and finite"))
    }
  )
})

describe("unrelated changes beyond the named limit", () => {
  it("names the first twenty unscoped changes and counts the rest", async () => {
    const root = await repository()
    const names = Array.from({ length: 25 }, (_, index) => `change-${String(index).padStart(2, "0")}.txt`)
    for (const name of names) await Fs.writeFile(NodePath.join(root, name), "unrelated\n", "utf8")
    const error = await failure(GitCommit.commit({ root, target: fixedCommit(), gateRunner: greenGates }))
    expect(error.code).toBe("unrelated_changes")
    expect(error.message).toContain(`25 change(s)`)
    expect(error.message).toContain(`declared: ${names.slice(0, 20).join(", ")}, and 5 more`)
    expect(error.message).not.toContain(names[20]!)
  })

  it("names the first twenty staged paths outside the scope and counts the rest", async () => {
    const root = await repository()
    const names = Array.from({ length: 22 }, (_, index) => `staged-${String(index).padStart(2, "0")}.txt`)
    for (const name of names) await Fs.writeFile(NodePath.join(root, name), "staged elsewhere\n", "utf8")
    await git(root, ["add", "--", ...names])
    await Fs.mkdir(NodePath.join(root, "scope"))
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned\n", "utf8")
    const error = await failure(
      GitCommit.commit({ root, target: fixedCommit(), paths: ["scope"], gateRunner: greenGates })
    )
    expect(error.code).toBe("unrelated_changes")
    expect(error.message).toBe(
      `unrelated_changes: the index carries 22 staged path(s) outside this commit's scope: ${
        names.slice(0, 20).join(", ")
      }, and 2 more`
    )
  })
})

describe("message agents", () => {
  it.each([
    [{ _tag: "AgentPool" as const, agents: ["luna", "sol"] }, "luna,sol"],
    [{ _tag: "AgentCodex" as const, model: "gpt-test" }, "inline:gpt-test"]
  ])("names the declared %o agent as %s to the composer", async (message, agent) => {
    const root = await repository()
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "agent change\n", "utf8")
    const agents: Array<string> = []
    const result = await GitCommit.commit({
      root,
      target: S.Git.Commit({ gates: [], message }),
      sweepWorkingTree: true,
      gateRunner: greenGates,
      agentMessage: {
        compose: async (context) => {
          agents.push(context.agent)
          return `feat: by ${context.agent}`
        }
      }
    })
    expect(agents).toEqual([agent])
    expect(result.message).toBe(`feat: by ${agent}`)
    expect(await git(root, ["log", "-1", "--format=%s"])).toBe(`feat: by ${agent}\n`)
  })

  it("reports a staged diff larger than the output bound as an unrunnable git command", async () => {
    const root = await repository()
    await Fs.writeFile(NodePath.join(root, "large.txt"), "x".repeat(99).concat("\n").repeat(90_000), "utf8")
    let composed = false
    const error = await failure(GitCommit.commit({
      root,
      target: S.Git.Commit({ gates: [], message: S.Agents["luna"]! }),
      sweepWorkingTree: true,
      gateRunner: greenGates,
      agentMessage: {
        compose: async () => {
          composed = true
          return "never"
        }
      }
    }))
    expect(error.code).toBe("spawn_failed")
    expect(error.message).toMatch(/^spawn_failed: git diff --cached could not run: ERR_CHILD_PROCESS_STDIO_MAXBUFFER/)
    expect(composed).toBe(false)
    expect(await git(root, ["status", "--porcelain"])).toBe("?? large.txt\n")
  })
})

describe("rollback without a parent", () => {
  it("deletes the commit a hook changed in a repository with no prior commit", async () => {
    const root = await repository({ unborn: true })
    await Fs.mkdir(NodePath.join(root, "scope"))
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned\n", "utf8")
    const hook = NodePath.join(root, ".git/hooks/pre-commit")
    await Fs.writeFile(hook, "#!/bin/sh\ngit add README.md\n", "utf8")
    await Fs.chmod(hook, 0o755)
    const error = await failure(
      GitCommit.commit({ root, target: fixedCommit(), paths: ["scope"], gateRunner: greenGates })
    )
    expect(error.code).toBe("candidate_changed")
    // HEAD is unborn again rather than pointing at the unjudged commit.
    await expect(git(root, ["rev-parse", "--verify", "-q", "HEAD"])).rejects.toThrow()
  })
})

describe("an index git cannot save", () => {
  it("leaves the staged resolution of a conflicted index after a refused commit", async () => {
    const root = await repository()
    await git(root, ["checkout", "--quiet", "-b", "side"])
    await Fs.writeFile(NodePath.join(root, "README.md"), "side\n", "utf8")
    await git(root, ["commit", "--quiet", "-am", "side"])
    await git(root, ["checkout", "--quiet", "main"])
    await Fs.writeFile(NodePath.join(root, "README.md"), "main\n", "utf8")
    await git(root, ["commit", "--quiet", "-am", "main"])
    await expect(git(root, ["merge", "--quiet", "side"])).rejects.toThrow()
    expect(await git(root, ["ls-files", "-u"])).not.toBe("")
    const before = await head(root)
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      sweepWorkingTree: true,
      gateRunner: { run: async () => [{ target: "Memory.Retain", message: "red" }] }
    }))
    expect(error.code).toBe("gates_failed")
    expect(await head(root)).toBe(before)
    // `write-tree` refused the unmerged index up front, so there was no tree to restore.
    expect(await git(root, ["ls-files", "-u"])).toBe("")
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("README.md\n")
  })
})

describe("cancellation", () => {
  it("surfaces the cancelled git command when the run stops during the gates", async () => {
    const root = await repository()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "new\n", "utf8")
    const controller = new AbortController()
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      sweepWorkingTree: true,
      signal: controller.signal,
      gateRunner: {
        run: async () => {
          controller.abort()
          return []
        }
      }
    }))
    expect(error.code).toBe("spawn_failed")
    expect(error.message).toBe("spawn_failed: git write-tree could not run: ABORT_ERR")
    expect(await head(root)).toBe(before)
  })
})

describe("a git that cannot run", () => {
  it("describes a git on PATH that is not executable", async () => {
    const root = await repository()
    const tools = await temporaryDirectory("smthrs-git-commit-tools-")
    await Fs.writeFile(NodePath.join(tools, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o644 })
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates,
      environment: { PATH: tools }
    }))
    expect(error.code).toBe("spawn_failed")
    expect(error.message).toMatch(/^spawn_failed: git rev-parse --is-inside-work-tree could not run: /)
    expect(error.message).not.toMatch(/: ENOENT$/)
    expect(error.message).toMatch(/EACCES|permission/i)
  })

  it("keeps the stderr of a git that timed out", async () => {
    const root = await repository()
    const tools = await temporaryDirectory("smthrs-git-commit-tools-")
    await writeExecutable(NodePath.join(tools, "git"), "#!/bin/sh\necho 'fake git stalled' >&2\nexec sleep 30\n")
    const started = Date.now()
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates,
      timeoutMs: 500,
      environment: { PATH: `${tools}:${process.env["PATH"] ?? ""}` }
    }))
    expect(error.code).toBe("spawn_failed")
    expect(error.message).toMatch(
      /^spawn_failed: git rev-parse --is-inside-work-tree could not run: .+: fake git stalled$/
    )
    expect(Date.now() - started).toBeLessThan(15_000)
  })
})

describe("materializing the candidate", () => {
  it("removes a path staged after the gates' tree was written", async () => {
    const root = await repository()
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "judged\n", "utf8")
    const copy = await temporaryDirectory("smthrs-git-commit-copy-")
    let written: ReadonlyArray<string> = []
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      sweepWorkingTree: true,
      gateRunner: {
        run: async (_gates, candidate) => {
          // A concurrent writer stages a new path after the candidate tree was recorded.
          await Fs.writeFile(NodePath.join(root, "late.txt"), "unjudged\n", "utf8")
          await git(root, ["add", "late.txt"])
          await Fs.cp(root, copy, { recursive: true, filter: (source) => !source.includes(`${NodePath.sep}.git`) })
          written = await candidate.materialize(copy)
          return []
        }
      }
    }))
    expect(written).toEqual(["late.txt"])
    expect(await Fs.readdir(copy)).toEqual(["README.md", "feature.txt"])
    expect(error.code).toBe("candidate_changed")
  })

  it("refuses to materialize over the filesystem root", async () => {
    const root = await repository()
    await Fs.mkdir(NodePath.join(root, "scope"))
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned\n", "utf8")
    // An unstaged out-of-scope edit is a path the materializer must rewrite.
    await Fs.writeFile(NodePath.join(root, "README.md"), "concurrent\n", "utf8")
    let refusal: unknown
    const result = await GitCommit.commit({
      root,
      target: fixedCommit(),
      paths: ["scope"],
      gateRunner: {
        run: async (_gates, candidate) => {
          refusal = await candidate.materialize("/").catch((cause: unknown) => cause)
          return []
        }
      }
    })
    expect(GitCommit.isGitCommitError(refusal)).toBe(true)
    expect(refusal).toMatchObject({
      code: "git_failed",
      message: "git_failed: git named a path outside the tree: \"README.md\""
    })
    expect(result.staged).toEqual(["scope/owned.txt"])
  })
})
