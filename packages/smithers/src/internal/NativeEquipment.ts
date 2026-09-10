/** Shared native agent equipment; the platform supplies its request executor.
 * @since 1.0.0
 */
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import type * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import type * as ModelError from "@smthrs/model/ModelError"
import * as OpenAIChatGPT from "@smthrs/model/OpenAIChatGPT"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import type * as Checkpoints from "@smthrs/std/Checkpoints"
import * as Container from "@smthrs/std/Container"
import * as TestRunner from "@smthrs/std/TestRunner"
import { Context, Effect, Layer, Redacted } from "effect"
import type { Path, Result } from "effect"
import { existsSync } from "node:fs"
import { isAbsolute, relative } from "node:path"
import * as CodexAuth from "../CodexAuth.ts"
import * as Environment_ from "../Environment.ts"
import * as Providers from "../Providers.ts"

const apiKeyVariable: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
}

/**
 * How the `openai` provider authenticates. `api-key` is the default and the
 * only mode the other providers have. `chatgpt` routes the same seat strings
 * to the ChatGPT-subscription backend on the codex CLI's OAuth session, so a
 * lane opts in through the environment without respelling any seat: the
 * journaled seat, its context window, and its committed price stay identical.
 */
const openaiAuthVariable = "SMITHERS_OPENAI_AUTH"

/**
 * The native seat resolver: it turns a `provider:modelId` seat into a live model
 * route, with the API key read from the given environment, usually
 * `process.env`, passed in as a value so nothing below this composition touches
 * the process directly.
 *
 * A seat with no separator is a bare model id on the Anthropic route, which is
 * the one provider convention this host assumes.
 *
 * `SMITHERS_OPENAI_AUTH=chatgpt` swaps the `openai` provider's credential source
 * from `OPENAI_API_KEY` to the codex CLI's ChatGPT session
 * (`$CODEX_HOME/auth.json`); the token store is shared across every seat that
 * resolves against the same file so its refresh stays single-flight.
 *
 * @category constructors
 * @since 0.1.0
 */
export const seatResolver = (
  environment: Readonly<Record<string, string | undefined>>,
  executor: RequestExecutor.RequestExecutor
): SeatResolver.Service => {
  const codexStores = new Map<string, CodexAuth.Store>()
  const codexStore = (file: string): CodexAuth.Store => {
    let store = codexStores.get(file)
    if (store === undefined) {
      store = CodexAuth.make({ file, executor })
      codexStores.set(file, store)
    }
    return store
  }
  return SeatResolver.make({
    resolve: (seat) =>
      Effect.gen(function*() {
        const separator = seat.indexOf(":")
        const provider = separator < 0 ? "anthropic" : seat.slice(0, separator)
        const modelId = Seat.modelIdOf(seat)
        // The OpenAI-compatible Chat Completions providers are routed by
        // table (`Providers.compatible`): the origin, the exact path, and the
        // key variables read in order. `Object.hasOwn`, so `constructor:x`
        // finds no inherited function.
        if (Object.hasOwn(Providers.compatible, provider)) {
          const entry = Providers.compatible[provider]!
          const found = Providers.compatibleKey(provider, environment)
          if (found === undefined) {
            return yield* new Seat.SeatUnresolved({
              seat,
              message: `Set ${entry.variables.join(" or ")} to run the ${seat} seat`
            })
          }
          return yield* seatOf(
            Route.openaiChatCompatible({
              id: provider,
              baseUrl: entry.baseUrl,
              path: entry.path,
              apiKey: Redacted.make(found.key)
            }),
            executor,
            seat,
            modelId
          )
        }
        const variable = apiKeyVariable[provider]
        if (variable === undefined) {
          return yield* new Seat.SeatUnresolved({
            seat,
            message: `No route is configured for the ${provider} provider`
          })
        }
        // An empty value is treated exactly like an unset variable, the same
        // convention the key variables follow below.
        const configured = Environment_.read(environment, openaiAuthVariable)
        const authMode = provider === "openai" && configured !== undefined && configured !== ""
          ? configured
          : "api-key"
        if (authMode !== "api-key" && authMode !== "chatgpt") {
          return yield* new Seat.SeatUnresolved({
            seat,
            message: `${openaiAuthVariable} must be "api-key" or "chatgpt" to run the ${seat} seat`
          })
        }
        if (authMode === "chatgpt") {
          // The ChatGPT mode needs a provisioned session, not an API key: the
          // refusal names the store so a detached lane fails before spending.
          const file = CodexAuth.locate(environment)
          if (!existsSync(file)) {
            return yield* new Seat.SeatUnresolved({
              seat,
              message: `Sign in with \`codex login\` to run the ${seat} seat: no ChatGPT credentials at ${file}`
            })
          }
          return yield* seatOf(
            OpenAIChatGPT.make({ auth: codexStore(file).auth({ modelId }) }),
            executor,
            seat,
            modelId
          )
        }
        const key = environment[variable]
        if (key === undefined || key.length === 0) {
          return yield* new Seat.SeatUnresolved({
            seat,
            message: `Set ${variable} to run the ${seat} seat`
          })
        }
        // The provider routes have distinct body types, so each branch is
        // erased into the seat shape on its own rather than through a union.
        // OpenRouter is the OpenAI Responses surface at a different origin, so
        // its seats spell the model as `openrouter:vendor/model` and route
        // through the compatible constructor.
        return yield* provider === "anthropic"
          ? seatOf(Route.anthropic({ apiKey: Redacted.make(key) }), executor, seat, modelId)
          : provider === "openrouter"
          ? seatOf(
            Route.openaiResponsesCompatible({
              id: "openrouter",
              baseUrl: "https://openrouter.ai/api",
              apiKey: Redacted.make(key)
            }),
            executor,
            seat,
            modelId
          )
          : seatOf(Route.openai({ apiKey: Redacted.make(key) }), executor, seat, modelId)
      })
  })
}

