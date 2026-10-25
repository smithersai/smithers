// `pnpm eval`: a TODO with a two-line lint fix publishes within its budget, checking only its package (the dogfood
// loop's T3, todo:7844cd5e, timed out at 40 minutes on 2026-10-22 without publishing: it installed the monorepo and
// wrote its own check script). The `todo` run's real agent works with the real model (the deployment's default,
// `CHAT_MODEL`, metered by the model endpoint as in production) on evals/todoLint.ts' repository: a real git checkout
// on a real box (worker/test/box.ts), whose commands run as real processes with no registry, as a branch's machine
// has none: pnpm's registry is a port that accepts and never answers, and its store is empty. The engine is the Node
// host's over Postgres and the GitHub is scripted. Nothing about the model is scripted. Two cases: the package's scripts
// run with nothing installed, so the agent checks its fix and publishes; or they need `tsc`, which isn't installed, as
// in production, so the agent publishes without installing and the pull request's checks run them.
//
//   EVAL_ONLY=todo-lint        run only this eval (any EVAL_ONLY without it skips it)
//   EVAL_K=3                   trials (1 unless set); the eval passes when every trial does
import { Agent } from "@smthrs/agent"
import { Model } from "@smthrs/model"
import { HostModel } from "@smthrs/model-host"
import { EgressHttpClient } from "@smthrs/platform-node"
import { ConfigProvider, Effect, Exit, Layer, Scope, Stream } from "effect"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { todoExecutionId } from "../src/features/pulls/contract.ts"
import { Machines } from "../worker/branch/Machines.ts"
import * as SandboxCommand from "../worker/flows/SandboxCommand.ts"
import * as Todo from "../worker/flows/Todo.ts"
import * as TodoAgent from "../worker/flows/TodoAgent.ts"
import { REPOSITORY, reset, services as githubServices, sql } from "../worker/github/test/fixtures.ts"
import { scriptedGitHub } from "../worker/github/test/scriptedGitHub.ts"
import * as ModelEndpoint from "../worker/ModelEndpoint.ts"
import { PersonalModels } from "../worker/personal/Models.ts"
import * as Stack from "../worker/stack/Stack.ts"
import * as Box from "../worker/test/box.ts"
import { runFlow } from "../worker/test/flowHost.ts"
import { testFile } from "../worker/test/harness.ts"
import { defaultModel } from "./session"
import {
  BUDGET_MS,
  type Call,
  checkedAfterWrite,
  filesOf,
  FIXED_FILE,
  isTheFix,
  projectedMs,
  strayWrite,
  TODO,
  wideBecause,
  writesOf,
} from "./todoLint.ts"

const NAME = "todo-lint"
const only = (process.env.EVAL_ONLY ?? "").split(",").filter((name) => name !== "")
const TRIALS = Number(process.env.EVAL_K ?? "1")

const runtime = testFile("eval_todo_lint")
const TSC = createRequire(import.meta.url).resolve("typescript/lib/tsc.js")
const maya = { id: "person-maya", login: "maya" }

/** What one trial did, and how long production would have taken to do it. */
interface Trial {
  /** Whether the package's scripts could run on the machine. */
  readonly installed: boolean
  readonly exit: "merged" | "other" | "over budget"
  readonly ms: number
  readonly modelMs: number
  readonly modelCalls: number
  /** The tokens the model endpoint metered for the trial. */
  readonly tokens: { readonly input: number; readonly output: number }
  readonly projectedMs: number
  readonly calls: ReadonlyArray<Call>
  /** Each command that wasn't a narrow check, and why; each write outside the TODO's file. */
  readonly wide: ReadonlyArray<string>
  readonly stray: ReadonlyArray<string>
  /** The files the merged change touched, and whether the package's lint and typecheck pass on the merged tree. */
  readonly changed: ReadonlyArray<string>
  /** Whether the merged file is the fix the TODO asks for, and whether TypeScript compiles the package as merged. */
  readonly fix: boolean
  readonly lint: number | null
  readonly check: number | null
  readonly tsc: number | null
  /** Whether the agent ran the package's lint and typecheck after its fix. */
  readonly checked: { readonly lint: boolean; readonly check: boolean }
}

/** A git repository at `root` holding `files`, committed on main. */
const repository = (root: string, files: Readonly<Record<string, string>>) => {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  const git = (...args: Array<string>) => execFileSync("git", args, { cwd: root, stdio: "ignore" })
  git("init", "--quiet", "--initial-branch=main")
  git("add", "-A")
  git("-c", "user.name=maya", "-c", "user.email=maya@example.com", "commit", "--quiet", "-m", "base")
}

