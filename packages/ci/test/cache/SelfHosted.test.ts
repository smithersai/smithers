/**
 * A cache hosted as `docs/concepts/cache.md` says, used by a repository that
 * `smithers-ci apply` set up. Every repository, clone and process is real.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { noSharedCache, workflowPath } from "../../src/generate/Render.ts"
import { bin, commit, git, remove, spawn, temporary } from "../cli/repo.ts"
import { host, hostable, type Hosted, service, tables } from "./host.ts"

const smthrs = fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))
const slow = 600_000

/** True when this machine can hold a step to the files it names: bubblewrap on Linux, seatbelt on macOS. */
const confines = process.platform === "darwin" || spawnSync("bwrap", ["--version"]).status === 0

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}

/**
 * A Bun workspace of two packages. Its CI tests each package, which `apply`
 * turns into one step per package, each held to its package's files, and
 * lints from the root, a step that may read any file. Every step reads the
 * root files, so `name` gives each repository results of its own.
 */
const sources = (name: string, aTest = `console.log("a passes")\n`): Readonly<Record<string, string>> => ({
  "package.json": JSON.stringify({ name, private: true, workspaces: ["packages/*"] }),
  "lint.js": `console.log("lint passes")\n`,
  "packages/a/package.json": JSON.stringify({ name: "a", scripts: { test: "bun test.js" } }),
  "packages/a/test.js": aTest,
  "packages/b/package.json": JSON.stringify({ name: "b", scripts: { test: "bun test.js" } }),
  "packages/b/test.js": `console.log("b passes")\n`,
  "packages/b/value.txt": "b's own file\n",
  ".github/workflows/ci.yml": [
    "on: [push]",
    "jobs:",
    ...["test", "lint"].flatMap((job) => [
      `  ${job}:`,
      `    runs-on: ${process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"}`,
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: oven-sh/setup-bun@v2",
      `      - run: ${job === "test" ? "bun run --filter '*' test" : "bun lint.js"}`
    ]),
    ""
  ].join("\n")
})

const repository = (files: Readonly<Record<string, string>>): string => {
  const root = keep(temporary("cache-origin"))
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "first", files)
  return root
}

/** A repository holding `files`, with what `smithers-ci apply` writes for it committed. */
const applied = async (files: Readonly<Record<string, string>>, args: ReadonlyArray<string>): Promise<string> => {
  const root = repository(files)
  const outcome = await spawn(bin, ["apply", ...args], root)
  expect(outcome.code, outcome.stderr).toBe(0)
  commit(root, "smithers-ci apply")
  return root
}

/** A fresh clone: the files of the newest commit and nothing a run left behind. */
const clone = (origin: string): string => {
  const root = keep(temporary("cache-clone"))
  git(root, "clone", "--quiet", origin, ".")
  expect(existsSync(join(root, ".flows"))).toBe(false)
  return root
}

interface Settings {
  /** The repository variable `SMITHERS_CACHE_URL`; without it the workflow uses the URL `apply --cache` was given. */
  readonly variable?: string
  /** The secret the workflow passes as `SMITHERS_CACHE_TOKEN`. */
  readonly token?: string
}

interface WorkflowStep {
  readonly name?: string
  readonly if?: string
  readonly run?: string
  readonly env?: Readonly<Record<string, string>>
}

const stepsOf = (root: string): ReadonlyArray<WorkflowStep> =>
  (parseYaml(readFileSync(join(root, workflowPath), "utf8")) as {
    readonly jobs: { readonly ci: { readonly steps: ReadonlyArray<WorkflowStep> } }
  }).jobs.ci.steps

/**
 * Runs the workflow's own command in `root` with the cache settings GitHub
 * would give it. Only the program differs: this checkout's `smthrs` stands
 * for the published one. Returns each step's status by name.
 */
