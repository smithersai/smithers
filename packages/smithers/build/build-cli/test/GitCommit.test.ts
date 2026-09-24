import { Smithers as S } from "@smthrs/targets"
import type * as Target from "@smthrs/targets/Target"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import * as GitCommit from "../src/GitCommit.ts"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile("git", [...args], { cwd: root }, (error, stdout) => {
      if (error !== null) reject(error)
      else resolve(stdout)
    })
  })

/** A throwaway git repository with one initial commit. */
const temporaryRepo = async (): Promise<string> => {
  const root = await tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-git-commit-"))))
  await git(root, ["init", "--quiet", "--initial-branch=main"])
  await git(root, ["config", "user.name", "smthrs test"])
  await git(root, ["config", "user.email", "test@example.invalid"])
  await git(root, ["config", "commit.gpgsign", "false"])
  await Fs.writeFile(NodePath.join(root, "README.md"), "seed\n", "utf8")
  await git(root, ["add", "-A"])
  await git(root, ["commit", "--quiet", "-m", "seed"])
  return root
}

/** A throwaway repository with tracked files inside and outside a commit scope. */
const scopedRepo = async (): Promise<string> => {
  const root = await temporaryRepo()
  await Fs.mkdir(NodePath.join(root, "scope"), { recursive: true })
  await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned baseline\n", "utf8")
  await Fs.writeFile(NodePath.join(root, "outside-tracked.txt"), "outside baseline\n", "utf8")
  await git(root, ["add", "-A"])
  await git(root, ["commit", "--quiet", "-m", "scope baseline"])
  return root
}

const head = (root: string): Promise<string> => git(root, ["rev-parse", "HEAD"]).then((sha) => sha.trim())

const gateTarget = (): Target.AnyTarget => S.Memory.Retain({ source: S.gitCommit("HEAD"), tags: ["gate"] })

const greenGates: GitCommit.GateRunner = { run: async () => [] }

const fixedCommit = (gates: ReadonlyArray<Target.AnyTarget> = []): Target.AnyTarget =>
  S.Git.Commit({ gates, message: "chore: fixed message" })

const agentCommit = (): Target.AnyTarget => S.Git.Commit({ gates: [], message: S.Agents["luna"]! })

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

describe("commit with fake gates", () => {
  it("stages, runs green gates, and creates the fixed-message commit", async () => {
    const root = await temporaryRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "new\n", "utf8")
    const seen: Array<ReadonlyArray<Target.AnyTarget>> = []
    const gate = gateTarget()
    const result = await GitCommit.commit({
      root,
      target: fixedCommit([gate]),
      sweepWorkingTree: true,
      gateRunner: {
        run: async (gates) => {
          seen.push(gates)
          return []
        }
      }
    })
    expect(seen).toEqual([[gate]])
    expect(result.message).toBe("chore: fixed message")
    expect(await head(root)).toBe(result.sha)
    expect(result.sha).not.toBe(before)
    expect(await git(root, ["log", "-1", "--format=%s"])).toBe("chore: fixed message\n")
    expect(await git(root, ["status", "--porcelain"])).toBe("")
  })

  it("refuses the commit when a gate is red and creates nothing", async () => {
    const root = await temporaryRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "new\n", "utf8")
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit([gateTarget()]),
      sweepWorkingTree: true,
      gateRunner: {
        run: async () => [{ target: "Memory.Retain", message: "lint failed" }]
      }
    }))
    expect(error.code).toBe("gates_failed")
    expect(error.failures).toEqual([{ target: "Memory.Retain", message: "lint failed" }])
    expect(await head(root)).toBe(before)
    // The refused invocation restores the index it staged, so the next scoped commit is not poisoned.
    expect(await git(root, ["status", "--porcelain"])).toBe("?? feature.txt\n")
  })

  it("restores a pre-existing staged path after a refused commit", async () => {
    const root = await scopedRepo()
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "staged by operator\n", "utf8")
    await git(root, ["add", "scope/owned.txt"])
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "then edited\n", "utf8")
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit([gateTarget()]),
      paths: ["scope"],
      gateRunner: { run: async () => [{ target: "gate", message: "red" }] }
    }))
    expect(error.code).toBe("gates_failed")
    expect(await git(root, ["show", ":scope/owned.txt"])).toBe("staged by operator\n")
    expect(await git(root, ["status", "--porcelain"])).toBe("MM scope/owned.txt\n")
  })

  it("honors the repository's commit.gpgsign policy", async () => {
    const root = await temporaryRepo()
    const before = await head(root)
    // A signing program that always fails stands in for a mandatory signing policy.
    await git(root, ["config", "commit.gpgsign", "true"])
    await git(root, ["config", "gpg.program", "false"])
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "new\n", "utf8")
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      sweepWorkingTree: true,
      gateRunner: greenGates
    }))
    expect(error.code).toBe("git_failed")
    expect(await head(root)).toBe(before)
    expect(await git(root, ["status", "--porcelain"])).toBe("?? feature.txt\n")
  })

  it("lets the -m override win over the declared message", async () => {
    const root = await temporaryRepo()
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "new\n", "utf8")
    const result = await GitCommit.commit({
      root,
      target: fixedCommit(),
      sweepWorkingTree: true,
      gateRunner: greenGates,
      messageOverride: "fix: override wins"
    })
    expect(result.message).toBe("fix: override wins")
    expect(await git(root, ["log", "-1", "--format=%s"])).toBe("fix: override wins\n")
  })
})

