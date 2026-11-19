import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Reasons from "../src/contract/Reasons.ts"
import {
  Closure,
  Command,
  Inventory,
  Parts,
  Plan,
  ReplayReport,
  RunRecord,
  Selection,
  Shard,
  TargetMap
} from "../src/index.ts"

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

describe("contract 1: run record", () => {
  it("decodes the real rc.18 workspace-targets run: 721 targets, no cache hits", () => {
    const record = Schema.decodeUnknownSync(RunRecord.RunRecord)(fixture("run-record.rc18-workspace-targets.json"))
    expect(record.ok).toBe(false)
    expect(record.results).toHaveLength(721)
    expect(record.counts).toEqual({ hit: 0, ran: 692, failed: 22, skipped: 7 })
    expect(record.results.filter((result) => RunRecord.verdictOf(result) === "fail")).toHaveLength(22)
  })

  it("refuses a status outside hit, ran, failed and skipped", () => {
    const result = { label: "//a:test", status: "passed", key: "k", durationMs: 1 }
    expect(() => Schema.decodeUnknownSync(RunRecord.TargetResult)(result)).toThrow()
  })

  it("labels a target from its attempts as the paper does", () => {
    const base = { label: "//a:test", key: "k", durationMs: 1 }
    const attempt = (passed: boolean) => ({ passed, durationMs: 1 })
    expect(RunRecord.verdictOf({ ...base, status: "skipped", skipReason: "predicted-safe" })).toBe("skipped")
    expect(RunRecord.verdictOf({ ...base, status: "ran" })).toBe("pass")
    expect(RunRecord.verdictOf({ ...base, status: "hit" })).toBe("pass")
    expect(RunRecord.verdictOf({ ...base, status: "failed" })).toBe("fail")
    expect(RunRecord.verdictOf({ ...base, status: "ran", attempts: [attempt(true)] })).toBe("pass")
    expect(RunRecord.verdictOf({ ...base, status: "failed", attempts: [attempt(false), attempt(false)] })).toBe("fail")
    expect(RunRecord.verdictOf({ ...base, status: "ran", attempts: [attempt(false), attempt(true)] })).toBe("flaky")
  })
})

describe("contract 2: plan", () => {
  it("decodes the plan `smthrs generate package --plan` printed", () => {
    const plan = Schema.decodeUnknownSync(Plan.Plan)(fixture("plan.generate-package.json"))
    expect(plan.targets.map((target) => target.label)).toEqual(plan.roots)
    expect(plan.targets[0]?.cacheable).toBe(false)
  })
})

