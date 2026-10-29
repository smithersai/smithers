/**
 * Renders a checked view module to HTML inside a QuickJS realm.
 *
 * The realm compiles QuickJS once and loads a presentation bundle (React,
 * `renderToStaticMarkup`, the components a view may import, and the realm
 * half in `Presentation`) into a fresh QuickJS runtime for every render and
 * interaction, then closes it. A render runs the module's `View` with
 * `{ props, state }`; an interaction runs its `reduce` and renders again, in
 * the same runtime. Nothing one view changes, however it reaches it, survives
 * into another view's render, so no view can read another's props. Nothing in
 * the realm can reach the network, storage, a clock, randomness or the host:
 * it is a WebAssembly interpreter with no module loader, and every value
 * crosses as a JSON string.
 *
 * Each render is bounded by time, interpreter steps, memory and stack, and
 * its HTML and state by size. An infinite loop or a memory bomb fails as a
 * `RealmError` with reason `limit_exceeded` and names the limit; the next
 * call runs in a fresh runtime, so one bad module never leaves a damaged
 * realm behind. A host stack overflow quarantines its shared WASM module;
 * further calls fail closed until the host supplies a fresh variant.
 *
 * A failure's telemetry is content-free. The `PresentationRealm.render` and
 * `PresentationRealm.interact` spans end through `SpanFailure`, carrying only
 * the `realm.reason` and `realm.limit` attributes; a `RealmError`'s `message`
 * names only its reason and limit; and what the module threw, which can quote
 * its props, state or event, stays in the redacted `detail`.
 *
 * The QuickJS build is the harness's `QuickJSVariant` seam: Node and a
 * browser provide the single-file build, and a Cloudflare Worker provides one
 * whose module its toolchain compiled.
 *
 * @since 0.1.0
 */

import { SpanFailure } from "@smthrs/flow"
import { QuickJSLifecycle, QuickJSVariant, type Sandbox } from "@smthrs/harness"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core"
import * as Bridge from "./Bridge.ts"
import type * as Interactions from "./Interactions.ts"
import { jsonLength, utf8Length } from "./internal/bytes.ts"
import { globalName } from "./Presentation.ts"
import type * as ViewCode from "./ViewCode.ts"

/**
 * The bounds on one realm.
 *
 * - `memoryBytes`: the realm's heap;
 * - `stackBytes`: the interpreter's stack. QuickJS must stop a deep
 *   recursion before the host's own stack does, and each byte here costs about
 *   three bytes of host stack, so keep it well under a third of the host's;
 * - `loadMs`: wall-clock time to load the bundle, which happens for every
 *   render and interaction;
 * - `renderMs`: wall-clock time for one render or reduce;
 * - `steps`: interrupt polls for one render or reduce, about ten thousand
 *   interpreter operations each;
 * - `propsBytes`: a render's props, as UTF-8 JSON.
 *
 * State is bounded by `Bridge.maxStateBytes` and HTML by
 * `Bridge.maxHtmlBytes`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Limits {
  readonly memoryBytes: number
  readonly stackBytes: number
  readonly loadMs: number
  readonly renderMs: number
  readonly steps: number
  readonly propsBytes: number
}

/**
 * The bounds a realm takes when given none.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultLimits: Limits = Object.freeze({
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: QuickJSLifecycle.stackBytes,
  loadMs: 10_000,
  renderMs: 1_000,
  steps: 2_000,
  propsBytes: 256 * 1024
})

/**
 * Which bound a render crossed.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Limit = Schema.Literals(["time", "steps", "memory", "stack", "html", "state", "props"])

/**
 * Which bound a render crossed.
 *
 * @category models
 * @since 0.1.0
 */
export type Limit = typeof Limit.Type

/**
 * Why a realm failed:
 *
 * - `load_failed`: the bundle did not load or did not install a renderer;
 * - `invalid_input`: props, state or an event that is not JSON;
 * - `render_failed`: the module threw, exported no component or `reduce`, or
 *   `reduce` returned no state;
 * - `limit_exceeded`: a bound in {@link Limits} or the bridge's sizes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Reason = Schema.Literals(["load_failed", "invalid_input", "render_failed", "limit_exceeded"])

/** A failure's message by reason: fixed text, so a span, a log line or a caller's error report carries no content. */
const sentences: Readonly<Record<typeof Reason.Type, string>> = {
  load_failed: "The presentation bundle did not load",
  invalid_input: "The view's props, state or event is not JSON",
  render_failed: "The view's module failed",
  limit_exceeded: "The view crossed a bound"
}

