/**
 * Turning a discovered descriptor into something the durable engine runs.
 *
 * Discovery answers *what flows exist*: a {@link module:Descriptor.FlowDescriptor}
 * is metadata read without evaluating anything, with the body left behind a
 * {@link module:Descriptor.BodyRef}. Nothing in that answer is executable, so
 * `smithers up <flow>` could print a plan card and stop. This module is the
 * missing half: it loads the body a descriptor points at, resolves the
 * `@smthrs/flow` flow the descriptor delegates to, and returns a durable flow
 * plus the `Interpreter` layer that registers it with the runtime.
 *
 * The bridge deliberately does not compile a `@smthrs/core` graph into a plan.
 * A discovered flow declares WHAT it delegates to — a markdown `flows:`
 * frontmatter list, a module `Flow.make({ flows })` — and the host declares
 * HOW that work runs, by registering `@smthrs/flow` flows under those names.
 * One delegating node is therefore the whole lowering, and every runtime
 * decision the descriptor carries rides it:
 *
 * - the declared cache policy goes onto the ACTION the bridged flow
 *   dispatches, which is the value `@smthrs/engine-store` `ActionPersistence`
 *   reads a policy off: `ttlMs` bounds the age of the row the engine may
 *   serve and `scope` narrows the address it is stored under. Declaring one is
 *   also what makes the delegation a single dispatched step at all; read
 *   {@link Lowered.cache} and {@link dispatchedAction} for the shape and for
 *   the one gate a policy still has to pass;
 * - `Node.priority` becomes the delegating node's priority, which is what
 *   reaches `NodeDraft.priority` and `@smthrs/engine-store`'s `PlanScheduler`.
 *   The rc.0 `up` path settles a flow through `@smthrs/flow` `Interpreter`,
 *   which admits every ready node at once, so the priority orders scheduled
 *   plans and nothing else;
 * - the placement directive becomes both the flow's opaque
 *   `@smthrs/flow` placement annotation and a field of the
 *   {@link Invocation} the delegate reads, which is what a host selects a
 *   spawn target with.
 *
 * A delegate the host never registered is refused HERE, with an
 * {@link ExecutableError} naming it, rather than at dispatch: an unresolved
 * call inside the engine dies with an empty `AnyOf` issue that names nothing
 * during dispatch, and a missing flow is a wiring mistake
 * an operator can fix only if the message says which flow is missing.
 *
 * @since 1.0.0-rc.0
 */
import * as Annotations from "@smthrs/core/Annotations"
import * as CoreFlow from "@smthrs/core/Flow"
import * as CoreMarkdown from "@smthrs/core/Markdown"
import * as CorePlacement from "@smthrs/core/Placement"
import * as Action from "@smthrs/flow/Action"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import * as RuntimeFlow from "@smthrs/flow/Flow"
import { FlowInstance, type FlowRuntime } from "@smthrs/flow/FlowRuntime"
import * as Interpreter from "@smthrs/flow/Interpreter"
import type * as FileSet from "@smthrs/plan/FileSet"
import * as PlanNode from "@smthrs/plan/Node"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Descriptor from "./Descriptor.ts"
import { readVerifiedBody } from "./internal/Body.ts"
import * as MarkdownFlow from "./MarkdownFlow.ts"
import * as Registry from "./Registry.ts"
import type { DiscoveryError, RegistryError } from "./RegistryError.ts"

/**
 * The delegate a descriptor runs on when it names no single flow of its own.
 *
 * A markdown skill and a bodiless `Flow.make({ model })` both say "a model
 * does this"; neither names the code that drives one. `agent` is the name a
 * host registers that driver under, and {@link Options.agent} renames it for a
 * host that calls it something else.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const defaultAgent = "agent"

/**
 * The payload a bridged flow is executed with.
 *
 * One JSON field, because the caller is `smithers up <flow> --data <json>` or
 * a control-plane launch, and neither knows the descriptor's schema at the
 * call site. A markdown flow receives its `{ args }` here.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Payload = Schema.Struct({
  input: Schema.optionalKey(Schema.Json)
})

/**
 * The payload a bridged flow is executed with.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Payload = typeof Payload.Type

/**
 * Everything a delegate is told about the descriptor it is running.
 *
 * It is a fixed, serializable envelope rather than the descriptor's own input
 * schema, because a host registers ONE delegate for many descriptors: the
 * agent driver runs every markdown skill in the project. The envelope is what
 * lets it, and it carries the two decisions a driver cannot re-derive —
 * `placement`, which selects the host a cell is spawned on, and `model`, which
 * selects the seat.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const Invocation = Schema.Struct({
  /** The discovered flow's registry name. */
  flow: Schema.String,
  /** The caller's input, as JSON. `null` when the caller supplied none. */
  input: Schema.Json,
  /** The rendered markdown body, or the empty string for a module flow. */
  prompt: Schema.String,
  /** The seat the descriptor declared, or `null`. */
  model: Schema.NullOr(Schema.String),
  /**
   * The lowered host kind, or `null`. A loaded body annotation wins over the
   * descriptor directive.
   */
  placement: Schema.NullOr(Descriptor.Placement),
  /**
   * Host-selection detail for the lowered placement, or `null` when it names
   * no image, profile, or target. A loaded body annotation wins here too.
   *
   * An absent key decodes to `null`. This envelope is a durable action payload
   * — hosts pass `Invocation` itself as an `Action.make` payload schema — so a
   * journal row written before this field existed is decoded again on replay.
   * Without the decoding default that replay would fail on a missing key. The
   * default applies to DECODING only: encoding still writes the key, so the
   * step key an envelope carrying a placement hashes to does not move.
   */
  placementOptions: Schema.NullOr(Schema.Struct({
    image: Schema.optional(Schema.String),
    profile: Schema.optional(Schema.String),
    target: Schema.optional(Schema.String)
  })).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The capabilities the descriptor declared. */
  capabilities: Schema.Array(Schema.String),
  /** The collaborator flows the descriptor declared. */
  flows: Schema.Array(Schema.String)
})