describe("contract 4: inventory", () => {
  it("holds a Zig repository driven by a Justfile and a Bun monorepo driven by GitHub Actions in one shape", () => {
    const decode = Schema.decodeUnknownSync(Inventory.Inventory)
    const zig = decode(fixture("inventory.justfile-zig.json"))
    const bun = decode(fixture("inventory.github-actions-bun.json"))
    expect(zig.jobs.map((job) => job.source)).toEqual(["justfile", "justfile"])
    expect(zig.jobs[0]?.needs).toEqual(["justfile:build"])
    expect(bun.jobs[0]?.matrix).toHaveLength(2)
    expect(bun.jobs[0]?.steps[1]?.secrets).toEqual(["CODECOV_TOKEN"])
    expect(JSON.stringify(bun)).not.toContain("secretValue")
  })

  it("names the variable a secret arrives in, and holds what belongs to a file and to no job", () => {
    const bun = Schema.decodeUnknownSync(Inventory.Inventory)(fixture("inventory.github-actions-bun.json"))
    expect(bun.jobs[0]?.steps[1]?.secretEnv).toEqual({ CODECOV_TOKEN: "CODECOV_TOKEN" })
    expect(bun.unsupported?.map((entry) => entry.feature)).toEqual(["malformed-file"])
    const zig = Schema.decodeUnknownSync(Inventory.Inventory)(fixture("inventory.justfile-zig.json"))
    expect(zig.unsupported).toBeUndefined()
    expect(Inventory.shell).toEqual(["bash", "-e", "-c"])
  })

  it("names the job a workflow step sets a tool up for, and the action that does it", () => {
    const bun = Schema.decodeUnknownSync(Inventory.Inventory)(fixture("inventory.github-actions-bun.json"))
    // A file that pins a tool belongs to no job.
    expect(bun.toolchains[0]).toEqual({ name: "bun", source: "package.json", version: "1.3.0" })
    expect(bun.toolchains[1]).toEqual({
      name: "bun",
      source: ".github/workflows/ci.yml",
      version: "1.3.0",
      job: "ci.yml:test",
      action: "oven-sh/setup-bun@v2"
    })
  })

  it("holds what one machine makes of an inventory: a tool at another version, and a tool to install", () => {
    const decode = Schema.decodeUnknownSync(Inventory.Inventory)
    const bun = decode(fixture("inventory.github-actions-bun.json"))
    // An inventory read for no machine says nothing about one.
    expect(bun.toolVersions).toBeUndefined()
    const toolVersions = [{ job: "ci.yml:test", tool: "bun", asked: "1.3.0", found: "1.4.2" }]
    expect(decode({ ...fixture("inventory.github-actions-bun.json") as object, toolVersions }).toolVersions).toEqual(
      toolVersions
    )
    expect(() => decode({ ...bun, toolVersions: [{ job: "ci.yml:test", tool: "bun", asked: "1.3.0" }] })).toThrow()
    // The replay report carries the same list, so both versions appear beside the times.
    const report = Schema.decodeUnknownSync(ReplayReport.ReplayReport)({
      ...(fixture("replay-report.example.json") as object),
      toolVersions
    })
    expect(report.toolVersions).toEqual(toolVersions)
    expect(
      Schema.decodeUnknownSync(ReplayReport.ReplayReport)(fixture("replay-report.example.json")).toolVersions
    ).toBeUndefined()
    expect(Inventory.missingTool).toBe("missing-tool")
    expect(Inventory.reasonsText([
      { feature: "condition", detail: "a" },
      { feature: Inventory.missingTool, detail: "go 1.23" },
      { feature: "condition", detail: "b" },
      { feature: Inventory.missingTool, detail: "ruby 3.4.6" },
      { feature: Inventory.missingTool, detail: "go 1.23" }
    ])).toBe("condition, missing-tool (go 1.23, ruby 3.4.6)")
    expect(Inventory.reasonsText([])).toBe("")
  })

  it("leaves out a job that starts a container program until the person allows Docker", () => {
    const decode = Schema.decodeUnknownSync(Inventory.Inventory)
    const base = fixture("inventory.github-actions-bun.json") as {
      readonly jobs: ReadonlyArray<Record<string, unknown>>
    }
    const runs = { feature: Inventory.docker, detail: "runs docker compose" }
    const hosted = { feature: "services", detail: "test runs service containers" }
    const first = base.jobs[0] as { readonly unsupported: ReadonlyArray<unknown> }
    const read = decode({ ...base, jobs: [{ ...first, unsupported: [...first.unsupported, runs, hosted] }] })
    expect(Inventory.docker).toBe("docker")
    // The feature words name what the job runs; the sentence adds what a person does to have it replayed.
    const reasons = (read.jobs[0]?.unsupported ?? []).filter((entry) => ["docker", "services"].includes(entry.feature))
    expect(Inventory.reasonsText(reasons)).toBe("docker (runs docker compose), services")
    expect(Reasons.reasonsSentence(reasons)).toBe(
      "runs docker compose, and a container daemon can reach every file of this machine; " +
        "pass --allow-docker to replay it; needs service containers, which only GitHub starts; " +
        "the job stays in your CI as it is"
    )
    expect(Inventory.blockers(read.jobs[0] as Inventory.Job).map((entry) => entry.feature)).toContain("docker")
    // Allowing Docker takes that one reason away, from a copy: every other reason stays, and the reading is as it was.
    const allowed = Inventory.allowingDocker(read)
    const left = (allowed.jobs[0]?.unsupported ?? []).map((entry) => entry.feature)
    expect(left).not.toContain("docker")
    expect(left).toContain("services")
    expect(left).toHaveLength((read.jobs[0]?.unsupported ?? []).length - 1)
    expect((read.jobs[0]?.unsupported ?? []).map((entry) => entry.feature)).toContain("docker")
    expect(Inventory.allowingDocker(allowed)).toEqual(allowed)
  })

  it("names the cache credentials a kept job runs without, for the report", () => {
    const decode = Schema.decodeUnknownSync(Inventory.Inventory)
    const job = (
      id: string,
      withheld: ReadonlyArray<string> | undefined,
      unsupported: ReadonlyArray<unknown> = []
    ) => ({
      id,
      source: "github-actions",
      file: ".github/workflows/ci.yml",
      name: id,
      needs: [],
      triggers: ["pull_request"],
      matrix: [],
      steps: [{
        id: `${id}:1`,
        command: "pnpm turbo run lint",
        cwd: "",
        env: {},
        secrets: [],
        ...(withheld === undefined ? {} : { withheld })
      }],
      unsupported
    })
    const read = decode({
      version: 1,
      repository: "r",
      commit: "c",
      toolchains: [],
      jobs: [
        job("lint", ["TURBO_TOKEN", "TURBO_TEAM"]),
        job("tsc", ["TURBO_TOKEN"]),
        job("plain", undefined),
        // A job that is not run names nothing: no time of it is in the report.
        job("deploy", ["NX_CLOUD_ACCESS_TOKEN"], [{ feature: "environment", detail: "deploys" }])
      ]
    })
    expect(read.jobs[0]?.steps[0]?.withheld).toEqual(["TURBO_TOKEN", "TURBO_TEAM"])
    expect(Inventory.withheldOf(read)).toEqual(["TURBO_TEAM", "TURBO_TOKEN"])
    expect(Inventory.withheldOf({ ...read, jobs: [read.jobs[2]!] })).toEqual([])
    expect(() => decode({ ...read, jobs: [job("bad", [""])] })).toThrow()
    const report = Schema.decodeUnknownSync(ReplayReport.ReplayReport)({
      ...(fixture("replay-report.example.json") as object),
      withheld: ["TURBO_TEAM", "TURBO_TOKEN"]
    })
    expect(report.withheld).toEqual(["TURBO_TEAM", "TURBO_TOKEN"])
  })

  it("says in one line that every CI job runs on another system, and where to run instead", () => {
    const decode = Schema.decodeUnknownSync(Inventory.Inventory)
    const elsewhere = (runsOn: string, matrix: ReadonlyArray<Record<string, string>> = []) => (id: string) => ({
      id,
      source: "github-actions",
      file: ".github/workflows/main.yml",
      name: id,
      needs: [],
      triggers: ["push"],
      matrix,
      runsOn,
      steps: [{ id: `${id}:1`, command: "npm test", cwd: "", env: {}, secrets: [] }],
      unsupported: [{ feature: Inventory.otherSystem, detail: `${id} runs on another system` }]
    })
    const read = (...jobs: ReadonlyArray<unknown>) =>
      decode({ version: 1, repository: "r", commit: "c", toolchains: [], jobs })
    expect(Inventory.refusal(read(elsewhere("macos-latest")("test"), elsewhere("macos-15")("browser")))).toBe(
      "every CI job of this repository runs on macOS; run smithers-ci on a Mac"
    )
    expect(Inventory.refusal(read(elsewhere("ubuntu-latest")("test")))).toBe(
      "every CI job of this repository runs on Linux; run smithers-ci on Linux"
    )
    expect(Inventory.refusal(read(elsewhere("windows-latest")("test")))).toBe(
      "every CI job of this repository runs on Windows; smithers-ci runs on Linux and macOS"
    )
    // A job that runs only on Windows is for another system whatever else is said of it: no machine is Windows.
    const powershell = {
      ...elsewhere("windows-latest")("test"),
      steps: [],
      unsupported: [{ feature: "shell", detail: "test step 1 runs in PowerShell on Windows" }]
    }
    expect(Inventory.refusal(read(powershell))).toBe(
      "every CI job of this repository runs on Windows; smithers-ci runs on Linux and macOS"
    )
    const both = elsewhere("${{ matrix.os }}", [{ os: "windows-latest" }, { os: "macos-latest" }])("test")
    expect(Inventory.refusal(read(both, elsewhere("windows-2025")("pack")))).toBe(
      "every CI job of this repository runs on macOS or Windows; run smithers-ci on a Mac"
    )
    // One job left out for another reason alone, and the answer is the list.
    const blocked = { ...elsewhere("ubuntu-latest")("lint"), unsupported: [{ feature: "uses", detail: "an action" }] }
    expect(Inventory.refusal(read(elsewhere("macos-latest")("test"), blocked))).toBe(
      "0 of 2 CI jobs can be reproduced on this machine\n  test  runs only on another operating system; run smithers-ci on that system\n  lint  uses the action with no command, which Smithers CI does not run"
    )
    // A macOS job that also receives a secret would not run on a Mac either: the list says both.
    const guarded = {
      ...elsewhere("macos-latest")("deploy"),
      unsupported: [
        { feature: Inventory.otherSystem, detail: "deploy runs on macOS" },
        { feature: "secret", detail: "deploy:1 receives TOKEN" }
      ]
    }
    expect(Inventory.refusal(read(elsewhere("macos-latest")("test"), guarded))).toBe(
      "0 of 2 CI jobs can be reproduced on this machine\n  test    runs only on another operating system; run smithers-ci on that system\n  deploy  runs only on another operating system; run smithers-ci on that system; receives the secret TOKEN, which a replay never has"
    )
    // A job that waits for a job on that system runs there with it.
    const after = { ...elsewhere("macos-latest")("after"), needs: ["test"] }
    expect(Inventory.refusal(read(elsewhere("macos-latest")("test"), after))).toBe(
      "every CI job of this repository runs on macOS; run smithers-ci on a Mac"
    )
    const tool = {
      ...elsewhere("ubuntu-latest")("build"),
      unsupported: [{ feature: Inventory.missingTool, detail: "ruby 3.4.6" }]
    }
    expect(Inventory.refusal(read(tool))).toBe(
      "0 of 1 CI job can be reproduced on this machine\n  build  needs ruby 3.4.6, which this machine does not have; install it and run smithers-ci again"
    )
  })

  it("fills one matrix variant into a step's command, directory and environment values", () => {
    const step: Inventory.Step = {
      id: "ci.yml:test:1",
      command: "bun test --shard=${{ matrix.shard }}/4 # ${{matrix.node.version}} ${{ matrix.absent }}",
      cwd: "packages/${{ matrix.package }}",
      env: { NODE: "${{ matrix.node.version }}", PLAIN: "${{ secrets.TOKEN }}" },
      secrets: []
    }
    const variant = { shard: "2", "node.version": "22", package: "core" }
    expect(Inventory.withVariant(step, variant)).toEqual({
      ...step,
      command: "bun test --shard=2/4 # 22 ${{ matrix.absent }}",
      cwd: "packages/core",
      env: { NODE: "22", PLAIN: "${{ secrets.TOKEN }}" }
    })
    expect(Inventory.expand("${{ matrix.constructor }} ${{ matrix.toString }}", {}))
      .toBe("${{ matrix.constructor }} ${{ matrix.toString }}")
    expect(Inventory.withVariant(step, {})).toEqual(step)
  })

  it("runs a step with runner text as that text, then the runner's function with the command as its one word", () => {
    const command = `echo "it's" \${{ matrix.n }}`
    const plain: Inventory.Step = { id: "ci:1", command, cwd: "", env: {}, secrets: [] }
    expect(Inventory.script(plain)).toBe(command)
    const step = { ...plain, runner: `${Inventory.runnerEntry}() { echo '\${{ matrix.n }}'; bash -e -c "$1"; }` }
    expect(Schema.decodeUnknownSync(Inventory.Step)(step)).toEqual(step)
    // A matrix value is filled into the runner text as it is into the command.
    const filled = Inventory.withVariant(step, { n: "2" })
    expect(filled.runner).toBe(`${Inventory.runnerEntry}() { echo '2'; bash -e -c "$1"; }`)
    const run = `${filled.runner}\n${Inventory.runnerEntry} 'echo "it'\\''s" 2'`
    // Two lines tell the runner text what only its caller knows: no job, and a step that is whole.
    expect(Inventory.script(filled)).toBe(`__smithers_ci_unit=''\n__smithers_ci_part=\n${run}`)
    const [program, ...flags] = Inventory.shell
    const ran = spawnSync(program, [...flags, Inventory.script(filled)], { encoding: "utf8" })
    expect(ran.stdout).toBe("2\nit's 2\n")
    // A baseline names the job, and a step split from another says so.
    expect(Inventory.script({ ...filled, from: "ci:0" }, "ci.yml:it's")).toBe(
      `__smithers_ci_unit='ci.yml:it'\\''s'\n__smithers_ci_part=1\n${run}`
    )
    const told = { ...filled, runner: `${Inventory.runnerEntry}() { echo "$__smithers_ci_unit $__smithers_ci_part"; }` }
    const heard = spawnSync(program, [...flags, Inventory.script({ ...told, from: "ci:0" }, "ci.yml:it's")], {
      encoding: "utf8"
    })
    expect(heard.stdout).toBe("ci.yml:it's 1\n")
  })

  it("knows a step that reads the commit by the note in its runner text", () => {
    const step = { runner: `${Inventory.runnerEntry}() {\n${Inventory.commitNote}\nbash -e -c "$1"\n}` }
    expect(Inventory.readsCommit(step)).toBe(true)
    // The note is a line of its own: a script that happens to hold the words is not one.
    expect(Inventory.readsCommit({ runner: `echo '${Inventory.commitNote}'` })).toBe(false)
    expect(Inventory.readsCommit({})).toBe(false)
  })

  // "Default environment variables": the commit, and the run's id, number and attempt, are another at every run.
  it("names what a run gives every step, and what a replay gives for a commit", () => {
    expect(Inventory.runVariables).toEqual([
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_NUMBER",
      "GITHUB_SHA",
      "GITHUB_WORKFLOW_SHA"
    ])
    const commit = "0123456789abcdef0123456789abcdef01234567"
    const given = Inventory.runValues(commit, 12)
    expect(Object.keys(given).sort()).toEqual([...Inventory.runVariables])
    expect(given).toEqual({
      GITHUB_RUN_ATTEMPT: "1",
      // The first nine digits of the commit, read as a number.
      GITHUB_RUN_ID: String(0x012345678),
      GITHUB_RUN_NUMBER: "12",
      GITHUB_SHA: commit,
      GITHUB_WORKFLOW_SHA: commit
    })
    // The same commit is the same run, and another commit another.
    expect(Inventory.runValues(commit, 12)).toEqual(given)
    expect(Inventory.runValues(commit.replace("0", "f"), 13).GITHUB_RUN_ID).not.toBe(given.GITHUB_RUN_ID)
  })

  it("gives a step with runner text every variable of a run, and any other step the ones its script names", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567"
    const given = { ...Inventory.runValues(commit, 3), [Inventory.eventsVariable]: "/events" }
    const started = Inventory.script({ command: "npm test", runner: "# what a runner does" })
    expect(Inventory.givenTo(started, given)).toEqual(given)
    // No runner starts this step. It is given what it names as a shell reads a variable, with or without braces.
    expect(Inventory.givenTo("echo \"$GITHUB_SHA\" \"${GITHUB_RUN_NUMBER}\"", given)).toEqual({
      GITHUB_RUN_NUMBER: "3",
      GITHUB_SHA: commit
    })
    // A name that only starts like one, a name with no `$`, and a script that names none: nothing.
    expect(Inventory.givenTo("echo \"$GITHUB_SHA_SHORT\" GITHUB_RUN_ID; printenv GITHUB_SHA", given)).toEqual({})
    expect(Inventory.givenTo(Inventory.script({ command: "just test" }), given)).toEqual({})
  })

  it("writes each event's file for a commit, with the commit and its parent where the marks stand", () => {
    const events = {
      pull_request: JSON.stringify({
        pull_request: { head: { sha: Inventory.commitMark }, base: { sha: Inventory.parentMark } },
        again: Inventory.commitMark
      }),
      push: JSON.stringify({ before: Inventory.parentMark, after: Inventory.commitMark })
    }
    const files = Inventory.eventFiles(events, "c".repeat(40), "p".repeat(40))
    expect(files.map(([name]) => name)).toEqual(["pull_request.json", "push.json"])
    expect(files.map(([, text]) => JSON.parse(text))).toEqual([
      {
        pull_request: { head: { sha: "c".repeat(40) }, base: { sha: "p".repeat(40) } },
        again: "c".repeat(40)
      },
      { before: "p".repeat(40), after: "c".repeat(40) }
    ])
    expect(files.every(([, text]) => text.endsWith("}\n"))).toBe(true)
    // The first commit of a repository has no parent: an event names forty zeros there.
    const [, first] = Inventory.eventFiles({ push: events.push }, "c".repeat(40), undefined)[0]!
    expect(JSON.parse(first)).toEqual({ before: Inventory.noParent, after: "c".repeat(40) })
    expect(Inventory.noParent).toBe("0".repeat(40))
    expect(Inventory.eventFiles({}, "c".repeat(40), undefined)).toEqual([])
    expect(Inventory.eventsVariable).toBe("SMITHERS_CI_EVENTS")
  })

  it("holds each event's file in an inventory, or none", () => {
    const zig = Schema.decodeUnknownSync(Inventory.Inventory)(fixture("inventory.justfile-zig.json"))
    expect(zig.events).toBeUndefined()
    const events = { push: JSON.stringify({ after: Inventory.commitMark }) }
    const decoded = Schema.decodeUnknownSync(Inventory.Inventory)({ ...zig, events })
    expect(decoded.events).toEqual(events)
    expect(() => Schema.decodeUnknownSync(Inventory.Inventory)({ ...zig, events: { push: 1 } })).toThrow()
  })

  it("runs a job only when it has a step and exits", () => {
    const zig = Schema.decodeUnknownSync(Inventory.Inventory)(fixture("inventory.justfile-zig.json"))
    const job = zig.jobs[0]!
    expect(Inventory.isRunnable(job)).toBe(true)
    expect(Inventory.isRunnable({ ...job, steps: [] })).toBe(false)
    const server = { feature: Inventory.longRunning, detail: "bun run dev never exits" }
    expect(Inventory.isRunnable({ ...job, unsupported: [server] })).toBe(false)
    const cache = { feature: Inventory.hostAction, detail: "actions/cache@v4 has no command to run" }
    const filter = { feature: Inventory.triggerFilter, detail: "push runs only for matching branches" }
    expect(Inventory.isRunnable({ ...job, unsupported: [cache, filter] })).toBe(true)
  })

  it("refuses a source it does not know", () => {
    const zig = fixture("inventory.justfile-zig.json") as { jobs: Array<{ source: string }> }
    zig.jobs[0]!.source = "jenkins"
    expect(() => Schema.decodeUnknownSync(Inventory.Inventory)(zig)).toThrow()
  })
})

