/**
 * Threat cases for the Node load guard. Every case loads through Node's own
 * module system; the decision must read the real path of the file a load
 * resolved to, never the text that named it.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire, registerHooks } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as LoadGuard from "../src/LoadGuard.ts"
import * as NodeLoadGuard from "../src/node/NodeLoadGuard.ts"

interface Site {
  /** Holds everything; removed when the case ends. */
  readonly base: string
  /** The flow source root, `<project>/.smithers/flows`. */
  readonly root: string
  /** The repository the flow works on. */
  readonly target: string
  /** Writes `module.exports = <name>` at `file`, creating its directory, and returns `file`. */
  readonly module: (file: string) => string
}

const site = Effect.acquireRelease(
  Effect.sync((): Site => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "smithers-load-guard-")))
    const root = join(base, "project", ".smithers", "flows")
    const target = join(base, "target")
    const module = (file: string) => {
      mkdirSync(join(file, ".."), { recursive: true })
      writeFileSync(file, `module.exports = ${JSON.stringify(file)}`)
      return file
    }
    mkdirSync(join(root, "load"), { recursive: true })
    mkdirSync(join(target, "node_modules", "typescript"), { recursive: true })
    writeFileSync(join(target, "package.json"), JSON.stringify({ name: "target" }))
    writeFileSync(join(target, "node_modules", "typescript", "package.json"), JSON.stringify({ main: "index.js" }))
    writeFileSync(join(target, "node_modules", "typescript", "index.js"), `exports.version = "9.9.9-target"`)
    return { base, root, target, module }
  }),
  ({ base }) => Effect.sync(() => rmSync(base, { recursive: true, force: true }))
)