const run = (root: string, settings: Settings) => {
  const step = stepsOf(root).find((entry) => entry.run?.includes("smthrs ci")) as WorkflowStep
  expect(Object.keys(step.env ?? {})).toEqual(["SMITHERS_CACHE_URL", "SMITHERS_CACHE_TOKEN"])
  const written = /\|\| '(.*)' \}\}$/.exec(step.env?.["SMITHERS_CACHE_URL"] ?? "")?.[1]
  const resultsFile = join(root, ".flows", "results.json")
  const command = (step.run as string).replace(/^npx .* smthrs /, `"$NODE" "$SMTHRS" `)
  expect(command).toContain("$SMTHRS")
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE: process.execPath,
    SMTHRS: smthrs,
    // GitHub gives an empty string for a variable or a secret the repository does not have.
    SMITHERS_CACHE_URL: settings.variable ?? written ?? "",
    SMITHERS_CACHE_TOKEN: settings.token ?? ""
  }
  delete environment["SMITHERS_CACHE_READ_TOKEN"]
  delete environment["SMITHERS_CACHE_WRITE_TOKEN"]
  delete environment["SMITHERS_CACHE_NAMESPACE"]
  const result = spawnSync("bash", ["-c", `${command} --results-file "$1"`, "bash", resultsFile], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024
  })
  const record = JSON.parse(readFileSync(resultsFile, "utf8")) as {
    readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
  }
  const short = (label: string): string => label.replace(/^\/\/:ci\.yml-/, "").replace(/-1/, "")
  return {
    code: result.status,
    output: `${result.stdout}${result.stderr}`,
    statuses: Object.fromEntries(record.results.map((target) => [short(target.label), target.status]))
  }
}