const seatOf = <Body, Frame, Event, State>(
  configured: Result.Result<Route.Route<Body, Frame, Event, State>, ModelError.ModelError>,
  executor: RequestExecutor.RequestExecutor,
  seat: string,
  modelId: string
): Effect.Effect<Seat.Seat, Seat.SeatUnresolved> =>
  Effect.gen(function*() {
    const routeConfig = yield* Effect.fromResult(configured).pipe(
      Effect.mapError((error) => new Seat.SeatUnresolved({ seat, message: error.message }))
    )
    const model = yield* Route.toModel(routeConfig).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor)
    )
    return Seat.make({
      id: seat,
      modelId,
      model,
      route: FlowEngineLike.routeResolver(routeConfig),
      contextWindowTokens: SeatResolver.contextWindowTokensFor(modelId)
    })
  })

/**
 * Provides {@link seatResolver} over the composition's request dispatcher.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerSeatResolver = (
  environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<SeatResolver.SeatResolver, never, RequestExecutor.RequestExecutor> =>
  Layer.effect(SeatResolver.SeatResolver)(
    Effect.gen(function*() {
      const executor = yield* RequestExecutor.RequestExecutor
      return seatResolver(environment, executor)
    })
  )

/**
 * The explicit sandbox budget every locally executed cell runs under. Never
 * unlimited: an unbounded QuickJS cell can hang the frame.

 * @since 1.0.0
 * @private
 */
export const cellLimits: Sandbox.Limits = {
  memoryBytes: 256 * 1024 * 1024,
  steps: 50_000_000
}

/**
 * The declared mount's name for a directory inside the repository, or
 * `undefined` when the mount cannot name it. `TestRun` derives its baseline
 * worktree's container path the same way, from the same pair of roots.
 */
const mountedAs = (mount: string, root: string, directory: string): string | undefined => {
  const inside = relative(root, directory)
  if (inside === "") return mount
  if (inside.startsWith("..") || isAbsolute(inside)) return undefined
  return `${mount.replace(/\/+$/, "")}/${inside}`
}