describe("commit scope", () => {
  it("a scoped commit leaves a concurrent unrelated edit out of the commit and in the working tree", async () => {
    const root = await scopedRepo()
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned change\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "outside-tracked.txt"), "concurrent change\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "outside-untracked.txt"), "concurrent addition\n", "utf8")

    const result = await GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates,
      paths: ["scope/owned.txt"]
    })

    expect(await git(root, ["show", "--name-only", "--pretty=format:", "HEAD"])).toBe("scope/owned.txt\n")
    expect(result.staged).toEqual(["scope/owned.txt"])
    expect(await git(root, ["status", "--porcelain"])).toBe(
      " M outside-tracked.txt\n?? outside-untracked.txt\n"
    )
  })

  it("a scoped commit stages a deletion inside the scope", async () => {
    const root = await scopedRepo()
    await Fs.rm(NodePath.join(root, "scope/owned.txt"))
    await Fs.writeFile(NodePath.join(root, "outside-tracked.txt"), "concurrent change\n", "utf8")

    const result = await GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates,
      paths: ["scope/owned.txt"]
    })

    expect(result.staged).toEqual(["scope/owned.txt"])
    expect(await git(root, ["ls-tree", "--name-only", "HEAD", "--", "scope/owned.txt"])).toBe("")
    expect(await git(root, ["status", "--porcelain"])).toBe(" M outside-tracked.txt\n")
  })

  it("an acknowledged sweep reports every path it swept", async () => {
    const root = await scopedRepo()
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned change\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "outside-tracked.txt"), "concurrent change\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "outside-untracked.txt"), "concurrent addition\n", "utf8")

    const result = await GitCommit.commit({
      root,
      target: fixedCommit(),
      sweepWorkingTree: true,
      gateRunner: greenGates
    })

    expect(result.staged).toEqual(["outside-tracked.txt", "outside-untracked.txt", "scope/owned.txt"])
  })

  it("refuses to sweep a dirty tree when the invocation declares no scope", async () => {
    const root = await scopedRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned change\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "outside-tracked.txt"), "concurrent change\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "outside-untracked.txt"), "concurrent addition\n", "utf8")

    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates
    }))

    expect(error.code).toBe("unrelated_changes")
    expect(error.message).toContain("outside-tracked.txt")
    expect(error.message).toContain("outside-untracked.txt")
    expect(error.message).toContain("scope/owned.txt")
    expect(await head(root)).toBe(before)
    // Nothing was staged: the refusal lands before `git add` runs.
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("")
    expect(await git(root, ["status", "--porcelain"])).toBe(
      " M outside-tracked.txt\n M scope/owned.txt\n?? outside-untracked.txt\n"
    )
  })

  it("names a path whose text a porcelain listing would otherwise quote", async () => {
    const root = await scopedRepo()
    await Fs.writeFile(NodePath.join(root, "a file with spaces.txt"), "concurrent addition\n", "utf8")

    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates
    }))

    expect(error.code).toBe("unrelated_changes")
    expect(error.message).toContain("a file with spaces.txt")
  })

  it("refuses a scoped commit when the index carries a staged path outside the scope", async () => {
    const root = await scopedRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned change\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "outside-tracked.txt"), "concurrent change\n", "utf8")
    // `git add -A -- <paths>` scopes only the new staging operation; the commit
    // that follows publishes the whole index, so a path staged before the
    // invocation would ride along unless the guard refuses it.
    await git(root, ["add", "--", "outside-tracked.txt"])

    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates,
      paths: ["scope/owned.txt"]
    }))

    expect(error.code).toBe("unrelated_changes")
    expect(error.message).toContain("outside-tracked.txt")
    expect(error.message).not.toContain("scope/owned.txt")
    expect(await head(root)).toBe(before)
  })

  it("refuses an empty scope", async () => {
    const root = await scopedRepo()
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned change\n", "utf8")
    const before = await git(root, ["status", "--porcelain"])

    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates,
      paths: []
    }))

    expect(error.code).toBe("invalid_paths")
    expect(await git(root, ["status", "--porcelain"])).toBe(before)
  })

  it("refuses a blank pathspec", async () => {
    const root = await scopedRepo()
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned change\n", "utf8")
    const before = await git(root, ["status", "--porcelain"])

    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates,
      paths: ["scope/owned.txt", " \t"]
    }))

    expect(error.code).toBe("invalid_paths")
    expect(error.message).toContain("pathspec at index 1")
    expect(error.message).toContain(JSON.stringify(" \t"))
    expect(await git(root, ["status", "--porcelain"])).toBe(before)
  })
})