/**
 * Everything a delegate is told about the descriptor it is running.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Invocation = typeof Invocation.Type

/**
 * A registered `@smthrs/flow` flow a descriptor may delegate to.
 *
 * Structural on purpose: a `Flow.make(...)` value satisfies it, and so does a
 * test double. The bridge needs the tag to resolve a name, and both ways of
 * reaching the flow, because the descriptor decides which one it uses: a
 * declared cache policy makes the delegation one dispatched step and a child
 * execution beneath it, and no policy leaves it a call in the caller's plan.
 * See {@link fromDescriptor} for the choice and {@link Lowered.cache} for why
 * it is a choice at all.
 *
 * Structural does not mean untyped. Both ways in take the {@link Invocation}
 * envelope, because that is the only value the bridge ever supplies: a
 * delegate is resolved by TAG, so a flow whose payload is its own shape would
 * otherwise resolve, load, and fail at dispatch on an envelope missing every
 * field it asked for. Requiring the envelope here refuses that flow where the
 * host writes it down instead.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Delegate {
  readonly _tag: string
  /**
   * Existing Flow codecs, preserved in inline and dispatched bridges. Custom
   * delegates without codecs keep their historical Unknown/JSON-only behavior.
   */
  readonly successSchema?: Schema.Top | undefined
  readonly errorSchema?: Schema.Top | undefined
  /**
   * Places the delegation in the caller's plan. This is the shape a descriptor
   * that declares no cache policy takes: the delegate's own topology — its
   * fan-out, its priorities, its waits — is part of the plan the engine builds
   * for the bridged flow, and a host reading that plan sees the real work.
   */
  readonly call: (payload: Invocation) => PlanNode.Node<any, any, any>
  /**
   * Runs the delegate as an execution of its own. This is the shape a
   * descriptor that DECLARES a cache policy takes, because a result can only
   * be recorded and served again if the delegation is one dispatched step;
   * see {@link fromDescriptor}.
   */
  readonly execute: (
    payload: Invocation,
    options?: { readonly executionId?: string | undefined }
  ) => Effect.Effect<any, any, any>
}

/**
 * Stable reasons a descriptor cannot be made runnable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ExecutableErrorCode = Schema.Literals([
  "missing_delegate",
  "ambiguous_delegate",
  "body_unavailable",
  "invalid_module"
])

/**
 * Stable reasons a descriptor cannot be made runnable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ExecutableErrorCode = typeof ExecutableErrorCode.Type

/**
 * A descriptor the bridge will not turn into a runnable flow.
 *
 * `delegate` is present whenever the refusal is about one named flow, which is
 * the whole point of the type: the engine's own unresolved-call defect names
 * nothing, so an operator reading it cannot tell which registration is
 * missing.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class ExecutableError extends Schema.TaggedError<ExecutableError>()(
  "flows/registry/ExecutableError",
  {
    code: ExecutableErrorCode,
    flow: Schema.String,
    path: Schema.optional(Schema.String),
    delegate: Schema.optional(Schema.String),
    available: Schema.Array(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * The runtime decisions lowered off a descriptor and its loaded body.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Lowered {
  /**
   * The declared cache policy, or `undefined` when none was declared.
   *
   * A declared policy is what makes a discovered flow's result reusable, and
   * declaring one changes the shape of the plan: the delegation becomes one
   * dispatched action ({@link dispatchedAction}) instead of the delegate's own
   * call, because a result can only be recorded and served again if it is one
   * step. The policy rides that action under the annotation
   * `@smthrs/engine-store` `ActionPersistence` reads a policy off, so `ttlMs`
   * bounds the age of the row the engine may serve and `scope` narrows the
   * address it is stored under. It also enters the delegating node's captured
   * key material, so a changed policy is a changed step key.
   *
   * One gate remains, and it is the engine's: `ActionPersistence` reuses a
   * `sealed` dispatch and nothing else. A descriptor that names a delegate flow
   * inherits authority discovery cannot read, so it projects the conservative
   * wildcard and its effective tier is `irreversible`; its policy reaches
   * admission and is refused there. A descriptor whose own capabilities project
   * a `sealed` tier — an agent-backed skill declaring what it may touch — is
   * the one whose recorded result travels.
   */
  readonly cache: CacheEnvironment.CachePolicy | undefined
  /**
   * The declared scheduling priority, or `undefined`.
   *
   * Honored by `@smthrs/engine-store`'s `PlanScheduler`, which admits ready
   * nodes highest-priority-first under a concurrency limit. The rc.0 `up` path
   * runs a flow through `@smthrs/flow` `Interpreter`, which settles every ready
   * node at once, so on that path the priority orders nothing.
   */
  readonly priority: number | undefined
  /** The declared placement directive, or `undefined`. */
  readonly placement: CorePlacement.Placement | undefined
}