describe.runIf(hostable && confines)("a cache you host yourself", () => {
  let cache: Hosted

  beforeAll(async () => {
    cache = await host()
  }, slow)

  afterAll(async () => {
    await cache.stop()
    made.forEach(remove)
  }, slow)

  it("stores in one clone, is reused in a fresh clone, and reruns only what reads a changed file", async () => {
    const origin = await applied(sources("stores"), ["--cache", cache.url])
    const before = cache.stored()

    // Clone A: nothing is stored yet, so every step runs. The two steps held to their files are stored.
    const first = run(clone(origin), { token: cache.writeToken })
    expect(first.code, first.output).toBe(0)
    expect(first.statuses).toEqual({ "test-a": "ran", "test-b": "ran", lint: "ran" })
    expect(cache.stored()).toBe(before + 2)

    // Clone B has no results of its own. Both stored steps come from the cache, with the token that only reads.
    const second = run(clone(origin), { token: cache.readToken })
    expect(second.code, second.output).toBe(0)
    expect(second.statuses).toEqual({ "test-a": "hit", "test-b": "hit", lint: "ran" })
    expect(cache.stored()).toBe(before + 2)

    // One file of package b changes. In a fresh clone only b's step runs again; a's still comes from the cache.
    commit(origin, "change b", { "packages/b/test.js": `console.log("b passes again")\n` })
    const third = run(clone(origin), { token: cache.writeToken })
    expect(third.code, third.output).toBe(0)
    expect(third.statuses).toEqual({ "test-a": "hit", "test-b": "ran", lint: "ran" })
    expect(cache.stored()).toBe(before + 3)
    expect(run(clone(origin), { token: cache.readToken }).statuses).toEqual({
      "test-a": "hit",
      "test-b": "hit",
      lint: "ran"
    })
  }, slow)

  it("refuses a wrong token: the run reuses nothing, stores nothing and still passes", async () => {
    const origin = await applied(sources("refuses"), ["--cache", cache.url])
    const stored = run(clone(origin), { token: cache.writeToken })
    expect(stored.statuses).toEqual({ "test-a": "ran", "test-b": "ran", lint: "ran" })
    const before = cache.stored()

    const wrong = "not-the-token-0123456789abcdef"
    const refused = run(clone(origin), { token: wrong })
    expect(refused.code, refused.output).toBe(0)
    expect(refused.statuses).toEqual({ "test-a": "ran", "test-b": "ran", lint: "ran" })
    expect(refused.output).toContain("HTTP 401")
    expect(refused.output).not.toContain(wrong)
    expect(cache.stored()).toBe(before)
    // The results were there for the right token.
    expect(run(clone(origin), { token: cache.readToken }).statuses).toEqual({
      "test-a": "hit",
      "test-b": "hit",
      lint: "ran"
    })

    const ask = (method: string, bearer: string | undefined): Promise<number> =>
      fetch(`${cache.url}/ac/${"0".repeat(64)}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` })
        },
        ...(method === "PUT" ? { body: "{}" } : {})
      }).then((response) => response.status)
    expect(await ask("GET", undefined)).toBe(401)
    expect(await ask("GET", wrong)).toBe(401)
    expect(await ask("PUT", wrong)).toBe(401)
    // The token that only reads may ask, and may not store.
    expect(await ask("GET", cache.readToken)).toBe(404)
    expect(await ask("PUT", cache.readToken)).toBe(403)
    expect(cache.log()).not.toContain(cache.readToken)
    expect(cache.log()).not.toContain(cache.writeToken)
  }, slow)

  it("stores only a step that ran held to the files it names", async () => {
    // Package a's test reads a file of package b, by a path it builds as it runs: no file of a names b, so the
    // step is held to a's files. In the open it passes.
    const files = sources(
      "holds",
      [
        "const directory = String.fromCharCode(46, 46, 47, 98, 47)",
        "await Bun.file(directory + \"value.txt\").text()",
        "console.log(\"a passes\")",
        ""
      ].join("\n")
    )
    const open = repository(files)
    expect(spawnSync("bun", ["run", "--filter", "a", "test"], { cwd: open }).status).toBe(0)
    const leaking = await applied(files, ["--cache", cache.url])
    const before = cache.stored()
    const outcome = run(clone(leaking), { token: cache.writeToken })
    // Held to package a's files it cannot read b's, so it fails and nothing is stored for it. The lint step passes
    // and may read any file, so it is never stored either: only b's step is.
    expect(outcome.statuses).toEqual({ "test-a": "failed", "test-b": "ran", lint: "ran" })
    expect(outcome.code).not.toBe(0)
    expect(cache.stored()).toBe(before + 1)
    expect(run(clone(leaking), { token: cache.readToken }).statuses).toEqual({
      "test-a": "failed",
      "test-b": "hit",
      lint: "ran"
    })
  }, slow)

  it("runs with no cache settings and says so in one line, then uses the variable and the secret", async () => {
    // Set up with no URL: only the repository's variable names the cache.
    const plain = await applied(sources("unset"), [])
    const steps = stepsOf(plain)
    const notice = steps.find((entry) => entry.name === "Shared cache") as WorkflowStep
    expect(notice.if).toBe("${{ vars.SMITHERS_CACHE_URL == '' }}")
    const said = spawnSync("bash", ["-c", notice.run as string], { encoding: "utf8" })
    expect(said.stdout).toBe(`${noSharedCache}\n`)

    // Neither set: every step runs, nothing is asked of any cache, and the run passes.
    const before = cache.stored()
    const alone = run(clone(plain), {})
    expect(alone.code, alone.output).toBe(0)
    expect(alone.statuses).toEqual({ "test-a": "ran", "test-b": "ran", lint: "ran" })
    expect(alone.output).not.toContain("remote cache")
    expect(cache.stored()).toBe(before)

    // The variable set and no secret, as in a pull request from a fork: one line, and no cache.
    const fork = run(clone(plain), { variable: cache.url })
    expect(fork.code, fork.output).toBe(0)
    expect(fork.statuses).toEqual({ "test-a": "ran", "test-b": "ran", lint: "ran" })
    expect(fork.output).toContain("remote cache off: no credentials")
    expect(cache.stored()).toBe(before)

    // Both set: results are stored, and the next clone reuses them.
    expect(run(clone(plain), { variable: cache.url, token: cache.writeToken }).statuses).toEqual({
      "test-a": "ran",
      "test-b": "ran",
      lint: "ran"
    })
    expect(cache.stored()).toBe(before + 2)
    expect(run(clone(plain), { variable: cache.url, token: cache.readToken }).statuses).toEqual({
      "test-a": "hit",
      "test-b": "hit",
      lint: "ran"
    })
  }, slow)
})

describe("the files the hosting page names", () => {
  it("are in this repository", () => {
    expect(existsSync(tables)).toBe(true)
    expect(existsSync(service)).toBe(true)
  })
})