/** Copies the working tree without `.git`, the way a scratch gate tree starts. */
const workingCopy = async (root: string): Promise<string> => {
  const copy = await tracked(Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-git-commit-scratch-")))
  await Fs.cp(root, copy, { recursive: true, filter: (source) => NodePath.basename(source) !== ".git" })
  return copy
}

const readOrAbsent = (path: string): Promise<string | undefined> =>
  Fs.readFile(path, "utf8").then((text) => text, () => undefined)

describe("gates judge the commit tree", () => {
  it("materializes exactly the tree being committed, not the working tree", async () => {
    const root = await scopedRepo()
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned change\n", "utf8")
    // Out-of-scope edits stay in the working tree and must be invisible to the gates.
    await Fs.writeFile(NodePath.join(root, "outside-tracked.txt"), "concurrent change\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "outside-untracked.txt"), "concurrent addition\n", "utf8")
    await Fs.rm(NodePath.join(root, "README.md"))
    const seen: Array<Record<string, string | undefined>> = []
    let candidateTree = ""
    const result = await GitCommit.commit({
      root,
      target: fixedCommit([gateTarget()]),
      paths: ["scope"],
      gateRunner: {
        run: async (_gates, candidate) => {
          const scratch = await workingCopy(root)
          await candidate.materialize(scratch)
          candidateTree = candidate.tree
          seen.push({
            owned: await readOrAbsent(NodePath.join(scratch, "scope/owned.txt")),
            outsideTracked: await readOrAbsent(NodePath.join(scratch, "outside-tracked.txt")),
            outsideUntracked: await readOrAbsent(NodePath.join(scratch, "outside-untracked.txt")),
            readme: await readOrAbsent(NodePath.join(scratch, "README.md"))
          })
          return []
        }
      }
    })
    expect(seen).toEqual([{
      owned: "owned change\n",
      outsideTracked: "outside baseline\n",
      outsideUntracked: undefined,
      readme: "seed\n"
    }])
    expect(candidateTree).toBe((await git(root, ["rev-parse", `${result.sha}^{tree}`])).trim())
    // The working tree keeps the unrelated edits exactly as they were.
    expect(await git(root, ["status", "--porcelain"])).toBe(
      " D README.md\n M outside-tracked.txt\n?? outside-untracked.txt\n"
    )
  })

  it("refuses when the index changes after the gates judged the candidate", async () => {
    const root = await scopedRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned change\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "outside-tracked.txt"), "concurrent change\n", "utf8")
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit([gateTarget()]),
      paths: ["scope"],
      gateRunner: {
        run: async () => {
          // A concurrent writer stages an unjudged path while the gates run.
          await git(root, ["add", "outside-tracked.txt"])
          return []
        }
      }
    }))
    expect(error.code).toBe("candidate_changed")
    expect(await head(root)).toBe(before)
  })

  it("rolls back a commit whose recorded tree is not the judged tree", async () => {
    const root = await scopedRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "scope/owned.txt"), "owned change\n", "utf8")
    await Fs.writeFile(NodePath.join(root, "outside-tracked.txt"), "concurrent change\n", "utf8")
    // A pre-commit hook that restages an unjudged path changes what `git commit` records.
    const hook = NodePath.join(root, ".git/hooks/pre-commit")
    await Fs.writeFile(hook, "#!/bin/sh\ngit add outside-tracked.txt\n", "utf8")
    await Fs.chmod(hook, 0o755)
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit([gateTarget()]),
      paths: ["scope"],
      gateRunner: greenGates
    }))
    expect(error.code).toBe("candidate_changed")
    expect(await head(root)).toBe(before)
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("")
  })
})

