// A pull request head's checks (worker/flows/Checks.ts, decision 0012 decision 12) on the Node host's engine over this
// file's schema of the compose Postgres, against the scripted GitHub. The branch's machine is a test `Machines` over an
// in-memory checkout of the head, and the judge behind the review is a scripted model admitted and metered by the
// model endpoint's own `ModelEndpoint.local`: the only stand-ins. Each check is a `runs` row on the head's SHA.
import { Model, ModelError, type ModelEvent } from "@smthrs/model"
import { SandboxTools } from "@smthrs/sandbox"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/flows"
import { Context, Effect, Exit, Fiber, Layer, Redacted, Scope, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import { checkExecutionId } from "../../src/features/pulls/contract.ts"
import { COMMAND_LIMIT_SECONDS } from "../../src/features/sandbox/contract.ts"
import { Machines } from "../branch/Machines.ts"
import { instantCommands, noCommands } from "../test/commands.ts"
import { CheckoutFailed, SandboxUnavailable } from "../branch/Sandboxes.ts"
import { judgeSeat, REPOSITORY, reset, services as githubServices, signedIn, sql } from "../github/test/fixtures.ts"
import { BOT_LOGIN, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as Box from "../test/box.ts"
import { build, runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Checks from "./Checks.ts"
import * as SandboxCommand from "./SandboxCommand.ts"

const runtime = testFile("checks_run")
const boxes = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-checks-box-")))
afterAll(() => rmSync(boxes, { recursive: true, force: true }))

/** The checks' registration beside the `sandbox/Command` jobs their scripts run as, which the deployed host registers. */
const withJobs = <A, E, R>(registration: Layer.Layer<A, E, R>) => Layer.mergeAll(registration, SandboxCommand.registration)
beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE pulls, pull_commits, reviews, runs")
})

/** A machine whose checkout holds `files`, whose `sh <path>` exits with `exits[path]` (0 unless set). */
const machine = (files: Readonly<Record<string, string>>, exits: Readonly<Record<string, number>> = {}, sync = 0) => {
  const commands: Array<string> = []
  const timeouts: Array<number | undefined> = []
  const branches = new Set<string>()
  const sleeps: Array<{ readonly branchId: string; readonly generation: number; readonly idleMs: number }> = []
  const exitOf = (command: string) => exits[command.replace(/^sh /, "")] ?? 0
  const results = new Map()
  const service = Machines.of({
    // Each script runs as its own `sandbox/Command` job: it starts once per key and finishes at once.
    commands: (branch) =>
      instantCommands(exitOf, (_key, call) => {
        branches.add(JSON.stringify(branch))
        commands.push(call.command)
        timeouts.push(call.timeoutSeconds)
      }, results),
    tool: (branch, _owner, _callId, call) => {
      branches.add(JSON.stringify(branch))
      const done = (result: SandboxTools.Result) => Effect.succeed({ result, generation: 1 })
      if (call.tool === "list") {
        const prefix = `${call.path}/`
        const names = Object.keys(files).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length))
        if (names.length === 0) {
          return Effect.fail({ _tag: "@smthrs/sandbox/SandboxTools/ToolRefused", reason: "not_found" } as never)
        }
        return done({
          tool: "list",
          path: call.path!,
          entries: [...names.map((name) => ({ name, kind: "file" as const, bytes: 1 })), {
            name: "nested",
            kind: "directory" as const,
            bytes: 0,
          }],
          truncated: false,
        })
      }
      if (call.tool === "run") {
        commands.push(call.command)
        const path = call.command.replace(/^sh /, "")
        const exitCode = call.command.startsWith("git ") ? sync : exits[path] ?? 0
        return done({
          tool: "run",
          exitCode,
          timedOut: false,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          truncated: false,
        })
      }
      return Effect.die(`checks never call ${call.tool}`)
    },
    sleepIfIdle: (branchId, generation, idleMs) =>
      Effect.sync(() => {
        sleeps.push({ branchId, generation, idleMs })
        return "slept" as const
      }),
  })
  return { commands, timeouts, branches, sleeps, layer: Layer.succeed(Machines, service) }
}

