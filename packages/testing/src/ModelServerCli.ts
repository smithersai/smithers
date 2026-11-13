/**
 * The command line behind `smthrs-model-server`: a `ModelServer` over a
 * fixture file, for a test that drives an install out of process.
 *
 * ```sh
 * # Record: misses go to the upstream and are written to the fixture.
 * UPSTREAM_KEY=... smthrs-model-server --fixture test/fixtures/journey.json \
 *   --record --upstream https://ai-gateway.vercel.sh --key-env UPSTREAM_KEY
 * # Replay: no upstream, no key, no network; a miss is a 501.
 * smthrs-model-server --fixture test/fixtures/journey.json
 * # Script Smithers' built-in flows (BuiltinScript), tracing every turn.
 * smthrs-model-server --script builtin --trace evidence/model-turns.jsonl
 * ```
 *
 * It prints one JSON line, `{"url":"http://127.0.0.1:<port>"}`, once it
 * listens, and runs until SIGINT or SIGTERM. A recording run publishes the
 * fixture when it stops. The key is read from the environment variable
 * `--key-env` names, never from the command line, and never reaches the
 * fixture.
 *
 * With `--script builtin` the script answers first. A turn it does not script
 * replays from `--fixture` when one is given, and is otherwise settled with
 * `BuiltinScript.unscripted`. With `--record` as well, nothing is scripted:
 * every turn goes to the upstream and is recorded, and the script only names
 * each turn in the trace.
 *
 * | Flag                    | Meaning                                                                 |
 * | ----------------------- | ----------------------------------------------------------------------- |
 * | `--fixture <path>`      | The fixture file. Required unless `--script`. Replay refuses a missing one. |
 * | `--record`              | Record misses. Needs `--upstream` and `--key-env`.                      |
 * | `--upstream <origin>`   | The OpenAI-compatible origin a miss is sent to, and its gateway judge.  |
 * | `--upstream-model <id>` | The model the upstream is asked for; the fixture keeps the request's.   |
 * | `--key-env <NAME>`      | The environment variable holding the upstream's bearer key.             |
 * | `--hold <regex>`        | Hold a turn whose text matches until its key (group 1) is released.     |
 * | `--normalize <regex>`   | Replace every match in a request with `<normalized>` before keying it.  |
 * | `--script builtin`      | Answer with `BuiltinScript` before the fixture.                         |
 * | `--script-config <path>`| `BuiltinScript.Options` as JSON; `todoFlow` is a path to the flow file. |
 * | `--trace <path>`        | Append each turn to this file as one JSON line (`TurnLog`).             |
 * | `--trace-messages`      | Keep every message's text on each traced chat turn.                     |
 * | `--host`, `--port`      | Where to listen: `127.0.0.1` and any free port by default.              |
 *
 * @since 1.0.0
 */

import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import { NodeHost } from "@smthrs/platform-node"
import { Effect, Exit, Layer, Redacted, Result, Scope } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as BuiltinScript from "./BuiltinScript.ts"
import * as CachedEvaluator from "./CachedEvaluator.ts"
import * as CachedModel from "./CachedModel.ts"
import { decode } from "./Fixture.ts"
import * as FixtureStore from "./FixtureStore.ts"
import type { RecordedRequestLike } from "./ModelLike.ts"
import * as ModelServer from "./ModelServer.ts"
import * as ScriptedModel from "./ScriptedModel.ts"
import * as TurnGate from "./TurnGate.ts"
import * as TurnLog from "./TurnLog.ts"

/**
 * A parsed command line.
 *
 * @category models
 * @since 1.0.0
 */
export interface Config {
  readonly fixture?: string | undefined
  readonly record?: {
    readonly upstream: string
    readonly model?: string | undefined
    readonly apiKey: Redacted.Redacted<string>
  } | undefined
  readonly hold: ReadonlyArray<RegExp>
  /** Run-varying text to replace with `<normalized>` before a request is keyed and recorded. */
  readonly normalize: ReadonlyArray<RegExp>
  readonly hostname?: string | undefined
  readonly port?: number | undefined
  /** The builtin script and its options, when `--script builtin` was given. */
  readonly script?: BuiltinScript.Options | undefined
  readonly trace?: { readonly file: string; readonly messages: boolean } | undefined
}

const usage = "Usage: smthrs-model-server [--fixture <path>] [--record --upstream <origin> --key-env <NAME> " +
  "[--upstream-model <id>]] [--script builtin [--script-config <path>]] [--trace <path> [--trace-messages]] " +
  "[--hold <regex>] [--normalize <regex>] [--host <host>] [--port <port>]"