describe("contract 5: replay report", () => {
  it("decodes a report whose fast mode skipped a target that failed in the baseline", () => {
    const report = Schema.decodeUnknownSync(ReplayReport.ReplayReport)(fixture("replay-report.example.json"))
    expect(report.speedup).toBeCloseTo(report.baselineWallMs / report.normalWallMs)
    expect(report.mismatches).toBe(report.commits.flatMap((commit) => commit.mismatches).length)
    expect(report.commits[1]?.mismatches[0]).toEqual({
      label: "//packages/core:test",
      mode: "fast",
      baseline: "fail",
      got: "skipped"
    })
  })

  it("lists each target fast mode skipped with the model's score and reason, and what asking the model cost", () => {
    const document = fixture("replay-report.example.json") as { readonly commits: ReadonlyArray<object> }
    const report = Schema.decodeUnknownSync(ReplayReport.ReplayReport)(document)
    const skips = report.commits.flatMap((commit) => commit.skipped ?? [])
    expect(skips).toHaveLength(7)
    expect(skips.every((skip) => skip.skipReason === "predicted-safe")).toBe(true)
    // The target that failed in the baseline is a skip and a mismatch: a skip is never a pass.
    expect(report.commits[1]?.skipped?.map((skip) => skip.label)).toContain(report.commits[1]?.mismatches[0]?.label)
    expect(report.model).toEqual({ ms: 33_000, questions: 9 })
    expect(report.model?.ms).toBe(report.commits.reduce((total, commit) => total + (commit.model?.ms ?? 0), 0))
    for (const commit of report.commits) expect(commit.fast!.wallMs).toBeGreaterThan(commit.model!.ms)
    // A skip in this list has one reason, and a target has a label.
    const withSkip = (skip: object) => ({ ...document, commits: [{ ...document.commits[0], skipped: [skip] }] })
    expect(() =>
      Schema.decodeUnknownSync(ReplayReport.ReplayReport)(
        withSkip({ label: "//a:test", skipReason: "dependency-failed" })
      )
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ReplayReport.ReplayReport)(withSkip({ label: "", skipReason: "predicted-safe" }))
    ).toThrow()
    expect(
      Schema.decodeUnknownSync(ReplayReport.ReplayReport)(withSkip({ label: "//a:test", skipReason: "predicted-safe" }))
        .commits[0]?.skipped
    ).toEqual([{ label: "//a:test", skipReason: "predicted-safe" }])
  })

  it("decodes a report whose fast mode could not be measured, which holds no fast-mode number", () => {
    const document = fixture("replay-report.fast-not-measured.json")
    const report = Schema.decodeUnknownSync(ReplayReport.ReplayReport)(document)
    expect(report.fastNotMeasured).toContain("could not be reached")
    expect(report.fastWallMs).toBeUndefined()
    expect(report.selection).toBeUndefined()
    expect(report.commits.every((commit) => commit.fast === undefined)).toBe(true)
    expect(report.commits.flatMap((commit) => commit.mismatches).filter((each) => each.mode === "fast")).toEqual([])
    expect(() => Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...(document as object), fastNotMeasured: "" }))
      .toThrow()
  })
})

describe("contract 6: selection", () => {
  const rows = Schema.decodeUnknownSync(Schema.Array(Selection.Row))(fixture("selection-rows.example.json"))
  const score = (commit: string, target: string, value: number): Selection.Score => ({ commit, target, score: value })

  it("has default settings that decode", () => {
    expect(Schema.decodeUnknownSync(Selection.Settings)(Selection.defaultSettings)).toEqual({
      scoreCutoff: 0.1,
      countCutoff: 5
    })
  })

  it("refuses a score outside 0 to 1", () => {
    expect(() => Schema.decodeUnknownSync(Selection.Score)(score("c1", "//a:test", 1.5))).toThrow()
    expect(() => Schema.decodeUnknownSync(Selection.Settings)({ scoreCutoff: 0.5, countCutoff: -1 })).toThrow()
  })

  it("selects every target at or above the cutoff, plus the highest-scoring few", () => {
    const scores = [score("c1", "//a:test", 0.9), score("c1", "//b:test", 0.2), score("c1", "//c:test", 0.2)]
    expect(Selection.select(scores, { scoreCutoff: 0.5, countCutoff: 0 })).toEqual(["//a:test"])
    expect(Selection.select(scores, { scoreCutoff: 0.2, countCutoff: 0 })).toEqual(["//a:test", "//b:test", "//c:test"])
    expect(Selection.select(scores, { scoreCutoff: 1, countCutoff: 2 })).toEqual(["//a:test", "//b:test"])
    expect(Selection.select([...scores].reverse(), { scoreCutoff: 1, countCutoff: 2 })).toEqual([
      "//a:test",
      "//b:test"
    ])
    expect(Selection.select(scores, { scoreCutoff: 1, countCutoff: 0 })).toEqual([])
  })

  it("computes test recall, change recall and selection rate as the paper defines them", () => {
    const caughtOne = new Map([["c1", ["//a:test", "//c:test"]]])
    expect(Selection.metrics(rows, caughtOne)).toEqual({
      rows: 5,
      selected: 2,
      failures: 2,
      failedChanges: 2,
      selectionRate: 2 / 5,
      testRecall: 1 / 2,
      changeRecall: 1 / 2
    })
    const everything = new Map([["c1", ["//a:test", "//b:test", "//c:test"]], ["c2", ["//a:test"]], ["c3", [
      "//b:test"
    ]]])
    expect(Selection.metrics(rows, everything)).toMatchObject({ selectionRate: 1, testRecall: 1, changeRecall: 1 })
  })

  it("never counts a flaky row as a failure, and reports no recall when nothing failed", () => {
    const flakyOnly = rows.filter((row) => row.flaky || row.commit === "c2")
    expect(Selection.metrics(flakyOnly, new Map())).toEqual({
      rows: 2,
      selected: 0,
      failures: 0,
      failedChanges: 0,
      selectionRate: 0
    })
    expect(Selection.metrics([], new Map())).toMatchObject({ rows: 0, selectionRate: 0 })
  })
})