/** A judge that answers `text` once per call. */
const judge = (text: string) => () =>
  Stream.fromIterable<ModelEvent.ModelEvent>([
    { type: "text-delta", id: "t", text },
    { type: "usage", inputTokens: 30, outputTokens: 5 },
    { type: "settle", stopReason: "stop" },
  ])

/** A pull request from `feature` that adds a line to README.md, opened by the App; answers the request for its checks. */
const opened = async (github: ReturnType<typeof scriptedGitHub>, owner: { readonly personId: string }) => {
  const base = github.refs.get("main")!
  const head = github.push("smithers/t1-readme", { "README.md": "# Widgets\n\nA line\n" })
  const pull = github.openPull("smithers/t1-readme", "T1: README", BOT_LOGIN)
  return {
    repoId: REPOSITORY.id,
    sha: head,
    prNumber: pull.number,
    baseSha: base,
    attemptId: crypto.randomUUID(),
    branch: "smithers/t1-readme",
    ownerId: owner.personId,
  } satisfies Checks.ChecksRequest
}

const runs = () =>
  sql(runtime, `SELECT flow, status, sha, launched_by AS "launchedBy" FROM runs ORDER BY flow`) as unknown as Promise<
    Array<{ flow: string; status: string; sha: string; launchedBy: string }>
  >