/**
 * What a registration layer still needs from its host: the flow runtime it
 * registers with, the action implementation table a driver resolves the
 * bridged dispatch through, and the `Crypto` the bridge derives its delegate's
 * child execution id with.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Registration = FlowRuntime | Action.Implementations | Crypto.Crypto

/**
 * One discovered flow, made runnable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Executable {
  /** The descriptor this was built from. */
  readonly descriptor: Descriptor.FlowDescriptor
  /** The registered flow this descriptor delegates to. */
  readonly delegate: string
  /** The runtime decisions lowered off the descriptor. */
  readonly lowered: Lowered
  /** The envelope the delegate receives for a given caller input. */
  readonly invocation: (input: Schema.Json) => Invocation
  /**
   * The durable flow, tagged with the descriptor's registry name. Delegate
   * already erases its call/execute services at this dynamic boundary; the
   * same host owns its codec services when registering and executing.
   */
  readonly flow: RuntimeFlow.Flow<
    string,
    typeof Payload,
    Schema.Codec<unknown, unknown>,
    Schema.Codec<unknown, unknown>,
    any
  >
  /** Registers {@link Executable.flow} with the runtime. */
  readonly layer: Layer.Layer<never, never, Registration>
}

/**
 * How a descriptor is loaded and what it may delegate to.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  /** The registered runtime flows a descriptor may delegate to. */
  readonly delegates: ReadonlyArray<Delegate>
  /** The delegate a model-backed descriptor runs on. Defaults to `agent`. */
  readonly agent?: string | undefined
  /**
   * Per-entry catalog deadline in milliseconds. Defaults to 30,000.
   * Must be positive and finite. Direct descriptor loads have no deadline.
   */
  readonly loadTimeoutMs?: number | undefined
  /**
   * Evaluates the verified entry bytes. Any cache must include both path and
   * contentDigest; reopening path does not honor the verified identity.
   * Defaults to importing a private, digest-qualified sibling file.
   */
  readonly load?:
    | ((path: string, source: {
      readonly bytes: Uint8Array
      readonly contentDigest: string
    }) => Effect.Effect<unknown, unknown>)
    | undefined
}

const refuse = (options: {
  readonly code: ExecutableErrorCode
  readonly flow: string
  readonly path?: string | undefined
  readonly delegate?: string | undefined
  readonly available?: ReadonlyArray<string> | undefined
  readonly message: string
  readonly cause?: unknown
}): ExecutableError =>
  new ExecutableError({
    code: options.code,
    flow: options.flow,
    path: options.path,
    delegate: options.delegate,
    available: options.available ?? [],
    message: options.message,
    cause: options.cause
  })