/**
 * The repository's own test invocation, as this host declares it.
 *
 * `TestRun` is a declaration flow: a caller selects *which* tests, never *how*
 * to run them, so the composition has to supply the how. This host reads it off
 * the environment, which is the same place it reads a seat's credentials, and
 * the only field that decides anything is the command. The rest describe where
 * that command runs.
 *
 * `undefined` means this host knows of no runner, and then the `test` flow is
 * not bound at all. That is the rule the r91 wave broke in the other direction:
 * `StandardFlows.tests` existed, the cell contract's doctrine assumed it, and
 * no composition offered it, so all 45 graded runs saw zero `test` calls. A
 * flow no composition offers is a flow that does not exist, and a flow bound
 * over a declaration that can only refuse is worse, because the catalog then
 * advertises a call whose every answer is "not configured".
 *
 * `workspaceRoot` is the checkout this executor actually runs in, which is not
 * `root` once a resumed history fork binds the run to its own worktree. The
 * runner has to name that checkout, or the suite grades the files the forked
 * agent never touched. `root` still decides the *container's* name for the
 * tree: `SMITHERS_TEST_CWD` is the mount the project root is reachable at, so
 * a workspace inside the project is reachable at the same relative path under
 * that mount. A workspace the mount cannot name at all declares no runner,
 * because the only alternative is a `test` call that silently runs elsewhere.
 *
 * @category constructors
 * @since 0.1.0
 */
export const testRunner = (
  environment: Readonly<Record<string, string | undefined>>,
  root: string,
  workspaceRoot: string = root
): TestRunner.Runner | undefined => {
  const command = Environment_.read(environment, "SMITHERS_TEST_COMMAND")?.trim()
  if (command === undefined || command === "") return undefined
  const container = Environment_.read(environment, "SMITHERS_TEST_CONTAINER")?.trim()
  const declared = Environment_.read(environment, "SMITHERS_TEST_CWD")?.trim()
  const timeout = Number(Environment_.read(environment, "SMITHERS_TEST_TIMEOUT_MS"))
  // The runner's directory and the workspace's are the same path until a
  // container gives the tree a second name; `root` stays a host path, because
  // that is where a baseline worktree is checked out from.
  const cwd = declared === undefined || declared === ""
    ? workspaceRoot
    : mountedAs(declared, root, workspaceRoot)
  if (cwd === undefined) return undefined
  return {
    command,
    cwd,
    root: workspaceRoot,
    ...(container === undefined || container === "" ? {} : { container }),
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {})
  }
}

/**
 * Where this host pins the trees a run checkpoints, and where a container sees
 * them.
 *
 * The same two paths {@link testRunner} reads, for the same reason: a
 * checkpoint is materialized as a directory under the repository, and a
 * container reaches that directory through the mount it already has.
 * `SMITHERS_TEST_CWD` is the container's name for the repository when there is
 * one, and the workspace root is the host's. A host that declares neither
 * still pins, and pins on one path under both names.
 *
 * @category constructors
 * @since 0.1.0
 */
export const checkpointStore = (
  environment: Readonly<Record<string, string | undefined>>,
  root: string
): Checkpoints.GitOptions => {
  const cwd = Environment_.read(environment, "SMITHERS_TEST_CWD")?.trim()
  return { root, ...(cwd === undefined || cwd === "" ? {} : { cwd }) }
}

/**
 * The `test` flow's binding source, or none when this host declares no runner.
 *
 * Named rather than spread inline because the r91 wave's whole finding about
 * this flow is that the *composition* was the untried link: the flow, its
 * declaration and its handler were all tested, and no test asked whether any
 * host offered them. This is that question, in the one place it can be asked
 * without booting a run.
 *
 * The runner's container is added to the same context, so the suite reaches the
 * image through the transport `bash` already uses.
 *
 * @category constructors
 * @since 0.1.0
 */
export const testFlows = (
  services: Context.Context<KernelChildProcessSpawner.ChildProcessSpawner | Path.Path>,
  container: Container.Container,
  runner: TestRunner.Runner | undefined
): ReadonlyArray<FlowBinding.Source> =>
  runner === undefined ? [] : [
    StandardFlows.tests(
      Context.add(
        Context.add(services, TestRunner.TestRunner, TestRunner.make(runner)),
        Container.Container,
        container
      )
    )
  ]