/**
 * A realm failed.
 *
 * `detail` is written for the renderer that wrote the module and may quote
 * the module or what it threw, which can be its props, state or event. It is
 * redacted, so it prints as `<redacted>`; read it with `Redacted.value` for a
 * correction prompt, never for a log, a span or a metric. `message` names
 * only the reason and the limit, so an ordinary span or log line around a
 * render carries no view content.
 *
 * @category errors
 * @since 0.1.0
 */
export class RealmError extends Schema.TaggedError<RealmError>()("@smthrs/views/RealmError", {
  reason: Reason,
  limit: Schema.optionalKey(Limit),
  detail: Schema.Redacted(Schema.String)
}) {
  /** The reason and the limit as a sentence; never the module's words. */
  override get message(): string {
    return this.limit === undefined ? sentences[this.reason] : `The view crossed its ${this.limit} limit`
  }
}

/**
 * One render: a checked module, its props, and its state.
 *
 * @category models
 * @since 0.1.0
 */
export interface RenderInput {
  readonly module: ViewCode.CheckedModule
  readonly props: unknown
  readonly state: unknown
}

/**
 * One interaction: a checked module, its props, its state, and the event.
 *
 * @category models
 * @since 0.1.0
 */
export interface InteractInput extends RenderInput {
  readonly event: Interactions.Event
}

/**
 * The view after an interaction: the state `reduce` returned and the HTML it
 * renders to.
 *
 * @category models
 * @since 0.1.0
 */
export interface Interacted {
  readonly state: unknown
  readonly html: string
}

/**
 * A loaded realm.
 *
 * @category models
 * @since 0.1.0
 */
export interface Realm {
  /** Renders the module's default export with `{ props, state }`. */
  readonly render: (input: RenderInput) => Effect.Effect<string, RealmError>
  /** Runs `reduce(state, event)` and renders the state it returns. */
  readonly interact: (input: InteractInput) => Effect.Effect<Interacted, RealmError>
  /** The component names the bundle resolves `@smthrs/ui` imports to, for `ViewCode.check`. */
  readonly components: ReadonlyArray<string>
}

/**
 * A loaded realm, as a service.
 *
 * @category services
 * @since 0.1.0
 */
export class PresentationRealm extends Context.Service<PresentationRealm, Realm>()(
  "@smthrs/views/PresentationRealm"
) {}

/**
 * A realm's inputs: the presentation bundle's source and any bounds to change.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly bundle: string
  readonly limits?: Partial<Limits> | undefined
}

/**
 * Bound crossings, by limit. Carries no module, props or state.
 *
 * @category metrics
 * @since 0.1.0
 */
export const limitHits: Metric.Counter<number> = Metric.counter("realm.limit_hit", {
  description: "Presentation realm renders stopped by a bound, by limit"
})

/** Removes the realm's clock, randomness and reflection traps before the bundle loads. */
const prelude = `"use strict";
${QuickJSLifecycle.prelude(["WeakRef", "FinalizationRegistry"])}
globalThis.console = Object.freeze({ log() {}, info() {}, warn() {}, error() {}, debug() {} });`

interface Loaded {
  /** Set when the host's own stack overflowed inside QuickJS: the runtime is unusable and unsafe to dispose. */
  broken: boolean
  readonly runtime: QuickJSRuntime
  readonly context: QuickJSContext
  readonly render: QuickJSHandle
  readonly reduce: QuickJSHandle
  readonly components: ReadonlyArray<string>
}

type Outcome<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: RealmError }

const failure = (reason: typeof Reason.Type, detail: string, limit?: Limit): RealmError =>
  new RealmError({ reason, ...(limit === undefined ? {} : { limit }), detail: Redacted.make(detail) })

const failed = (reason: typeof Reason.Type, detail: string, limit?: Limit): Outcome<never> => ({
  ok: false,
  error: failure(reason, detail, limit)
})

const crossed = (limit: Limit, detail: string): Outcome<never> => failed("limit_exceeded", detail, limit)

const close = (loaded: Loaded): void => {
  loaded.render.dispose()
  loaded.reduce.dispose()
  loaded.context.dispose()
  loaded.runtime.dispose()
}