/**
 * A `file:` specifier for an absolute filesystem path.
 *
 * Written by hand rather than with `node:url` so a package importing this
 * conversion does not also require a Node builtin or a bundler shim for one.
 * It follows `pathToFileURL`'s escaping for filesystem paths. A `#` or a `?`
 * in a directory name is both a legal filename character and URL syntax, and
 * concatenating one unescaped truncates the specifier at it, so `file:///a#b.ts`
 * addresses `/a`. The loader then imports the wrong module, or none, with
 * nothing in the failure to say why.
 *
 * Exported because {@link Options.load} receives a resolved filesystem path
 * or an existing file URL. A host that supplies its own loader can convert
 * filesystem paths without depending on `node:url` here.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const fileSpecifier = (path: string): string => {
  if (path.startsWith("file:")) return path
  const normalized = /^[A-Za-z]:[\\/]/.test(path) ? path.replaceAll("\\", "/") : path
  const escaped = encodeURI(normalized).replaceAll("#", "%23").replaceAll("?", "%3F")
  return normalized.startsWith("/") ? `file://${escaped}` : `file:///${escaped}`
}

const importModule = (
  path: string,
  source: { readonly bytes: Uint8Array; readonly contentDigest: string }
): Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const platformPath = yield* Path.Path
    const sourcePath = path.startsWith("file:") ? yield* platformPath.fromFileUrl(new URL(path)) : path
    // Reserve a unique name using the host filesystem. The module is a sibling
    // of this directory, so relative imports retain the source's base directory.
    const reservation = yield* fs.makeTempDirectoryScoped({
      directory: platformPath.dirname(sourcePath),
      prefix: `.smithers-${source.contentDigest}-`
    })
    const modulePath = `${reservation}${platformPath.extname(sourcePath) || ".mjs"}`
    yield* Effect.acquireRelease(
      fs.writeFile(modulePath, new Uint8Array(0), { flag: "wx", mode: 0o600 }),
      () => fs.remove(modulePath).pipe(Effect.orDie)
    )
    yield* fs.writeFile(modulePath, source.bytes)
    return yield* Effect.tryPromise({
      try: () => import(/* @vite-ignore */ fileSpecifier(modulePath)) as Promise<unknown>,
      catch: (cause) => cause
    })
  }).pipe(Effect.scoped)

/**
 * The registry name of the flow a descriptor delegates to.
 *
 * A descriptor that names exactly one flow delegates to it. One that names
 * none delegates to the agent, and so does one that names several while
 * declaring a model — a skill listing its tools is naming what the model may
 * call, not what runs it. Several named flows and no model leaves nothing to
 * choose between them, and the bridge refuses rather than guesses.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const delegateOf = (
  descriptor: Descriptor.FlowDescriptor,
  options: { readonly agent?: string | undefined } = {}
): Effect.Effect<string, ExecutableError> => {
  const agent = options.agent ?? defaultAgent
  if (descriptor.flows.length === 1) return Effect.succeed(descriptor.flows[0]!)
  if (descriptor.flows.length === 0 || Option.isSome(descriptor.model)) return Effect.succeed(agent)
  return Effect.fail(
    refuse({
      code: "ambiguous_delegate",
      flow: descriptor.name,
      message:
        `flow "${descriptor.name}" names ${descriptor.flows.length} flows and no model, so the flow it delegates to is undecidable; declare a model or name one flow`
    })
  )
}

/**
 * The placement directive a descriptor's literal stands for.
 *
 * Discovery records placement as one of four literals because a descriptor is
 * serializable; `@smthrs/core` models it as a tagged value with host-selection
 * options. This is the one-way projection between them.
 */
const placementOf = (literal: Descriptor.Placement): CorePlacement.Placement => {
  switch (literal) {
    case "client":
      return CorePlacement.client()
    case "local":
      return CorePlacement.local()
    case "sandbox":
      return CorePlacement.sandbox()
    case "remote":
      return CorePlacement.remote()
  }
}

/**
 * Reads the runtime decisions a loaded body and its descriptor declare.
 *
 * The body's annotation bag wins over the descriptor's frontmatter, because a
 * body is the later and more specific statement: `Flow.within(...)` and
 * `@smthrs/patterns`' `withCache` both write there, and frontmatter cannot
 * express either.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const lower = (
  descriptor: Descriptor.FlowDescriptor,
  annotations: Context.Context<never>
): Lowered => ({
  cache: CacheEnvironment.cachePolicyOf(annotations),
  priority: Option.getOrUndefined(Annotations.getOption(annotations, Annotations.Priority)),
  placement: Option.getOrUndefined(Annotations.getOption(annotations, Annotations.Placement)) ??
    Option.getOrUndefined(Option.map(descriptor.placement, placementOf))
})

const ownedJson = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(ownedJson))
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ownedJson(child)])))
  }
  return value
}

const ownedStrings = (values: ReadonlyArray<string>): Array<string> => {
  const copy = [...values]
  Object.freeze(copy)
  return copy
}

const invocationPlacement = (
  placement: CorePlacement.Placement | undefined
): Pick<Invocation, "placement" | "placementOptions"> => {
  if (placement === undefined) return { placement: null, placementOptions: null }
  switch (placement._tag) {
    case "flows/core/Placement/Client":
      return { placement: "client", placementOptions: null }
    case "flows/core/Placement/Local":
      return { placement: "local", placementOptions: null }
    case "flows/core/Placement/Sandbox":
    case "flows/core/Placement/Remote": {
      const options = {
        ...(placement.image === undefined ? {} : { image: placement.image }),
        ...(placement.profile === undefined ? {} : { profile: placement.profile }),
        ...(placement.target === undefined ? {} : { target: placement.target })
      }
      return {
        placement: placement._tag === "flows/core/Placement/Sandbox" ? "sandbox" : "remote",
        placementOptions: Object.keys(options).length === 0 ? null : Object.freeze(options)
      }
    }
  }
}

/** The captured declaration identity a policy contributes to the node's key. */
const captured = (lowered: Lowered): Readonly<Record<string, unknown>> => ({
  ...(lowered.cache?.ttlMs === undefined ? {} : { ttlMs: lowered.cache.ttlMs }),
  ...(lowered.cache?.scope === undefined ? {} : { scope: lowered.cache.scope })
})

