/**
 * The Promise side of the Incur projection: Incur's CLI objects, discovery
 * caching, and request dispatch. Every program it runs is one of
 * {@link Programs}, which `Incur.createCli` builds, through `run`.
 *
 * @private
 * @since 0.1.0
 */

import * as Positionals from "@smthrs/build-cli/Positionals"
import type * as Flow from "@smthrs/core/Flow"
import type * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { Cli as IncurCli, type MiddlewareHandler } from "incur"
import type * as CommandTree from "../CommandTree.vibe"
import type * as FlowInvoker from "../FlowInvoker.vibe"
import { FsError } from "../FsError.vibe"
import type * as Route from "../Route.vibe"
import * as CommandLine from "./CommandLine.vibe"
import type * as SchemaBridge from "./SchemaBridge.vibe"

/**
 * The reserved child segment that invokes a route which also has children.
 *
 * Incur cannot represent a node that is both runnable and a command group, so
 * `domains` alongside `domains/list` is advertised and dispatched as
 * `domains self` on the CLI and `/domains/self` over HTTP. The bare name keeps
 * dispatching to the same route.
 *
 * @category constants
 * @since 0.1.0
 */
export const selfSegment = "self"

/**
 * The part of Incur's command context a run reads and settles.
 *
 * @private
 * @since 0.1.0
 */
export type Context = {
  readonly args: Readonly<Record<string, unknown>>
  readonly error: (options: {
    readonly code: string
    readonly exitCode?: number | undefined
    readonly message: string
  }) => never
  readonly ok: (data: unknown) => never
  readonly options: Readonly<Record<string, unknown>>
  readonly request?: Request | undefined
}

/**
 * A route loaded and projected onto Incur descriptors.
 *
 * @private
 * @since 0.1.0
 */
export type SelectedRoute = {
  readonly route: Route.Route
  readonly flow: Pick<Flow.Any, "name" | "input" | "output"> & Partial<Pick<Flow.Any, "description">>
  readonly schema: SchemaBridge.CommandSchema
}

/**
 * A selected route and the request tokens that name it.
 *
 * @private
 * @since 0.1.0
 */
export type Selection = SelectedRoute & {
  readonly dispatch: ReadonlyArray<string>
}

/**
 * What one route contributes to the metadata surface once it is projected.
 *
 * @private
 * @since 0.1.0
 */
export type Projection =
  | { readonly _tag: "Ready"; readonly selected: SelectedRoute }
  | { readonly _tag: "Failed"; readonly error: FsError }

/**
 * The route a request names, none when it names no route, or why it cannot run.
 *
 * @private
 * @since 0.1.0
 */
export type Outcome =
  | { readonly _tag: "Selection"; readonly selection: Option.Option<Selection> }
  | { readonly _tag: "Error"; readonly error: FsError }

/**
 * Runs a program with the host's services.
 *
 * @private
 * @since 0.1.0
 */
export type Run = <A, E>(
  effect: Effect.Effect<A, E, FlowInvoker.FlowInvoker>,
  options?: { readonly signal: AbortSignal } | undefined
) => Promise<A>

/**
 * The programs the host runs.
 *
 * @private
 * @since 0.1.0
 */
export interface Programs {
  /** Decodes, invokes, and encodes one call, settling it through the context. */
  readonly execute: (
    selected: SelectedRoute,
    context: Context
  ) => Effect.Effect<unknown, never, FlowInvoker.FlowInvoker>
  /** Reports a projection failure through the context. */
  readonly refuse: (context: Context, error: FsError) => Effect.Effect<never>
  /** Loads and projects every route once. */
  readonly projectAll: (tree: CommandTree.CommandTree) => Effect.Effect<ReadonlyMap<Route.Route, Projection>>
  /** Selects the route that request tokens name. */
  readonly select: (tokens: ReadonlyArray<string>, dispatchTokens: ReadonlyArray<string>) => Effect.Effect<Outcome>
}

/**
 * The process facts a served CLI reads and the channels it writes.
 *
 * A library never reads `process` itself: the platform that hosts the CLI
 * supplies these, so the same projection runs where no `process` exists.
 *
 * @private
 * @since 0.1.0
 */
export interface Host {
  /** The command line after the executable and script names. */
  readonly argv: () => ReadonlyArray<string>
  /** One environment variable, or `undefined` when it is unset. */
  readonly env: (name: string) => string | undefined
  /** Writes text to standard output. */
  readonly stdout: (text: string) => void
  /** Ends the process with an exit code. */
  readonly exit: (code: number) => void
}

type AmbientProcess = {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdout: { readonly write: (text: string) => unknown }
  readonly exit: (code: number) => unknown
}

// Read on every call, never captured: a host without `process` (a Worker or a
// browser) gets an empty command line, no environment, and inert channels
// instead of a `ReferenceError`.
const ambientProcess = (): AmbientProcess | undefined =>
  (globalThis as { readonly process?: AmbientProcess | undefined }).process

/**
 * The host used when none is provided: the ambient `process` when the runtime
 * has one, and an empty, inert host when it does not.
 *
 * @private
 * @since 0.1.0
 */