describe("agent-written messages", () => {
  it("composes the message from the named agent and the staged diff", async () => {
    const root = await temporaryRepo()
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "agent change\n", "utf8")
    const contexts: Array<{ root: string; agent: string; stagedDiff: string }> = []
    const result = await GitCommit.commit({
      root,
      target: agentCommit(),
      sweepWorkingTree: true,
      gateRunner: greenGates,
      agentMessage: {
        compose: async (context) => {
          contexts.push({ ...context })
          return "feat: written by the agent"
        }
      }
    })
    expect(contexts).toHaveLength(1)
    expect(contexts[0]!.agent).toBe("luna")
    expect(contexts[0]!.root).toBe(root)
    expect(contexts[0]!.stagedDiff).toContain("agent change")
    expect(result.message).toBe("feat: written by the agent")
    expect(await git(root, ["log", "-1", "--format=%s"])).toBe("feat: written by the agent\n")
  })

  it("prefers the -m override without consulting the agent", async () => {
    const root = await temporaryRepo()
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "agent change\n", "utf8")
    let composed = 0
    const result = await GitCommit.commit({
      root,
      target: agentCommit(),
      sweepWorkingTree: true,
      gateRunner: greenGates,
      agentMessage: {
        compose: async () => {
          composed += 1
          return "never used"
        }
      },
      messageOverride: "docs: override"
    })
    expect(composed).toBe(0)
    expect(result.message).toBe("docs: override")
  })

  it("refuses an agent-declared message with no bound AgentMessage", async () => {
    const root = await temporaryRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "agent change\n", "utf8")
    const error = await failure(GitCommit.commit({
      root,
      target: agentCommit(),
      sweepWorkingTree: true,
      gateRunner: greenGates
    }))
    expect(error.code).toBe("agent_message_unavailable")
    expect(error.message).toContain("luna")
    expect(await head(root)).toBe(before)
  })

  it("refuses an empty composed message", async () => {
    const root = await temporaryRepo()
    const before = await head(root)
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "agent change\n", "utf8")
    const error = await failure(GitCommit.commit({
      root,
      target: agentCommit(),
      sweepWorkingTree: true,
      gateRunner: greenGates,
      agentMessage: { compose: async () => "   " }
    }))
    expect(error.code).toBe("empty_message")
    expect(await head(root)).toBe(before)
  })
})