/**
 * The annotation bag the bridged flow carries.
 *
 * Placement is stored under `@smthrs/flow`'s own placement key, which
 * `@smthrs/flow` `Graph` reads while building the plan. The cache policy is
 * stored under `CacheEnvironment.CachePolicyAnnotation`, the identifier
 * `@smthrs/patterns`' `withCache` writes on a flow, so a host reading the
 * bridged flow back sees the same declaration the descriptor made.
 *
 * A flow's bag is not an action's bag, and nothing carries one onto the other:
 * `@smthrs/engine-store` `ActionPersistence` reads a policy off the DISPATCHED
 * ACTION. That copy is written by {@link dispatchedAction}, which is the half
 * that reaches admission. This bag is the declaration surface.
 */
const annotationsOf = (lowered: Lowered): Context.Context<never> => {
  let bag = Context.empty()
  if (lowered.cache !== undefined) bag = Context.add(bag, CacheEnvironment.CachePolicyAnnotation, lowered.cache)
  if (lowered.placement !== undefined) {
    bag = Context.add(bag, RuntimeFlow.Placement, lowered.placement as RuntimeFlow.PlacementDirective)
  }
  return bag
}

/**
 * The filesystem boundary a descriptor's own effect declaration lowers to.
 *
 * A descriptor declares reads and writes as strings plus a `mode`, because it
 * is serializable metadata read without evaluating anything. An action's
 * `Action.FileBoundary` wants measured inputs or globs on the read side and
 * patterns on the write side. A declared read carries no digest at discovery
 * time, so the whole read set lowers to one glob the host expands and
 * measures; `@smthrs/engine-store` keeps a globbed read set out of the
 * cross-run cache, so a descriptor that declares reads is boundary-checked but
 * not reused. `hermetic` says the two sets are complete, which is exactly what
 * a `hard` boundary enforces, and `expected` records a deviation rather than
 * refusing the result.
 *
 * The patterns are the author's, not the bridge's: an unusable one is refused
 * by the host that prepares the boundary, naming the path.
 */
const boundaryOf = (descriptor: Descriptor.FlowDescriptor): Action.FileBoundary => ({
  readSet: descriptor.effects.reads.length === 0
    ? []
    : [{ _tag: "Glob", include: descriptor.effects.reads as FileSet.Glob["include"] }],
  writeSet: descriptor.effects.writes,
  boundaryMode: descriptor.effects.mode === "hermetic" ? "hard" : "expected"
})

/**
 * The loaded body of one descriptor: the prompt it renders, and the annotation
 * bag its declaration carries.
 */
interface LoadedBody {
  readonly prompt: string
  readonly annotations: Context.Context<never>
}

const sourceBytes = (
  descriptor: Descriptor.FlowDescriptor,
  sourcePath: string
): Effect.Effect<Uint8Array, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* readVerifiedBody(fs, path, descriptor).pipe(
      Effect.mapError((failure) =>
        refuse({
          code: "body_unavailable",
          flow: descriptor.name,
          path: sourcePath,
          message: failure._tag === "changed"
            ? `the body of flow "${descriptor.name}" changed at "${sourcePath}" after discovery; refresh the registry before running it`
            : failure._tag === "unmeasured"
            ? `the body of flow "${descriptor.name}" is unmeasured at "${sourcePath}"; refresh the registry before running it`
            : `the body of flow "${descriptor.name}" is unavailable at "${sourcePath}"`,
          cause: failure._tag === "unreadable" ? failure.cause : undefined
        })
      )
    )
  })

const loadMarkdown = (
  descriptor: Descriptor.FlowDescriptor,
  path: string,
  baseDirectory: string
): Effect.Effect<LoadedBody, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const text = new TextDecoder().decode(yield* sourceBytes(descriptor, path))
    // `loadBody` is typed over the whole body union but answers `Prompt` for
    // every markdown source, which is the only kind that reaches here; the
    // module arm is the branch above. Narrowing by assertion rather than by a
    // condition keeps an unreachable arm out of the module.
    const body = MarkdownFlow.loadBody(text, baseDirectory) as Descriptor.FlowBodyPrompt
    const prompt = MarkdownFlow.renderPrompt(body, { args: "" })
    const lowered = CoreMarkdown.lowerMarkdown(MarkdownFlow.toCoreFrontmatter(descriptor), prompt)
    return { prompt, annotations: lowered.annotations }
  })