export const ambientHost: Host = Object.freeze({
  argv: () => ambientProcess()?.argv.slice(2) ?? [],
  env: (name: string) => ambientProcess()?.env[name],
  stdout: (text: string) => {
    ambientProcess()?.stdout.write(text)
  },
  exit: (code: number) => {
    ambientProcess()?.exit(code)
  }
})

const discoveryFlags = new Set(["--help", "-h", "--llms", ["--llms", "full"].join("-"), "--schema", "--version"])

const isDiscovery = (argv: ReadonlyArray<string>, host: Host): boolean =>
  // Incur itself tests truthiness, so `COMPLETE=""` must not divert a run.
  Boolean(host.env("COMPLETE")) || argv.includes("--mcp") || argv.some((token) => discoveryFlags.has(token))

const isFetchDiscovery = (pathname: string): boolean =>
  pathname === "/mcp" || pathname === "/openapi.json" || pathname === "/openapi.yml" ||
  pathname === "/openapi.yaml" || pathname.startsWith("/.well-known/")

const descriptionOf = (route: Route.Route): string | undefined => Option.getOrUndefined(route.description)

const commandTokens = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const tokens: Array<string> = []
  for (const token of argv) {
    if (token.startsWith("-")) break
    tokens.push(token)
  }
  return Object.freeze(tokens)
}

type RequestPath = {
  /** Segments exactly as Incur's own matcher will see them. */
  readonly raw: ReadonlyArray<string>
  /** The same segments decoded, which is what route resolution compares. */
  readonly decoded: ReadonlyArray<string>
}

const requestPath = (pathname: string): RequestPath | undefined => {
  const raw: Array<string> = []
  const decoded: Array<string> = []
  for (const segment of pathname.split("/")) {
    if (segment.length === 0) continue
    try {
      // Splitting before decoding keeps `%2F` inside one segment, so an encoded
      // slash can never invent a path boundary.
      decoded.push(decodeURIComponent(segment))
    } catch {
      return undefined
    }
    raw.push(segment)
  }
  return { raw: Object.freeze(raw), decoded: Object.freeze(decoded) }
}

const malformedPath = (): FsError =>
  new FsError({
    code: "parse_failed",
    method: "Incur.fetch",
    description: "The request path contains a malformed percent escape"
  })

const errorEnvelope = (error: FsError): string =>
  JSON.stringify({ ok: false, error: { code: error.code, message: error.description } }, null, 2)

type Channels = {
  readonly stdout: (text: string) => void
  readonly exit: (code: number) => void
}

const reportServe = (error: FsError, channels: Channels): void => {
  channels.stdout(`${errorEnvelope(error)}\n`)
  channels.exit(1)
}

const reportFetch = (error: FsError): Response =>
  new Response(errorEnvelope(error), {
    status: 400,
    headers: { "content-type": "application/json" }
  })

const runOptions = (request: Request | undefined): { readonly signal: AbortSignal } | undefined =>
  request === undefined ? undefined : { signal: request.signal }

const failedDefinition = (route: Route.Route, error: FsError, run: Run, programs: Programs) => ({
  description: descriptionOf(route),
  // A route whose input cannot be projected stays advertised, because it stays
  // dispatchable. Calling it reports the exact failure that stopped the
  // projection instead of a contentless error.
  run(context: Context) {
    return run(programs.refuse(context, error), runOptions(context.request))
  }
})

const selectedDefinition = (selected: SelectedRoute, run: Run, programs: Programs) => ({
  args: selected.schema.args,
  description: descriptionOf(selected.route),
  options: selected.schema.options,
  run(context: Context) {
    return run(programs.execute(selected, context), runOptions(context.request))
  }
})

const metadataCli = (
  name: string,
  tree: CommandTree.CommandTree,
  projections: ReadonlyMap<Route.Route, Projection>,
  run: Run,
  programs: Programs
): IncurCli.Cli => {
  const cli = IncurCli.create(name)
  // Every advertised command carries the same descriptors the dispatch path
  // mounts, so `--llms`, `--schema`, the OpenAPI document, and the MCP tool
  // list describe the input the flow actually accepts, and an MCP tool call
  // reaches the flow with its arguments intact.
  const definitionFor = (route: Route.Route) => {
    const projection = projections.get(route)!
    return projection._tag === "Ready"
      ? selectedDefinition(projection.selected, run, programs)
      : failedDefinition(route, projection.error, run, programs)
  }
  const mountChildren = (parent: IncurCli.Cli, node: CommandTree.CommandTree): void => {
    for (const [segment, child] of node.children) {
      const route = Option.getOrUndefined(child.route)
      if (child.children.size === 0) {
        // A trie node without children is always the leaf of a route.
        parent.command(segment, definitionFor(route!))
        continue
      }
      const group = IncurCli.create(segment, {
        description: route === undefined ? undefined : descriptionOf(route)
      })
      mountChildren(group, child)
      // Incur cannot represent a node that is both runnable and a group, so a
      // route carrying children is advertised under the reserved segment
      // instead of disappearing from every discovery surface.
      if (route !== undefined) group.command(selfSegment, definitionFor(route))
      parent.command(group)
    }
  }
  mountChildren(cli, tree)
  return cli
}

