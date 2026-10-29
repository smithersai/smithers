/**
 * The realm half of a presentation bundle: the code that runs inside QuickJS
 * and renders a checked view module to HTML.
 *
 * A presentation bundle is one classic script that calls {@link install}
 * with React, React's JSX runtime, `renderToStaticMarkup` and the components a
 * view may import. `@smthrs/ui` builds the one Smithers ships; this module
 * takes React as arguments, so it carries no framework of its own and a test
 * can build a bundle from React alone.
 *
 * `install` publishes `globalThis.__smithersPresentation`, which
 * `PresentationRealm` calls, and then deeply freezes the realm's global,
 * `require` and every module behind it, so a view that changes a shared
 * object fails instead.
 *
 * A view module reaches four modules through `require`: `react` and
 * `react/jsx-runtime`, whose element constructors refuse the elements and
 * attributes `ViewCode` refuses early; `@smthrs/ui` (the components passed
 * here); and `smithers:view`, whose one value is `event(name, arg?)`, the
 * `data-event` attribute for an event.
 *
 * The constructors are not the boundary: a view can build an element by
 * hand, or change one after a constructor checked it. The boundary is the
 * renderer. A bundle builds React's static renderer through
 * {@link guardRenderer}, so every element it emits passes {@link guardHost}
 * as it emits it, and `install` refuses a bundle whose renderer does not. The
 * HTML a realm returns is untrusted all the same: the frame's sanitizer and
 * CSP stand behind it.
 *
 * @since 0.1.0
 */

import { harden } from "./internal/harden.ts"
import { attributeRefusal, isEventHandler, isRefusedElement } from "./internal/vocabulary.ts"

/**
 * The global name `install` publishes the renderer under.
 *
 * @category constants
 * @since 0.1.0
 */
export const globalName = "__smithersPresentation"

/**
 * The global name `install` publishes {@link guardHost} under, which a
 * renderer patched by {@link guardRenderer} calls.
 *
 * @category constants
 * @since 0.1.0
 */
export const hostGuardName = "__smithersHostGuard"

/**
 * An element constructor: `createElement`, `jsx` or `jsxs`. Its parameters
 * are `any` so React's own overloads fit it.
 *
 * @category models
 * @since 0.1.0
 */
export type CreateElement = (type: any, props?: any, ...rest: Array<any>) => unknown

/**
 * What a bundle passes to {@link install}.
 *
 * @category models
 * @since 0.1.0
 */
export interface InstallOptions {
  /** React's root module. Only `Fragment`, `createElement`, `Children`, `cloneElement` and `isValidElement` reach a view. */
  readonly react: {
    readonly Fragment: unknown
    readonly createElement: CreateElement
    readonly Children: unknown
    readonly cloneElement: CreateElement
    readonly isValidElement: (value: any) => boolean
  }
  /** `react/jsx-runtime`. */
  readonly jsxRuntime: { readonly Fragment: unknown; readonly jsx: CreateElement; readonly jsxs: CreateElement }
  /** `react-dom/server`'s `renderToStaticMarkup`. */
  readonly renderToStaticMarkup: (element: any) => string
  /** The components a view may import from `@smthrs/ui`, by name. */
  readonly components: Readonly<Record<string, unknown>>
}

/**
 * A module's evaluator: the compiled CommonJS body of a checked view, wrapped
 * as `function (require, module, exports) { ... }` by the host.
 *
 * @category models
 * @since 0.1.0
 */
export type ModuleFactory = (
  require: (name: string) => unknown,
  module: { exports: Record<string, unknown> },
  exports: Record<string, unknown>
) => void

/**
 * What `install` publishes. Every input and output is a JSON string, so no
 * object crosses between the realm and the host.
 *
 * @category models
 * @since 0.1.0
 */
export interface Installed {
  /** Renders the module's default export with `{ props, state }` to HTML. */
  readonly render: (factory: ModuleFactory, props: string, state: string) => string
  /** Runs the module's `reduce(state, event)` and returns the next state as JSON. */
  readonly reduce: (factory: ModuleFactory, state: string, event: string) => string
  /** The component names `@smthrs/ui` resolves to, sorted. */
  readonly components: ReadonlyArray<string>
}

const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)

/** Refuses what `ViewCode` refuses, for an element built at render time. */
const guard = (type: unknown, props: unknown): void => {
  const element = typeof type === "string" ? type : ""
  if (element !== "" && isRefusedElement(element)) throw new Error(`<${element}> is refused in a view`)
  if (typeof props !== "object" || props === null) return
  for (const key of Object.keys(props)) {
    const refusal = attributeRefusal(element, key, (props as Record<string, unknown>)[key])
    if (refusal !== undefined) throw new Error(refusal)
  }
}

const guarded = (create: CreateElement): CreateElement => (type, props, ...rest) => {
  guard(type, props)
  return create(type, props, ...rest)
}

/**
 * The render guard, as a renderer patched by {@link guardRenderer} runs it on
 * each element it emits: it reads the element's own enumerable props once,
 * drops event handlers (a component's own, such as Radix's `onMouseDown`,
 * which React never emits anyway), refuses what `ViewCode` refuses, and
 * returns the frozen copy the renderer then emits, so a getter cannot answer
 * the guard and the renderer differently.
 *
 * @category rendering
 * @since 0.1.0
 */