describe("contract 7: command surface", () => {
  it("runs a read-only report with no command, and lists every flag on a command that exists", () => {
    expect(Command.name).toBe("smithers-ci")
    expect(Command.commands[""]).toContain("Writes nothing")
    const known = Object.keys(Command.commands)
    for (const flag of Object.values(Command.flags)) {
      for (const command of flag.on) expect(known).toContain(command)
    }
    expect(new Set(Object.values(Command.exitCodes)).size).toBe(Object.keys(Command.exitCodes).length)
  })

  it("gives every exit code a meaning and every part failure an exit code that is never ok or mismatch", () => {
    expect(Object.keys(Command.exitCodeHelp)).toEqual(Object.keys(Command.exitCodes))
    const codes = Object.values(Command.exitCodes) as ReadonlyArray<number>
    for (const code of Parts.Failure.fields.code.literals) {
      const exit = Command.failureExitCodes[code]
      expect(codes).toContain(exit)
      expect(exit).toBeGreaterThan(Command.exitCodes.mismatch)
    }
    expect(Command.failureExitCodes["command-failed"]).toBe(Command.exitCodes.failed)
  })

  it("names the document --json prints for exactly the commands that accept --json", () => {
    expect(Object.keys(Command.documents).sort()).toEqual([...Command.flags.json.on].sort())
    expect(Command.syntax.help).toContain("--help")
    expect(Command.syntax.value).toContain("--commits 5")
    // A person allows Docker for a replay, and for the files `apply` writes from what the replay measured.
    expect(Command.flags["allow-docker"].on).toEqual(["", "replay", "apply"])
    expect(Command.flags["allow-docker"].default).toBe("false")
    expect(Command.flags["allow-docker"].help).toContain("every file of this machine")
    expect(Command.syntax.value).toContain("`--check` and `--allow-docker` take no value")
    expect(Object.keys(Command.environment)).toEqual(
      expect.arrayContaining([
        "PATH",
        "SMITHERS_CACHE_TOKEN",
        "AI_GATEWAY_API_KEY",
        "ANTHROPIC_API_KEY",
        "SMITHERS_OPENAI_AUTH"
      ])
    )
  })
})

describe("contract 8: shards", () => {
  const labels = Array.from({ length: 200 }, (_, index) => `//packages/p${index}:test`)

  it("puts every label in exactly one shard, the same one on every call", () => {
    const shards = [0, 1, 2, 3].map((index) => Shard.labelsOf(labels, { index, count: 4 }))
    expect(shards.flat().sort()).toEqual([...labels].sort())
    expect(shards.every((shard) => shard.length > 20)).toBe(true)
    expect(Shard.shardOf("//packages/smithers:test", 4)).toBe(Shard.shardOf("//packages/smithers:test", 4))
    expect(Shard.labelsOf(labels, { index: 0, count: 1 })).toEqual(labels)
  })

  it("balances measured labels longest first and leaves unmeasured ones where the hash puts them", () => {
    const durations = { "//a:test": 40, "//b:test": 30, "//c:test": 20, "//d:test": 10, "//e:test": 10 }
    const labels = [...Object.keys(durations), "//f:lint", "//g:lint", "//a:test"]
    const assigned = Shard.assign(labels, 2, durations)
    const load = (index: number): number =>
      Object.entries(durations).filter(([label]) => assigned.get(label) === index).reduce((sum, [, ms]) => sum + ms, 0)
    expect([load(0), load(1)]).toEqual([60, 50])
    expect(assigned.get("//a:test")).toBe(0)
    expect(assigned.get("//b:test")).toBe(1)
    expect(assigned.get("//f:lint")).toBe(Shard.shardOf("//f:lint", 2))
    expect(assigned.get("//g:lint")).toBe(Shard.shardOf("//g:lint", 2))
    expect(assigned.size).toBe(7)
    expect([...Shard.assign([...labels].reverse(), 2, durations)].sort()).toEqual([...assigned].sort())
  })

  it("treats a duration that is missing, negative or not a number as unmeasured", () => {
    const labels = ["//a:test", "//b:test", "//c:test", "toString"]
    const durations = { "//a:test": Number.NaN, "//b:test": -5, "//c:test": Number.POSITIVE_INFINITY }
    const assigned = Shard.assign(labels, 3, durations)
    for (const label of labels) expect(assigned.get(label)).toBe(Shard.shardOf(label, 3))
  })

  it("refuses a shard count below one", () => {
    expect(() => Schema.decodeUnknownSync(Shard.Shard)({ index: 0, count: 0 })).toThrow()
  })
})

describe("contract 9: dependency closure", () => {
  const closure: Closure.Closure = {
    strategy: "typescript",
    entries: ["src/a.test.ts"],
    files: [{ path: "src/a.test.ts", digest: "d1" }, { path: "src/a.ts", digest: "d2" }],
    packages: ["effect"],
    unresolved: [],
    dynamic: []
  }

  it("is affected only by a change to a file it reaches", () => {
    expect(Schema.decodeUnknownSync(Closure.Closure)(closure)).toEqual(closure)
    expect(Closure.isAffectedBy(closure, ["src/a.ts"])).toBe(true)
    expect(Closure.isAffectedBy(closure, ["src/b.ts", "README.md"])).toBe(false)
    expect(Closure.isAffectedBy(closure, [])).toBe(false)
  })

  it("is affected by every change when an import could not be followed", () => {
    const open = { from: "src/a.ts", specifier: "./plugins/" }
    expect(Closure.isComplete(closure)).toBe(true)
    expect(Closure.isAffectedBy({ ...closure, dynamic: [open] }, ["README.md"])).toBe(true)
    expect(Closure.isAffectedBy({ ...closure, unresolved: [open] }, ["README.md"])).toBe(true)
  })
})

