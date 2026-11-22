/** How a replay stops a command: a real process that ignores the signal to stop is killed. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { reasonOf } from "../../src/replay/Failures.ts"
import { cleanCopy, cloneCopy, exec, originHeadOf, originOf, runStep } from "../../src/replay/Process.vibe"
import { makePlace } from "./place.ts"

const made: Array<string> = []
afterAll(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })))

const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "replay-process-"))
  made.push(path)
  return path
}

/** A shell that writes its process id, ignores the signal to stop, and becomes a long `sleep`. */
const stubborn = (file: string): ReadonlyArray<string> => ["-c", `trap "" TERM; echo $$ > ${file}; exec sleep 120`]

const environment = { PATH: process.env["PATH"] }

const onNode = <A, E>(work: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(work)

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether the process at the id in `file` has ended, given a moment to be reaped. */
const ended = async (file: string): Promise<boolean> => {
  expect(existsSync(file)).toBe(true)
  const pid = Number(readFileSync(file, "utf8").trim())
  for (let tries = 0; tries < 50 && isRunning(pid); tries++) await new Promise((done) => setTimeout(done, 100))
  return !isRunning(pid)
}

describe("a command that ignores the signal to stop", { timeout: 120_000 }, () => {
  it("is killed when it runs past a step's time limit", async () => {
    const cwd = directory()
    const file = join(cwd, "pid")
    const run = await onNode(
      runStep("sh", stubborn(file), cwd, environment, "2 seconds").pipe(Effect.provide(NodeServices.layer)) as never
    ) as { readonly timedOut: boolean; readonly exitCode: number }
    expect(run).toMatchObject({ timedOut: true, exitCode: 124 })
    expect(await ended(file)).toBe(true)
  })

  it("is killed when the replay stops waiting for it", async () => {
    const cwd = directory()
    const file = join(cwd, "pid")
    const outcome = await onNode(
      exec("sh", stubborn(file), cwd, environment, 4000, undefined, true).pipe(
        Effect.timeoutOption("2 seconds"),
        Effect.provide(NodeServices.layer)
      ) as never
    ) as Option.Option<unknown>
    expect(Option.isNone(outcome)).toBe(true)
    expect(await ended(file)).toBe(true)
  })
})

describe("a command a signal ended", { timeout: 120_000 }, () => {
  const step = (script: string) =>
    onNode(
      runStep("bash", ["-c", script], directory(), environment, "30 seconds").pipe(
        Effect.provide(NodeServices.layer)
      ) as never
    ) as Promise<Record<string, unknown>>

  it("has the exit code a shell gives for the signal, and what it printed, with no word of its command", async () => {
    expect(await step("echo out; echo 'the widget failed' >&2; kill -KILL $$")).toEqual({
      timedOut: false,
      stalled: false,
      exitCode: 137,
      stderr: "the widget failed\n",
      stdout: "out\n"
    })
    expect(await step("kill -TERM $$")).toMatchObject({ exitCode: 143, stderr: "", stdout: "" })
  })
})

describe("what a failed step printed", { timeout: 120_000 }, () => {
  it("holds the error above a long stack trace, as is-plain-obj's `npm test` printed it on a job's machine", async () => {
    const steps = JSON.parse(readFileSync(new URL("../fixtures/failed-steps.json", import.meta.url), "utf8")) as {
      readonly isPlainObj: { readonly stderr: string; readonly stdout: string }
    }
    const cwd = directory()
    writeFileSync(join(cwd, "stderr"), steps.isPlainObj.stderr)
    writeFileSync(join(cwd, "stdout"), steps.isPlainObj.stdout)
    const run = await onNode(
      runStep("sh", ["-c", "cat stdout; cat stderr >&2; exit 1"], cwd, environment, "30 seconds").pipe(
        Effect.provide(NodeServices.layer)
      ) as never
    ) as { readonly exitCode: number; readonly stderr: string; readonly stdout: string }
    expect(run).toMatchObject({ exitCode: 1, stderr: steps.isPlainObj.stderr, stdout: steps.isPlainObj.stdout })
    expect(reasonOf(run)).toBe("TypeError: util.isDate is not a function")
  })
})

/** Runs git in `cwd` and answers what it printed, trimmed. */
const gitIn = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t"
    }
  }).trim()