describe("checks/Run", { timeout: 60_000 }, () => {
  test("runs each script for as long as the deployment lets a command run, never a fixed 600 s", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("- nothing."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    const timeouts = async (registration: ReturnType<typeof Checks.registration>, sha: string) => {
      const box = machine({ ".smithers/checks/readme.sh": "" })
      await runFlow(Checks.ChecksRun, { ...request, sha }, withJobs(registration).pipe(Layer.provide(box.layer)), {
        executionId: checkExecutionId(request.repoId, sha, "all"),
      })
      return box.timeouts
    }
    // SANDBOX_COMMAND_MAX_SECONDS at 1,800, and unset: the job's own limit, an hour.
    expect(await timeouts(Checks.registration({ ...services, reviewerFor: () => seat }, 1_800), request.sha)).toEqual([1_800])
    const other = github.push("smithers/t1-readme", { "README.md": "# Widgets\n\nA line.\n" })
    expect(await timeouts(Checks.registration({ ...services, reviewerFor: () => seat }), other)).toEqual([COMMAND_LIMIT_SECONDS])
  })

  test("runs each .smithers/checks script on the head, then the review, each a run on the head's SHA", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat, requests } = await judgeSeat(runtime, judge("- README.md: the line has no period."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    const box = machine({ ".smithers/checks/readme.sh": "", ".smithers/checks/lint.sh": "", ".smithers/checks/x.txt": "" }, {
      ".smithers/checks/lint.sh": 1,
    })
    // The review is its TODO owner's: the reviewer is asked for as theirs (decisions 0099 and 0107).
    const owners: Array<string> = []
    const reviewerFor = (ownerId: string) => {
      owners.push(ownerId)
      return seat
    }
    const ran = await runFlow(Checks.ChecksRun, request, withJobs(Checks.registration({ ...services, reviewerFor })).pipe(
      Layer.provide(box.layer),
    ), { executionId: checkExecutionId(request.repoId, request.sha, "all") })
    expect(owners).toEqual([request.ownerId])

    expect(ran.exit).toEqual(Exit.succeed({
      statuses: [
        { name: "lint", state: "failure", outcome: "sent" },
        { name: "readme", state: "success", outcome: "sent" },
        { name: "review", state: "success", outcome: "sent" },
      ],
    }))
    // Each check reports running, then its result, on the head as the App (GH-10); Smithers never reads one back.
    expect(github.statuses.get(request.sha)!.map(({ context, state, description, login }) => [context, state, description, login]))
      .toEqual([
        ["smithers/lint", "pending", "Running", BOT_LOGIN],
        ["smithers/readme", "pending", "Running", BOT_LOGIN],
        ["smithers/lint", "failure", "Failed", BOT_LOGIN],
        ["smithers/readme", "success", "Passed", BOT_LOGIN],
        ["smithers/review", "pending", "Running", BOT_LOGIN],
        ["smithers/lint", "failure", "Failed", BOT_LOGIN],
        ["smithers/readme", "success", "Passed", BOT_LOGIN],
        ["smithers/review", "success", "Passed", BOT_LOGIN],
      ])
    expect(github.shownStatuses(request.sha)).toEqual({
      "smithers/lint": "failure",
      "smithers/readme": "success",
      "smithers/review": "success",
    })
    expect(github.seen("GET", /statuses/)).toEqual([])
    // Its token may write commit statuses and nothing else.
    expect(github.minted.map(({ body }) => (body as { permissions: unknown }).permissions)).toContainEqual({ statuses: "write" })
    expect(await runs()).toEqual([
      { flow: "checks/lint", status: "failed", sha: request.sha, launchedBy: maya.personId },
      { flow: "checks/readme", status: "done", sha: request.sha, launchedBy: maya.personId },
      { flow: "checks/review", status: "done", sha: request.sha, launchedBy: maya.personId },
    ])
    expect(box.commands).toEqual([
      `git fetch --quiet origin 'smithers/t1-readme' && git reset --quiet --hard ${request.sha} && git clean -fdq`,
      "sh .smithers/checks/lint.sh",
      "sh .smithers/checks/readme.sh",
    ])
    // On the head's own throwaway job machine, never the TODO's: a check job, put to sleep once its scripts ran.
    const job = Checks.jobMachineOf(request)
    expect([...box.branches].map((branch) => JSON.parse(branch))).toEqual([job.branch])
    expect(job.branch).toEqual({
      branchId: expect.stringMatching(/^job-[0-9a-f]{40}$/),
      owner: REPOSITORY.owner,
      name: REPOSITORY.name,
      branch: "smithers/t1-readme",
      forge: "github",
      kind: "job",
    })
    expect(box.sleeps).toEqual([{ branchId: job.branch.branchId, generation: 1, idleMs: 0 }])
    // One comment review as the App, on the head, never an approval; its body names whom it acted for.
    const reviews = github.pulls.get(request.prNumber)!.reviews
    expect(reviews.map((review) => [review.event, review.login, review.commitId])).toEqual([["COMMENT", BOT_LOGIN, request.sha]])
    expect(reviews[0]!.body).toContain("- README.md: the line has no period.")
    expect(reviews[0]!.body).toContain("Reviewed by Smithers for @maya (review).")
    // The judge read the diff.
    expect(JSON.stringify(requests[0])).toContain("+A line")
    // The pull request's page shows the review from the projection.
    expect(await sql(runtime, `SELECT state, author_login AS "author", commit_sha AS "commitSha" FROM reviews`)).toEqual([
      { state: "COMMENTED", author: BOT_LOGIN, commitSha: request.sha },
    ])
  })

  test("with no checks directory only the review runs; a run again changes nothing", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("No findings."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    const registration = withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(Layer.provide(machine({}).layer))
    await runFlow(Checks.ChecksRun, request, registration)
    await runFlow(Checks.ChecksRun, request, registration)
    expect((await runs()).map(({ flow, status }) => [flow, status])).toEqual([["checks/review", "done"]])
    expect(github.pulls.get(request.prNumber)!.reviews).toHaveLength(1)
  })

  test("a judge that fails, or answers nothing, fails the review check and posts nothing", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("   "))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    const ran = await runFlow(Checks.ChecksRun, request, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(machine({}).layer),
    ))
    expect(ran.exit).toEqual(Exit.succeed({ statuses: [{ name: "review", state: "failure", outcome: "sent" }] }))
    expect(github.shownStatuses(request.sha)).toEqual({ "smithers/review": "failure" })
    expect(await runs()).toEqual([{ flow: "checks/review", status: "failed", sha: request.sha, launchedBy: maya.personId }])
    expect(github.pulls.get(request.prNumber)!.reviews).toHaveLength(0)
  })

  test("without the App, the review fails, and the scripts still run", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("x"))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    github.installed = false
    await runFlow(Checks.ChecksRun, request, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(machine({ ".smithers/checks/a.sh": "" }).layer),
    ))
    expect((await runs()).map(({ flow, status }) => [flow, status])).toEqual([["checks/a", "done"], ["checks/review", "failed"]])
    // No App, no token: no status is sent, and the runs keep the results.
    expect(github.statuses.size).toBe(0)
  })

  test("a judge the provider refuses fails the review check and posts nothing", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, () =>
      Stream.fail(new ModelError.ModelError({ code: "content_policy", message: "refused" })))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    const ran = await runFlow(Checks.ChecksRun, request, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(machine({}).layer),
    ))
    expect(ran.exit).toEqual(Exit.succeed({ statuses: [{ name: "review", state: "failure", outcome: "sent" }] }))
    expect(github.pulls.get(request.prNumber)!.reviews).toHaveLength(0)
  })

  test("a branch or head that isn't one, or a checkout that fails, runs no script: the head's checkout check fails", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("No findings."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    const invalid = machine({ ".smithers/checks/a.sh": "" })
    await runFlow(Checks.ChecksRun, { ...request, branch: "not a branch" }, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(invalid.layer),
    ))
    expect(invalid.commands).toEqual([])
    expect((await runs()).map(({ flow, status }) => [flow, status])).toEqual([["checks/checkout", "failed"], ["checks/review", "done"]])
    expect(github.shownStatuses(request.sha)).toMatchObject({ "smithers/checkout": "failure" })
    // The head moved past what the forge serves: the reset fails, so no script runs on some other commit.
    await sql(runtime, "TRUNCATE runs")
    const unsynced = machine({ ".smithers/checks/a.sh": "" }, {}, 128)
    await runFlow(Checks.ChecksRun, request, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(Layer.provide(unsynced.layer)))
    expect(unsynced.commands).toHaveLength(1)
    expect((await runs()).map(({ flow, status }) => [flow, status])).toEqual([["checks/checkout", "failed"], ["checks/review", "done"]])
    // A clone the forge refused fails the checkout the same way.
    await sql(runtime, "TRUNCATE runs")
    const refused = Machines.of({
      commands: () => noCommands,
      tool: () => Effect.fail(new CheckoutFailed()),
      sleepIfIdle: () => Effect.die("a job that never checked out never sleeps"),
    })
    await runFlow(Checks.ChecksRun, request, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(Layer.succeed(Machines, refused)),
    ))
    expect((await runs()).map(({ flow, status }) => [flow, status])).toEqual([["checks/checkout", "failed"], ["checks/review", "done"]])
  })

  test("a check the machine can't run fails; an unknown owner is named so", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { seat } = await judgeSeat(runtime, judge("- a finding"))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, { personId: crypto.randomUUID() })
    const commands: Array<string> = []
    // The machine can't run the script: its session fails as a script step that can't be tried again does.
    const cannot = () => Effect.fail(new SandboxTools.ToolUnavailable({ code: "unknown", exitCode: 125 }))
    const box = Machines.of({
      commands: () => ({ start: cannot, observe: cannot, collect: cannot, cancel: cannot }),
      tool: (_branch, _owner, _callId, call) => {
        const done = (result: SandboxTools.Result) => Effect.succeed({ result, generation: 1 })
        if (call.tool === "list") {
          return done({ tool: "list", path: call.path!, entries: [{ name: "a.sh", kind: "file", bytes: 1 }], truncated: false })
        }
        if (call.tool === "run" && call.command.startsWith("git ")) {
          commands.push(call.command)
          return done({ tool: "run", exitCode: 0, timedOut: false, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, truncated: false })
        }
        return Effect.fail(new SandboxUnavailable({ reason: "exec" }))
      },
      // A machine that can't sleep stays awake: the checks' results stand.
      sleepIfIdle: () => Effect.fail(new SandboxUnavailable({ reason: "exec" })),
    })
    await runFlow(Checks.ChecksRun, request, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(Layer.succeed(Machines, box)),
    ))
    expect(commands).toHaveLength(1)
    expect((await runs()).map(({ flow, status }) => [flow, status])).toEqual([["checks/a", "failed"], ["checks/review", "done"]])
    expect(github.pulls.get(request.prNumber)!.reviews[0]!.body).toContain("Reviewed by Smithers for @unknown (review).")
  })

  test("a job machine that can't start fails the scripts step for its retry policy, runs no script and isn't put to sleep", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("No findings."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    const sleeps: Array<string> = []
    const down = Machines.of({
      commands: () => noCommands,
      tool: () => Effect.fail(new SandboxUnavailable({ reason: "start" })),
      sleepIfIdle: (branchId) => Effect.sync(() => (sleeps.push(branchId), "slept" as const)),
    })
    const exit = await Effect.runPromise(
      Effect.exit(Checks.steps({ ...services, reviewerFor: () => seat }).scripts({ request })).pipe(
        Effect.provide(Layer.succeed(Machines, down)),
      ),
    )
    expect(exit._tag === "Failure" && String(exit.cause)).toContain("ChecksUnavailable")
    expect(await runs()).toEqual([])
    expect(sleeps).toEqual([])
  })

  test("two repositories whose names split differently never share a job machine", () => {
    const base = { sha: "a".repeat(40), prNumber: 1, baseSha: "b".repeat(40), attemptId: "x", branch: "main", ownerId: "p" }
    const one = Checks.jobMachineOf({ ...base, repoId: "github/acme/tools-ui" }).branch
    const other = Checks.jobMachineOf({ ...base, repoId: "github/acme-tools/ui" }).branch
    expect(one.branchId).not.toBe(other.branchId)
    expect([one.owner, one.name, other.owner, other.name]).toEqual(["acme", "tools-ui", "acme-tools", "ui"])
  })

  test("Postgres down fails the scripts step for its retry policy", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const { seat } = await judgeSeat(runtime, judge("x"))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, { personId: "p" })
    const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
    const exit = await Effect.runPromise(
      Effect.exit(Checks.steps({ ...services, reviewerFor: () => seat, database: unreachable }).scripts({ request })).pipe(
        Effect.provide(machine({ ".smithers/checks/a.sh": "" }).layer),
      ),
    )
    expect(exit._tag === "Failure" && String(exit.cause)).toContain("ChecksUnavailable")
  })

  test("a review whose answer was lost is found by its marker, not posted twice", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("- one finding"))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/reviews"), lost: true })
    await runFlow(Checks.ChecksRun, request, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(machine({}).layer),
    ))
    expect(github.pulls.get(request.prNumber)!.reviews).toHaveLength(1)
    expect((await runs()).map(({ status }) => status)).toEqual(["done"])
  })
})

