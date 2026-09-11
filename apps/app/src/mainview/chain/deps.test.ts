import { Author, Catalog, Chain, Journal, QuickJsRunner, ScriptRunner } from "@smthrs/chain"
import type { Event, Outcome } from "@smthrs/chain"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"

/*
 * DESIGN.md §14 dependency law, proven not asserted: @smthrs/chain
 * resolves through this app's declared dependencies, runs under bun, seals in
 * QuickJS, and stays browser-bundleable. The closure used to be vendored
 * (vendor/smthrs + a copy script); it is now pnpm workspace links to
 * ../../packages/*, so the two properties vendoring bought are asserted
 * directly here: the closure carries no path specifiers, and exactly one
 * effect instance is in the graph — a package resolving effect from a second
 * copy would load identity-keyed features (Redacted, references) that cannot
 * see this one's. If a dependency change breaks any of that, this file fails
 * before any product code does.
 */

const flow = (...lines: ReadonlyArray<string>): string => ["```flow", ...lines, "```"].join("\n")

const scripts = [
  flow(
    `const hits = await ctx.call("grep", { pattern: "TODO" })`,
    `const s = await ctx.call("author", { context: [hits.files.join("\\n")] })`,
    `return to(s)`
  ),
  flow(`await ctx.call("edit", { file: "a.ts" })`, `return done({ patched: true })`)
]

const grep = {
  name: "grep",
  description: "test grep",
  handler: () => Effect.succeed({ files: ["a.ts", "b.ts"] })
}
const edit = { name: "edit", description: "test edit", handler: () => Effect.succeed({ ok: true }) }

const runChain = (runner: Layer.Layer<ScriptRunner.ScriptRunner, unknown>) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const outcome = yield* Chain.run({ goal: "patch TODOs" })
      const journal = yield* Journal.Journal
      const events = yield* journal.read
      return { outcome, events }
    }).pipe(
      Effect.provide(
        (() => {
          const base = Layer.mergeAll(Journal.layerMemory([]), Author.layerMock(scripts), runner)
          return Layer.mergeAll(base, Catalog.layer([grep, edit]).pipe(Layer.provide(base)))
        })()
      )
    ) as Effect.Effect<
      { outcome: Outcome.Terminal; events: ReadonlyArray<Event.Event> },
      never,
      never
    >
  )

describe("@smthrs/chain resolves and runs under mvp", () => {
  test("a two-link chain reaches done through the in-process runner", async () => {
    const { outcome, events } = await runChain(ScriptRunner.layerInProcess)
    expect(outcome._tag).toBe("Done")
    const tags = events.map((event) => event._tag)
    expect(tags).toContain("ChainStarted")
    expect(tags).toContain("LinkAuthored")
    expect(tags).toContain("CallSettled")
    expect(tags).toContain("LinkEnded")
  })

  test("the same chain reaches done through the QuickJS sealed realm", async () => {
    const { outcome } = await runChain(QuickJsRunner.layer())
    expect(outcome._tag).toBe("Done")
  })
})

describe("chain stays browser-bundleable", () => {
  test("Bun.build bundles @smthrs/chain for the browser target", async () => {
    const entry = join(import.meta.dir, "bundle-entry.fixture.ts")
    const result = await Bun.build({ entrypoints: [entry], target: "browser" })
    expect(result.success).toBe(true)
  }, 30000)
})

const appRoot = join(import.meta.dir, "..", "..", "..")
const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe("the dependency closure", () => {
  /*
   * The vendored closure is gone: every @smthrs package is a workspace link
   * to ../../packages/*, and nothing is pulled in by path. A `file:` or
   * `link:` specifier is a re-vendor by another name — it escapes the
   * workspace's single resolution and its version pins.
   */
  test("declares only workspace and registry specifiers, never a path", () => {
    const declared = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    const paths = declared.filter(([, range]) => /^(?:file|link|portal):/.test(range))
    expect(paths).toEqual([])
    const smthrs = declared.filter(([name]) => name.startsWith("@smthrs/"))
    expect(smthrs.length).toBeGreaterThan(0)
    const offScope = smthrs.filter(([, range]) => !(range === "workspace:*" || /^\d/.test(range)))
    expect(offScope).toEqual([])
  })

  /*
   * What vendoring guaranteed structurally, the workspace must now prove:
   * this app and every workspace package it depends on load the SAME effect.
   */
  test("one effect instance is shared with every workspace package", () => {
    const ours = realpathSync(Bun.resolveSync("effect", appRoot))
    const resolved = Object.entries(manifest.dependencies)
      .filter(([name, range]) => name.startsWith("@smthrs/") && range === "workspace:*")
      .flatMap(([name]) => {
        const packageRoot = realpathSync(join(appRoot, "node_modules", name))
        // A workspace package that does not depend on effect has nothing to share.
        const theirs = ((): string | undefined => {
          try {
            return realpathSync(Bun.resolveSync("effect", packageRoot))
          } catch {
            return undefined
          }
        })()
        return theirs === undefined ? [] : [[name, theirs] as const]
      })
    expect(resolved.length).toBeGreaterThan(0)
    expect(resolved.filter(([, theirs]) => theirs !== ours)).toEqual([])
  })
})

/*
 * AGENTS.md "New Smithers only": retired runtime packages use
 * the retired @smithers scope; product code may only import the new @smthrs
 * packages owned by this repository. Scans all product source, not just shared.
 */
describe("legacy scope boundary", () => {
  test("no src module imports the retired @smithers/* scope", () => {
    const roots = [join(import.meta.dir, "..", "..")]
    const offenders: Array<string> = []
    while (roots.length > 0) {
      const dir = roots.pop() as string
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) {
          roots.push(path)
          continue
        }
        if (!/\.(ts|tsx)$/.test(name)) continue
        if (/from\s+"@smithers\//.test(readFileSync(path, "utf8"))) offenders.push(path)
      }
    }
    expect(offenders).toEqual([])
  })
})