describe("a copy of the repository a replay makes", { timeout: 120_000 }, () => {
  /** An upstream whose default branch is `develop`, and the person's clone of it, checked out on a branch of theirs. */
  const repositories = () => {
    const base = directory()
    const upstream = join(base, "upstream")
    gitIn(base, "init", "--quiet", "--initial-branch=develop", upstream)
    writeFileSync(join(upstream, "a.txt"), "a\n")
    gitIn(upstream, "add", "a.txt")
    gitIn(upstream, "commit", "--quiet", "-m", "first")
    const person = join(base, "person")
    gitIn(base, "clone", "--quiet", upstream, person)
    gitIn(person, "checkout", "--quiet", "-b", "my-feature")
    // The replay's own clone of the person's repository, as it makes one: its HEAD is the person's branch.
    const source = join(base, "source")
    gitIn(base, "clone", "--quiet", "--no-checkout", person, source)
    return { base, person, source }
  }

  const copied = async (
    head: { readonly exitCode: number; readonly text: string },
    { base, person, source }: ReturnType<typeof repositories> = repositories()
  ) => {
    const copy = join(base, "copy")
    const origin = await onNode(originOf(person).pipe(Effect.provide(NodeServices.layer)) as never)
    await onNode(
      cloneCopy(base, source, copy, origin as never, head as never).pipe(Effect.provide(NodeServices.layer)) as never
    )
    return { copy, person }
  }

  // Read.vibe takes the default branch from `origin/HEAD`, and then a condition such as `github.ref ==
  // 'refs/heads/develop'` or a `pull_request: branches: [develop]` filter is judged for that branch.
  it("names the repository's default branch, not the branch the person has checked out", async () => {
    const repos = repositories()
    const { person } = repos
    const head = await onNode(originHeadOf(person).pipe(Effect.provide(NodeServices.layer)) as never) as {
      readonly exitCode: number
      readonly text: string
    }
    expect(head.exitCode).toBe(0)
    expect(head.text.trim()).toBe("refs/remotes/origin/develop")
    const { copy } = await copied(head, repos)
    expect(gitIn(copy, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).toBe("origin/develop")
    expect(gitIn(copy, "remote", "get-url", "origin")).toBe(gitIn(person, "remote", "get-url", "origin"))
  })

  it("keeps the copy's own when the repository names no default branch", async () => {
    const { copy } = await copied({ exitCode: 1, text: "" })
    expect(gitIn(copy, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).toBe("origin/my-feature")
  })
})

describe("cleanCopy", () => {
  it("removes every untracked and ignored file of a copy but what it is told to keep", async () => {
    const copy = directory()
    const run = (...args: ReadonlyArray<string>) => execFileSync("git", ["-C", copy, ...args], { stdio: "ignore" })
    run("init", "--quiet", "--initial-branch=main")
    writeFileSync(join(copy, ".gitignore"), "ignored.txt\nkept/\n")
    writeFileSync(join(copy, "tracked.txt"), "tracked\n")
    run("add", "-A")
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "one")
    writeFileSync(join(copy, "untracked.txt"), "left by a step\n")
    writeFileSync(join(copy, "ignored.txt"), "built\n")
    execFileSync("mkdir", ["-p", join(copy, "kept")])
    writeFileSync(join(copy, "kept", "cache"), "kept\n")
    await onNode(cleanCopy(copy, ["kept"], makePlace()).pipe(Effect.provide(NodeServices.layer)))
    expect(existsSync(join(copy, "tracked.txt"))).toBe(true)
    expect(existsSync(join(copy, "untracked.txt"))).toBe(false)
    expect(existsSync(join(copy, "ignored.txt"))).toBe(false)
    expect(readFileSync(join(copy, "kept", "cache"), "utf8")).toBe("kept\n")
  })
})
