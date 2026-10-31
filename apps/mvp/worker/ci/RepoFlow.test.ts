// A repository flow's run (worker/ci/RepoFlow.ts) on the Node host's engine against the scripted GitHub: flow.ts read
// at the commit as the App, planned in the real QuickJS realm, each job a `ci/job` child on a test `Machines` (which
// records each command and answers its exit code from a table), and the result a commit status. The machine and
// GitHub are the only stand-ins.
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import { QuickJSVariant } from "@smthrs/harness"
import type { SandboxTools } from "@smthrs/sandbox"
import { Effect, Exit, Layer } from "effect"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { beforeEach, describe, expect, test } from "vitest"
import { noCommands } from "../test/commands.ts"
import { Machines } from "../branch/Machines.ts"
import * as CiJobMachine from "../flows/CiJobMachine.ts"
import { REPOSITORY, reset, services as githubServices } from "../github/test/fixtures.ts"
import { BOT_LOGIN, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as RepoFlow from "./RepoFlow.ts"

const runtime = testFile("repo_flow")
beforeEach(() => reset(runtime))

const variant = QuickJSVariant.layerVariant(wasmfile as unknown as QuickJSSyncVariant)

/** A machine at whatever commit it was asked for, whose command exits with `exits[command]` (0 unless set). */
const machine = (exits: Readonly<Record<string, number>> = {}) => {
  const commands: Array<{ readonly branchId: string; readonly command: string }> = []
  const layer = Layer.succeed(
    Machines,
    Machines.of({
    commands: () => noCommands,
      tool: (branch, _owner, _callId, call) => {
        const command = (call as typeof SandboxTools.Run.Type).command
        commands.push({ branchId: branch.branchId, command })
        const exitCode = command.startsWith("test ") ? (command.endsWith(branch.branch) ? 0 : 1) : exits[command] ?? 0
        return Effect.succeed({
          generation: 1,
          result: {
            tool: "run" as const,
            exitCode,
            timedOut: false,
            stdout: "",
            stderr: "",
            stdoutBytes: 0,
            stderrBytes: 0,
            truncated: false,
          },
        })
      },
      sleepIfIdle: () => Effect.succeed("slept" as const),
    }),
  )
  return { commands, layer, ran: () => commands.map((call) => call.command).filter((command) => !command.startsWith("test ") && command !== CiJobMachine.STOP_LEFTOVERS) }
}

const CI = `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"

const versions = CiJob.make("versions", { steps: [{ name: "node", run: "node --version" }, { name: "pnpm", run: "pnpm --version" }] })
const lint = CiJob.make("lint", { steps: [{ name: "lint", run: "pnpm lint" }] })

export default Flow.make("ci", {
  body: (run: { readonly sha: string }) => Node.all({ versions: versions.call(run), lint: lint.call(run) }),
})
`

const request = (sha: string, flow = "ci"): RepoFlow.RunRequest => ({
  run: `${flow}:delivery-${sha.slice(0, 8)}`,
  repo: `${REPOSITORY.owner}/${REPOSITORY.name}`,
  flow,
  sha,
  ref: "refs/heads/main",
  event: "push",
  secrets: true,
})

const run = async (
  github: ReturnType<typeof scriptedGitHub>,
  box: ReturnType<typeof machine>,
  input: RepoFlow.RunRequest,
  options: { readonly databaseFailures?: number } = {},
) => {
  const { services } = await githubServices(runtime, github)
  // A Postgres that can't be reached the first `databaseFailures` times a step opens it.
  let failures = options.databaseFailures ?? 0
  const database = Layer.unwrap(Effect.suspend(() =>
    failures-- > 0 ? Effect.fail(new Error("connection refused")) : Effect.succeed(services.database)
  ))
  return runFlow(
    RepoFlow.Run,
    input,
    ExecutionHost.withRepoFlows(
      ExecutionHost.withCiJobs({ flows: [], registration: Layer.empty }, box.layer),
      Effect.succeed({ ...services, database }), variant,
    ).registration,
    { executionId: input.run },
  )
}

describe("repo/Run", { timeout: 60_000 }, () => {
  test("plans flow.ts at the commit, runs every job on its own machine, and reports smithers/ci passed", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const sha = github.push("main", { ".smithers/flows/ci/flow.ts": CI })
    const box = machine()
    const ran = await run(github, box, request(sha))
    expect(ran.exit).toEqual(Exit.succeed({
      state: "success",
      outcome: "sent",
      jobs: [{ name: "versions", outcome: "passed" }, { name: "lint", outcome: "passed" }],
    }))
    expect(box.ran().sort()).toEqual(["node --version", "pnpm --version", "pnpm lint"])
    // Two jobs, two machines.
    expect(new Set(box.commands.map((call) => call.branchId)).size).toBe(2)
    expect(github.statuses.get(sha)!.map(({ context, state, description, login }) => [context, state, description, login]))
      .toEqual([
        ["smithers/ci", "pending", "Running", BOT_LOGIN],
        ["smithers/ci", "success", "Passed", BOT_LOGIN],
      ])
  })

  test("a job that fails fails the flow, its sibling still runs, and the status names the failed job", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const sha = github.push("main", { ".smithers/flows/ci/flow.ts": CI })
    const box = machine({ "pnpm lint": 1 })
    const ran = await run(github, box, request(sha))
    expect(ran.exit).toEqual(Exit.succeed({
      state: "failure",
      outcome: "sent",
      jobs: [{ name: "versions", outcome: "passed" }, { name: "lint", outcome: "failed" }],
    }))
    expect(github.shownStatuses(sha)).toEqual({ "smithers/ci": "failure" })
    expect(github.statuses.get(sha)!.at(-1)!.description).toBe("Failed: lint")
  })

  test("a job runs after the jobs it needs; one whose need failed is skipped, runs nothing and fails the flow", async () => {
    const GRAPH = `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"

const build = CiJob.make("build", { steps: [{ name: "build", run: "make" }] })
const lint = CiJob.make("lint", { steps: [{ name: "lint", run: "pnpm lint" }] })
const test = CiJob.make("test", { steps: [{ name: "test", run: "make test" }], needs: ["build"] })
const docs = CiJob.make("docs", { steps: [{ name: "docs", run: "make docs" }], needs: ["lint"] })

export default Flow.make("ci", {
  body: (run) => Node.all({ build: build.call(run), lint: lint.call(run), test: test.call(run), docs: docs.call(run) }),
})
`
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const sha = github.push("main", { ".smithers/flows/ci/flow.ts": GRAPH })
    const passing = machine()
    expect((await run(github, passing, request(sha))).exit).toEqual(Exit.succeed({
      state: "success",
      outcome: "sent",
      jobs: [
        { name: "build", outcome: "passed" },
        { name: "lint", outcome: "passed" },
        { name: "test", outcome: "passed" },
        { name: "docs", outcome: "passed" },
      ],
    }))
    const ran = passing.ran()
    expect(ran.indexOf("make test")).toBeGreaterThan(ran.indexOf("make"))
    const failing = machine({ make: 2 })
    const second = github.push("main", { ".smithers/flows/ci/flow.ts": GRAPH, "README.md": "again" })
    expect((await run(github, failing, request(second))).exit).toEqual(Exit.succeed({
      state: "failure",
      outcome: "sent",
      jobs: [
        { name: "build", outcome: "failed" },
        { name: "lint", outcome: "passed" },
        { name: "test", outcome: "skipped" },
        { name: "docs", outcome: "passed" },
      ],
    }))
    expect(failing.ran()).not.toContain("make test")
    expect(github.statuses.get(second)!.at(-1)!.description).toBe("Failed: build, test")
  })

  test("reads flow.ts at the run's commit, not the branch's head", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const sha = github.push("main", { ".smithers/flows/ci/flow.ts": CI })
    github.push("main", { ".smithers/flows/ci/flow.ts": CI.replace("pnpm lint", "pnpm lint --fix") })
    const box = machine()
    await run(github, box, request(sha))
    expect(box.ran()).toContain("pnpm lint")
    expect(box.ran()).not.toContain("pnpm lint --fix")
  })

  test("a flow with no flow.ts at the commit, or one the realm refuses, runs no job and reports failure", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const sha = github.push("main", { ".smithers/flows/ci/flow.ts": `import { execSync } from "node:child_process"\n${CI}` })
    const box = machine()
    expect((await run(github, box, request(sha, "release"))).exit).toEqual(Exit.succeed({ state: "failure", outcome: "sent", jobs: [] }))
    expect((await run(github, box, request(sha))).exit).toEqual(Exit.succeed({ state: "failure", outcome: "sent", jobs: [] }))
    expect(box.commands).toEqual([])
    expect(github.statuses.get(sha)!.map(({ context, description }) => [context, description])).toEqual([
      ["smithers/release", "Couldn't run the flow (not_found)"],
      ["smithers/ci", "Couldn't run the flow (import)"],
    ])
  })

  test("without the Commit statuses permission the jobs still run and the status is recorded refused", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.statusesGranted = false
    const sha = github.push("main", { ".smithers/flows/ci/flow.ts": CI })
    const box = machine()
    expect((await run(github, box, request(sha))).exit).toEqual(Exit.succeed({
      state: "success",
      outcome: "refused",
      jobs: [{ name: "versions", outcome: "passed" }, { name: "lint", outcome: "passed" }],
    }))
    expect(github.statuses.get(sha)).toBeUndefined()
  })

  test("without Contents: read the flow can't be read, and nothing runs", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.contentsGranted = false
    const sha = github.push("main", { ".smithers/flows/ci/flow.ts": CI })
    const box = machine()
    expect((await run(github, box, request(sha))).exit).toEqual(Exit.succeed({ state: "failure", outcome: "sent", jobs: [] }))
    expect(github.statuses.get(sha)!.at(-1)!.description).toBe("Couldn't run the flow (unreadable)")
    expect(box.commands).toEqual([])
  })

  test("GitHub's outages and a Postgres that can't be reached are tried again; the run settles as without them", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const sha = github.push("main", { ".smithers/flows/ci/flow.ts": CI })
    const statusWrite = (method: string, path: string) => method === "POST" && path.endsWith(`/statuses/${sha}`)
    github.faults.push(
      { match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), status: 502 },
      { match: (method, path) => method === "GET" && path.includes("/contents/"), status: 502 },
      // The pending status is dropped; the result is sent on the second try.
      { match: statusWrite, status: 502 },
      { match: statusWrite, status: 502 },
    )
    const box = machine()
    expect((await run(github, box, request(sha), { databaseFailures: 1 })).exit).toEqual(Exit.succeed({
      state: "success",
      outcome: "sent",
      jobs: [{ name: "versions", outcome: "passed" }, { name: "lint", outcome: "passed" }],
    }))
    expect(github.statuses.get(sha)!.map(({ state }) => state)).toEqual(["success"])
  })

  test("a read GitHub refuses, and a status it refuses, are recorded and not tried again", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const sha = github.push("main", { ".smithers/flows/ci/flow.ts": CI })
    github.faults.push(
      { match: (method, path) => method === "GET" && path.includes("/contents/"), status: 451 },
      { match: (method, path) => method === "POST" && path.endsWith(`/statuses/${sha}`), status: 422 },
    )
    const box = machine()
    expect((await run(github, box, request(sha))).exit).toEqual(Exit.succeed({ state: "failure", outcome: "refused", jobs: [] }))
    expect(box.commands).toEqual([])
  })

  test("a flow.ts GitHub answers as a directory is unreadable, and nothing runs", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const sha = github.push("main", { ".smithers/flows/ci/flow.ts/index.ts": CI })
    const box = machine()
    expect((await run(github, box, request(sha))).exit).toEqual(Exit.succeed({ state: "failure", outcome: "sent", jobs: [] }))
    expect(github.statuses.get(sha)!.at(-1)!.description).toBe("Couldn't run the flow (unreadable)")
  })
})
