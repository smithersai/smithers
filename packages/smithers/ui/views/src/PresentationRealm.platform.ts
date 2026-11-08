/**
 * The platform code of `PresentationRealm.vibe`: everything that drives a
 * QuickJS runtime, which a .vibe file does not call directly (EK4402, EK0401).
 * The realm's bounds, its failures as data, and the host's own stack overflow
 * live here; `PresentationRealm.vibe` turns each refusal into a `RealmError`.
 *
 * @since 0.1.0
 * @private
 */

import { QuickJSLifecycle } from "@smthrs/harness"
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core"
import * as Bridge from "./Bridge.vibe"
import type * as Interactions from "./Interactions.vibe"
import { jsonLength, utf8Length } from "./internal/bytes.ts"
import { globalName } from "./Presentation.ts"
import type { Interacted, Limit, Limits, Reason } from "./PresentationRealm.vibe"
import type * as ViewCode from "./ViewCode.ts"

/**
 * A call the realm refused: why, the detail written for the renderer, and the
 * limit crossed when there is one.
 *
 * @since 0.1.0
 * @private
 */
export interface Refused {
  readonly ok: false
  readonly reason: typeof Reason.Type
  readonly detail: string
  readonly limit?: Limit
}

/**
 * What a call in the realm produced, or why it did not.
 *
 * @since 0.1.0
 * @private
 */
export type Outcome<A> = { readonly ok: true; readonly value: A } | Refused

/**
 * A realm host: the QuickJS module, the bounds, and the runtime loaded for the
 * next call.
 *
 * @since 0.1.0
 * @private
 */
export interface Host {
  /** The component names the bundle resolves `@smthrs/ui` imports to. */
  readonly components: ReadonlyArray<string>
}

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

class RealmHost implements Host {
  components: ReadonlyArray<string> = []
  loaded: Loaded | undefined = undefined
  closed = false
  hit: Limit | undefined = undefined
  readonly interrupt: ReturnType<typeof QuickJSLifecycle.interruptBudget>
  readonly module: QuickJSWASMModule
  readonly limits: Limits
  readonly bundle: string
  constructor(module: QuickJSWASMModule, limits: Limits, now: () => number, bundle: string) {
    this.module = module
    this.limits = limits
    this.bundle = bundle
    this.interrupt = QuickJSLifecycle.interruptBudget(now)
  }
}

const failed = (reason: typeof Reason.Type, detail: string, limit?: Limit): Refused => ({
  ok: false,
  reason,
  detail,
  ...(limit === undefined ? {} : { limit })
})

const crossed = (limit: Limit, detail: string): Refused => failed("limit_exceeded", detail, limit)

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

const arm = (host: RealmHost, ms: number, stepBudget: number): void => {
  host.interrupt.arm(ms, stepBudget)
  host.hit = undefined
}