const refuse = (message: string): never => {
  throw new Error(`${message}\n${usage}`)
}

const compile = (flag: string, source: string, flags?: string): RegExp => {
  try {
    return new RegExp(source, flags)
  } catch {
    return refuse(`${flag} is not a regular expression: ${source}`)
  }
}

const pattern = (source: string): RegExp => {
  const compiled = compile("--hold", source)
  return new RegExp(`${source}|`).exec("")!.length === 2 ? compiled : refuse("--hold needs one capture group")
}

/**
 * Reads the command line. Throws an `Error` naming the first problem.
 *
 * @category constructors
 * @since 1.0.0
 */
export const parse = (argv: ReadonlyArray<string>, env: Readonly<Record<string, string | undefined>>): Config => {
  const values = new Map<string, string>()
  const hold: Array<RegExp> = []
  const normalize: Array<RegExp> = []
  let record = false
  let messages = false
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!
    if (flag === "--record") {
      record = true
      continue
    }
    if (flag === "--trace-messages") {
      messages = true
      continue
    }
    const flags = [
      "--fixture",
      "--upstream",
      "--upstream-model",
      "--key-env",
      "--hold",
      "--normalize",
      "--host",
      "--port",
      "--script",
      "--script-config",
      "--trace"
    ]
    if (!flags.includes(flag)) {
      refuse(`Unknown argument ${flag}`)
    }
    const value = argv[++index] ?? refuse(`${flag} needs a value`)
    if (flag === "--hold") hold.push(pattern(value))
    else if (flag === "--normalize") normalize.push(compile(flag, value, "g"))
    else values.set(flag, value)
  }
  const script = values.get("--script")
  if (script !== undefined && script !== "builtin") {
    refuse(`--script ${script} is not a script; the one script is builtin`)
  }
  const scriptConfig = values.get("--script-config")
  if (scriptConfig !== undefined && script === undefined) refuse("--script-config needs --script")
  const trace = values.get("--trace")
  if (messages && trace === undefined) refuse("--trace-messages needs --trace")
  const fixture = values.get("--fixture") ??
    (script === undefined || record ? refuse("--fixture is required") : undefined)
  const upstream = values.get("--upstream")
  if (!record && upstream !== undefined) refuse("--upstream needs --record")
  const port = values.get("--port")
  if (port !== undefined && !/^\d+$/.test(port)) refuse("--port must be an integer")
  const recording = () => {
    const origin = upstream ?? refuse("--record needs --upstream")
    const name = values.get("--key-env") ?? refuse("--record needs --key-env")
    const key = env[name] ?? ""
    return {
      upstream: origin,
      model: values.get("--upstream-model"),
      apiKey: Redacted.make(key === "" ? refuse(`${name} is empty`) : key)
    }
  }
  return {
    fixture,
    record: record ? recording() : undefined,
    hold,
    normalize,
    hostname: values.get("--host"),
    port: port === undefined ? undefined : Number(port),
    script: script === undefined ? undefined : scriptOptions(scriptConfig),
    trace: trace === undefined ? undefined : { file: trace, messages }
  }
}