const serialize = (value: unknown, limit: "props" | "state", max: number): Outcome<string> => {
  const bytes = jsonLength(value)
  if (bytes === undefined) return failed("invalid_input", `The view's ${limit} must be JSON`)
  if (bytes > max) return crossed(limit, `The view's ${limit} are ${bytes} bytes of JSON, over the ${max}-byte limit`)
  return { ok: true, value: JSON.stringify(value) }
}

/**
 * Loads a realm over the bundle, for the life of the scope.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  options: Options
): Effect.Effect<Realm, RealmError, QuickJSVariant.Variant | Scope.Scope> =>
  Effect.gen(function*() {
    const limits: Limits = { ...defaultLimits, ...options.limits }
    const clock = yield* Clock.Clock
    const module: QuickJSWASMModule = yield* QuickJSVariant.compiledModule.pipe(
      Effect.mapError((error: Sandbox.SandboxError) =>
        failure("load_failed", `QuickJS could not be compiled: ${error.message}`)
      )
    )

    if (QuickJSLifecycle.isQuarantined(module)) {
      return yield* Effect.fail(
        failure("load_failed", "The QuickJS module was quarantined after a host stack overflow")
      )
    }

    const interrupt = QuickJSLifecycle.interruptBudget(() => clock.currentTimeMillisUnsafe())
    let hit: Limit | undefined
    const arm = (ms: number, stepBudget: number): void => {
      interrupt.arm(ms, stepBudget)
      hit = undefined
    }

    /** The outcome of a call that threw inside the realm, read before its handle is disposed. */
    const thrown = (context: QuickJSContext, error: QuickJSHandle, reason: "load_failed" | "render_failed") => {
      const dumped: unknown = context.dump(error)
      error.dispose()
      if (hit !== undefined) {
        return crossed(hit, hit === "time" ? "The view ran past its time limit" : "The view ran past its step limit")
      }
      const name = typeof dumped === "object" && dumped !== null ? String((dumped as { name?: unknown }).name) : ""
      const message = typeof dumped === "object" && dumped !== null
        ? String((dumped as { message?: unknown }).message)
        : String(dumped)
      if (/out of memory/i.test(message)) return crossed("memory", "The view ran out of memory")
      if (/stack overflow|call stack/i.test(message)) return crossed("stack", "The view overflowed its stack")
      return failed(reason, name === "" || name === "undefined" ? message : `${name}: ${message}`)
    }

    const load = (): Outcome<Loaded> => {
      const runtime = module.newRuntime()
      runtime.setMemoryLimit(limits.memoryBytes)
      runtime.setMaxStackSize(limits.stackBytes)
      runtime.setInterruptHandler(() => {
        hit = interrupt.poll()
        return hit !== undefined
      })
      const context = runtime.newContext()
      const abandon = (outcome: Outcome<never>): Outcome<never> => {
        context.dispose()
        runtime.dispose()
        return outcome
      }
      arm(limits.loadMs, Number.POSITIVE_INFINITY)
      for (const [code, filename] of [[prelude, "prelude.js"], [options.bundle, "presentation.js"]] as const) {
        const result = context.evalCode(code, filename)
        if (result.error !== undefined) return abandon(thrown(context, result.error, "load_failed"))
        result.value.dispose()
      }
      const installed = context.getProp(context.global, globalName)
      const render = context.getProp(installed, "render")
      const reduce = context.getProp(installed, "reduce")
      const names = context.getProp(installed, "components")
      const components: unknown = context.dump(names)
      names.dispose()
      installed.dispose()
      if (context.typeof(render) !== "function" || context.typeof(reduce) !== "function") {
        render.dispose()
        reduce.dispose()
        return abandon(failed("load_failed", `The bundle did not install ${globalName}`))
      }
      return {
        ok: true,
        value: {
          broken: false,
          runtime,
          context,
          render,
          reduce,
          components: Array.isArray(components) ? components.filter((name) => typeof name === "string") : []
        }
      }
    }

    const first = load()
    if (!first.ok) return yield* Effect.fail(first.error)
    let loaded: Loaded | undefined = first.value
    let closed = false
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (loaded !== undefined) close(loaded)
        loaded = undefined
        closed = true
      })
    )

    /**
     * Runs one call in a realm of its own: the one loaded when the realm was
     * made, or a fresh one. The realm is closed after the call, so nothing a
     * view changed in it, a component's internals included, reaches the next.
     */
    const within = <A>(call: (realm: Loaded) => Outcome<A>): Effect.Effect<A, RealmError> =>
      Effect.suspend(() => {
        if (closed || QuickJSLifecycle.isQuarantined(module)) {
          return Effect.fail(failure("load_failed", "The realm is closed or its QuickJS module is quarantined"))
        }
        let realm = loaded
        loaded = undefined
        if (realm === undefined) {
          const fresh = load()
          if (!fresh.ok) return Effect.fail(fresh.error)
          realm = fresh.value
        }
        const outcome = call(realm)
        if (!realm.broken) close(realm)
        return outcome.ok ? Effect.succeed(outcome.value) : Effect.fail(outcome.error)
      }).pipe(
        Effect.tapError((error) =>
          error.limit === undefined
            ? Effect.annotateCurrentSpan("realm.reason", error.reason)
            : Effect.andThen(
              Effect.annotateCurrentSpan({ "realm.reason": error.reason, "realm.limit": error.limit }),
              Metric.update(Metric.withAttributes(limitHits, { limit: error.limit }), 1)
            )
        )
      )

    /** Calls one of the installed functions with the module's factory and JSON string arguments. */
    const invoke = (
      realm: Loaded,
      fn: QuickJSHandle,
      checked: ViewCode.CheckedModule,
      args: ReadonlyArray<string>
    ): Outcome<string> => {
      const { context } = realm
      arm(limits.renderMs, limits.steps)
      try {
        const factory = context.evalCode(
          `(function (require, module, exports) {\n${checked.compiled}\n})`,
          `view-${checked.digest.slice(0, 12)}.js`
        )
        if (factory.error !== undefined) return thrown(context, factory.error, "render_failed")
        const handles = args.map((arg) => context.newString(arg))
        const result = context.callFunction(fn, context.undefined, factory.value, ...handles)
        for (const handle of handles) handle.dispose()
        factory.value.dispose()
        if (result.error !== undefined) return thrown(context, result.error, "render_failed")
        const text = context.getString(result.value)
        result.value.dispose()
        return { ok: true, value: text }
      } catch {
        // The host's own stack overflowed inside the interpreter. Disposing the
        // runtime now would abort on its unbalanced heap, so it is abandoned.
        QuickJSLifecycle.abandon(module)
        realm.broken = true
        return crossed("stack", "The view overflowed the host's stack")
      }
    }

    const renderIn = (realm: Loaded, checked: ViewCode.CheckedModule, props: string, state: string) => {
      const html = invoke(realm, realm.render, checked, [props, state])
      if (!html.ok) return html
      const bytes = utf8Length(html.value)
      return bytes > Bridge.maxHtmlBytes
        ? crossed("html", `The view rendered ${bytes} bytes of HTML, over the ${Bridge.maxHtmlBytes}-byte limit`)
        : html
    }

    const inputs = (input: RenderInput): Outcome<readonly [string, string]> => {
      const props = serialize(input.props, "props", limits.propsBytes)
      if (!props.ok) return props
      const state = serialize(input.state, "state", Bridge.maxStateBytes)
      if (!state.ok) return state
      return { ok: true, value: [props.value, state.value] }
    }

    const render = (input: RenderInput): Effect.Effect<string, RealmError> =>
      within((realm) => {
        const args = inputs(input)
        return args.ok ? renderIn(realm, input.module, ...args.value) : args
      }).pipe(SpanFailure.withSpan("PresentationRealm.render"))

    const interact = (input: InteractInput): Effect.Effect<Interacted, RealmError> =>
      within((realm): Outcome<Interacted> => {
        const args = inputs(input)
        if (!args.ok) return args
        const [props, state] = args.value
        const reduced = invoke(realm, realm.reduce, input.module, [state, JSON.stringify(input.event)])
        if (!reduced.ok) return reduced
        const bytes = utf8Length(reduced.value)
        if (bytes > Bridge.maxStateBytes) {
          return crossed(
            "state",
            `reduce returned ${bytes} bytes of state, over the ${Bridge.maxStateBytes}-byte limit`
          )
        }
        const next: unknown = JSON.parse(reduced.value)
        const html = renderIn(realm, input.module, props, reduced.value)
        return html.ok ? { ok: true, value: { state: next, html: html.value } } : html
      }).pipe(SpanFailure.withSpan("PresentationRealm.interact"))

    return { render, interact, components: first.value.components }
  })

/**
 * Provides a realm over the bundle.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: Options): Layer.Layer<PresentationRealm, RealmError, QuickJSVariant.Variant> =>
  Layer.effect(PresentationRealm, make(options))