// Dogfooding lints and type-checks the whole monorepo in one script, longer than one Cloudflare alarm may run.
describe("checks/Run on a host that dies mid-check", { timeout: 120_000 }, () => {
  test("a script outlives the engine that started it: it runs once, and its check settles once", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("No findings."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    // The job machine runs its script on a real box (a scratch checkout, real processes); git and the listing are the
    // in-memory machine's.
    const workdir = join(boxes, `checks-${crypto.randomUUID()}`)
    mkdirSync(join(workdir, ".smithers", "checks"), { recursive: true })
    writeFileSync(
      join(workdir, ".smithers", "checks", "slow.sh"),
      "echo ran >> runs.log; touch started; sleep 2; touch finished\n",
    )
    const real = Box.machinesOn(Box.boxAt({ workdir, homes: `${workdir}-homes` }).box)
    const fake = Context.get(
      await Effect.runPromise(Layer.build(machine({ ".smithers/checks/slow.sh": "" }).layer).pipe(Effect.scoped)),
      Machines,
    )
    const machines = Layer.succeed(Machines, Machines.of({
      tool: (branch, owner, callId, call) =>
        call.tool === "run" && call.command.startsWith("sh ")
          ? real.tool(branch, owner, callId, call)
          : fake.tool(branch, owner, callId, call),
      commands: real.commands,
      sleepIfIdle: fake.sleepIfIdle,
    }))
    const registration = withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(Layer.provide(machines))
    const executionId = checkExecutionId(request.repoId, request.sha, "all")
    const engine = async (schema?: string) => {
      const scope = Effect.runSync(Scope.make())
      const built = await Effect.runPromise(
        Scope.provide(scope)(
          build(registration, {
            hostId: "durable-object",
            isAlive: RunStore.Ownership.singleIncarnationLiveness,
            maxConnections: 3,
            ...(schema === undefined ? {} : { schema }),
          }),
        ),
      )
      const execute = Context.get(built.context, FlowRuntime.FlowRuntime).execute(Checks.ChecksRun, {
        executionId,
        payload: request,
      }).pipe(Effect.provide(built.context)) as Effect.Effect<unknown, unknown>
      return { built, execute, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
    }

    const first = await engine()
    const running = Effect.runFork(Effect.exit(first.execute))
    // The host dies while the script runs: its connections cut, its fibers stopped, its exec sessions closed.
    await expect.poll(() => existsSync(join(workdir, "started")), { interval: 10, timeout: 60_000 }).toBe(true)
    expect(existsSync(join(workdir, "finished"))).toBe(false)
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (client) =>
        client`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND query LIKE ${`%${first.built.engine.schema}%`}`),
    )
    await Effect.runPromise(Fiber.interrupt(running))
    await first.close()
    const second = await engine(first.built.engine.schema)
    const resumed = await Effect.runPromise(Effect.exit(second.execute))
    await second.close()
    // A fresh run against the same check receipts must not settle or execute the script twice.
    const repeated = await runFlow(Checks.ChecksRun, request, registration)
    expect(Exit.isSuccess(repeated.exit)).toBe(true)

    expect(Exit.isSuccess(resumed) && (resumed.value as Checks.Reported).statuses).toEqual(expect.arrayContaining([
      { name: "slow", state: "success", outcome: "sent" },
      { name: "review", state: "success", outcome: "sent" },
    ]))
    // The script ran once, and its check settled once: Passed.
    expect(readFileSync(join(workdir, "runs.log"), "utf8")).toBe("ran\n")
    expect((await runs()).map(({ flow, status }) => [flow, status])).toEqual([["checks/review", "done"], ["checks/slow", "done"]])
  })
})

