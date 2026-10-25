// `pnpm eval`: a person's steer against the TODO it changes (ruling TODO-3, docs/features/runs.md#steering). The `todo`
// run's real agent works with the real model (the deployment's default, `CHAT_MODEL`, metered by the model endpoint as in
// production) on a TODO that says "Change nothing else", and while its first turn is in flight the person asks it to add
// a second line. A steer is a newer instruction than the TODO, so the merged pull request must carry both lines. The
// run is the Node host's engine over Postgres, the GitHub is scripted and the branch's machine is in memory
// (worker/test/todoMachines.ts); the message is admitted to the run's queue through a journal of its own, as ChatApi's
// steer route admits it. Nothing about the model is scripted.
//
//   EVAL_ONLY=todo-steer       run only this eval (any EVAL_ONLY without it skips it)
//   EVAL_K=3                   trials (1 unless set); the eval passes when every trial does
import { Agent } from "@smthrs/agent"
import { Database as FlowsDatabase, Journal } from "@smthrs/flows"
import { Model } from "@smthrs/model"
import { HostModel } from "@smthrs/model-host"
import { Notification, NotificationQueue, SteerPayload } from "@smthrs/notifications"
import { EgressHttpClient } from "@smthrs/platform-node"
import { ConfigProvider, Effect, Exit, Layer, Scope, Stream } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { todoExecutionId } from "../src/features/pulls/contract.ts"
import * as ExecutionHost from "../worker/ExecutionHost.ts"
import * as Todo from "../worker/flows/Todo.ts"
import * as TodoAgent from "../worker/flows/TodoAgent.ts"
import * as SandboxCommand from "../worker/flows/SandboxCommand.ts"
import { REPOSITORY, reset, services as githubServices, sql } from "../worker/github/test/fixtures.ts"
import { scriptedGitHub } from "../worker/github/test/scriptedGitHub.ts"
import * as ModelEndpoint from "../worker/ModelEndpoint.ts"
import { PersonalModels } from "../worker/personal/Models.ts"
import * as Stack from "../worker/stack/Stack.ts"
import { runFlow } from "../worker/test/flowHost.ts"
import { testFile } from "../worker/test/harness.ts"
import { machines } from "../worker/test/todoMachines.ts"
import { defaultModel } from "./session"

const NAME = "todo-steer"
const only = (process.env.EVAL_ONLY ?? "").split(",").filter((name) => name !== "")
const TRIALS = Number(process.env.EVAL_K ?? "1")

const runtime = testFile("eval_todo_steer")
const maya = { id: "person-maya", login: "maya" }

/** The README the repository starts with. */
const README = "# Widgets\n\nWidgets for everyone.\n"

/** What one trial did: whether the merged README has the TODO's line and the steered one, and how the run ended. */
interface Trial {
  readonly word: string
  readonly exit: "merged" | "other"
  readonly asked: number
  readonly todoLine: boolean
  readonly steeredLine: boolean
  /** Whether a model request after the first carried the steer: the queue delivered it. */
  readonly delivered: boolean
  /** The merged README, to read what the agent did. */
  readonly readme: string
  readonly ms: number
}