/** Reads `--script-config`: `BuiltinScript.Options`, except that `todoFlow` names a file, relative to the config. */
const scriptOptions = (path: string | undefined): BuiltinScript.Options => {
  if (path === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    return refuse(`--script-config ${path} is not readable JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse(`--script-config ${path} is not a JSON object`)
  }
  const options = parsed as BuiltinScript.Options
  if (options.todoFlow === undefined) return options
  const flow = resolve(dirname(path), options.todoFlow)
  return existsSync(flow)
    ? { ...options, todoFlow: readFileSync(flow, "utf8") }
    : refuse(`todoFlow ${flow} does not exist`)
}

/** Every text a request carries, so a hold pattern can match any of it. */
const textOf = (request: ModelRequest): string =>
  [
    ...request.system.map((part) => part.text),
    ...request.messages.flatMap((message) =>
      message.content.map((part) =>
        part.type === "tool-call" ? part.arguments : part.type === "tool-result" ? part.content : part.text
      )
    )
  ].join("\n")

const live = (record: NonNullable<Config["record"]>) =>
  Effect.gen(function*() {
    const route = Route.openaiChatCompatible({
      id: "upstream",
      providerName: "upstream",
      baseUrl: record.upstream,
      apiKey: record.apiKey
    })
    const model = yield* Route.toModel(Result.getOrThrow(route))
    const evaluator = yield* Effect.provide(
      Effect.gen(function*() {
        return yield* Evaluator.Evaluator
      }),
      Evaluator.layerVercelGateway({
        apiKey: record.apiKey,
        baseUrl: `${record.upstream}${ModelServer.paths.evaluation}`,
        timeoutMs: 60_000
      })
    )
    const renamed = record.model === undefined ? model : Model.make({
      stream: (request) => model.stream(ModelRequest.make({ ...request, modelId: record.model! }))
    })
    return { model: renamed, evaluator }
  }).pipe(
    Effect.provide(Layer.provideMerge(RequestExecutor.layer, FetchHttpClient.layer))
  )

/** Replaces every match of `patterns` in every string a request carries, except its model id. */
const normalizer = (patterns: ReadonlyArray<RegExp>): CachedModel.Options["normalize"] =>
  patterns.length === 0 ? undefined : (request) =>
    JSON.parse(
      JSON.stringify(request),
      (key, value: unknown) =>
        typeof value === "string" && key !== "modelId"
          ? patterns.reduce((text, pattern) => text.replace(pattern, "<normalized>"), value)
          : value
    ) as RecordedRequestLike

/** A replay reads the file once and never writes it, so any number of runs can share it. */
const replayStore = (path: string) =>
  Effect.gen(function*() {
    if (!existsSync(path)) return yield* Effect.die(new Error(`${path} does not exist. Record it with --record.`))
    return yield* FixtureStore.makeMemory(yield* Effect.orDie(decode(JSON.parse(readFileSync(path, "utf8")))))
  })

/**
 * Serves `config` for the lifetime of the scope. A recording publishes the
 * fixture when the scope closes.
 *
 * @category constructors
 * @since 1.0.0
 */
export const serve = (config: Config): Effect.Effect<ModelServer.ModelServer, never, Scope.Scope> =>
  Effect.gen(function*() {
    const record = config.record
    const fixture = config.fixture === undefined
      ? undefined
      : record === undefined
      ? yield* replayStore(config.fixture)
      : yield* Effect.acquireRelease(
        FixtureStore.makeFile(config.fixture).pipe(
          Effect.provide(Layer.mergeAll(NodeHost.NodeFileSystem.layer, NodeHost.NodePath.layer))
        ),
        (store) => store.flush()
      )
    const upstream = record === undefined ? undefined : yield* live(record)
    const gate = yield* TurnGate.make()
    const log = yield* TurnLog.make(config.trace ?? {})
    const normalize = normalizer(config.normalize)
    const cached = fixture === undefined ? undefined : CachedModel.make({ fixture, live: upstream?.model, normalize })
    const builtin = config.script === undefined ? undefined : BuiltinScript.make(config.script)
    const model = (() => {
      if (builtin === undefined || record !== undefined) {
        // Replayed or recorded; a script only names the turn.
        const fallback = record === undefined ? "replayed" : "recorded"
        return TurnLog.model(cached!, { log, step: (request) => builtin?.script(request)?.name ?? fallback })
      }
      return ScriptedModel.make({
        script: (request) =>
          builtin.script(request) ?? (cached === undefined ? BuiltinScript.unscripted(request) : undefined),
        fallback: cached,
        gate,
        log
      })
    })()
    const evaluator = builtin !== undefined && record === undefined
      ? BuiltinScript.evaluator
      : CachedEvaluator.make({ fixture: fixture!, live: upstream?.evaluator, normalize })
    const key = (request: ModelRequest) => {
      const text = textOf(request)
      return config.hold.map((hold) => hold.exec(text)?.[1]).find((match) => match !== undefined)
    }
    return yield* ModelServer.make({
      model: config.hold.length === 0 ? model : TurnGate.model(model, { gate, key }),
      evaluator: TurnLog.evaluator(evaluator, { log }),
      gate,
      log,
      hostname: config.hostname,
      port: config.port
    })
  })

/**
 * Where {@link run} prints and when it stops.
 *
 * @category models
 * @since 1.0.0
 */
export interface Io {
  readonly print: (line: string) => void
  readonly stopped: Promise<void>
}

/**
 * Parses `argv`, serves it, prints the URL line, and stops when `io.stopped`
 * settles. Rejects with the parse or startup failure.
 *
 * @category constructors
 * @since 1.0.0
 */
export const run = async (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  io: Io
): Promise<void> => {
  const config = parse(argv, env)
  const scope = Effect.runSync(Scope.make())
  try {
    const server = await Effect.runPromise(Scope.provide(serve(config), scope))
    io.print(JSON.stringify({ url: server.url }))
    await io.stopped
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}