describe("checks/Run's commit statuses (GH-10)", { timeout: 60_000 }, () => {
  const statusWrite = (method: string, path: string) => method === "POST" && path.includes("/statuses/")

  test("without the Commit statuses permission every check still runs; each status is refused once and counted, never retried", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.statusesGranted = false
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("No findings."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    const ran = await runFlow(Checks.ChecksRun, request, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(machine({ ".smithers/checks/lint.sh": "" }).layer),
    ))
    expect(ran.exit).toEqual(Exit.succeed({
      statuses: [
        { name: "lint", state: "success", outcome: "refused" },
        { name: "review", state: "success", outcome: "refused" },
      ],
    }))
    expect((await runs()).map(({ flow, status }) => [flow, status])).toEqual([["checks/lint", "done"], ["checks/review", "done"]])
    expect(github.statuses.size).toBe(0)
    expect(github.seen("POST", /statuses/)).toEqual([])
  })

  test("a commit GitHub doesn't have refuses the report, and the runs keep the results", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("No findings."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    const report = await Effect.runPromise(
      Checks.steps({ ...services, reviewerFor: () => seat }).report({ request: { ...request, sha: "f".repeat(40) }, after: "scripts" }),
    )
    expect(report).toEqual({ statuses: [] })
    await sql(runtime, `INSERT INTO runs (id, flow, status, launched_by, repo_id, sha)
      VALUES (gen_random_uuid(), 'checks/lint', 'done', '${maya.personId}', '${request.repoId}', '${"f".repeat(40)}')`)
    expect(
      await Effect.runPromise(
        Checks.steps({ ...services, reviewerFor: () => seat }).report({ request: { ...request, sha: "f".repeat(40) }, after: "scripts" }),
      ),
    ).toEqual({ statuses: [{ name: "lint", state: "success", outcome: "refused" }] })
    expect(github.statuses.size).toBe(0)
  })

  test("GitHub's 502 drops a pending status and fails the report for its retry policy; retried, the head shows each result", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("No findings."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    // The first status write is lint's pending, dropped; the second is the scripts' report, which the engine retries.
    github.faults.push({ match: statusWrite, status: 502 }, { match: statusWrite, status: 502 })
    const ran = await runFlow(Checks.ChecksRun, request, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(machine({ ".smithers/checks/lint.sh": "" }, { ".smithers/checks/lint.sh": 2 }).layer),
    ))
    expect(Exit.isSuccess(ran.exit)).toBe(true)
    expect(github.statuses.get(request.sha)!.map(({ context, state }) => `${context} ${state}`)).toEqual([
      "smithers/lint failure",
      "smithers/review pending",
      "smithers/lint failure",
      "smithers/review success",
    ])
    expect(github.shownStatuses(request.sha)).toEqual({ "smithers/lint": "failure", "smithers/review": "success" })
  })

  test("a report whose answer was lost fails for its retry policy; sent again, it says the same thing", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("No findings."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    await sql(runtime, `INSERT INTO runs (id, flow, status, launched_by, repo_id, sha)
      VALUES (gen_random_uuid(), 'checks/lint', 'failed', '${maya.personId}', '${request.repoId}', '${request.sha}')`)
    github.faults.push({ match: statusWrite, lost: true })
    const steps = Checks.steps({ ...services, reviewerFor: () => seat })
    const first = await Effect.runPromise(Effect.exit(steps.report({ request, after: "scripts" })))
    expect(first._tag === "Failure" && String(first.cause)).toContain("ChecksUnavailable")
    expect(await Effect.runPromise(steps.report({ request, after: "scripts" }))).toEqual({
      statuses: [{ name: "lint", state: "failure", outcome: "sent" }],
    })
    expect(github.statuses.get(request.sha)!.map(({ state }) => state)).toEqual(["failure", "failure"])
    expect(github.shownStatuses(request.sha)).toEqual({ "smithers/lint": "failure" })
    // GitHub failing to mint the token fails the report for its retry policy too.
    github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), status: 502 })
    const unminted = await Effect.runPromise(Effect.exit(steps.report({ request, after: "review" })))
    expect(unminted._tag === "Failure" && String(unminted.cause)).toContain("ChecksUnavailable")
    expect(github.statuses.get(request.sha)).toHaveLength(2)
  })

  test("each head's statuses are its own: a newer head starts with none, and an older head's failure never shows on it", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("No findings."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const older = await opened(github, maya)
    await runFlow(Checks.ChecksRun, older, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(machine({ ".smithers/checks/lint.sh": "" }, { ".smithers/checks/lint.sh": 1 }).layer),
    ), { executionId: checkExecutionId(older.repoId, older.sha, "all") })
    const newer = { ...older, sha: github.push("smithers/t1-readme", { "README.md": "# Widgets\n\nA line.\n" }) }
    expect(github.shownStatuses(newer.sha)).toEqual({})
    await runFlow(Checks.ChecksRun, newer, withJobs(Checks.registration({ ...services, reviewerFor: () => seat })).pipe(
      Layer.provide(machine({ ".smithers/checks/lint.sh": "" }).layer),
    ), { executionId: checkExecutionId(newer.repoId, newer.sha, "all") })
    expect(github.shownStatuses(older.sha)).toEqual({ "smithers/lint": "failure", "smithers/review": "success" })
    expect(github.shownStatuses(newer.sha)).toEqual({ "smithers/lint": "success", "smithers/review": "success" })
  })

  test("a check still Running when its report comes, its step having given up, is failed and reported failed", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
    const { seat } = await judgeSeat(runtime, judge("No findings."))
    const { services } = await githubServices(runtime, github, { judge: seat })
    const request = await opened(github, maya)
    await sql(runtime, `INSERT INTO runs (id, flow, status, launched_by, repo_id, sha)
      VALUES (gen_random_uuid(), 'checks/review', 'working', '${maya.personId}', '${request.repoId}', '${request.sha}')`)
    expect(await Effect.runPromise(Checks.steps({ ...services, reviewerFor: () => seat }).report({ request, after: "review" }))).toEqual({
      statuses: [{ name: "review", state: "failure", outcome: "sent" }],
    })
    expect((await runs()).map(({ status }) => status)).toEqual(["failed"])
    expect(github.shownStatuses(request.sha)).toEqual({ "smithers/review": "failure" })
  })

  test("a check run's status is GitHub's: passed is success, anything else failure; the words are the Checks tab's", () => {
    expect([Checks.statusStateOf("done"), Checks.statusStateOf("failed")]).toEqual(["success", "failure"])
    expect(Checks.STATUS_DESCRIPTIONS).toEqual({ pending: "Running", success: "Passed", failure: "Failed" })
  })
})