const dispatchCli = (
  name: string,
  selection: Selection,
  run: Run,
  programs: Programs
): IncurCli.Cli => {
  const cli = IncurCli.create(name)
  // The rebuilt CLI serves exactly one request, so it mounts only the tokens
  // that request actually consumed. Mounting the caller's own spelling is what
  // lets a percent-encoded or decomposed name reach Incur's raw matcher.
  const definition = selectedDefinition(selection, run, programs)
  let parent = cli
  for (let index = 0; index < selection.dispatch.length - 1; index++) {
    const group = IncurCli.create(selection.dispatch[index]!)
    parent.command(group)
    parent = group
  }
  parent.command(selection.dispatch[selection.dispatch.length - 1]!, definition)
  return cli
}

/**
 * Serves a validated command tree as an Incur CLI and HTTP handler.
 *
 * @private
 * @since 0.1.0
 */
export const mount = (options: {
  readonly name: string
  readonly tree: CommandTree.CommandTree
  readonly run: Run
  readonly programs: Programs
  readonly host: Host
}): IncurCli.Cli & { readonly close: () => Promise<void> } => {
  const { host, name, programs, run, tree } = options
  const cli = IncurCli.create(name)

  // Dispatch CLIs are short-lived; the metadata CLI also receives guards
  // registered after discovery, including an already running MCP server.
  const middlewares: Array<MiddlewareHandler> = []
  let metadataInstance: IncurCli.Cli | undefined
  const register = cli.use.bind(cli)
  cli.use = (handler) => {
    middlewares.push(handler)
    metadataInstance?.use(handler)
    return register(handler)
  }
  const guarded = (surface: IncurCli.Cli): IncurCli.Cli => {
    Positionals.guard(surface)
    for (const handler of middlewares) surface.use(handler)
    return surface
  }

  // The host owns the shared build. Request cancellation only releases that
  // request's waiter; closing the host interrupts projection itself.
  const lifetime = new AbortController()
  let metadata: Promise<IncurCli.Cli> | undefined
  const metadataSurface = (signal?: AbortSignal): Promise<IncurCli.Cli> => {
    lifetime.signal.throwIfAborted()
    signal?.throwIfAborted()
    // Only successful builds are cached. A rejected build must not poison
    // later discovery requests, including failures while mounting Incur.
    const build = metadata ??= run(programs.projectAll(tree), { signal: lifetime.signal }).then((projections) => {
      lifetime.signal.throwIfAborted()
      return metadataInstance = guarded(metadataCli(name, tree, projections, run, programs))
    }).catch((error: unknown) => {
      metadata = undefined
      throw error
    })
    if (signal === undefined) return build
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort)
        reject(signal.reason)
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      build.then((surface) => {
        signal.removeEventListener("abort", abort)
        resolve(surface)
      }, (error: unknown) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      })
    })
  }

  const select = (
    tokens: ReadonlyArray<string>,
    dispatchTokens: ReadonlyArray<string>,
    options?: { readonly signal: AbortSignal } | undefined
  ): Promise<Outcome> => run(programs.select(tokens, dispatchTokens), options)

  cli.serve = async (argv = [...host.argv()], options = {}) => {
    lifetime.signal.throwIfAborted()
    // Incur falls back to `process` for a channel it is not handed, so every
    // delegated call carries the host's.
    const served = { ...options, stdout: options.stdout ?? host.stdout, exit: options.exit ?? host.exit }
    if (isDiscovery(argv, host)) return (await metadataSurface()).serve(argv, served)
    const normalized = CommandLine.splitName(argv)
    const tokens = commandTokens(normalized)
    const outcome = await select(tokens, tokens)
    if (outcome._tag === "Error") return reportServe(outcome.error, served)
    return Option.isNone(outcome.selection)
      ? (await metadataSurface()).serve([...normalized], served)
      : guarded(dispatchCli(name, outcome.selection.value, run, programs)).serve([...normalized], served)
  }

  cli.fetch = async (request) => {
    lifetime.signal.throwIfAborted()
    request.signal.throwIfAborted()
    const url = new URL(request.url)
    if (isFetchDiscovery(url.pathname)) return (await metadataSurface(request.signal)).fetch(request)
    const path = requestPath(url.pathname)
    if (path === undefined) return reportFetch(malformedPath())
    const outcome = await select(path.decoded, path.raw, { signal: request.signal })
    if (outcome._tag === "Error") return reportFetch(outcome.error)
    return Option.isNone(outcome.selection)
      ? (await metadataSurface(request.signal)).fetch(request)
      : guarded(dispatchCli(name, outcome.selection.value, run, programs)).fetch(request)
  }

  return Object.assign(cli, {
    async close(): Promise<void> {
      lifetime.abort(new DOMException("The CLI is closed", "AbortError"))
      // Interruption settles the Effect fiber even when a native import is
      // still evaluating. Never await the native import itself at shutdown.
      await metadata?.catch(() => undefined)
      metadata = undefined
      metadataInstance = undefined
    }
  })
}