export const guardHost = (type: string, props: unknown): Readonly<Record<string, unknown>> => {
  const copy: Record<string, unknown> = Object.create(null)
  if (typeof props === "object" && props !== null) {
    for (const key of Object.keys(props)) {
      if (!isEventHandler(key)) copy[key] = (props as Record<string, unknown>)[key]
    }
  }
  guard(type, copy)
  return Object.freeze(copy)
}

/** Where React's static renderer starts emitting an element: `pushStartInstance(target, type, props, ...) {`. */
const emitter = /function pushStartInstance\(\s*[\w$]+,\s*type,\s*props,[^)]*\)\s*\{/g

/**
 * Patches the source of React's static renderer
 * (`react-dom/cjs/react-dom-server-legacy.browser.production.js`) so that
 * every element it emits passes {@link guardHost} first, whoever built the
 * element. A bundle builder applies it where it loads that file, for example
 * in an esbuild `onLoad` hook.
 *
 * Throws when the source does not have exactly one
 * `pushStartInstance(target, type, props, ...)`, as after a React upgrade
 * that renamed it, so a renderer is never left unguarded.
 *
 * @category rendering
 * @since 0.1.0
 */
export const guardRenderer = (source: string): string => {
  const found = source.match(emitter) ?? []
  if (found.length !== 1) {
    throw new Error("React's static renderer has no single pushStartInstance(target, type, props, ...) to guard")
  }
  return source.replace(emitter, (start) => `${start}\n  props = ${hostGuardName}(type, props);`)
}

const exportsOf = (factory: ModuleFactory, require: (name: string) => unknown): Record<string, unknown> => {
  const module: { exports: Record<string, unknown> } = { exports: {} }
  factory(require, module, module.exports)
  return module.exports
}

/** The renderer, and what a view reaches through `require`: the doors `install` hardens. */
const build = (
  options: InstallOptions
): { readonly installed: Installed; readonly reachable: ReadonlyArray<unknown> } => {
  const { jsxRuntime, react, renderToStaticMarkup } = options
  const components = Object.freeze({ ...options.components })
  const modules: Readonly<Record<string, unknown>> = {
    "react": Object.freeze({
      Fragment: react.Fragment,
      createElement: guarded(react.createElement),
      Children: react.Children,
      cloneElement: guarded(react.cloneElement),
      isValidElement: react.isValidElement
    }),
    "react/jsx-runtime": Object.freeze({
      Fragment: jsxRuntime.Fragment,
      jsx: guarded(jsxRuntime.jsx),
      jsxs: guarded(jsxRuntime.jsxs)
    }),
    "@smthrs/ui": components,
    "smithers:view": Object.freeze({
      event: (name: string, arg?: string | number): string => arg === undefined ? name : `${name}:${String(arg)}`
    })
  }
  const require = (name: string): unknown => {
    if (own(modules, name)) return modules[name]
    throw new Error(`A view may import only react, @smthrs/ui and smithers:view, not ${name}`)
  }
  const installed: Installed = {
    render: (factory, props, state) => {
      const view = exportsOf(factory, require).default
      if (typeof view !== "function" && (typeof view !== "object" || view === null)) {
        throw new TypeError("The module's default export must be a component")
      }
      const html = renderToStaticMarkup(jsxRuntime.jsx(view, { props: JSON.parse(props), state: JSON.parse(state) }))
      return html
    },
    reduce: (factory, state, event) => {
      const reduce = exportsOf(factory, require).reduce
      if (typeof reduce !== "function") throw new TypeError("The module exports no reduce function")
      const next = JSON.stringify(reduce(JSON.parse(state), JSON.parse(event)))
      if (next === undefined) throw new TypeError("reduce returned no state")
      return next
    },
    components: Object.keys(components).sort()
  }
  return { installed, reachable: [require, modules] }
}

/**
 * Builds the renderer without publishing it: what {@link install} publishes.
 *
 * @category installing
 * @since 0.1.0
 */
export const make = (options: InstallOptions): Installed => build(options).installed

/**
 * Publishes {@link guardHost} at `globalThis.__smithersHostGuard` and checks
 * that the renderer calls it: an element built by hand as `<script>` must be
 * refused, or `install` throws. A bundle builds its renderer through
 * {@link guardRenderer}.
 *
 * Publishes the renderer at `globalThis.__smithersPresentation`, then freezes
 * every object a view can reach by name: the realm's global and its
 * prototypes, and `require` with every module behind it, deeply, so React's
 * `Children`, each component and its statics, the element constructors and
 * `event` are frozen too. Call it once, as the bundle's last statement.
 *
 * What a component returns when a view calls it, such as an element whose
 * `type` is an internal component or a context, stays writable: React writes
 * some of it, and a closure hides the rest. `PresentationRealm` loads a fresh
 * realm for every render and interaction, so nothing a view changes there
 * reaches another view.
 *
 * @category installing
 * @since 0.1.0
 */
export const install = (options: InstallOptions): Installed => {
  const { installed, reachable } = build(options)
  Object.defineProperty(globalThis, hostGuardName, { value: guardHost, enumerable: false })
  const element = options.react.createElement("p") as { readonly $$typeof: unknown }
  const forged = { $$typeof: element.$$typeof, type: "script", key: null, ref: null, props: {} }
  let refused = false
  try {
    options.renderToStaticMarkup(forged)
  } catch (error) {
    refused = error instanceof Error && error.message === "<script> is refused in a view"
  }
  if (!refused) throw new Error("The bundle's renderer does not guard what it emits; build it with guardRenderer")
  Object.defineProperty(globalThis, globalName, { value: installed, enumerable: false })
  harden([globalThis, ...reachable])
  return installed
}