describe("contract 10: parts", () => {
  it("names the part and a known reason in every failure", () => {
    const failure = { code: "unsupported", message: "bun install is not supported yet", part: "replay" }
    expect(Schema.decodeUnknownSync(Parts.Failure)(failure)).toEqual(failure)
    expect(() => Schema.decodeUnknownSync(Parts.Failure)({ ...failure, code: "oops" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Parts.Failure)({ ...failure, part: "billing" })).toThrow()
  })
})

describe("contract 10: the parts a replay is handed", () => {
  it("lets the program pass the reader, generator and scorer to a replay, with a cache for the generator", async () => {
    const calls: Array<string> = []
    const fail = (failure: Parts.Failure) => Effect.fail(failure)
    const parts: Parts.ReplayParts = {
      read: (root) => fail({ code: "not-a-repository", message: `${root} has no .git`, part: "inventory" }),
      files: (_inventory, options) => Effect.succeed([{ path: TargetMap.path, content: options?.cache ?? "" }]),
      rows: () => Effect.succeed([]),
      score: () => Effect.succeed([])
    }
    const run: Parts.RunReplay = (request, given) =>
      Effect.gen(function*() {
        calls.push(String(request.settings?.countCutoff ?? Selection.defaultSettings.countCutoff))
        const files = yield* given.files(
          Inventory.ci({ version: 1, repository: "r", commit: "c", toolchains: [], jobs: [] }),
          { cache: request.cache }
        )
        for (const file of files) calls.push(file.path, file.content)
        const exit: number = yield* Effect.match(given.read(request.root), {
          onFailure: (failure) => Command.failureExitCodes[failure.code],
          onSuccess: () => Command.exitCodes.ok
        })
        return yield* fail({ code: "command-failed", message: `exit ${exit}`, part: "replay" })
      })
    const request = { root: "/tmp/x", commits: 1, modes: ["normal" as const], cache: "https://cache.example" }
    const failure = await Effect.runPromise(Effect.flip(run(request, parts)))
    expect(failure.message).toBe("exit 3")
    expect(calls).toEqual(["5", ".smithers/ci-targets.json", "https://cache.example"])
  })
})

describe("contract 11: target map", () => {
  const map = Schema.decodeUnknownSync(TargetMap.TargetMap)(fixture("target-map.example.json"))

  it("finds the target a step became, per matrix variant", () => {
    expect(TargetMap.labelsOf(map, "ci.yml:test", "ci.yml:test:1", { os: "macos-latest" }))
      .toEqual(["//:ci-yml-test-1-os-macos-latest"])
    expect(TargetMap.labelsOf(map, "justfile:build", "justfile:build:1", {})).toEqual(["//:justfile-build-1"])
  })

  it("has no target for a step, job or variant the generator did not write", () => {
    expect(TargetMap.labelsOf(map, "ci.yml:test", "ci.yml:test:2", { os: "macos-latest" })).toEqual([])
    expect(TargetMap.labelsOf(map, "ci.yml:lint", "ci.yml:test:1", { os: "macos-latest" })).toEqual([])
    expect(TargetMap.labelsOf(map, "ci.yml:test", "ci.yml:test:1", { os: "windows-latest" })).toEqual([])
    // A target of a step that was split may say which part of the step it runs.
    const part = { label: "//:a-lint", job: "a", step: "a:1", variant: {}, part: "lint" }
    const parted = Schema.decodeUnknownSync(TargetMap.TargetMap)({ version: 1, targets: [part, { ...map.targets[0] }] })
    expect([...TargetMap.partsOf(parted)]).toEqual([["//:a-lint", "lint"]])
    expect(() => Schema.decodeUnknownSync(TargetMap.Entry)({ ...part, part: "" })).toThrow()
    expect(TargetMap.labelsOf(map, "ci.yml:test", "ci.yml:test:1", {})).toEqual([])
  })

  it("names the machine a job's variant runs on, and none for a job with no machine", () => {
    expect(TargetMap.machineOf(map, "ci.yml:test", { os: "macos-latest" })).toBe("ci.yml:test (os=macos-latest)")
    expect(TargetMap.machineOf(map, "ci.yml:test", { os: "windows-latest" })).toBeUndefined()
    expect(TargetMap.machineOf(map, "justfile:build", {})).toBeUndefined()
    expect(() => Schema.decodeUnknownSync(TargetMap.Entry)({ ...map.targets[0], machine: "" })).toThrow()
  })

  it("reads a variant the same whatever order its keys are in", () => {
    expect(TargetMap.variantKey({ os: "linux", node: "22" })).toBe(TargetMap.variantKey({ node: "22", os: "linux" }))
    expect(TargetMap.variantKey({ os: "linux" })).not.toBe(TargetMap.variantKey({ os: "macos" }))
    expect(TargetMap.path).toBe(".smithers/ci-targets.json")
  })

  it("refuses an entry with no label", () => {
    const entry = { label: "", job: "j", step: "s", variant: {} }
    expect(() => Schema.decodeUnknownSync(TargetMap.Entry)(entry)).toThrow()
  })
})

describe("contract changes, third round", () => {
  const firstRow = (): Selection.Row => {
    const rows = fixture("selection-rows.example.json") as Array<unknown> | { rows: Array<unknown> }
    return Schema.decodeUnknownSync(Selection.Row)((Array.isArray(rows) ? rows : rows.rows)[0])
  }

  it("is affected by any file under a directory the closure reads whole, and by nothing beside it", () => {
    const closure: Closure.Closure = {
      strategy: "zig",
      entries: ["fmt"],
      files: [{ path: "build.zig", digest: "d" }],
      packages: ["zig@0.17.1"],
      unresolved: [],
      dynamic: [],
      directories: ["src", "tools/"]
    }
    expect(Schema.decodeUnknownSync(Closure.Closure)(closure)).toEqual(closure)
    expect(Closure.isAffectedBy(closure, ["src/new.zig"])).toBe(true)
    expect(Closure.isAffectedBy(closure, ["tools/gen/a.zig"])).toBe(true)
    expect(Closure.isAffectedBy(closure, ["build.zig"])).toBe(true)
    expect(Closure.isAffectedBy(closure, ["src2/new.zig", "srcfile", "docs/src/a.zig"])).toBe(false)
  })

  it("holds a row's time, a run's test count and the distance of a target nothing is known to reach", () => {
    const row = firstRow()
    expect(row.at).toBe(1_794_873_600_000)
    expect(
      Schema.decodeUnknownSync(Selection.Row)({ ...row, features: { ...row.features, graphDistance: -1 } })
        .features.graphDistance
    ).toBe(Selection.unreachable)
    const result = { label: "//a:test", status: "ran", key: "k", durationMs: 1, tests: 12 }
    expect(Schema.decodeUnknownSync(RunRecord.TargetResult)(result).tests).toBe(12)
    expect(() => Schema.decodeUnknownSync(RunRecord.TargetResult)({ ...result, tests: -1 })).toThrow()
  })

  it("counts a selection the same when one change has thousands of targets", () => {
    const row = firstRow()
    const rows = Array.from({ length: 4000 }, (_, index) => ({
      ...row,
      commit: "c1",
      target: `//p${index}:test`,
      failed: index % 1000 === 0,
      flaky: false
    }))
    const selected = new Map([["c1", rows.filter((_, index) => index % 2 === 0).map((entry) => entry.target)]])
    expect(Selection.metrics(rows, selected)).toEqual({
      rows: 4000,
      selected: 2000,
      failures: 4,
      failedChanges: 1,
      selectionRate: 0.5,
      testRecall: 1,
      changeRecall: 1
    })
    expect(Selection.metrics(rows, new Map()).selected).toBe(0)
  })

  it("lets a closure strategy fail as a part, and hands a plan to the row builder", async () => {
    const failure = { code: "unsupported", message: "zig 0.12 is too old", part: "closure" }
    expect(Schema.decodeUnknownSync(Parts.Failure)(failure)).toEqual(failure)
    const close: Parts.CloseEntries = (_root, entries) =>
      Effect.succeed(entries.map((entry) => ({
        strategy: "zig",
        entries: [entry],
        files: [],
        packages: [],
        unresolved: [],
        dynamic: []
      })))
    const plan = Schema.decodeUnknownSync(Plan.Plan)(fixture("plan.generate-package.json"))
    const seen: Array<number> = []
    const rows: Parts.BuildRows = (_root, _record, given) =>
      Effect.sync(() => {
        seen.push(given?.targets.length ?? -1)
        return []
      })
    const record = Schema.decodeUnknownSync(RunRecord.RunRecord)(fixture("run-record.rc18-workspace-targets.json"))
    const closures = await Effect.runPromise(close("/repo", ["test", "fmt"]))
    await Effect.runPromise(rows("/repo", record, plan))
    await Effect.runPromise(rows("/repo", record))
    expect(closures.map((closure) => closure.entries)).toEqual([["test"], ["fmt"]])
    expect(seen).toEqual([plan.targets.length, -1])
  })

  it("caps how many generated targets run at once, and names what apply refuses and ignores", () => {
    const map = Schema.decodeUnknownSync(TargetMap.TargetMap)(fixture("target-map.example.json"))
    expect(map.maxJobs).toBe(1)
    expect(() => Schema.decodeUnknownSync(TargetMap.TargetMap)({ ...map, maxJobs: 0 })).toThrow()
    expect(Command.applyRefuses).toEqual([".smithers/WORKSPACE.ts", ".smithers/WORKSPACE.smithers", "WORKSPACE.ts"])
    // Nothing of Smithers CI is in the checkout, so apply has no line to add.
    expect(Command.applyIgnores).toEqual([])
  })
})

describe("contract changes, fourth round: what is CI, and splitting a step", () => {
  const decode = Schema.decodeUnknownSync(Inventory.Inventory)
  const step = (id: string, command: string): Inventory.Step => ({ id, command, cwd: "", env: {}, secrets: [] })
  const job = (
    id: string,
    file: string,
    source: Inventory.Source,
    triggers: ReadonlyArray<string>,
    needs: ReadonlyArray<string> = [],
    commands: ReadonlyArray<string> = ["true"]
  ): Inventory.Job => ({
    id,
    source,
    file,
    name: id,
    needs,
    triggers,
    matrix: [],
    steps: commands.map((command, index) => step(`${id}:${index + 1}`, command)),
    unsupported: []
  })
  const inventory = (jobs: ReadonlyArray<Inventory.Job>): Inventory.Inventory =>
    decode({ version: 1, repository: "r", commit: "c", toolchains: [], jobs })

  it("runs only what a change triggers, never a deploy, a migration or a script nothing calls", () => {
    const all = inventory([
      job("ci.yml:test", ".github/workflows/ci.yml", "github-actions", ["pull_request", "merge_group"], [
        "ci.yml:build"
      ]),
      job("ci.yml:build", ".github/workflows/ci.yml", "github-actions", ["workflow_call"]),
      job("ci.yml:missing-need", ".github/workflows/ci.yml", "github-actions", ["push"], ["ci.yml:gone"]),
      job("release.yml:publish", ".github/workflows/release.yml", "github-actions", ["workflow_dispatch"]),
      job("nightly.yml:soak", ".github/workflows/nightly.yml", "github-actions", ["schedule"]),
      job("package.json:db:cloud:migrate", "package.json", "package-json", []),
      job("package.json:ci", "package.json", "package-json", []),
      job("packages/app/package.json:ios:device:deploy", "packages/app/package.json", "package-json", [])
    ])
    expect(Inventory.ciJobs(all).map((entry) => entry.id)).toEqual([
      "ci.yml:test",
      "ci.yml:build",
      "ci.yml:missing-need"
    ])
  })

  it("falls back to the root `ci` recipe and what it needs when no workflow runs on a change", () => {
    const zig = inventory([
      job("justfile:build", "justfile", "justfile", []),
      job("justfile:test", "justfile", "justfile", [], [], ["zig build test"]),
      job("justfile:tidy", "justfile", "justfile", [], ["justfile:fmt"]),
      job("justfile:fmt", "justfile", "justfile", [], ["justfile:tidy"]),
      job("justfile:clean", "justfile", "justfile", [], [], ["rm -rf zig-out .zig-cache"]),
      job("justfile:ci", "justfile", "justfile", [], ["justfile:tidy", "justfile:test"], []),
      job("tools/justfile:ci", "tools/justfile", "justfile", []),
      job("release.yml:publish", ".github/workflows/release.yml", "github-actions", ["workflow_dispatch"])
    ])
    expect(Inventory.ciJobs(zig).map((entry) => entry.id)).toEqual([
      "justfile:test",
      "justfile:tidy",
      "justfile:fmt",
      "justfile:ci"
    ])
    // The recipes of one Justfile come in the order `just ci` runs them: `ci: tidy test`, and `tidy` needs `fmt`.
    const narrowed = Inventory.ci(zig)
    expect(narrowed.jobs.map((entry) => entry.id)).toEqual(["justfile:fmt", "justfile:tidy", "justfile:test"])
    expect(narrowed.jobs.map((entry) => entry.needs)).toEqual([["justfile:tidy"], ["justfile:fmt"], []])
  })

  it("finds no CI in a repository with only scripts, and never runs a job that does not exit", () => {
    const scripts = inventory([
      job("package.json:test", "package.json", "package-json", []),
      job("package.json:deploy", "package.json", "package-json", [])
    ])
    expect(Inventory.ciJobs(scripts)).toEqual([])
    expect(Inventory.ci(scripts).jobs).toEqual([])
    const server = {
      ...job("ci.yml:dev", ".github/workflows/ci.yml", "github-actions", ["push"]),
      unsupported: [{ feature: Inventory.longRunning, detail: "bun run dev" }]
    }
    expect(Inventory.ciJobs(inventory([server]))).toHaveLength(1)
    expect(Inventory.ci(inventory([server])).jobs).toEqual([])
  })

  it("hands a replay a splitter, or none", async () => {
    const empty: Inventory.Inventory = inventory([])
    const split: Parts.Decompose = (_root, given) => Effect.succeed({ ...given, commit: "split" })
    const base = {
      read: () => Effect.succeed(empty),
      files: () => Effect.succeed([]),
      rows: () => Effect.succeed([]),
      score: () => Effect.succeed([])
    }
    const commitOf = (parts: Parts.ReplayParts) =>
      Effect.runPromise((parts.decompose ?? ((_root, given) => Effect.succeed(given)))("/repo", Inventory.ci(empty)))
        .then((result) => result.commit)
    expect(await commitOf({ ...base, decompose: split })).toBe("split")
    expect(await commitOf(base)).toBe("c")
  })

  it("lets a split step name what it reads and the step it came from", () => {
    const split = {
      ...step("ci.yml:test:1:packages/core", "bun test"),
      inputs: ["packages/core/**"],
      from: "ci.yml:test:1"
    }
    expect(Schema.decodeUnknownSync(Inventory.Step)(split)).toEqual(split)
    expect(() => Schema.decodeUnknownSync(Inventory.Step)({ ...split, inputs: [""] })).toThrow()
    // What a step writes is optional and held to the same form as what it reads.
    expect(Schema.decodeUnknownSync(Inventory.Step)({ ...split, outputs: ["packages/core/dist/**"] }).outputs)
      .toEqual(["packages/core/dist/**"])
    expect(() => Schema.decodeUnknownSync(Inventory.Step)({ ...split, outputs: [""] })).toThrow()
    // A step split from a command that ran its parts at the same time may say so.
    expect(Schema.decodeUnknownSync(Inventory.Step)({ ...split, atOnce: true }).atOnce).toBe(true)
    expect(() => Schema.decodeUnknownSync(Inventory.Step)({ ...split, atOnce: "yes" })).toThrow()
    // A step split from a command that ran its parts in order may say so.
    expect(Schema.decodeUnknownSync(Inventory.Step)({ ...split, inOrder: true }).inOrder).toBe(true)
    expect(() => Schema.decodeUnknownSync(Inventory.Step)({ ...split, inOrder: "yes" })).toThrow()
    // A step that runs a script of several commands and stays one step says why, in a sentence of `Reasons`.
    const whole = { ...step("ci.yml:test:2", "npm run check"), whole: { feature: "script-hook", detail: "precheck" } }
    expect(Schema.decodeUnknownSync(Inventory.Step)(whole)).toEqual(whole)
    expect(Reasons.wholeScriptSentence(whole.whole)).toBe(
      "stays one step: the script has the hook `precheck`, which the package manager runs with it"
    )
    expect(() => Schema.decodeUnknownSync(Inventory.Step)({ ...whole, whole: { feature: "", detail: "" } })).toThrow()
    // A tool's cache is kept inside Smithers build's cache directory, which is outside the checkout: the constant
    // starts with the text Smithers build replaces with that directory.
    expect(Inventory.toolCache).toBe("{smthrs:cache-directory}/tools")
    const failure = { code: "command-failed", message: "bun pm ls exited 1", part: "decompose" }
    expect(Schema.decodeUnknownSync(Parts.Failure)(failure)).toEqual(failure)
  })

  it("names the variable a baseline step is told its store by, which no step's own script is given", () => {
    expect(Inventory.stateVariable).toBe("SMITHERS_CI_STATE")
    // The name Smithers build gives the temporary directory of a job's machine.
    expect(Inventory.jobTemporaryVariable).toBe("SMTHRS_MACHINE_TMP")
    // It is the replay's own word to its steps, not one a person sets.
    expect(JSON.stringify(Command.environment)).not.toContain(Inventory.stateVariable)
  })

  it("names the variables a GitHub runner tells a step its software by, sorted and free of its own", () => {
    expect(Inventory.runnerSoftware).toEqual([...Inventory.runnerSoftware].sort())
    expect(Inventory.runnerSoftware).toEqual(expect.arrayContaining(["ANDROID_HOME", "ANDROID_SDK_ROOT", "JAVA_HOME"]))
    expect(Inventory.runnerSoftware.filter((name) => /TOKEN|SECRET|KEY/.test(name))).toEqual([])
  })

  it("compares a step with all the targets it was split into", () => {
    const entry = (label: string) => ({ label, job: "ci.yml:test", step: "ci.yml:test:1", variant: {} })
    const map = Schema.decodeUnknownSync(TargetMap.TargetMap)({
      version: 1,
      targets: [entry("//:test-core"), entry("//:test-ui"), { ...entry("//:lint"), step: "ci.yml:test:2" }]
    })
    expect(TargetMap.labelsOf(map, "ci.yml:test", "ci.yml:test:1", {})).toEqual(["//:test-core", "//:test-ui"])
    expect(TargetMap.labelsOf(map, "ci.yml:test", "ci.yml:test:9", {})).toEqual([])
    expect(RunRecord.combine(["pass", "fail", "flaky"])).toBe("fail")
    expect(RunRecord.combine(["pass", "flaky", "skipped"])).toBe("flaky")
    expect(RunRecord.combine(["skipped", "pass"])).toBe("pass")
    expect(RunRecord.combine(["skipped"])).toBe("skipped")
    expect(RunRecord.combine([])).toBe("skipped")
  })
})

describe("contract changes, sixth round: a job that cannot be reproduced is never run", () => {
  const decode = Schema.decodeUnknownSync(Inventory.Inventory)
  const job = (id: string, features: ReadonlyArray<string>, commands: ReadonlyArray<string> = ["true"]) => ({
    id,
    source: "github-actions",
    file: ".github/workflows/ci.yml",
    name: id,
    needs: [],
    triggers: ["push"],
    matrix: [],
    steps: commands.map((command, index) => ({ id: `${id}:${index + 1}`, command, cwd: "", env: {}, secrets: [] })),
    unsupported: features.map((feature) => ({ feature, detail: `${id} ${feature}` }))
  })
  const inventory = decode({
    version: 1,
    repository: "r",
    commit: "c",
    toolchains: [],
    jobs: [
      job("ci.yml:test", [Inventory.hostAction, Inventory.triggerFilter]),
      job("ci.yml:handoff", ["secret-env", Inventory.hostAction, "condition"], ["gh api --method POST /dispatches"]),
      job("ci.yml:shards", ["runner-variable"]),
      job("ci.yml:reusable", [Inventory.hostAction], []),
      job("ci.yml:plain", []),
      { ...job("ci.yml:gate", [], []), needs: ["ci.yml:test", "ci.yml:plain", "ci.yml:gone"] },
      { ...job("ci.yml:after-gate", []), needs: ["ci.yml:gate", "ci.yml:test"] },
      { ...job("ci.yml:after-shards", []), needs: ["ci.yml:shards"] },
      { ...job("ci.yml:all", [], []), needs: ["ci.yml:after-shards"] },
      { ...job("ci.yml:last", []), needs: ["ci.yml:all"] }
    ]
  })

  it("runs a job only when every unsupported feature is harmless", () => {
    // A step left out because its condition is false for the event is one its CI would not run either.
    expect(Inventory.harmless).toEqual(["host-action", "trigger-filter", Inventory.conditionFalse])
    expect(Inventory.hostActions).toContain("actions/checkout")
    expect(Inventory.hostActions).not.toContain("actions/download-artifact")
    expect(Inventory.ci(inventory).jobs.map((entry) => [entry.id, entry.needs])).toEqual([
      ["ci.yml:test", []],
      ["ci.yml:plain", []],
      ["ci.yml:after-gate", ["ci.yml:test", "ci.yml:plain"]]
    ])
    for (const feature of ["uses", "condition", "expression", "services", "continue-on-error", "something-new"]) {
      expect(Inventory.isRunnable(inventory.jobs[4]!)).toBe(true)
      expect(Inventory.isRunnable({ ...inventory.jobs[4]!, unsupported: [{ feature, detail: "" }] })).toBe(false)
    }
  })

  it("never runs a job with a step that receives a secret, and lists it with the secret's name", () => {
    const plain = inventory.jobs[4]!
    const withSecret = {
      ...plain,
      id: "ci.yml:publish",
      steps: [
        ...plain.steps,
        { id: "ci.yml:publish:2", command: "npm publish", cwd: "", env: {}, secrets: ["NPM_TOKEN", "OTHER"] }
      ]
    }
    expect(Inventory.secret).toBe("secret")
    expect(Inventory.isRunnable(plain)).toBe(true)
    expect(Inventory.isRunnable(withSecret)).toBe(false)
    expect(Inventory.blockers(withSecret)).toEqual([
      { feature: "secret", detail: "ci.yml:publish:2 receives NPM_TOKEN, OTHER" }
    ])
    const both = decode({ ...inventory, jobs: [plain, withSecret] })
    expect(Inventory.ci(both).jobs.map((entry) => entry.id)).toEqual(["ci.yml:plain"])
    expect(Inventory.notReplayed(both)).toEqual([{ job: "ci.yml:publish", reasons: Inventory.blockers(withSecret) }])
  })

  it("never runs a release job or a job that may write outside its checkout", () => {
    expect([Inventory.releaseTrigger, Inventory.writePermission]).toEqual(["release-trigger", "write-permission"])
    for (const feature of [Inventory.releaseTrigger, Inventory.writePermission]) {
      expect(Inventory.harmless).not.toContain(feature)
      expect(Inventory.isRunnable({ ...inventory.jobs[4]!, unsupported: [{ feature, detail: "" }] })).toBe(false)
    }
  })

  it("lists a CI job whose every step was a host action, and leaves a job that only groups others in neither list", () => {
    const upload = { ...job("ci.yml:package", [Inventory.hostAction], []), needs: ["ci.yml:plain"] }
    const group = { ...job("ci.yml:group", [], []), needs: ["ci.yml:plain"] }
    const after = { ...job("ci.yml:after", []), needs: ["ci.yml:package", "ci.yml:group"] }
    const both = decode({ ...inventory, jobs: [inventory.jobs[4]!, upload, group, after] })
    expect(Inventory.noCommand).toBe("no-command")
    expect(Inventory.notReplayed(both)).toEqual([
      { job: "ci.yml:package", reasons: [{ feature: "no-command", detail: "ci.yml:package has no command to run" }] }
    ])
    // It ran nothing, so the job that needs it waits for what it waited for, as with a job that only groups.
    expect(Inventory.ci(both).jobs.map((entry) => [entry.id, entry.needs])).toEqual([
      ["ci.yml:plain", []],
      ["ci.yml:after", ["ci.yml:plain"]]
    ])
    expect(Inventory.refusal(decode({ ...inventory, jobs: [upload] }))).toBe(
      "0 of 1 CI job can be reproduced on this machine\n  ci.yml:package  has no command to run: all its steps only prepare the CI machine"
    )
  })

  it("names the system a runner means, and the features of what a replay leaves out for it", () => {
    expect(["ubuntu-latest", "self-hosted,linux,x64", "macos-15", "macOS-latest", "windows-2022"].map(Inventory.hostOf))
      .toEqual(["linux", "linux", "darwin", "darwin", "win32"])
    expect(Inventory.hostOf("self-hosted")).toBeUndefined()
    expect(["self-hosted", "Self-Hosted,linux", "linux, self-hosted"].map(Inventory.isSelfHosted)).toEqual([
      true,
      true,
      true
    ])
    expect(["ubuntu-latest", "my-self-hosted", undefined].map(Inventory.isSelfHosted)).toEqual([false, false, false])
    expect(Inventory.hostOf(undefined)).toBeUndefined()
    expect(Schema.decodeUnknownSync(Inventory.Host)("darwin")).toBe("darwin")
    expect([Inventory.otherSystem, Inventory.noTarget]).toEqual(["other-system", "no-target"])
    expect(Inventory.stepTimeoutHours).toBe(6)
    expect(Inventory.uncommittedChanges).toBe("uncommitted-changes")
  })

  it("holds what was read and belongs to no job, without the workspace file it found", () => {
    const unread = { feature: "malformed-file", detail: ".github/workflows/tests.yml: BAD_INDENT at line 3" }
    const own = { feature: Inventory.smithersBuild, detail: "WORKSPACE.ts" }
    expect(Inventory.notRead(inventory)).toEqual([])
    expect(Inventory.notRead(decode({ ...inventory, unsupported: [own, unread] }))).toEqual([unread])
    const report = Schema.decodeUnknownSync(ReplayReport.ReplayReport)({
      ...(fixture("replay-report.example.json") as object),
      notRead: [unread],
      flaky: 2
    })
    expect(report).toMatchObject({ notRead: [unread], flaky: 2 })
    const older = { commit: "0000000000000000000000000000000000000001", reason: "it had no CI" }
    expect(
      Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...report, notReplayedCommits: [older] }).notReplayedCommits
    ).toEqual([older])
    expect(() =>
      Schema.decodeUnknownSync(ReplayReport.ReplayReport)({
        ...report,
        notReplayedCommits: [{ commit: "", reason: "" }]
      })
    ).toThrow()
    expect(Schema.decodeUnknownSync(ReplayReport.ReplayReport)(fixture("replay-report.example.json")).flaky).toBe(0)
  })

  it("gives the jobs of one shared tree in the order they run, and a GitHub job a checkout of its own", () => {
    const recipe = (id: string, needs: ReadonlyArray<string>, commands: ReadonlyArray<string> = ["true"]) => ({
      ...job(`justfile:${id}`, [], commands),
      source: "justfile",
      file: "Justfile",
      triggers: [],
      needs: needs.map((need) => `justfile:${need}`)
    })
    // `ci: lint build test` with no body, written above the recipes it lists; `test` also lists `build`.
    const jobs = [
      recipe("ci", ["lint", "build", "test"], []),
      recipe("test", ["build"]),
      recipe("clean", ["gone"]),
      recipe("build", ["install"]),
      recipe("lint", ["install"]),
      recipe("install", [])
    ]
    const just = decode({ ...inventory, jobs })
    expect(Inventory.treeOf(just.jobs[0]!)).toBe("Justfile")
    expect(Inventory.treeOf(inventory.jobs[0]!)).toBeUndefined()
    expect([...Inventory.treeOrder(just.jobs)]).toEqual([
      ["Justfile", ["install", "lint", "build", "test", "ci", "clean"].map((id) => `justfile:${id}`)]
    ])
    expect(Inventory.treeOrder(inventory.jobs).size).toBe(0)
    // `ci` only groups and `clean` is not CI: the four that run come in the order `just ci` runs them.
    expect(Inventory.ci(just).jobs.map((entry) => entry.id)).toEqual(
      ["install", "lint", "build", "test"].map((id) => `justfile:${id}`)
    )
    // A job of another tree between them keeps its place, and a need on a job of another tree orders nothing.
    const script = {
      ...job("package.json:ci", [], ["npm test"]),
      source: "package-json",
      file: "package.json",
      triggers: [],
      needs: ["justfile:build"]
    }
    const mixed = decode({
      ...inventory,
      jobs: [recipe("test", ["build"]), script, recipe("build", []), recipe("ci", ["build", "test"], [])]
    })
    expect(Inventory.ci(mixed).jobs.map((entry) => entry.id)).toEqual([
      "justfile:build",
      "package.json:ci",
      "justfile:test"
    ])
  })

  it("never counts the workflow it generated as the repository's CI", () => {
    const own = { ...job("smithers-ci.yml:ci", []), file: Inventory.generatedWorkflow }
    const both = decode({ ...inventory, jobs: [own, inventory.jobs[4]!] })
    expect(Inventory.ciJobs(both).map((entry) => entry.id)).toEqual(["ci.yml:plain"])
    expect(Inventory.ciJobs(decode({ ...inventory, jobs: [own] }))).toEqual([])
  })

  it("names a repository that already builds with Smithers build, by its workspace file", () => {
    expect(Inventory.ownWorkspace(inventory)).toBeUndefined()
    const own = decode({
      ...inventory,
      unsupported: [{ feature: "something-else", detail: "x" }, {
        feature: Inventory.smithersBuild,
        detail: "WORKSPACE.ts"
      }]
    })
    expect(Inventory.ownWorkspace(own)).toBe("WORKSPACE.ts")
    expect(Command.applyRefuses).toContain(Inventory.ownWorkspace(own))
    expect(Command.flags.targets.on).toEqual(["", "replay"])
  })

  it("names the patterns a replay of a repository's own targets measured", () => {
    const report = Schema.decodeUnknownSync(ReplayReport.ReplayReport)(fixture("replay-report.example.json"))
    expect(report.targets).toBeUndefined()
    const native = Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...report, targets: ["//packages/ci/..."] })
    expect(native.targets).toEqual(["//packages/ci/..."])
    expect(() => Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...report, targets: [""] })).toThrow()
  })

  it("replaces the steps of a CI's jobs, and never leaves a job without a step", () => {
    const narrowed = Inventory.ci(inventory)
    const split = Inventory.withSteps(narrowed, (entry) =>
      entry.id === "ci.yml:test"
        ? entry.steps.flatMap((step) => [{ ...step, id: `${step.id}-a`, from: step.id }, {
          ...step,
          id: `${step.id}-b`,
          from: step.id
        }])
        : [])
    expect(split.jobs.map((entry) => [entry.id, entry.needs, entry.steps.length])).toEqual(
      narrowed.jobs.map((entry) => [entry.id, entry.needs, entry.steps.length * (entry.id === "ci.yml:test" ? 2 : 1)])
    )
    expect(split.jobs[0]!.steps.every((step) => step.from !== undefined)).toBe(true)
    expect(split.jobs[1]).toEqual(narrowed.jobs[1])
  })

  it("refuses with one answer when nothing of the CI can be run", () => {
    expect(Inventory.refusal(inventory)).toBeUndefined()
    const blocked = (id: string, features: ReadonlyArray<string>) => ({
      ...inventory.jobs[4]!,
      id,
      needs: [],
      unsupported: features.map((feature) => ({ feature, detail: "" }))
    })
    expect(Inventory.refusal(decode({ ...inventory, jobs: [blocked("ci.yml:a", ["condition"])] }))).toBe(
      "0 of 1 CI job can be reproduced on this machine\n  ci.yml:a  runs only when a condition holds that a replay cannot check"
    )
    expect(
      Inventory.refusal(
        decode({
          ...inventory,
          jobs: [
            blocked("ci.yml:deploy", ["secret-env", "condition", "secret-env"]),
            blocked("ci.yml:e2e", ["services"])
          ]
        })
      )
    ).toBe(
      [
        "0 of 2 CI jobs can be reproduced on this machine",
        "  ci.yml:deploy  builds a variable from a secret, which a replay never has; runs only when a condition holds that a replay cannot check",
        "  ci.yml:e2e     needs service containers, which only GitHub starts; the job stays in your CI as it is"
      ].join("\n")
    )
    expect(Inventory.refusal(decode({ ...inventory, jobs: [] }))).toBe(
      "no job runs on a push or a pull request, and the repository root has no `ci` recipe or script"
    )
  })

  it("lists every CI job it leaves out, with the reasons", () => {
    const left = Inventory.notReplayed(inventory)
    expect(left).toEqual([
      {
        job: "ci.yml:handoff",
        reasons: [
          { feature: "secret-env", detail: "ci.yml:handoff secret-env" },
          { feature: "condition", detail: "ci.yml:handoff condition" }
        ]
      },
      { job: "ci.yml:shards", reasons: [{ feature: "runner-variable", detail: "ci.yml:shards runner-variable" }] },
      { job: "ci.yml:reusable", reasons: [{ feature: "no-command", detail: "ci.yml:reusable has no command to run" }] },
      {
        job: "ci.yml:after-shards",
        reasons: [{ feature: "needs", detail: "ci.yml:after-shards needs ci.yml:shards, which is not replayed" }]
      },
      {
        job: "ci.yml:all",
        reasons: [{ feature: "needs", detail: "ci.yml:all needs ci.yml:after-shards, which is not replayed" }]
      },
      {
        job: "ci.yml:last",
        reasons: [{ feature: "needs", detail: "ci.yml:last needs ci.yml:all, which is not replayed" }]
      }
    ])
    const report = {
      ...(fixture("replay-report.example.json") as object),
      notReplayed: left
    }
    expect(Schema.decodeUnknownSync(ReplayReport.ReplayReport)(report).notReplayed).toEqual(left)
    expect(() =>
      Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...report, notReplayed: [{ job: "", reasons: [] }] })
    ).toThrow()
  })

  it("gives the generator and the splitter only what `ci` returned", async () => {
    const narrowed: Inventory.Ci = Inventory.ci(inventory)
    const files: Parts.GenerateFiles = (given) =>
      Effect.succeed(given.jobs.map((entry) => ({ path: `${entry.name}.ts`, content: "" })))
    const split: Parts.Decompose = (_root, given) => Effect.succeed({ ...given, jobs: given.jobs.slice(0, 1) })
    // @ts-expect-error an inventory that did not come from `ci` is refused
    const refused = files(inventory)
    expect(await Effect.runPromise(refused)).toHaveLength(10)
    const once = await Effect.runPromise(split("/repo", narrowed))
    expect((await Effect.runPromise(files(once))).map((file) => file.path)).toEqual(["ci.yml:test.ts"])
  })
})

