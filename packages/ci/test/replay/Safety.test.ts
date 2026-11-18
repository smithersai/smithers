/** What a CI step may reach when the replay runs it: no remote to push to, and none of the person's environment. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { toolEnvironment } from "@smthrs/targets/Exec"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { noPushUrl, placeEnvironment, pushRefusal, stepEnvironment } from "../../src/replay/Environment.ts"
import { run } from "../../src/replay/index.ts"
import { job, makeEmptyDirectory, makeSmallRepository } from "./fixture.ts"
import { options, parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (root: string): string => {
  created.push(root)
  return root
}
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

type Parts = ReplayParts<never>
const base = parts("none") as unknown as Parts

const replay = (root: string, overrides: Partial<Parts> = {}): Promise<ReplayReport> =>
  Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"] }, { ...base, ...overrides }).pipe(
      Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

/** Whether `git push` from `copy` fails, and what git said. */
const pushFrom = (copy: string): string => {
  try {
    return `pushed: ${git(copy, "push", "--force", "origin", "HEAD:refs/heads/from-a-copy")}`
  } catch (cause) {
    return String((cause as { readonly stderr: string }).stderr)
  }
}

describe("a copy the replay makes", () => {
  it("fetches from the repository's remote and has no remote a step can push to", async () => {
    const remote = track(makeEmptyDirectory())
    execFileSync("git", ["init", "--quiet", "--bare", remote])
    const url = `file://${remote}`
    const out = track(makeEmptyDirectory())
    // What a release step does: it says where it would push, then pushes.
    const push = [
      `git remote get-url origin >> ${out}/fetch`,
      `git remote get-url --push origin >> ${out}/push`,
      "git push --force origin HEAD:refs/heads/published"
    ].join(" && ")
    const root = track(makeSmallRepository([job("release", push), job("ok", "sh a.sh")]))
    git(root, "remote", "add", "origin", url)
    git(root, "push", "--quiet", "origin", "main")
    const before = git(root, "ls-remote", "origin")

    const copies: Array<ReadonlyArray<string>> = []
    const read: Parts["read"] = (copy) => {
      copies.push([git(copy, "remote", "get-url", "origin"), git(copy, "remote", "get-url", "--push", "origin")])
      copies.push([pushFrom(copy)])
      return base.read(copy)
    }
    const [commit] = (await replay(root, { read })).commits

    // The baseline's step ran, in a copy of its own, and its push failed: once at first and once as a rerun.
    expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 1, skipped: 0 })
    expect(readFileSync(join(out, "fetch"), "utf8").trim().split("\n")).toEqual([url, url])
    expect(readFileSync(join(out, "push"), "utf8").trim().split("\n")).toEqual([noPushUrl, noPushUrl])
    // The copy the targets run in is the same.
    expect(copies[0]).toEqual([url, noPushUrl])
    expect(copies[1]?.[0]).toContain("does not appear to be a git repository")
    expect(commit?.normal.counts.failed).toBe(1)
    expect(git(root, "ls-remote", "origin")).toBe(before)
  }, 600_000)
})

describe("a baseline step", () => {
  it("gets the environment a target gets and its own variables, and nothing else of the person's", async () => {
    const out = track(makeEmptyDirectory())
    const seen = join(out, "seen")
    const root = track(
      makeSmallRepository([job("env", "env > \"$SEEN\"", { env: { SEEN: seen, MINE: "from the step" } })])
    )
    const planted = {
      AI_GATEWAY_API_KEY: "dummy-key-123",
      SMITHERS_CACHE_TOKEN: "dummy-tok-456",
      TOOL_HOME: "/opt/tool"
    }
    Object.assign(process.env, planted)
    try {
      const [commit] = (await replay(root)).commits
      expect(commit?.baseline.ok).toBe(true)
    } finally {
      for (const name of Object.keys(planted)) delete process.env[name]
    }
    const text = readFileSync(seen, "utf8")
    const names = text.split("\n").filter((line) => line.includes("=")).map((line) => line.slice(0, line.indexOf("=")))
    for (const value of Object.values(planted)) expect(text).not.toContain(value)
    // bash adds its own three; every other name is one Smithers build gives a target, the step's, or one the replay
    // sets for every step: its home and temporary directory, and what tells git to refuse a push.
    const target = new Set([
      ...Object.keys(toolEnvironment({ SEEN: seen, MINE: "from the step" }, [])),
      ...Object.keys(placeEnvironment({ home: "", tmp: "" })),
      ...Object.keys(pushRefusal)
    ])
    expect(names.filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name)).sort()).toEqual([...target].sort())
    expect(text).toContain("MINE=from the step\n")
    expect(text).toContain("LANG=C\n")
    expect(names).toContain("PATH")
  }, 600_000)

  it("reads end of file on standard input", async () => {
    // With an open pipe as its input, `cat` would wait until the test timed out.
    const root = track(makeSmallRepository([job("stdin", "cat > /dev/null && echo done")]))
    const [commit] = (await replay(root)).commits
    expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
  }, 600_000)
})

describe("stepEnvironment", () => {
  const place = { home: "/replay/home", tmp: "/replay/tmp" }

  it("gives the replay's home in place of the person's, and keeps the machine's temporary directory", () => {
    const environment = stepEnvironment({}, place)
    expect(environment).toMatchObject({ HOME: "/replay/home", XDG_CACHE_HOME: "/replay/home/.cache" })
    // A jail puts the replay's own directory behind the name; the name stays, so `smthrs` finds its compiled code.
    expect(environment["TMPDIR"]).toBe(process.env["TMPDIR"])
    expect(environment).toMatchObject(pushRefusal)
    expect(Object.values(environment)).not.toContain(homedir())
  })

  it("lets a step's own value win", () => {
    expect(stepEnvironment({ HOME: "/somewhere/else" }, place)["HOME"]).toBe("/somewhere/else")
    expect(stepEnvironment({ GIT_TERMINAL_PROMPT: "1" }, place)["GIT_TERMINAL_PROMPT"]).toBe("1")
  })
})
