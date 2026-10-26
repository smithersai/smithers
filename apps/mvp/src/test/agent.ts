import { FileTabsTabs } from "../features/files/flows"
import { BugTabs } from "../features/bugs/flows"
import { FlowRegistry } from "../flows/registry"
// The browser's agent on the Node host, for the tests (docs/features/agent.md#tests). ChatApi's real handler on the
// test file's schema of the compose Postgres serves the model endpoint and the answer routes, with a scripted model as
// the deployment's default model: the only scripted seam. The engine is the Node host's (`Runtime.layer` over
// @smthrs/platform-node and the compose Postgres, worker/test/flowHost.ts), with every client flow registered as the
// browser's engine worker registers them (src/flows/registrations.ts). This device's theme is a `ThemeStore` in memory.
import { Persistence } from "@smthrs/effect-tanstack-db"
import type { HostModel } from "@smthrs/model-host"
import { FlowRuntime } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { EngineStore, RunStore } from "@smthrs/flows"
import { Context, type Duration, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import type { Actor } from "../../worker/Actor.ts"
import { build } from "../../worker/test/flowHost.ts"
import type { CuratedFile } from "../../worker/home/Curated.ts"
import { harness } from "../../worker/test/harness.ts"
import { Answer } from "../features/agent/flows"
import { Tabs } from "../features/navigation/flows"
import type { Part } from "../features/agent/schema"
import type { ThemeMode } from "../features/theme/contract"
import { tabPreferences, ThemeStore } from "../features/theme/store"
import type { HostOptions as AgentHostOptions } from "../features/agent/host"
import * as RunCredentials from "../flows/credentials"
import { clientFlows } from "../flows/declarations"
import type { Door } from "../flows/dispatch"
import { tabDoors } from "../flows/doors"
import { registrations } from "../flows/registrations"
import { TabRequests } from "../flows/requests"
import { TabClipboard } from "../features/repo/copy"
import { TabSession } from "../features/auth/steps"
import { TabChat } from "../features/chat/steps"
import { TabIssues } from "../features/issues/steps"
import { TabRuns } from "../features/runs/steps"
import { TabTodos } from "../features/todos/steps"

/** ChatApi's origin as the agent reaches it: the harness's in-process handler. */
export const ORIGIN = "http://chat.test"

/** The person's presses, as a tab would remember them, for a host with no tab: every run a test starts is theirs. */
const personPresses = Layer.succeed(
  TabRequests,
  TabRequests.of({ add: () => Effect.void, doorOf: () => Effect.succeedSome<Door>("button") }),
)

/** A person with the Member role: the signed-in caller every agent test asks as. */
export const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

/** A model's answer: one cell, in the fence the cell loop reads. */
export const cell = (source: string) => "```cell\n" + source + "\n```"

type Harness = Awaited<ReturnType<typeof harness>>
type Runtime = Parameters<typeof harness>[0]
type Script = Parameters<typeof harness>[1]

/** One incarnation of this device's engine: built over `schema` (a fresh one unless set), closed with `kill`. */
export interface Engine {
  readonly schema: string
  readonly flows: FlowRuntime.FlowRuntime["Service"]
  readonly driver: EngineStore.EngineStore.Driver["Service"]
  /** The engine's run reads, what a run's page reads through the browser's engine (decision 0014 §3). */
  readonly inspection: EngineStore.RunInspection.RunInspection["Service"]
  readonly theme: ThemeStore["Service"]
  /** Closes the engine, interrupting what it runs. */
  readonly kill: () => Promise<void>
  /**
   * Cuts the engine off its store at once, as a killed tab does: Postgres ends its connections, rolling back anything
   * in flight, so it records nothing more. Its fibers stay where they were until `kill`.
   */
  readonly crash: () => Promise<void>
}

/** ChatApi on the file's schema, signed in as `actor`, answering model calls with `script`, and a device to ask on. */
export const openAgent = async (
  runtime: Runtime,
  script: Script,
  options: {
    readonly actor?: Actor
    readonly partsEvery?: `${number} millis`
    /** The deployment's default model in place of `script`: the agent evals' real model (evals/agent.eval.ts). */
    readonly model?: HostModel["Service"]
    /** The fetch ChatApi reaches Electric and outside pages with (worker/test/pages.ts): the harness's unless set. */
    readonly fetch?: typeof globalThis.fetch
    /** The curated homes, and the docs they name, ChatApi reads (worker/home/Curated.ts): the real ones unless set. */
    readonly homes?: ReadonlyArray<CuratedFile>
  } = {},
) => {
  const h: Harness = await harness(runtime, script, {
    actor: options.actor ?? member,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.homes === undefined ? {} : { homes: options.homes }),
  })
  // Only a call: Bun's globals, which a program loading the `@smthrs/cli` root sees, add `preconnect` to `fetch`.
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return h.fetch(`${url.pathname}${url.search}`, input instanceof Request ? input : init)
  }) as typeof globalThis.fetch
  const painted: Array<ThemeMode | undefined> = []
  const mirrored: Array<ThemeMode | undefined> = []
  const device = ThemeStore.layer({
    paint: (mode) => void painted.push(mode),
    mirror: (mode) => void mirrored.push(mode),
    system: () => "light",
    painted: () => painted.at(-1),
  }).pipe(Layer.provide(Persistence.memory))

  /**
   * Builds this device's engine: every client flow on the Node host, as the browser's engine worker registers them.
   * `turnWait` is how long an answer's run waits for its turn while the queue before it doesn't move
   * (`ANSWER_TURN_WAIT` unless set).
   */
  const engine = async (
    schema?: string,
    engineOptions: {
      readonly turnWait?: Duration.Input
      /** A faulty transport for the browser's HTTP service; real handler transport unless set. */
      readonly fetch?: typeof globalThis.fetch
      readonly memorySources?: AgentHostOptions["memorySources"]
    } = {},
  ): Promise<Engine> => {
    const scope = Effect.runSync(Scope.make())
    let disconnected = false
    const connectionName = `test-agent-${crypto.randomUUID()}`
    // A killed tab cannot reconnect its old engine. singleIncarnationLiveness
    // assumes that host promise; merely terminating a Pg backend lets two live
    // Node engines steal ownership back and forth while their pools reconnect.
    // A dead connection refuses even shutdown's final journal flush. Parking
    // forever here deadlocks that finalizer; it does not simulate a killed tab.
    const databaseGate = Effect.suspend(() => disconnected
      ? Effect.fail(new SqlError({ reason: new ConnectionError({
        cause: "test engine crashed",
        message: "The test engine's database connection ended",
        operation: "execute",
      }) }))
      : Effect.void)
    const doors = `agent-${crypto.randomUUID()}`
    const registration = Layer.merge(
      registrations({
        origin: ORIGIN,
        partsEvery: options.partsEvery ?? "20 millis",
        ...(engineOptions.turnWait === undefined ? {} : { turnWait: engineOptions.turnWait }),
        ...(engineOptions.memorySources === undefined ? {} : { memorySources: engineOptions.memorySources }),
      }),
      // No tab dispatches here: the test is the person, so every root run it starts is their own press. The agent's
      // runs, and every run nested in one, still get run credentials (src/flows/credentials.ts).
      tabDoors({ name: doors }).pipe(Layer.provide(personPresses)),
    ).pipe(
      // Every request goes as the run that made it, as in the browser's engine worker.
      Layer.provide(RunCredentials.layer({ origin: ORIGIN, name: doors, flows: clientFlows }).pipe(Layer.provide(FlowRegistry.layer))),
      Layer.provide(tabPreferences),
      // No tab listens on this engine's navigation, files, clipboard, issues, TODOs, chat, session or bug channels: a
      // navigation, a file tab, a copy, an issue or TODO write, a message's Copy or Edit, or a session refresh here finds
      // its tab gone.
      Layer.provide(Tabs.layerChannel({ name: `agent-${crypto.randomUUID()}`, origin: ORIGIN })),
      Layer.provide(TabClipboard.layerChannel({ name: `agent-${crypto.randomUUID()}`, origin: ORIGIN })),
      Layer.provide(TabIssues.layerChannel({ name: `agent-${crypto.randomUUID()}` })),
      Layer.provide(TabTodos.layerChannel({ name: `agent-${crypto.randomUUID()}` })),
      Layer.provide(TabRuns.layerChannel({ name: `agent-${crypto.randomUUID()}` })),
      Layer.provide(TabChat.layerChannel({ name: `agent-${crypto.randomUUID()}` })),
      Layer.provide(TabSession.layerChannel({ name: `agent-${crypto.randomUUID()}` })),
      Layer.provide(FileTabsTabs.layerChannel({ name: `agent-${crypto.randomUUID()}` })),
      Layer.provide(BugTabs.layerChannel({ name: `agent-${crypto.randomUUID()}` })),
      Layer.provide(TabChannel.layer),
      // The run reads the acts on runs need, which the browser's engine provides (decision 0014 §3).
      Layer.provideMerge(EngineStore.RunInspection.layer),
      Layer.provideMerge(device),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, engineOptions.fetch ?? fetch)),
    )
    const built = await Effect.runPromise(
      Scope.provide(scope)(
        // The browser's liveness: an owner under this host id that isn't this incarnation died with its tab.
        build(registration, {
          hostId: "device",
          databaseGate,
          connectionName,
          isAlive: RunStore.Ownership.singleIncarnationLiveness,
          ...(schema === undefined ? {} : { schema }),
        }),
      ),
    )
    return {
      schema: built.engine.schema,
      flows: Context.get(built.context, FlowRuntime.FlowRuntime),
      driver: Context.get(built.context, EngineStore.EngineStore.Driver),
      inspection: Context.get(built.context, EngineStore.RunInspection.RunInspection),
      theme: Context.get(built.context, ThemeStore),
      kill: () => Effect.runPromise(Scope.close(scope, Exit.void)),
      crash: () => {
        disconnected = true
        return runtime.runPromise(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE pid <> pg_backend_pid() AND application_name = ${connectionName}`),
        ).then(() => undefined)
      },
    }
  }

  /** Asks `text`; resolves with the answer's id once ChatApi has both rows. */
  const ask = async (text: string) => {
    const question = { id: crypto.randomUUID(), answerId: crypto.randomUUID(), text }
    const response = await h.ask(question)
    if (response.status !== 202) throw new Error(`asking answered ${response.status}`)
    return question.answerId
  }

  /** Runs `chat/Answer` for `answerId` to its end on `on`, as the asking tab starts it. */
  const answer = (on: Engine, answerId: string) =>
    Effect.runPromise(Effect.exit(on.flows.execute(Answer, { executionId: answerId, payload: { answerId } })))

  /**
   * Takes over `answerId`'s unfinished run on `on`, as a new leader tab's engine does when it wakes (it drives every
   * unfinished run once), then reads how the run ended.
   */
  const resume = (on: Engine, answerId: string) =>
    Effect.runPromise(
      Effect.exit(
        on.driver.drive(Answer, { executionId: answerId, payload: { answerId } }).pipe(
          Effect.andThen(on.flows.execute(Answer, { executionId: answerId, payload: { answerId } })),
        ),
      ),
    )

  /**
   * Starts `chat/Answer` for `answerId` on `on` and leaves it running: `stop` cuts it off where it is. `done` answers how
   * the run ended, interrupted once stopped; it never rejects, so a test that stops a run needn't read it.
   */
  const start = (on: Engine, answerId: string) => {
    const fiber = Effect.runFork(
      Effect.exit(on.flows.execute(Answer, { executionId: answerId, payload: { answerId } })),
    )
    return {
      done: Effect.runPromise(Effect.map(Fiber.await(fiber), (exit) => (Exit.isSuccess(exit) ? exit.value : exit))),
      stop: () => Effect.runPromise(Fiber.interrupt(fiber)),
    }
  }

  return { h, fetch, engine, ask, answer, resume, start, painted, mirrored }
}

/** An answer as Postgres holds it, parts included. */
export const answerRow = (runtime: Runtime, id: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [found] = yield* sql<{
        readonly status: string
        readonly text: string
        readonly failure: string | null
        readonly parts: ReadonlyArray<Part>
        readonly inputTokens: number | null
        readonly outputTokens: number | null
      }>`
        SELECT status, text, failure, parts, input_tokens AS "inputTokens", output_tokens AS "outputTokens"
        FROM messages WHERE id = ${id}`
      return found!
    }),
  )