describe("what a report says about a failure", () => {
  const report = fixture("replay-report.example.json") as { readonly commits: ReadonlyArray<object> }

  it("holds each failed step's name, reason, exit code and command, and how many commits the speedup covers", () => {
    const decoded = Schema.decodeUnknownSync(ReplayReport.ReplayReport)(report)
    expect(decoded.speedupCommits).toBe(1)
    expect(decoded.commits[1]?.baseline.failures).toEqual([{
      step: "//packages/core:test",
      reason: "expected 2, got 3",
      exitCode: 1,
      command: "bun test packages/core"
    }])
    expect(decoded.commits[0]?.baseline.failures).toBeUndefined()
  })

  it("holds the first run of each way, or why the first commit started with an empty cache", () => {
    const decoded = Schema.decodeUnknownSync(ReplayReport.ReplayReport)(report)
    expect(decoded.firstRun).toEqual({
      commit: "0000000000000000000000000000000000000001",
      baselineMs: 1_390_000,
      normalMs: 1_470_000,
      fastMs: 1_480_000
    })
    expect(decoded.cold).toBeUndefined()
    const decode = Schema.decodeUnknownSync(ReplayReport.FirstRun)
    // A mode whose first run did not finish has no time; the baseline always has one.
    expect(decode({ commit: "abc", baselineMs: 1 })).toEqual({ commit: "abc", baselineMs: 1 })
    expect(() => decode({ commit: "abc", normalMs: 1 })).toThrow()
    expect(() => decode({ commit: "", baselineMs: 1 })).toThrow()
    const { firstRun: _firstRun, ...without } = report as unknown as { readonly firstRun: unknown }
    const cold = "no commit comes before 0000000 in this repository"
    expect(Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...without, cold })).toMatchObject({ cold })
    expect(() => Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...without, cold: "" })).toThrow()
    // A person asks for the count from an empty cache; a replay is asked for the first run.
    expect(Command.flags.cold).toMatchObject({ on: ["", "replay"], default: "false" })
    const request: Parts.ReplayRequest = { root: ".", commits: 1, modes: ["normal"], warm: true }
    expect(request.warm).toBe(true)
  })

  it("holds what the run as apply leaves the repository took, and a person can leave that run out", () => {
    const decoded = Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...report, appliedMs: 41_000 })
    expect(decoded.appliedMs).toBe(41_000)
    expect(Schema.decodeUnknownSync(ReplayReport.ReplayReport)(report).appliedMs).toBeUndefined()
    expect(() => Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...report, appliedMs: "long" })).toThrow()
    // The flag is named for what it leaves out, as `--no-trial` is, and takes no value.
    expect(Command.flags["no-apply-check"]).toMatchObject({ on: ["", "replay"], default: "false" })
    expect(Command.flags["no-apply-check"].help).toContain("the files apply writes")
    expect(Command.syntax.value).toContain("`--no-apply-check`")
    // A replay is asked for the run; without the word there is none.
    const request: Parts.ReplayRequest = { root: ".", commits: 1, modes: ["normal"], applied: true }
    expect(request.applied).toBe(true)
  })

  it("holds the CPU time each way's steps used, for a commit and over the commits the times cover", () => {
    const decoded = Schema.decodeUnknownSync(ReplayReport.ReplayReport)(report)
    expect(decoded.commits[0]?.baseline.cpuMs).toBe(4_200_000)
    expect(decoded.commits[0]?.normal.cpuMs).toBe(600_000)
    expect(decoded.commits[0]?.fast?.cpuMs).toBe(210_000)
    // A run whose processes could not be read has no number.
    expect(decoded.commits[1]?.baseline.cpuMs).toBeUndefined()
    expect(decoded).toMatchObject({ baselineCpuMs: 4_200_000, normalCpuMs: 600_000, fastCpuMs: 210_000 })
    expect(() => Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...report, baselineCpuMs: "much" })).toThrow()
  })

  it("holds how many failed steps ran again and how long that took", () => {
    const decoded = Schema.decodeUnknownSync(ReplayReport.ReplayReport)(report)
    expect(decoded.reruns).toEqual({ count: 2, ms: 2_600_000 })
    expect(() => Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...report, reruns: { count: 1.5, ms: 1 } }))
      .toThrow()
    // A person sets the number; one rerun tells a flaky failure from a broken one.
    expect(Command.flags.reruns).toMatchObject({ on: ["", "replay"], default: "1" })
    const request: Parts.ReplayRequest = { root: ".", commits: 1, modes: ["normal"], reruns: 0 }
    expect(request.reruns).toBe(0)
  })

  it("refuses a failure with no step or no reason, and a negative count of commits", () => {
    const decode = Schema.decodeUnknownSync(ReplayReport.StepFailure)
    expect(decode({ step: "a", reason: "b" })).toEqual({ step: "a", reason: "b" })
    expect(() => decode({ step: "", reason: "b" })).toThrow()
    expect(() => decode({ step: "a", reason: "" })).toThrow()
    expect(() => Schema.decodeUnknownSync(ReplayReport.ReplayReport)({ ...report, speedupCommits: -1 })).toThrow()
  })

  it("lets a run record, a result and a run's totals say what the time was spent on", () => {
    const parts = { ms: { step: 1200.5, reads: 40 }, cpuMs: { step: 900 } }
    const result = { label: "//:a", status: "ran", key: "", durationMs: 1300, parts }
    expect(Schema.decodeUnknownSync(RunRecord.TargetResult)(result)).toEqual(result)
    const record = { ok: true, counts: { hit: 0, ran: 1, failed: 0, skipped: 0 }, results: [result] }
    const whole = { ...record, parts: { ms: { start: 900, plan: 100 } } }
    expect(Schema.decodeUnknownSync(RunRecord.RunRecord)(whole)).toEqual(whole)
    // A record of a Smithers build that times nothing holds none.
    expect(Schema.decodeUnknownSync(RunRecord.RunRecord)(record)).not.toHaveProperty("parts")
    const totals = { ok: true, wallMs: 2300, workMs: 1300, counts: record.counts, parts }
    expect(Schema.decodeUnknownSync(ReplayReport.RunTotals)(totals)).toEqual(totals)
    expect(() => Schema.decodeUnknownSync(RunRecord.Parts)({ ms: { step: "long" } })).toThrow()
    expect(() => Schema.decodeUnknownSync(RunRecord.Parts)({ cpuMs: { step: 1 } })).toThrow()
  })

  it("lets a result say why it was not reused, and a run's totals name each such step", () => {
    const result = {
      label: "//:a",
      status: "ran",
      key: "",
      durationMs: 1,
      notReused: "src/a.ts changed",
      notStored: "it opened a network connection (npm to 104.16.4.34 port 443)"
    }
    expect(Schema.decodeUnknownSync(RunRecord.TargetResult)(result)).toEqual(result)
    expect(() => Schema.decodeUnknownSync(RunRecord.TargetResult)({ ...result, notReused: 1 })).toThrow()
    const step = { step: "test", reason: "src/a.ts changed", kept: true }
    const totals = { ok: true, wallMs: 1, workMs: 1, counts: { hit: 0, ran: 1, failed: 0, skipped: 0 } }
    expect(Schema.decodeUnknownSync(ReplayReport.RunTotals)({ ...totals, notReused: [step] })).toEqual({
      ...totals,
      notReused: [step]
    })
    // A run that reused nothing, as the baseline, names none.
    expect(Schema.decodeUnknownSync(ReplayReport.RunTotals)(totals)).not.toHaveProperty("notReused")
    const decode = Schema.decodeUnknownSync(ReplayReport.StepNotReused)
    expect(() => decode({ step: "test", reason: "src/a.ts changed" })).toThrow()
    expect(() => decode({ ...step, reason: "" })).toThrow()
    expect(() => decode({ ...step, step: "" })).toThrow()
  })

  it("lets a run record's result say how its command ended", () => {
    const result = { label: "//:a", status: "failed", key: "", durationMs: 1, exitCode: 127, command: "docker" }
    expect(Schema.decodeUnknownSync(RunRecord.TargetResult)(result)).toEqual(result)
    expect(() => Schema.decodeUnknownSync(RunRecord.TargetResult)({ ...result, exitCode: 1.5 })).toThrow()
  })
})

