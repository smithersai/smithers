/**
 * A cache hosted as `docs/concepts/cache.md` says, used by a repository that
 * `smithers-ci apply` set up. Every repository, clone and process is real.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { noSharedCache, workflowPath } from "../../src/generate/Render.ts"
import { bin, commit, git, remove, spawn, temporary } from "../cli/repo.ts"
import { freePort, host, hostable, type Hosted, service, tables } from "./host.ts"

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url))
const smthrs = join(repositoryRoot, "packages", "smithers", "bin", "smithers.mjs")
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
 * lints from the root, a step that names no files and so may read any. Every
 * step reads the root files, so `name` gives each repository results of its
 * own.
 */
const sources = (name: string, aTest = `console.log("a passes")\n`): Readonly<Record<string, string>> => ({
  "package.json": JSON.stringify({ name, private: true, workspaces: ["packages/*"] }),
  "lint.txt": "lint passes\n",
  "packages/a/package.json": JSON.stringify({ name: "a", scripts: { test: "bun test.js" } }),
  "packages/a/test.js": aTest,
  "packages/b/package.json": JSON.stringify({ name: "b", scripts: { test: "bun test.js" } }),
  "packages/b/test.js": `console.log("b passes")\n`,
  "packages/b/value.txt": "b's own file\n",
  ".github/workflows/ci.yml": [
    "on: [push, pull_request]",
    "jobs:",
    ...["test", "lint"].flatMap((job) => [
      `  ${job}:`,
      `    runs-on: ${process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"}`,
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: oven-sh/setup-bun@v2",
      `      - run: ${job === "test" ? "bun run --filter '*' test" : "grep -q passes lint.txt"}`
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

/** What a GitHub repository holds, and what started the run. Anything left out is not set. */
interface Settings {
  /** The repository variable `SMITHERS_CACHE_URL`. */
  readonly variable?: string
  /** The secret `SMITHERS_CACHE_TOKEN`. */
  readonly token?: string
  /** The secret `SMITHERS_CACHE_READ_TOKEN`. */
  readonly readToken?: string
  readonly event?: "push" | "pull_request"
}

/**
 * The value GitHub gives a workflow expression made of contexts, strings,
 * `==`, `!=`, `&&` and `||`, which is all the cache lines use. A context the
 * repository does not set is an empty string; `&&` and `||` give one of
 * their operands, as GitHub's do.
 */
const evaluate = (text: string, settings: Settings): string => {
  const contexts: Readonly<Record<string, string | undefined>> = {
    "vars.SMITHERS_CACHE_URL": settings.variable,
    "secrets.SMITHERS_CACHE_TOKEN": settings.token,
    "secrets.SMITHERS_CACHE_READ_TOKEN": settings.readToken,
    "github.event_name": settings.event ?? "push"
  }
  const expression = /^\$\{\{ (.*) \}\}$/.exec(text)
  if (expression === null) return text
  const tokens = (expression[1] as string).match(/'(?:[^']|'')*'|\|\||&&|==|!=|[\w.]+/g) ?? []
  let at = 0
  const operand = (): string => {
    const token = tokens[at++] as string
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
    expect(Object.keys(contexts), text).toContain(token)
    return contexts[token] ?? ""
  }
  const equality = (): string | boolean => {
    const left = operand()
    const sign = tokens[at]
    if (sign !== "==" && sign !== "!=") return left
    at++
    return (left === operand()) === (sign === "==")
  }
  const truthy = (value: string | boolean): boolean => value !== "" && value !== false
  const both = (): string | boolean => {
    let value = equality()
    while (tokens[at] === "&&") {
      at++
      const right = equality()
      value = truthy(value) ? right : value
    }
    return value
  }
  let value = both()
  while (tokens[at] === "||") {
    at++
    const right = both()
    value = truthy(value) ? value : right
  }
  expect(at, text).toBe(tokens.length)
  return value === false ? "" : String(value)
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

let runs = 0

/**
 * Runs the workflow's own command in `root`, with the environment its own
 * expressions give for `settings`. Only the program differs: this checkout's
 * `smthrs` stands for the published one. Returns each step's status by name;
 * none when the run stopped before its first step.
 */
const run = (root: string, settings: Settings) => {
  const step = stepsOf(root).find((entry) => entry.run?.includes("smthrs ci")) as WorkflowStep
  // Beside the cache's two settings, the step names where Node keeps the compiled code of smthrs, and where Smithers
  // build keeps the jobs' machines.
  expect(Object.keys(step.env ?? {})).toEqual([
    "NODE_COMPILE_CACHE",
    "SMTHRS_MACHINES",
    "SMITHERS_CACHE_URL",
    "SMITHERS_CACHE_TOKEN"
  ])
  const given = Object.fromEntries(
    ["SMITHERS_CACHE_URL", "SMITHERS_CACHE_TOKEN"].map((name) => [name, evaluate(step.env?.[name] as string, settings)])
  )
  // Each clone is a runner of its own: its temporary directory is beside the checkout, never in it.
  const runner = `${root}.runner`
  if (!existsSync(runner)) mkdirSync(keep(runner))
  // The CLI refuses to overwrite a results file, so each run names its own.
  const resultsFile = join(runner, `results-${++runs}.json`)
  const command = (step.run as string).replace(/^npx .* smthrs /, `"$NODE" "$SMTHRS" `).replaceAll(
    "${{ runner.temp }}",
    runner
  )
  expect(command).toContain(`--cache-dir "${runner}/smithers-ci"`)
  expect(command).toContain("$SMTHRS")
  const machines = (step.env?.["SMTHRS_MACHINES"] as string).replaceAll("${{ runner.temp }}", runner)
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE: process.execPath,
    SMTHRS: smthrs,
    SMTHRS_MACHINES: machines,
    ...given
  }
  delete environment["SMITHERS_CACHE_READ_TOKEN"]
  delete environment["SMITHERS_CACHE_WRITE_TOKEN"]
  delete environment["SMITHERS_CACHE_NAMESPACE"]
  const result = spawnSync("bash", ["-c", `${command} --results-file "$1"`, "bash", resultsFile], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    // A run that hangs fails its test instead of holding the suite.
    timeout: 300_000
  })
  // The run kept its cache on the runner and left the checkout as git made it.
  expect(existsSync(join(root, ".flows"))).toBe(false)
  const record = existsSync(resultsFile)
    ? JSON.parse(readFileSync(resultsFile, "utf8")) as {
      readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
    }
    : { results: [] }
  const short = (label: string): string => label.replace(/^\/\/:ci\.yml-/, "").replace(/-1/, "")
  return {
    code: result.status,
    output: `${result.stdout}${result.stderr}`,
    given,
    statuses: Object.fromEntries(record.results.map((target) => [short(target.label), target.status]))
  }
}

const allRan = { "test-a": "ran", "test-b": "ran", lint: "ran" }

describe.runIf(hostable && confines)("a cache you host yourself", () => {
  let cache: Hosted | undefined
  const hosted = (): Hosted => cache as Hosted

  beforeAll(async () => {
    cache = await host()
  }, slow)

  afterAll(async () => {
    try {
      await cache?.stop()
    } finally {
      made.forEach(remove)
    }
  }, slow)

  it("stores in one clone, is reused in a fresh clone, and reruns only what reads a changed file", async () => {
    const { url, readToken, writeToken, stored } = hosted()
    const origin = await applied(sources("stores"), ["--cache", url])
    const secrets = { token: writeToken, readToken }
    const before = stored()

    // Clone A, a push: nothing is stored yet, so every step runs. The two steps held to their files are stored.
    const a = clone(origin)
    const first = run(a, { ...secrets, event: "push" })
    expect(first.given).toEqual({ SMITHERS_CACHE_URL: url, SMITHERS_CACHE_TOKEN: writeToken })
    expect(first.code, first.output).toBe(0)
    expect(first.statuses).toEqual(allRan)
    expect(stored()).toBe(before + 2)

    // The same clone again, with no token: all three results are on this machine. The lint step's is there too:
    // it ran in the open with its reads recorded, and the one file it read is unchanged.
    const again = run(a, {})
    expect(again.output).toContain("remote cache off: no credentials")
    expect(again.statuses).toEqual({ "test-a": "hit", "test-b": "hit", lint: "hit" })

    // Clone B, a pull request, has no results of its own. It is given the token that only reads, and both stored
    // steps come from the cache. The lint step's result never left clone A.
    const second = run(clone(origin), { ...secrets, event: "pull_request" })
    expect(second.given).toEqual({ SMITHERS_CACHE_URL: url, SMITHERS_CACHE_TOKEN: readToken })
    expect(second.code, second.output).toBe(0)
    expect(second.statuses).toEqual({ "test-a": "hit", "test-b": "hit", lint: "ran" })
    expect(stored()).toBe(before + 2)

    // One file of package b changes. In a fresh clone only b's step runs again; a's still comes from the cache.
    // A pull request stores nothing, so the push after it runs b's step once more and stores it.
    commit(origin, "change b", { "packages/b/test.js": `console.log("b passes again")\n` })
    const changed = { "test-a": "hit", "test-b": "ran", lint: "ran" }
    const request = run(clone(origin), { ...secrets, event: "pull_request" })
    expect(request.code, request.output).toBe(0)
    expect(request.statuses).toEqual(changed)
    expect(stored()).toBe(before + 2)
    const pushed = run(clone(origin), { ...secrets, event: "push" })
    expect(pushed.code, pushed.output).toBe(0)
    expect(pushed.statuses).toEqual(changed)
    expect(stored()).toBe(before + 3)
    expect(run(clone(origin), { ...secrets, event: "pull_request" }).statuses).toEqual({
      "test-a": "hit",
      "test-b": "hit",
      lint: "ran"
    })

    // A repository with no read token gives a pull request no token: never the one that writes. A push is given it.
    const tokenLine = stepsOf(a).find((entry) => entry.run?.includes("smthrs ci"))?.env?.["SMITHERS_CACHE_TOKEN"]
    expect(evaluate(tokenLine as string, { token: writeToken, event: "pull_request" })).toBe("")
    expect(evaluate(tokenLine as string, { token: writeToken, event: "push" })).toBe(writeToken)
    expect(evaluate(tokenLine as string, { token: writeToken, readToken: "r", event: "push" })).toBe(writeToken)
  }, slow)

  it("refuses a wrong token: the run reuses nothing, stores nothing and still passes", async () => {
    const { url, readToken, writeToken, stored, log } = hosted()
    const origin = await applied(sources("refuses"), ["--cache", url])
    expect(run(clone(origin), { token: writeToken }).statuses).toEqual(allRan)
    const before = stored()

    const wrong = "not-the-token-0123456789abcdef"
    const refused = run(clone(origin), { token: wrong })
    expect(refused.code, refused.output).toBe(0)
    expect(refused.statuses).toEqual(allRan)
    expect(refused.output).toContain("HTTP 401")
    expect(refused.output).not.toContain(wrong)
    expect(stored()).toBe(before)
    // The results were there for the right token.
    expect(run(clone(origin), { token: readToken }).statuses).toEqual({
      "test-a": "hit",
      "test-b": "hit",
      lint: "ran"
    })

    const ask = (method: string, bearer: string | undefined): Promise<number> =>
      fetch(`${url}/ac/${"0".repeat(64)}`, {
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
    expect(await ask("GET", readToken)).toBe(404)
    expect(await ask("PUT", readToken)).toBe(403)
    // The service printed neither token. `includes` keeps a token out of a failure's message.
    expect(log().includes(readToken)).toBe(false)
    expect(log().includes(writeToken)).toBe(false)
  }, slow)

  it("stores only a step that ran held to the files it names", async () => {
    const { url, readToken, writeToken, stored } = hosted()
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
    const leaking = await applied(files, ["--cache", url])
    const before = stored()
    const outcome = run(clone(leaking), { token: writeToken })
    // Held to package a's files it cannot read b's, so it fails and nothing is stored for it. The lint step passes
    // and may read any file, so it is never stored either: only b's step is.
    expect(outcome.statuses).toEqual({ "test-a": "failed", "test-b": "ran", lint: "ran" })
    expect(outcome.code).not.toBe(0)
    expect(stored()).toBe(before + 1)
    expect(run(clone(leaking), { token: readToken }).statuses).toEqual({
      "test-a": "failed",
      "test-b": "hit",
      lint: "ran"
    })
  }, slow)

  it("runs with no cache settings and says so in one line, then uses the variable and the secret", async () => {
    const { url, readToken, writeToken, stored } = hosted()
    // Set up with no URL: only the repository's variable names the cache.
    const plain = await applied(sources("unset"), [])
    const notice = stepsOf(plain).find((entry) => entry.name === "Shared cache") as WorkflowStep
    // The step runs only while the variable is not set, and prints one line.
    expect(evaluate(notice.if as string, {})).toBe("true")
    expect(evaluate(notice.if as string, { variable: url })).toBe("")
    const said = spawnSync("bash", ["-c", notice.run as string], { encoding: "utf8" })
    expect(said.stdout).toBe(`${noSharedCache}\n`)

    // Neither set: every step runs, nothing is asked of any cache, and the run passes.
    const before = stored()
    const alone = run(clone(plain), {})
    expect(alone.given).toEqual({ SMITHERS_CACHE_URL: "", SMITHERS_CACHE_TOKEN: "" })
    expect(alone.code, alone.output).toBe(0)
    expect(alone.statuses).toEqual(allRan)
    expect(alone.output).not.toContain("remote cache")
    expect(stored()).toBe(before)

    // The variable set and no secret: one line, and no cache.
    const tokenless = run(clone(plain), { variable: url })
    expect(tokenless.code, tokenless.output).toBe(0)
    expect(tokenless.statuses).toEqual(allRan)
    expect(tokenless.output).toContain("remote cache off: no credentials")
    expect(stored()).toBe(before)

    // Both set: results are stored, and the next clone reuses them.
    expect(run(clone(plain), { variable: url, token: writeToken }).statuses).toEqual(allRan)
    expect(stored()).toBe(before + 2)
    expect(run(clone(plain), { variable: url, token: readToken }).statuses).toEqual({
      "test-a": "hit",
      "test-b": "hit",
      lint: "ran"
    })

    // A cache that does not answer: a warning, and every step runs.
    const silent = run(clone(plain), { variable: `http://127.0.0.1:${await freePort()}`, token: writeToken })
    expect(silent.code, silent.output).toBe(0)
    expect(silent.statuses).toEqual(allRan)
    expect(silent.output).toContain("remote cache disabled after a failure")

    // A URL that is not HTTPS on another machine can never work: the run stops before its first step and says why.
    const plainHttp = run(clone(plain), { variable: "http://cache.example.com", token: writeToken })
    expect(plainHttp.code).not.toBe(0)
    expect(plainHttp.statuses).toEqual({})
    expect(plainHttp.output).toContain("HTTPS")
  }, slow)
})

describe("the hosting page", () => {
  it("names the two files of this repository that the test hosts the cache from", () => {
    const page = readFileSync(join(repositoryRoot, "packages/ci/docs/concepts/cache.md"), "utf8")
    const named = new Set([...page.matchAll(/packages\/smithers\/build\/[\w./-]+/g)].map((match) => match[0]))
    expect(named).toEqual(new Set([relative(repositoryRoot, tables), relative(repositoryRoot, service)]))
    for (const path of named) expect(existsSync(join(repositoryRoot, path)), path).toBe(true)
  })
})