/** A registry that accepts connections and never answers, as a branch machine's missing internet looks to pnpm. */
const blackHole = () =>
  new Promise<Server>((resolve) => {
    const server = createServer(() => {})
    server.listen(0, "127.0.0.1", () => resolve(server))
  })

const trial = async (real: HostModel["Service"], installed: boolean): Promise<Trial> => {
  const FILES = filesOf(installed)
  const started = Date.now()
  await reset(runtime)
  await sql(runtime, "TRUNCATE stack_ops, todo_attempts, todo_requests, todos, stacks, pulls, pull_commits, reviews, runs, model_usage")
  const scratch = mkdtempSync(join(tmpdir(), "todo-lint-"))
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.push("main", FILES, "maya")
  github.onPullOpened = (number) => void github.merge(number, "maya")
  // The branch's machine: a checkout whose origin is the repository, as the forge serves it to a real machine.
  const origin = join(scratch, "origin")
  repository(origin, FILES)
  const workdir = join(scratch, "checkout")
  execFileSync("git", ["clone", "--quiet", origin, workdir])
  const box = Box.boxAt({ workdir, homes: join(scratch, "homes") })
  const calls: Array<Call> = []
  const startedAt = new Map<string, number>()
  const machine = Box.machinesOn(box.box)
  // Every tool call the agent and todo/Collect make, as the machine receives it; a command's job starts once per call.
  const recorded = Machines.of({
    ...machine,
    tool: (branch, ownerId, callId, call) => {
      calls.push(call.tool === "write" ? { tool: "write", path: call.path } : { tool: call.tool } as Call)
      return machine.tool(branch, ownerId, callId, call)
    },
    commands: (branch, ownerId, callId) => {
      const operations = machine.commands(branch, ownerId, callId)
      return {
        ...operations,
        start: (call, key) => Effect.suspend(() => {
          startedAt.set(key, calls.push({ tool: "run", command: call.command, cwd: call.cwd }) - 1)
          return operations.start(call, key)
        }),
        // How the command exited, on the call it was started for.
        collect: (key) => Effect.tap(operations.collect(key), (result) => Effect.sync(() => {
          const at = startedAt.get(key)
          const call = at === undefined ? undefined : calls[at]
          if (call?.tool === "run") calls[at!] = { ...call, exitCode: result.exitCode }
        })),
      }
    },
  })
  const { services } = await githubServices(runtime, github)
  const database = await runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))
  let modelMs = 0
  let modelCalls = 0
  // The real model, timed: production's model time is the trial's own.
  const model = Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        modelCalls++
        const at = Date.now()
        return real.model.stream(request).pipe(Stream.ensuring(Effect.sync(() => void (modelMs += Date.now() - at))))
      }),
  })
  const seat = await Effect.runPromise(
    ModelEndpoint.local(database, { hosted: true }).pipe(
      Effect.provideService(HostModel, HostModel.of({ ...real, model })),
      Effect.provide(PersonalModels.none),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ),
  )
  const registration = Layer.mergeAll(
    Todo.registration(
      { database: services.database, tokens: services.tokens, http: services.http, apiBaseUrl: services.apiBaseUrl, start: () => Effect.void },
      TodoAgent.registration(seat("agent"), database, Agent.layerSandbox),
    ),
    SandboxCommand.registration,
  ).pipe(Layer.provide(Layer.succeed(Machines, recorded)))
  const start = await runtime.runPromise(
    Effect.map(
      Stack.apply({
        opId: crypto.randomUUID(),
        repoId: REPOSITORY.id,
        actor: maya,
        via: "person",
        op: { kind: "commit", ...TODO },
      }, { runs: true }),
      (applied) => (applied.kind === "applied" ? applied.receipt.starts[0] : undefined),
    ),
  )
  if (start === undefined) throw new Error("the TODO's run didn't start")
  try {
    // A run past the budget has failed already; the eval stops it there rather than wait out the step's own timeout.
    // Stopped (interrupted, its runtime closed) before the next trial resets the database.
    const budget = AbortSignal.timeout(BUDGET_MS)
    const ran = await runFlow(Todo.Todo, start, registration, { executionId: todoExecutionId(start.attemptId), signal: budget })
      .catch((error: unknown) => {
        if (budget.aborted) return undefined
        throw error
      })
    const merged = new Map(github.tree("main"))
    const changed = [...new Set([...merged.keys(), ...Object.keys(FILES)])]
      .filter((path) => merged.get(path) !== FILES[path]).sort()
    // The package's own checks on what merged, as the pull request's checks would run them once installed.
    const result = join(scratch, "merged")
    for (const [path, contents] of merged) {
      mkdirSync(dirname(join(result, path)), { recursive: true })
      writeFileSync(join(result, path), contents)
    }
    const [usage] = await sql(
      runtime,
      "SELECT coalesce(sum(input_tokens), 0)::int AS input, coalesce(sum(output_tokens), 0)::int AS output FROM model_usage",
    ) as unknown as ReadonlyArray<{ readonly input: number; readonly output: number }>
    const script = (name: string) =>
      spawnSync("node", [`../../tools/${name}.mjs`, "src"], { cwd: join(result, "packages/widgets") }).status
    // TypeScript's own compiler, which the eval's host has, on the package as merged.
    const tsc = spawnSync("node", [TSC, "-p", "packages/widgets"], { cwd: result }).status
    return {
      installed,
      exit: ran === undefined
        ? "over budget"
        : Exit.isSuccess(ran.exit) && (ran.exit.value as { state?: string }).state === "merged"
        ? "merged"
        : "other",
      ms: Date.now() - started,
      modelMs,
      modelCalls,
      tokens: { input: usage?.input ?? 0, output: usage?.output ?? 0 },
      projectedMs: projectedMs(calls, modelMs),
      calls,
      wide: calls.flatMap((call) => {
        const why = call.tool === "run" ? wideBecause(call.command) : undefined
        return why === undefined || call.tool !== "run" ? [] : [`${call.command}: ${why}`]
      }),
      stray: calls.flatMap((call) =>
        writesOf(call).flatMap((path) => {
          const why = strayWrite(path)
          return why === undefined ? [] : [why]
        })
      ),
      changed,
      fix: isTheFix(merged.get(FIXED_FILE)),
      lint: script("lint"),
      check: script("check"),
      tsc,
      checked: checkedAfterWrite(calls),
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

test.skipIf(only.length > 0 && !only.includes(NAME))(
  "todo-lint: a two-line lint fix publishes within its budget, checking only its package",
  async () => {
    // A branch's machine has no internet: the registry never answers, and pnpm's store and npm's cache are empty.
    const registry = await blackHole()
    const store = mkdtempSync(join(tmpdir(), "todo-lint-store-"))
    const address = registry.address() as { readonly port: number }
    // pnpm 11 reads its settings from `pnpm_config_*`, earlier versions from `npm_config_*`.
    process.env.npm_config_registry = process.env.pnpm_config_registry = `http://127.0.0.1:${address.port}/`
    process.env.npm_config_store_dir = process.env.pnpm_config_store_dir = store
    process.env.npm_config_cache = join(store, "npm-cache")
    // Nor has it the eval's own tools: no `node_modules/.bin` (this host's `tsc`) on the commands' PATH.
    process.env.PATH = (process.env.PATH ?? "").split(delimiter).filter((entry) => !entry.includes("node_modules")).join(delimiter)
    const fetch = await Effect.runPromise(Scope.provide(Effect.runSync(Scope.make()))(EgressHttpClient.providerFetch(process.env)))
    const real = await Effect.runPromise(defaultModel(fetch))
    const trials: Array<Trial> = []
    try {
      for (let n = 0; n < TRIALS; n++) for (const installed of [true, false]) trials.push(await trial(real, installed))
    } finally {
      registry.close()
      rmSync(store, { recursive: true, force: true })
    }
    const results = new URL("results/", import.meta.url)
    mkdirSync(results, { recursive: true })
    writeFileSync(
      new URL(`${NAME}-${new Date().toISOString().replaceAll(":", "-")}.json`, results),
      `${JSON.stringify({ eval: NAME, model: real.modelId, budgetMs: BUDGET_MS, trials }, null, 2)}\n`,
    )
    // Every trial merged the fix the TODO asks for alone, its package's checks and TypeScript pass on it, it ran no install, no declared check script
    // and no check of every package, it wrote nothing but the fix, and production would have taken under the budget.
    // Where the package's scripts can run, its lint and its typecheck passed on the agent's machine after its last write.
    expect(trials.map((t) => ({
      exit: t.exit,
      changed: t.changed,
      fix: t.fix,
      lint: t.lint,
      check: t.check,
      tsc: t.tsc,
      wide: t.wide,
      stray: t.stray,
      inBudget: t.ms <= BUDGET_MS && t.projectedMs <= BUDGET_MS,
      checked: t.installed ? t.checked : "can't run",
    }))).toEqual(trials.map((t) => ({
      exit: "merged",
      changed: [FIXED_FILE],
      fix: true,
      lint: 0,
      check: 0,
      tsc: 0,
      wide: [],
      stray: [],
      inBudget: true,
      checked: t.installed ? { lint: true, check: true } : "can't run",
    })))
  },
)