describe("contract changes, twelfth round: files a repository's own tools never read", () => {
  it("marks a generated file the program alone reads, and gives the files that are written", () => {
    const files: ReadonlyArray<Parts.GeneratedFile> = [
      { path: ".smithers/WORKSPACE.smithers", content: "x" },
      { path: TargetMap.path, content: "{}", written: false },
      { path: ".smithers/ci/legs.txt", content: "y", written: undefined }
    ]
    expect(Parts.writtenFiles(files).map((file) => file.path)).toEqual([
      ".smithers/WORKSPACE.smithers",
      ".smithers/ci/legs.txt"
    ])
    expect(Parts.writtenFiles([])).toEqual([])
  })

  it("names the generated file Smithers build reads as the workspace declaration", () => {
    const workspace = { path: ".smithers/WORKSPACE.smithers", content: "x" }
    const files: ReadonlyArray<Parts.GeneratedFile> = [
      { path: ".github/workflows/smithers-ci.yml", content: "w" },
      workspace,
      { path: ".smithers/ci-targets.json", content: "{}", written: false }
    ]
    // A replay writes this one file beside its copy and names it to Smithers build.
    expect(Command.declarationOf(files)).toBe(workspace)
    for (const path of Command.applyRefuses) expect(Command.declarationOf([{ path, content: "x" }])?.path).toBe(path)
    // A repository with a workspace of its own has no generated one, and a file that is not written is not it.
    expect(Command.declarationOf([files[0]!, files[2]!])).toBeUndefined()
    expect(Command.declarationOf([{ ...workspace, written: false }])).toBeUndefined()
    expect(Command.declarationOf([])).toBeUndefined()
  })

  it("lets a mismatch say which tool read a file Smithers CI wrote", () => {
    const decode = Schema.decodeUnknownSync(ReplayReport.Mismatch)
    const plain = { label: "//:check", mode: "normal", baseline: "pass", got: "fail" }
    expect(decode(plain)).toEqual(plain)
    const cause = "tsc read .smithers/WORKSPACE.smithers, which Smithers CI wrote. Add .smithers to \"exclude\"."
    expect(decode({ ...plain, cause })).toEqual({ ...plain, cause })
    expect(() => decode({ ...plain, cause: "" })).toThrow()
  })
})