/** Runs `use` with a guard that already holds the site's source root. */
const guarded = <A, E>(
  use: (site: Site, guard: LoadGuard.LoadGuard["Service"]) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.gen(function*() {
    const made = yield* site
    const guard = Option.getOrThrow(yield* Effect.serviceOption(LoadGuard.LoadGuard))
    yield* guard.protect(made.root)
    return yield* use(made, guard)
  }).pipe(Effect.provide(NodeLoadGuard.layer), Effect.scoped)

/** `require(specifier)` as a module at `from` would make it. `from` is only text: it need not exist. */
const load = (from: string, specifier: string): unknown => createRequire(from)(specifier)

/** What a load threw, or `undefined` when it loaded. */
const refusal = (run: () => unknown): unknown => {
  try {
    run()
    return undefined
  } catch (cause) {
    return cause
  }
}

const expectRefused = (cause: unknown, file: string, root: string) => {
  expect(cause).toBeInstanceOf(LoadGuard.UnmeasuredLoadError)
  const refused = cause as LoadGuard.UnmeasuredLoadError
  expect(refused._tag).toBe("flows/registry/UnmeasuredLoadError")
  expect(refused.path).toBe(file)
  expect(refused.root).toBe(root)
  expect(refused.message).toContain(`"${file}" was loaded at run time from inside the flow source root "${root}"`)
}

describe("NodeLoadGuard", () => {
  it.effect("loads the TypeScript of the repository a flow works on", () =>
    guarded(({ target }) =>
      Effect.sync(() => {
        expect(load(join(target, "package.json"), "typescript")).toEqual({ version: "9.9.9-target" })
        expect(load(join(target, "package.json"), "node:path")).toHaveProperty("join")
      })
    ))

  it.effect("refuses an unmeasured file beside the flow and names it", () =>
    guarded(({ module, root }) =>
      Effect.sync(() => {
        const file = module(join(root, "load", "unmeasured.cjs"))
        expectRefused(refusal(() => load(join(root, "load", "flow.ts"), "./unmeasured.cjs")), file, root)
        // Another flow's directory is the same source root.
        const other = module(join(root, "other", "helper.cjs"))
        expectRefused(refusal(() => load(join(root, "load", "flow.ts"), "../other/helper.cjs")), other, root)
      })
    ))

  it.effect("refuses a .. path that leads back inside from the target repository", () =>
    guarded(({ module, root, target }) =>
      Effect.sync(() => {
        const file = module(join(root, "load", "dotdot.cjs"))
        expectRefused(
          refusal(() => load(join(target, "package.json"), "../project/.smithers/flows/load/dotdot.cjs")),
          file,
          root
        )
        expectRefused(refusal(() => load(join(target, "package.json"), file)), file, root)
      })
    ))

  it.effect("refuses a symbolic link outside the root that names a file inside it", () =>
    guarded(({ module, root, target }) =>
      Effect.sync(() => {
        const file = module(join(root, "load", "linked.cjs"))
        symlinkSync(file, join(target, "innocent.cjs"))
        expectRefused(refusal(() => load(join(target, "package.json"), "./innocent.cjs")), file, root)
        // A linked directory is the same door.
        symlinkSync(join(root, "load"), join(target, "vendor"), "dir")
        const second = module(join(root, "load", "linked-directory.cjs"))
        expectRefused(refusal(() => load(join(target, "package.json"), "./vendor/linked-directory.cjs")), second, root)
      })
    ))

  it.effect("holds the real root when the project is reached through a symbolic link", () =>
    Effect.gen(function*() {
      const { base, module, root } = yield* site
      const guard = Option.getOrThrow(yield* Effect.serviceOption(LoadGuard.LoadGuard))
      symlinkSync(join(base, "project"), join(base, "alias"), "dir")
      const alias = join(base, "alias", ".smithers", "flows")
      yield* guard.protect(alias)
      const file = module(join(root, "load", "aliased.cjs"))
      expectRefused(refusal(() => load(join(alias, "load", "flow.ts"), "./aliased.cjs")), file, root)
      expectRefused(refusal(() => load(join(root, "load", "flow.ts"), "./aliased.cjs")), file, root)
    }).pipe(Effect.provide(NodeLoadGuard.layer), Effect.scoped))

  it.effect("refuses a computed import() whatever query its URL carries", () =>
    guarded(({ module, root, target }) =>
      Effect.gen(function*() {
        const file = module(join(root, "load", "imported.cjs"))
        // Written as CommonJS so the import() below is Node's own, not the test runner's.
        writeFileSync(join(target, "importer.cjs"), "module.exports = (specifier) => import(specifier)")
        const importer = load(join(target, "package.json"), "./importer.cjs") as (specifier: string) => Promise<unknown>
        const cause = yield* Effect.flip(Effect.tryPromise({
          try: () => importer(`${pathToFileURL(file).href}?version=2`),
          catch: (thrown) => thrown
        }))
        expectRefused(cause, file, root)
        expect(yield* Effect.promise(() => importer("node:path"))).toHaveProperty("join")
      })
    ))

  it.effect("loads what is outside the root, however close its name", () =>
    guarded(({ base, module, root, target }) =>
      Effect.sync(() => {
        // A directory whose name only starts like the root.
        const neighbour = module(join(base, "project", ".smithers", "flows-archive", "old.cjs"))
        expect(load(join(root, "load", "flow.ts"), "../../flows-archive/old.cjs")).toBe(neighbour)
        // The repository's own configuration, outside the flow source root.
        const config = module(join(base, "project", "bundler.config.cjs"))
        expect(load(join(base, "project", "package.json"), "./bundler.config.cjs")).toBe(config)
        // A link beside the flow to a file outside the root is that outside file.
        const outside = module(join(target, "tool.cjs"))
        symlinkSync(outside, join(root, "load", "tool-link.cjs"))
        expect(load(join(root, "load", "flow.ts"), "./tool-link.cjs")).toBe(outside)
      })
    ))

  it.effect("loads an installed package beneath the root as a static package import does", () =>
    guarded(({ module, root }) =>
      Effect.sync(() => {
        const installed = module(join(root, "node_modules", "dep", "index.js"))
        expect(load(join(root, "load", "flow.ts"), "dep")).toBe(installed)
      })
    ))

  it.effect("holds a file another hook resolved, and that is not on disk, by the path it was given", () =>
    Effect.gen(function*() {
      const { root, target } = yield* site
      // A loader that resolves names to files it will supply itself.
      const virtual = registerHooks({
        resolve: (specifier, context, nextResolve) =>
          specifier.startsWith("virtual:")
            ? { url: pathToFileURL(specifier.slice("virtual:".length)).href, shortCircuit: true }
            : nextResolve(specifier, context)
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => virtual.deregister()))
      // A guard registered after that loader, so Node asks the guard first and the guard asks the loader.
      const guard = yield* Effect.map(Effect.serviceOption(LoadGuard.LoadGuard), Option.getOrThrow).pipe(
        Effect.provide(NodeLoadGuard.layerWith((hooks) => (registerHooks as NodeLoadGuard.RegisterHooks)(hooks)))
      )
      yield* guard.protect(root)
      const inside = join(root, "load", "virtual.cjs")
      expectRefused(refusal(() => load(join(target, "package.json"), `virtual:${inside}`)), inside, root)
      // Outside the root the guard decides nothing; Node then finds no file to read.
      const outside = refusal(() => load(join(target, "package.json"), `virtual:${join(target, "virtual.cjs")}`))
      expect(outside).not.toBeInstanceOf(LoadGuard.UnmeasuredLoadError)
      // Node's own read of the missing file, not the guard's look at its real path.
      expect(outside).toMatchObject({ code: "ENOENT", syscall: "open" })
    }).pipe(Effect.scoped))

  it.effect("lets a measured copy load only while its permit is held", () =>
    guarded(({ module, root }, guard) =>
      Effect.gen(function*() {
        const copy = module(join(root, "load", "smithers-copy.cjs"))
        yield* Effect.scoped(Effect.gen(function*() {
          yield* guard.permit(copy)
          expect(load(join(root, "load", "flow.ts"), "./smithers-copy.cjs")).toBe(copy)
        }))
        // Asked for from another directory, so Node resolves it afresh.
        expectRefused(refusal(() => load(join(root, "other", "flow.ts"), "../load/smithers-copy.cjs")), copy, root)
      })
    ))

  it.effect("fails rather than hold a root or permit a copy it cannot resolve", () =>
    guarded(({ root }, guard) =>
      Effect.gen(function*() {
        const missingRoot = yield* Effect.flip(guard.protect(join(root, "absent")))
        expect(missingRoot).toBeInstanceOf(LoadGuard.LoadGuardError)
        expect(missingRoot.path).toBe(join(root, "absent"))
        const missingCopy = yield* Effect.flip(guard.permit(join(root, "load", "absent.cjs")))
        expect(missingCopy.message).toContain("could not resolve")
      })
    ))

  it.effect("decides nothing for a root until it is held, and holds it after the layer that held it closes", () =>
    Effect.gen(function*() {
      const { module, root } = yield* site
      const flow = join(root, "load", "flow.ts")
      yield* Effect.gen(function*() {
        const guard = Option.getOrThrow(yield* Effect.serviceOption(LoadGuard.LoadGuard))
        const before = module(join(root, "load", "before.cjs"))
        expect(load(flow, "./before.cjs")).toBe(before)
        yield* guard.protect(root)
        const during = module(join(root, "load", "during.cjs"))
        expectRefused(refusal(() => load(flow, "./during.cjs")), during, root)
      }).pipe(Effect.provide(NodeLoadGuard.layer))
      // The flow that was loaded can still run, so what it may load is still decided.
      const after = module(join(root, "load", "after.cjs"))
      expectRefused(refusal(() => load(flow, "./after.cjs")), after, root)
    }).pipe(Effect.scoped))

  it.effect("decides with one state for every layer and every copy of the module in the process", () =>
    Effect.gen(function*() {
      const { module, root } = yield* site
      // A second instance of the module, as a second install or build of the package would be.
      const second = (yield* Effect.promise(() =>
        import(/* @vite-ignore */ `${new URL("../src/node/NodeLoadGuard.ts", import.meta.url).href}?second`)
      )) as typeof NodeLoadGuard
      expect(second.layer).not.toBe(NodeLoadGuard.layer)
      const service = (layer: typeof NodeLoadGuard.layer) =>
        Effect.map(Effect.serviceOption(LoadGuard.LoadGuard), Option.getOrThrow).pipe(Effect.provide(layer))
      yield* (yield* service(NodeLoadGuard.layer)).protect(root)
      const copy = module(join(root, "load", "smithers-shared.cjs"))
      const other = yield* service(second.layer)
      yield* Effect.scoped(Effect.gen(function*() {
        yield* other.permit(copy)
        expect(load(join(root, "load", "flow.ts"), "./smithers-shared.cjs")).toBe(copy)
      }))
      const unmeasured = module(join(root, "load", "shared-unmeasured.cjs"))
      expectRefused(
        refusal(() =>
          load(join(root, "load", "flow.ts"), "./shared-unmeasured.cjs")
        ),
        unmeasured,
        root
      )
    }).pipe(Effect.scoped))

  it.effect("holds nothing on a runtime that accepts module hooks and never calls them", () =>
    Effect.gen(function*() {
      const { module, root } = yield* site
      let registrations = 0
      const guard = yield* Effect.map(Effect.serviceOption(LoadGuard.LoadGuard), Option.getOrThrow).pipe(
        Effect.provide(NodeLoadGuard.layerWith(() => {
          registrations++
        }))
      )
      for (const _attempt of [1, 2]) {
        const failure = yield* Effect.flip(guard.protect(root))
        expect(failure).toBeInstanceOf(LoadGuard.LoadGuardError)
        expect(failure.message).toBe(
          "this runtime accepts module hooks and does not call them, so it cannot check loads at run time"
        )
      }
      expect(registrations).toBe(1)
      // Nothing was held: a host that got this failure refuses the flow instead.
      const file = module(join(root, "load", "unheld.cjs"))
      expect(load(join(root, "load", "flow.ts"), "./unheld.cjs")).toBe(file)
    }).pipe(Effect.scoped))

  it.effect("provides no guard on a runtime without module hooks, so computed loads stay refused", () =>
    Effect.gen(function*() {
      expect(Option.isNone(yield* Effect.serviceOption(LoadGuard.LoadGuard))).toBe(true)
    }).pipe(Effect.provide(NodeLoadGuard.layerWith(undefined))))
})