const loadModule = (
  descriptor: Descriptor.FlowDescriptor,
  path: string,
  options: Options
): Effect.Effect<LoadedBody, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const platformPath = yield* Path.Path
    const bytes = yield* sourceBytes(descriptor, path)
    const loadPath = path.startsWith("file:") ? path : platformPath.resolve(path)
    const loaded = yield* (options.load ?? importModule)(loadPath, {
      bytes,
      contentDigest: descriptor.body.contentDigest!
    }).pipe(
      Effect.mapError((cause) =>
        refuse({
          code: "body_unavailable",
          flow: descriptor.name,
          path,
          message: `the body of flow "${descriptor.name}" could not be loaded from "${path}"`,
          cause
        })
      )
    )
    const exported = (loaded as { readonly default?: unknown } | null | undefined)?.default
    if (!CoreFlow.isFlow(exported)) {
      return yield* Effect.fail(
        refuse({
          code: "invalid_module",
          flow: descriptor.name,
          path,
          message: `"${path}" must default-export a Flow.make value; flow "${descriptor.name}" cannot be run`
        })
      )
    }
    // Every flow carries an annotation bag; `Flow.Any` simply does not say so.
    return { prompt: "", annotations: (exported as unknown as CoreFlow.Flow<never, never, never>).annotations }
  })

/**
 * The one action a policy-declaring descriptor's bridged flow dispatches, and
 * the layer carrying its implementation.
 *
 * The declaration is a thin named seam: `Declared.toLayer` builds the action it
 * dispatches from the declaration's own tier and idempotency key and carries no
 * `metadata`, and an action with no file boundary is never cacheable. The
 * dispatched unit that carries the descriptor's declarations is therefore the
 * inline action the implementation returns — its tier, its identity, its file
 * boundary, and the `CacheEnvironment.CachePolicyAnnotation`
 * `@smthrs/engine-store` `ActionPersistence` reads off a DISPATCHED action to
 * bound a row's age by `ttlMs` and narrow its address by `scope`.
 *
 * The delegate runs underneath as a CHILD EXECUTION derived from the parent's —
 * the same derivation `@smthrs/flow` `Interpreter` uses for a `.child()`
 * boundary — so it keeps its own execution, journal lineage, and retry policy
 * beneath the step rather than being hidden inside it. Deriving the id from the
 * parent's is what keeps two runs' children apart: the ambient default derives
 * an id from the flow tag and the payload, so two runs invoking the same
 * descriptor the same way would otherwise be one child execution, and a
 * descriptor that declared nothing would reuse a result anyway.
 */
const dispatchedAction = (options: {
  readonly tag: string
  readonly descriptor: Descriptor.FlowDescriptor
  readonly delegate: Delegate
  readonly cache: CacheEnvironment.CachePolicy
}) => {
  const { cache, delegate, descriptor, tag } = options
  const declaration = Action.make(tag, {
    payload: Invocation,
    success: delegate.successSchema ?? Schema.Unknown,
    error: delegate.errorSchema ?? Schema.Unknown
  })
  const layer = declaration.toLayer((envelope: Invocation) => {
    const identityEnvelope = Schema.encodeUnknownSync(Invocation)(envelope) as unknown as Schema.Json
    return CacheEnvironment.withCache(
      Action.make({
        name: `${tag}/run`,
        success: delegate.successSchema ?? Schema.Unknown,
        error: delegate.errorSchema ?? Schema.Unknown,
        // The descriptor's own reversibility tier, declared or inferred from its
        // projected authority, and never widened here. It is also the gate on
        // reuse: `ActionPersistence` caches a `sealed` dispatch and nothing
        // else, so a policy on a descriptor whose authority projects to
        // `irreversible` — which is every descriptor naming a delegate flow,
        // because the delegate's authority is not statically visible — reaches
        // admission and is refused there rather than being dropped here.
        tier: descriptor.effects.tier,
        // The cross-run address: the delegate, the whole envelope — the
        // descriptor's declaration AND the caller's input, so one caller's
        // recorded answer is never served to the next caller's question — and
        // the policy itself, because `ActionPersistence` assumes a changed
        // `ttlMs` is a changed step key when it fences its own expiry verdict.
        idempotencyKey: { delegate: delegate._tag, invocation: identityEnvelope, cache },
        metadata: boundaryOf(descriptor),
        execute: Effect.gen(function*() {
          const instance = yield* FlowInstance
          const executionId = yield* Interpreter.childExecutionId(
            instance.executionId,
            tag,
            delegate._tag,
            identityEnvelope
          )
          return yield* delegate.execute(envelope, { executionId })
        })
      }),
      cache
    )
  })
  return { declaration, layer }
}

