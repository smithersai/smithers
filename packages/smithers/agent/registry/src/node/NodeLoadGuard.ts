/**
 * The Node implementation of {@link module:LoadGuard}: a synchronous
 * `node:module` resolve hook, which Node consults for `import`, `import()`,
 * `require()` and every loader `createRequire` returns.
 *
 * The hook is registered when the first source root is protected, so a host
 * that admits no flow with a computed load pays nothing. What the guard holds
 * belongs to the process, like the hook and the module cache it stands in
 * front of: every layer built in one process shares it, and a root stays held
 * after the layer that protected it closes, because the code of a loaded flow
 * can still run.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { realpathSync } from "node:fs"
import * as Module from "node:module"
import { isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import * as LoadGuard from "../LoadGuard.ts"

/**
 * `node:module` `registerHooks`, as far as this guard uses it.
 *
 * @category models
 * @since 1.0.0
 */
export type RegisterHooks = (hooks: {
  readonly resolve: (
    specifier: string,
    context: unknown,
    nextResolve: (specifier: string, context: unknown) => { readonly url: string }
  ) => { readonly url: string }
}) => unknown

/** What one process holds for one `registerHooks`. */
interface Held {
  /** Real paths of the protected source roots. */
  readonly roots: Set<string>
  /** Real paths of the measured copies that may load. */
  readonly permitted: Set<string>
  /** Whether the hook is registered. */
  registered: boolean
  /** Whether the runtime has called the hook at least once. */
  consulted: boolean
}

/**
 * Keyed on the global object, so two copies of this module in one process
 * (an ESM and a CommonJS build, two installs) decide with one state. With two
 * states, each hook would refuse the copies the other one permitted.
 */
const holds = ((): WeakMap<RegisterHooks, Held> => {
  const key = Symbol.for("@smthrs/registry/NodeLoadGuard")
  const existing = Reflect.get(globalThis, key) as WeakMap<RegisterHooks, Held> | undefined
  if (existing !== undefined) return existing
  const created = new WeakMap<RegisterHooks, Held>()
  Reflect.set(globalThis, key, created)
  return created
})()

/** Whether `file` is `root` or lies beneath it. Both are real paths. */
const within = (root: string, file: string): boolean => {
  const suffix = relative(root, file)
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))
}

/** The real path of `file`, or `file` itself when nothing on disk answers to it. */
const onDisk = (file: string): string => {
  try {
    return realpathSync.native(file)
  } catch {
    return file
  }
}

/** Whether a path beneath `root` runs through an installed-package directory. */
const installed = (root: string, file: string): boolean => relative(root, file).split(sep).includes("node_modules")

const real = (file: string) =>
  Effect.try({
    try: () => realpathSync.native(file),
    catch: (cause) =>
      new LoadGuard.LoadGuardError({
        path: file,
        message: `the load guard could not resolve "${file}"`,
        cause
      })
  })

/**
 * The guard over a given `registerHooks`, or no service at all where the
 * runtime has none (Bun, and Node before 22.15). A host without the service
 * keeps refusing flows whose loads are computed.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerWith = (register: RegisterHooks | undefined): Layer.Layer<never> =>
  Layer.effectContext(Effect.sync(() => {
    if (register === undefined) return Context.empty()
    const held: Held = holds.get(register) ??
      { roots: new Set(), permitted: new Set(), registered: false, consulted: false }
    holds.set(register, held)

    const refusal = (file: string): LoadGuard.UnmeasuredLoadError | undefined => {
      if (held.permitted.has(file)) return undefined
      for (const root of held.roots) {
        if (!within(root, file) || installed(root, file)) continue
        return new LoadGuard.UnmeasuredLoadError({
          path: file,
          root,
          message:
            `"${file}" was loaded at run time from inside the flow source root "${root}" and is not a module measured for this run. Import it statically so it is measured, or keep code a flow loads by a computed path outside the source root`
        })
      }
      return undefined
    }

    const resolveHook: Parameters<RegisterHooks>[0]["resolve"] = (specifier, context, nextResolve) => {
      held.consulted = true
      const resolved = nextResolve(specifier, context)
      if (!resolved.url.startsWith("file:")) return resolved
      // The real path is the file whose bytes run, whatever spelled the way to
      // it. Another hook can resolve to a file that is not on disk and supply
      // its source itself; that file is held by the path the hook gave it.
      const refused = refusal(onDisk(fileURLToPath(resolved.url)))
      if (refused !== undefined) throw refused
      return resolved
    }

    return Context.make(LoadGuard.LoadGuard, {
      protect: (root) =>
        Effect.flatMap(real(root), (source) => {
          if (!held.registered) {
            register({ resolve: resolveHook })
            held.registered = true
          }
          // A runtime can accept hooks and never call them. Asking it to
          // resolve a builtin shows whether this one does, before anything
          // is admitted on the strength of the hook.
          if (!held.consulted) Module.createRequire(join(source, "flow.js")).resolve("node:module")
          if (!held.consulted) {
            return Effect.fail(
              new LoadGuard.LoadGuardError({
                path: source,
                message:
                  "this runtime accepts module hooks and does not call them, so it cannot check loads at run time"
              })
            )
          }
          held.roots.add(source)
          return Effect.void
        }),
      permit: (file) =>
        Effect.acquireRelease(
          Effect.map(real(file), (copy) => {
            held.permitted.add(copy)
            return copy
          }),
          (copy) => Effect.sync(() => held.permitted.delete(copy))
        ).pipe(Effect.asVoid)
    })
  }))

/**
 * The guard for this process.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<never> = layerWith(
  (Module as { readonly registerHooks?: RegisterHooks }).registerHooks
)