describe("refusals before staging", () => {
  it("refuses a root outside any git work tree", async () => {
    const root = await tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-not-a-repo-"))))
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates
    }))
    expect(error.code).toBe("not_a_git_repository")
  })

  it("refuses a tree identical to HEAD", async () => {
    const root = await temporaryRepo()
    const error = await failure(GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates
    }))
    expect(error.code).toBe("nothing_to_commit")
  })

  it("refuses a non-Git.Commit target", async () => {
    const root = await temporaryRepo()
    await expect(GitCommit.commit({
      root,
      target: gateTarget(),
      gateRunner: greenGates
    })).rejects.toThrow("expected a Git.Commit target")
  })
})

describe("a git command that cannot run is not an exit code", () => {
  /**
   * Node reports a spawn-level failure with a string `code`. Collapsing that
   * to a synthetic exit 1 with empty output made a host without git report
   * `not_a_git_repository: <root> is not inside a git work tree`, which sends
   * an operator to check the repository rather than the toolchain.
   */
  it("reports spawn_failed with the OS code when git is not on PATH", async () => {
    const root = await temporaryRepo()
    const path = process.env["PATH"]
    process.env["PATH"] = NodePath.join(root, "no-tools")
    try {
      const error = await failure(
        GitCommit.commit({ root, target: fixedCommit(), gateRunner: greenGates })
      )
      expect(error.code).toBe("spawn_failed")
      expect(error.message).toMatch(/could not run:.*ENOENT/)
    } finally {
      if (path === undefined) delete process.env["PATH"]
      else process.env["PATH"] = path
    }
  })
})