/**
 * Makes one discovered descriptor runnable.
 *
 * The body is loaded — a module through the loader, markdown through
 * {@link module:MarkdownFlow} — the delegate is resolved against the host's
 * registered flows, and the result is a durable flow whose body is one
 * delegating node plus the layer that registers it.
 *
 * Everything that can be refused is refused here, before the flow exists: a
 * missing delegate, an undecidable one, an unreadable body, a module that
 * exports something else. A flow this function returns is one the engine can
 * drive.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const fromDescriptor = (
  descriptor: Descriptor.FlowDescriptor,
  options: Options
): Effect.Effect<Executable, ExecutableError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    // The delegate is resolved BEFORE the body is loaded. Both refusals are
    // real, but only one of them is about this host: a flow whose delegate
    // nobody registered is not runnable here whatever its body says, and an
    // operator reading "could not load" would go looking in the wrong place.
    const name = yield* delegateOf(descriptor, options)
    const delegate = options.delegates.find((candidate) => candidate._tag === name)
    if (delegate === undefined) {
      return yield* Effect.fail(
        refuse({
          code: "missing_delegate",
          flow: descriptor.name,
          delegate: name,
          available: options.delegates.map((candidate) => candidate._tag).sort(),
          message: `flow "${descriptor.name}" delegates to "${name}", which no registered flow provides`
        })
      )
    }
    const body = descriptor.body._tag === "Markdown"
      ? yield* loadMarkdown(descriptor, descriptor.body.path, descriptor.body.baseDirectory)
      : yield* loadModule(descriptor, descriptor.body.path, options)
    const lowered = lower(descriptor, body.annotations)
    const invocation = (input: Schema.Json): Invocation => {
      const placement = invocationPlacement(lowered.placement)
      return Object.freeze({
        flow: descriptor.name,
        input: ownedJson(input),
        prompt: body.prompt,
        model: Option.getOrNull(descriptor.model),
        placement: placement.placement,
        placementOptions: placement.placementOptions,
        capabilities: ownedStrings(descriptor.capabilities),
        flows: ownedStrings(descriptor.flows)
      })
    }
    // WHAT THE BRIDGED FLOW DISPATCHES, AND WHY IT DEPENDS ON THE POLICY.
    //
    // Without a cache policy the delegation is a CALL: the delegate's node goes
    // into the plan the engine builds for this flow, so its fan-out, its
    // priorities, and its waits are the caller's plan and a host reading that
    // plan sees the real work. That shape is not a step the engine can record —
    // it is many steps — so there is nothing there for a policy to govern.
    //
    // A declared policy asks for exactly that: one recorded unit, served again
    // when a later run asks the same question. A descriptor that declares one
    // therefore dispatches `dispatchedAction` instead of calling the delegate,
    // and the delegate runs underneath it as a child execution.
    const bridge = lowered.cache === undefined ? undefined : dispatchedAction({
      tag: `registry/${descriptor.name}`,
      descriptor,
      delegate,
      cache: lowered.cache
    })
    // The policy travels three ways: as an annotation on the flow (the
    // declaration surface a host reads back), as captured identity on the
    // delegating node, so two descriptors declaring different policies are two
    // declarations with two step keys, and — the half that reaches admission —
    // onto the action the bridged flow dispatches, above.
    const identity = PlanNode.capture(captured(lowered), (value: unknown) => value)
    // The BODY's identity is captured too, and it has to be. A plan-time
    // function JavaScript cannot inspect gets process-local identity, so a
    // bridged flow built from one unchanged descriptor would key differently in
    // every process — no replayed step would ever match, and no recorded result
    // would ever be reused. Everything the body reads is inert descriptor data,
    // so declaring it makes the flow's identity a function of the descriptor
    // rather than of the process that loaded it.
    const placement = invocationPlacement(lowered.placement)
    const build = PlanNode.capture(
      {
        flow: descriptor.name,
        delegate: name,
        prompt: body.prompt,
        model: Option.getOrNull(descriptor.model),
        placement: placement.placement,
        placementOptions: placement.placementOptions,
        capabilities: [...descriptor.capabilities],
        flows: [...descriptor.flows],
        priority: lowered.priority ?? null,
        ...captured(lowered)
      },
      (payload: Payload) => {
        const envelope = invocation(payload.input ?? null)
        const carried = bridge === undefined
          ? delegate.call(envelope)
          : PlanNode.map(bridge.declaration.call(envelope), identity)
        return lowered.priority === undefined ? carried : PlanNode.priority(carried, lowered.priority)
      }
    )
    const flow = RuntimeFlow.make(descriptor.name, {
      payload: Payload,
      // Preserve the delegate's codecs through the named bridge. Unknown loses
      // transformations and cannot encode tagged Error instances as JSON.
      success: delegate.successSchema ?? Schema.Unknown,
      error: delegate.errorSchema ?? Schema.Unknown,
      annotations: annotationsOf(lowered),
      body: build
    })
    return {
      descriptor,
      delegate: name,
      lowered,
      invocation,
      // The catalog cannot name services of a dynamically selected delegate.
      // Keep its exact schema objects. Delegate.call/execute already erase
      // services; the delegate's registrant also owns these codec services.
      flow: flow as Executable["flow"],
      // The cast erases the requirement `bridge` minted for itself. Its key is
      // built from a tag this function computes, so no caller can spell the
      // type, and nothing outside the bridged flow's own body asks for it.
      layer: (bridge === undefined
        ? Interpreter.layer(flow)
        : Layer.merge(Interpreter.layer(flow), bridge.layer)) as Layer.Layer<never, never, Registration>
    }
  })

/**
 * Makes one discovered flow runnable by registry name.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const fromRegistry = (
  name: string,
  options: Options
): Effect.Effect<
  Executable,
  ExecutableError | RegistryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    return yield* fromDescriptor(yield* registry.get(name), options)
  })

/**
 * Every discovered flow this host can run, and the ones it declined.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Catalog {
  readonly executables: ReadonlyArray<Executable>
  readonly refused: ReadonlyArray<ExecutableError>
}

/**
 * Service tag for the catalog a host was built from.
 *
 * {@link layer} provides it, so a command that lists or diagnoses flows reads
 * the same refusals the registration phase acted on instead of rebuilding the
 * catalog and hoping the two agree.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export const Catalog: Context.Service<Catalog, Catalog> = Context.Service("flows/registry/Catalog")

/**
 * Makes every discovered flow runnable, reporting the ones it could not.
 *
 * A project's `flows/` directory is a mixed set: some entries delegate to a
 * flow this host registered, others name a delegate only another host has, and
 * one may simply be broken. None of those is a reason to withhold the rest.
 * `flows/` is a directory a person edits, so at any moment one file in it is
 * mid-edit or wrong, and a catalog that failed on it would take down `ls`,
 * `ps`, and every unrelated `up` with it.
 *
 * So every refusal is reported in {@link Catalog.refused} carrying its
 * {@link ExecutableError} code, and the entries that resolve stay runnable. The
 * codes are what distinguish the two kinds: `missing_delegate` and
 * `ambiguous_delegate` are statements about this host, while
 * `body_unavailable` and `invalid_module` are defects in the entry.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const catalog = (
  options: Options
): Effect.Effect<
  Catalog,
  RegistryError | DiscoveryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry
    const descriptors = yield* registry.list()
    const executables: Array<Executable> = []
    const refused: Array<ExecutableError> = []
    for (const descriptor of descriptors) {
      const loadTimeoutMs = options.loadTimeoutMs ?? 30_000
      const result = yield* Effect.result(
        fromDescriptor(descriptor, options).pipe(
          Effect.timeoutOrElse({
            duration: loadTimeoutMs,
            orElse: () =>
              Effect.fail(refuse({
                code: "body_unavailable",
                flow: descriptor.name,
                path: descriptor.body.path,
                message:
                  `the body of flow "${descriptor.name}" timed out after ${loadTimeoutMs}ms while loading "${descriptor.body.path}"`
              }))
          })
        )
      )
      if (result._tag === "Success") {
        executables.push(result.success)
        continue
      }
      const failure = result.failure
      refused.push(failure)
      yield* Effect.logWarning("discovered flow is not runnable on this host", {
        flow: failure.flow,
        path: failure.path,
        code: failure.code,
        delegate: failure.delegate,
        available: failure.available,
        reason: failure.message
      })
    }
    return { executables, refused }
  })

/**
 * Registers every runnable discovered flow with the runtime.
 *
 * This is the layer a host passes as the durable runtime's registration phase:
 * once it has been built, `Control.run` on a discovered flow reaches a
 * registered durable flow instead of an empty catalog.
 *
 * A refusal is never silent. Each one is logged as a warning naming the flow,
 * the code, the delegate it wanted, and what is registered instead, and the
 * whole {@link Catalog} is provided as a service, so a host can print the
 * refusals rather than let an operator discover them from `up <flow>` failing
 * inside the runtime.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (
  options: Options
): Layer.Layer<
  Catalog,
  RegistryError | DiscoveryError,
  Registry.Registry | FileSystem.FileSystem | Path.Path | Registration
> =>
  Layer.unwrap(
    Effect.map(
      catalog(options),
      (built) =>
        Layer.mergeAll(
          Layer.succeed(Catalog)(built),
          ...built.executables.map((executable) => executable.layer)
        )
    )
  )

/**
 * Compatibility alias for the project registry options, retained for one release candidate.
 *
 * @deprecated Use `Registry.ProjectOptions`.
 * @category models
 * @since 1.0.0-rc.0
 */
export type ProjectOptions = Registry.ProjectOptions

/**
 * Compatibility alias for the project registry constructor, retained for one release candidate.
 *
 * @deprecated Use `Registry.layerProject`.
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerProject: typeof Registry.layerProject = Registry.layerProject