/** One trial: a TODO that says "Change nothing else", and a steer that asks for a second line while turn 1 runs. */
const trial = async (real: HostModel["Service"]): Promise<Trial> => {
  const started = Date.now()
  await reset(runtime)
  await sql(runtime, "TRUNCATE stack_ops, todo_attempts, todo_requests, todos, stacks, pulls, pull_commits, reviews, runs, model_usage")
  const word = `w${Date.now().toString(36)}`
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.files.set("README.md", README)
  github.onPullOpened = (number) => void github.merge(number, "maya")
  const machine = machines(github)
  const { services } = await githubServices(runtime, github)
  const database = await runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))
  // The engine's schema, named here so the steer is admitted to it as ChatApi admits one.
  const schema = `flows_${crypto.randomUUID().replaceAll("-", "")}`
  const server = await runtime.runPromise(TestDatabase.serverUrl)
  const queue = NotificationQueue.layer.pipe(
    Layer.provide(Journal.SqlJournal.layer({ capacity: 1024, overflow: "reject", sourceEventCache: 1 })),
    Layer.provide(Layer.provideMerge(FlowsDatabase.DurableWriter.layer(), ExecutionHost.database(server.toString(), schema))),
  )
  let runId = ""
  let asked = 0
  let delivered = false
  // The real model, and the person pressing Send while its first answer streams.
  const model = Model.make({
    stream: (request) =>
      Stream.unwrap(Effect.gen(function* () {
        asked++
        if (asked > 1 && JSON.stringify(request.messages).includes(`steered ${word}`)) delivered = true
        if (asked === 1) {
          yield* Effect.flatMap(NotificationQueue.NotificationQueue, (notifications) =>
            notifications.admit(runId, Notification.humanSteer({
              runId,
              id: crypto.randomUUID(),
              actor: `person:${maya.id}`,
              attribution: { login: maya.login, via: "person" },
              payload: SteerPayload.encode({
                kind: "Message",
                body: `Please also append a second line to README.md that says steered ${word}, right after the first one.`,
              }),
            }))).pipe(Effect.provide(queue), Effect.scoped, Effect.orDie)
        }
        return real.model.stream(request)
      })),
  })
  const seat = await Effect.runPromise(
    ModelEndpoint.local(database, { hosted: true }).pipe(
      Effect.provideService(HostModel, HostModel.of({ ...real, model })),
      Effect.provide(PersonalModels.none),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ),
  )
  // The agent's commands run as `sandbox/Command` jobs, which the deployed host registers beside the sandbox tools.
  const registration = Layer.mergeAll(
    Todo.registration(
      {
        database: services.database,
        tokens: services.tokens,
        http: services.http,
        apiBaseUrl: services.apiBaseUrl,
        start: () => Effect.void,
      },
      TodoAgent.registration(seat("agent"), database, Agent.layerSandbox),
    ),
    SandboxCommand.registration,
  ).pipe(Layer.provide(machine.layer))
  const start = await runtime.runPromise(
    Effect.map(
      Stack.apply({
        opId: crypto.randomUUID(),
        repoId: REPOSITORY.id,
        actor: maya,
        via: "person",
        op: {
          kind: "commit",
          title: `Add a line to README ${word}`,
          prompt: `Append one line that says ${word} to the end of README.md. Change nothing else.`,
          acceptance: [],
        },
      }, { runs: true }),
      (applied) => (applied.kind === "applied" ? applied.receipt.starts[0] : undefined),
    ),
  )
  if (start === undefined) throw new Error("the TODO's run didn't start")
  runId = todoExecutionId(start.attemptId)
  try {
    const ran = await runFlow(Todo.Todo, start, registration, { executionId: runId, schema })
    const merged = github.tree("main").get("README.md") ?? ""
    return {
      word,
      exit: Exit.isSuccess(ran.exit) && (ran.exit.value as { state?: string }).state === "merged" ? "merged" : "other",
      asked,
      todoLine: merged.includes(word),
      steeredLine: merged.includes(`steered ${word}`),
      delivered,
      readme: merged,
      ms: Date.now() - started,
    }
  } finally {
    await sql(runtime, `DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  }
}

test.skipIf(only.length > 0 && !only.includes(NAME))(
  "todo-steer: the agent follows a person's steer over the TODO's \"Change nothing else\"",
  async () => {
    // The provider pool lives as long as the eval.
    const fetch = await Effect.runPromise(Scope.provide(Effect.runSync(Scope.make()))(EgressHttpClient.providerFetch(process.env)))
    const real = await Effect.runPromise(defaultModel(fetch))
    const trials: Array<Trial> = []
    for (let n = 0; n < TRIALS; n++) trials.push(await trial(real))
    const results = new URL("results/", import.meta.url)
    mkdirSync(results, { recursive: true })
    writeFileSync(
      new URL(`${NAME}-${new Date().toISOString().replaceAll(":", "-")}.json`, results),
      `${JSON.stringify({ eval: NAME, model: real.modelId, trials }, null, 2)}\n`,
    )
    // Every trial merged with the TODO's line and the steered one: the newer instruction won.
    expect(trials.map((t) => [t.exit, t.todoLine, t.steeredLine])).toEqual(trials.map(() => ["merged", true, true]))
  },
)