vi.mock("../src/internal/ContainedProcess.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ContainedProcess>()
  return { ...actual, run: vi.fn(actual.run) }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("subprocess bounds", () => {
  it("passes the run signal, deadline and sanitized environment to every git command", async () => {
    const root = await temporaryRepo()
    await Fs.writeFile(NodePath.join(root, "feature.txt"), "new\n")
    const controller = new AbortController()
    vi.stubEnv("TEST_WORKSPACE_CACHE_CREDENTIAL", "invented-test-marker")
    vi.mocked(ContainedProcess.run).mockClear()
    await GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates,
      paths: ["feature.txt"],
      signal: controller.signal,
      sensitiveNames: ["TEST_WORKSPACE_CACHE_CREDENTIAL"]
    })
    const calls = vi.mocked(ContainedProcess.run).mock.calls
    expect(calls.length).toBeGreaterThan(5)
    for (const call of calls) {
      expect(call[0]).toMatchObject({
        signal: controller.signal,
        timeoutMs: 60_000,
        maxOutputBytes: 8 * 1024 * 1024,
        environment: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" }
      })
      expect(Object.hasOwn(call[0].environment!, "TEST_WORKSPACE_CACHE_CREDENTIAL")).toBe(
        false
      )
    }
  })

  it.each(["abort", "timeout"] as const)("bounds a hung git with %s", async (mode) => {
    const controller = new AbortController()
    const actual = await vi.importActual<typeof ContainedProcess>("../src/internal/ContainedProcess.ts")
    vi.mocked(ContainedProcess.run).mockImplementationOnce((options) => {
      const pending = actual.run({
        ...options,
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(9), 1500)"]
      })
      if (mode === "abort") setTimeout(() => controller.abort(), 20)
      return pending
    })
    const error = await failure(GitCommit.commit({
      root: Os.tmpdir(),
      target: fixedCommit(),
      gateRunner: greenGates,
      signal: controller.signal,
      timeoutMs: mode === "timeout" ? 30 : 10_000
    }))
    expect(error.message).toMatch(mode === "abort" ? /ABORT_ERR/ : /timed out/)
    expect(vi.mocked(ContainedProcess.run).mock.calls.at(-1)?.[0]).toMatchObject({
      signal: controller.signal,
      timeoutMs: mode === "timeout" ? 30 : 10_000,
      environment: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" }
    })
  })

  it("parses a staged rename followed by a modified sibling", async () => {
    const root = await temporaryRepo()
    await Fs.writeFile(NodePath.join(root, "a.txt"), "original\n")
    await Fs.writeFile(NodePath.join(root, "sibling.txt"), "before\n")
    await git(root, ["add", "-A"])
    await git(root, ["commit", "-qm", "seed rename"])
    await git(root, ["mv", "a.txt", "b.txt"])
    await Fs.writeFile(NodePath.join(root, "sibling.txt"), "after\n")
    expect(await git(root, ["status", "--porcelain", "-z"])).toBe("R  b.txt\0a.txt\0 M sibling.txt\0")
    const refusal = await failure(GitCommit.commit({ root, target: fixedCommit(), gateRunner: greenGates }))
    expect(refusal.code).toBe("unrelated_changes")
    expect(refusal.message).toContain("carries 2 change(s)")
    expect(refusal.message).toMatch(/declared: b.txt, sibling.txt$/)
    const result = await GitCommit.commit({
      root,
      target: fixedCommit(),
      gateRunner: greenGates,
      paths: ["b.txt", "sibling.txt"]
    })
    expect(result.staged).toEqual(["b.txt", "sibling.txt"])
  })

  it("skips the source of a copy record before a modified sibling", async () => {
    const root = await temporaryRepo()
    await Fs.writeFile(NodePath.join(root, "a.txt"), "original\n")
    await Fs.writeFile(NodePath.join(root, "sibling.txt"), "before\n")
    await git(root, ["add", "-A"])
    await git(root, ["commit", "-qm", "seed copy"])
    await Fs.copyFile(NodePath.join(root, "a.txt"), NodePath.join(root, "b.txt"))
    await Fs.writeFile(NodePath.join(root, "sibling.txt"), "after\n")
    await git(root, ["add", "-A"])
    expect(await git(root, ["diff", "--cached", "-C", "--find-copies-harder", "--name-status", "-z"]))
      .toBe("C100\0a.txt\0b.txt\0M\0sibling.txt\0")
    // status does not consistently discover copies across Git versions. Supply
    // its documented C record for the copy that diff -C verified above.
    const actual = await vi.importActual<typeof ContainedProcess>("../src/internal/ContainedProcess.ts")
    vi.mocked(ContainedProcess.run).mockImplementation(async (options) => {
      if (options.args[0] === "status") {
        options.stdout("C  b.txt\0a.txt\0M  sibling.txt\0")
        return 0
      }
      return actual.run(options)
    })
    try {
      const refusal = await failure(GitCommit.commit({ root, target: fixedCommit(), gateRunner: greenGates }))
      expect(refusal.code).toBe("unrelated_changes")
      expect(refusal.message).toContain("carries 2 change(s)")
      expect(refusal.message).toMatch(/declared: b.txt, sibling.txt$/)
      const result = await GitCommit.commit({
        root,
        target: fixedCommit(),
        gateRunner: greenGates,
        paths: ["b.txt", "sibling.txt"]
      })
      expect(result.staged).toEqual(["b.txt", "sibling.txt"])
    } finally {
      vi.mocked(ContainedProcess.run).mockImplementation(actual.run)
    }
  })
})