describe("the review's text", () => {
  test("drops mentions and links from the findings, and says whom it acted for", () => {
    expect(Checks.reviewBodyOf(" - ping @everyone, see https://x.test/a ", "maya")).toBe(
      "- ping @​everyone, see (link removed)\n\nReviewed by Smithers for @maya (review).",
    )
  })

  test("the judge reads each file's patch, within the budget; a binary file says so", () => {
    const request = Checks.reviewRequest([
      { filename: "a.md", status: "modified", additions: 1, deletions: 0, patch: "+a" },
      { filename: "b.png", status: "added", additions: 0, deletions: 0 },
    ])
    const text = JSON.stringify(request.messages)
    expect(text).toContain("--- a.md (modified, +1 -0)\\n+a")
    expect(text).toContain("--- b.png (added, +0 -0)\\n(no textual diff)")
    const huge = Checks.reviewRequest([
      { filename: "big.md", status: "modified", additions: 1, deletions: 0, patch: "x".repeat(Checks.MAX_REVIEW_DIFF_CHARS + 10) },
      { filename: "late.md", status: "modified", additions: 1, deletions: 0, patch: "+late" },
    ])
    const hugeText = JSON.stringify(huge.messages)
    expect(hugeText).not.toContain("+late")
    expect(hugeText).toContain("--- late.md")
  })
})

