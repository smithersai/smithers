/**
 * The CI `apply` writes reuses what the replay counted as reused.
 *
 * A runner starts every run with a fresh checkout at the same path, an empty
 * home and an empty temporary directory, and brings one thing along: the
 * directory the workflow caches. Its home is no temporary directory, so the
 * machines of its jobs are kept beside `/tmp`, where a replay keeps them
 * under it. The third ship review's blocker 2: on a runner every step ran
 * again, because what a step left in its machine's temporary directory (the
 * files a job's steps pass their state on with) was kept only under `/tmp`.
 *
 * The real `smthrs` runs the generated workflow's command as a runner does,
 * with the real tracer, so the case runs on a Linux host that has `strace`.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { stateDirectory } from "../../src/generate/Render.ts"
import { probe } from "../../src/replay/Jail.ts"
import { bin, commit, git, head, observes, remove, spawn } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const smthrs = fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))

/** A machine that can give a step a `/tmp` of its own: Linux with a bubblewrap that starts. */
const mounts = !("refusal" in probe())

// The table of the docs: an install, a lint and a test. Only the test reads `data.txt`, and it needs what the
// install left in the checkout and in the home.
const workflow = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: mkdir -p deps && cp lock.txt deps/installed && echo tool > ~/.tool",
  "      - run: grep -q 1 lint.cfg && test -e deps/installed",
  "      - run: grep -q ok data.txt && test -e deps/installed && grep -q tool ~/.tool",
  ""
].join("\n")

const steps = ["//:ci.yml-test-1", "//:ci.yml-test-2", "//:ci.yml-test-3"]

describe("the CI `apply` writes, run as a runner runs it", () => {
  it.skipIf(!observes)("reuses the steps before the one that reads what changed, on a fresh machine", async () => {
    // Beside the temporary directory, as a runner's work directory and home are.
    const base = mkdtempSync("/var/tmp/smithers-ci-applied-reuse-")
    made.push(base)
    const source = join(base, "source")
    mkdirSync(source)
    git(source, "init", "--quiet", "--initial-branch=main")
    commit(source, "base", {
      ".github/workflows/ci.yml": workflow,
      ".gitignore": "deps\n",
      "data.txt": "ok 1\n",
      "docs/readme.md": "# Fixture\n",
      "lint.cfg": "1\n",
      "lock.txt": "locked 1\n"
    })
    const applied = await spawn(bin, ["apply"], source)
    expect(applied.code, applied.stderr).toBe(0)
    commit(source, "apply")
    const generated = readFileSync(join(source, ".github/workflows/smithers-ci.yml"), "utf8")
    // The command of the generated workflow, with the `smthrs` of this checkout in place of the published one.
    const generatedSteps = (parseYaml(generated) as {
      readonly jobs: { readonly ci: { readonly steps: ReadonlyArray<{ readonly run?: string }> } }
    }).jobs.ci.steps
    const command = String(generatedSteps.find((one) => String(one.run).includes("smthrs ci"))?.run)
    expect(/smthrs ci (.*)$/.exec(command)?.[1]).toBe(`'//...' --cache-dir "${stateDirectory}"`)
    const before = head(source)
    commit(source, "data changed", { "data.txt": "ok 2\n" })
    const after = head(source)

    // What the workflow caches from run to run.
    const state = join(base, "state", "smithers-ci")
    let runs = 0
    /** One run of the workflow at a commit: each step's status, by its label. */
    const run = (sha: string): Record<string, string> => {
      // A fresh clone at the same path and an empty home, with the variables a runner sets.
      const checkout = join(base, "run")
      const home = join(base, "home")
      remove(checkout)
      remove(home)
      mkdirSync(home)
      git(base, "clone", "--quiet", source, checkout)
      git(checkout, "checkout", "--quiet", "-B", "main", sha)
      runs += 1
      const ran = spawnSync(
        process.execPath,
        [smthrs, "ci", "//...", "--format", "json", "--cache-dir", state],
        {
          cwd: checkout,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            HOME: home,
            CI: "true",
            GITHUB_ACTIONS: "true",
            GITHUB_SHA: sha,
            GITHUB_REF: "refs/heads/main",
            GITHUB_REF_NAME: "main",
            GITHUB_EVENT_NAME: "push",
            GITHUB_RUN_ID: String(7_000 + runs),
            GITHUB_RUN_NUMBER: String(runs),
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_REPOSITORY: "example/applied-reuse",
            GITHUB_WORKSPACE: checkout,
            RUNNER_TEMP: join(base, "runner-temp"),
            RUNNER_OS: "Linux",
            NODE_COMPILE_CACHE: join(state, "node-compile-cache"),
            ...(mounts ? { SMTHRS_MACHINE_OWN_TMP: "required" } : {})
          }
        }
      )
      expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0)
      const record = JSON.parse(ran.stdout) as {
        readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
      }
      return Object.fromEntries(record.results.map((result) => [result.label, result.status]))
    }

    expect(run(before)).toEqual(Object.fromEntries(steps.map((step) => [step, "ran"])))
    // Only the test reads the changed file. The install and the lint are answered from their records, and what
    // they left is put back for the test: the checkout, the home and the job's own state.
    expect(run(after)).toEqual({ [steps[0]!]: "hit", [steps[1]!]: "hit", [steps[2]!]: "ran" })
    // Nothing changed since: no step runs.
    expect(run(after)).toEqual(Object.fromEntries(steps.map((step) => [step, "hit"])))
  }, 540_000)
})