/** The outcome of a call that threw inside the realm, read before its handle is disposed. */
const thrown = (
  host: RealmHost,
  context: QuickJSContext,
  error: QuickJSHandle,
  reason: "load_failed" | "render_failed"
): Refused => {
  const dumped: unknown = context.dump(error)
  error.dispose()
  const hit = host.hit
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

const load = (host: RealmHost): Outcome<Loaded> => {
  const { limits, module } = host
  const runtime = module.newRuntime()
  runtime.setMemoryLimit(limits.memoryBytes)
  runtime.setMaxStackSize(limits.stackBytes)
  runtime.setInterruptHandler(() => {
    host.hit = host.interrupt.poll()
    return host.hit !== undefined
  })
  const context = runtime.newContext()
  const abandon = (outcome: Refused): Refused => {
    context.dispose()
    runtime.dispose()
    return outcome
  }
  arm(host, limits.loadMs, Number.POSITIVE_INFINITY)
  for (const [code, filename] of [[prelude, "prelude.js"], [host.bundle, "presentation.js"]] as const) {
    const result = context.evalCode(code, filename)
    if (result.error !== undefined) return abandon(thrown(host, context, result.error, "load_failed"))
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

/**
 * Runs one call in a realm of its own: the one loaded when the host was made,
 * or a fresh one. The realm is closed after the call, so nothing a view
 * changed in it, a component's internals included, reaches the next.
 */
const within = <A>(host: RealmHost, call: (realm: Loaded) => Outcome<A>): Outcome<A> => {
  let realm = host.loaded
  host.loaded = undefined
  if (realm === undefined) {
    const fresh = load(host)
    if (!fresh.ok) return fresh
    realm = fresh.value
  }
  const outcome = call(realm)
  if (!realm.broken) close(realm)
  return outcome
}

/** Calls one of the installed functions with the module's factory and JSON string arguments. */
const invoke = (
  host: RealmHost,
  realm: Loaded,
  fn: QuickJSHandle,
  checked: ViewCode.CheckedModule,
  args: ReadonlyArray<string>
): Outcome<string> => {
  const { context } = realm
  arm(host, host.limits.renderMs, host.limits.steps)
  try {
    const factory = context.evalCode(
      `(function (require, module, exports) {\n${checked.compiled}\n})`,
      `view-${checked.digest.slice(0, 12)}.js`
    )
    if (factory.error !== undefined) return thrown(host, context, factory.error, "render_failed")
    const handles = args.map((arg) => context.newString(arg))
    const result = context.callFunction(fn, context.undefined, factory.value, ...handles)
    for (const handle of handles) handle.dispose()
    factory.value.dispose()
    if (result.error !== undefined) return thrown(host, context, result.error, "render_failed")
    const text = context.getString(result.value)
    result.value.dispose()
    return { ok: true, value: text }
  } catch {
    // The host's own stack overflowed inside the interpreter. Disposing the
    // runtime now would abort on its unbalanced heap, so it is abandoned.
    QuickJSLifecycle.abandon(host.module)
    realm.broken = true
    return crossed("stack", "The view overflowed the host's stack")
  }
}

const renderHtml = (host: RealmHost, realm: Loaded, checked: ViewCode.CheckedModule, props: string, state: string) => {
  const html = invoke(host, realm, realm.render, checked, [props, state])
  if (!html.ok) return html
  const bytes = utf8Length(html.value)
  return bytes > Bridge.maxHtmlBytes
    ? crossed("html", `The view rendered ${bytes} bytes of HTML, over the ${Bridge.maxHtmlBytes}-byte limit`)
    : html
}

const inputs = (host: RealmHost, props: unknown, state: unknown): Outcome<readonly [string, string]> => {
  const serializedProps = serialize(props, "props", host.limits.propsBytes)
  if (!serializedProps.ok) return serializedProps
  const serializedState = serialize(state, "state", Bridge.maxStateBytes)
  if (!serializedState.ok) return serializedState
  return { ok: true, value: [serializedProps.value, serializedState.value] }
}

/**
 * Whether `module` was quarantined after a host stack overflow.
 *
 * @throws {never}
 * @since 0.1.0
 * @private
 */
export const quarantined = (module: QuickJSWASMModule): boolean => QuickJSLifecycle.isQuarantined(module)

/**
 * Loads the bundle into a first realm over `module`, bounded by `limits`, and
 * keeps it for the first call.
 *
 * @throws {never}
 * @since 0.1.0
 * @private
 */
export const createHost = (
  module: QuickJSWASMModule,
  limits: Limits,
  now: () => number,
  bundle: string
): Outcome<Host> => {
  const host = new RealmHost(module, limits, now, bundle)
  const first = load(host)
  if (!first.ok) return first
  host.loaded = first.value
  host.components = first.value.components
  return { ok: true, value: host }
}

/**
 * Closes the realm kept for the next call, if any; later calls are refused.
 *
 * @throws {never}
 * @since 0.1.0
 * @private
 */
export const closeHost = (host: Host): void => {
  const realm = host as RealmHost
  if (realm.loaded !== undefined) close(realm.loaded)
  realm.loaded = undefined
  realm.closed = true
}

/**
 * Whether the host is closed or its QuickJS module is quarantined, so no call
 * may run.
 *
 * @throws {never}
 * @since 0.1.0
 * @private
 */
export const unavailable = (host: Host): boolean => {
  const realm = host as RealmHost
  return realm.closed || QuickJSLifecycle.isQuarantined(realm.module)
}

/**
 * Renders the module's default export with `{ props, state }` in a realm of
 * its own.
 *
 * @throws {never}
 * @since 0.1.0
 * @private
 */
export const renderIn = (host: Host, checked: ViewCode.CheckedModule, props: unknown, state: unknown): Outcome<string> =>
  within(host as RealmHost, (realm) => {
    const args = inputs(host as RealmHost, props, state)
    return args.ok ? renderHtml(host as RealmHost, realm, checked, ...args.value) : args
  })

/**
 * Runs `reduce(state, event)` and renders the state it returns, in a realm of
 * its own.
 *
 * @throws {never}
 * @since 0.1.0
 * @private
 */
export const interactIn = (
  host: Host,
  checked: ViewCode.CheckedModule,
  props: unknown,
  state: unknown,
  event: Interactions.Event
): Outcome<Interacted> =>
  within(host as RealmHost, (realm): Outcome<Interacted> => {
    const args = inputs(host as RealmHost, props, state)
    if (!args.ok) return args
    const [serializedProps, serializedState] = args.value
    const reduced = invoke(host as RealmHost, realm, realm.reduce, checked, [serializedState, JSON.stringify(event)])
    if (!reduced.ok) return reduced
    const bytes = utf8Length(reduced.value)
    if (bytes > Bridge.maxStateBytes) {
      return crossed(
        "state",
        `reduce returned ${bytes} bytes of state, over the ${Bridge.maxStateBytes}-byte limit`
      )
    }
    const next: unknown = JSON.parse(reduced.value)
    const html = renderHtml(host as RealmHost, realm, checked, serializedProps, reduced.value)
    return html.ok ? { ok: true, value: { state: next, html: html.value } } : html
  })