test.each(["token", "github", "database"] as const)("a review %s outage remains retryable instead of recording a failed check", async (fault) => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const { seat } = await judgeSeat(runtime, judge("must not reach the judge"))
  const { services } = await githubServices(runtime, github, { judge: seat })
  const request = await opened(github, { personId: "p" })
  const { TokenUnavailable } = await import("../github/Tokens")
  const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
  if (fault === "github") github.faults.push({ match: (method, path) => method === "GET" && path.includes("/compare/"), status: 503 })
  const steps = Checks.steps({ ...services, reviewerFor: () => seat,
    ...(fault === "database" ? { database: unreachable } : {}),
    tokens: { ...services.tokens, forInstallation: (repo, purpose) => purpose === "review" && fault === "token"
      ? Effect.fail(new TokenUnavailable({ reason: "unavailable" })) : services.tokens.forInstallation(repo, purpose) },
  })
  // A no-retry test action exposes the durable step's error without spending the production retry deadline.
  const review = Action.make("test/ReviewFault/step", { payload: { request: Checks.ChecksRequest }, success: Checks.Checked, error: Checks.ChecksUnavailable })
  const flow = Flow.make("test/ReviewFault", { payload: { request: Checks.ChecksRequest }, success: Checks.Checked, error: Checks.ChecksUnavailable,
    body: Node.capture({ review: review.name }, (payload) => review.call(payload)),
  })
  const result = await runFlow(flow, { request }, Interpreter.layerWithImplementations(flow, review.toLayer(steps.review)).pipe(Layer.provideMerge(Action.layerImplementations)))
  expect(Exit.isFailure(result.exit)).toBe(true)
  expect(JSON.stringify(result.exit)).toContain("ChecksUnavailable")
  expect(github.pulls.get(request.prNumber)!.reviews).toEqual([])
})
