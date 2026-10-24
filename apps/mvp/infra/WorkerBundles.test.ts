// Each Worker Alchemy bundles from source, bundled the way `alchemy plan` bundles it: through Alchemy's own
// WorkerBundle, with the props WorkerProvider.diff hands hasChanged. Alchemy's Diff.stripEffects turns a Worker's build
// plugins (functions, class instances) into undefined, so on 2026-10-24 `alchemy plan` bundled ChatApi and
// ElectricGateway without vibelang-unplugin and failed on @smthrs/errors' .vibe source, while every hand-made bundle
// in the tests passed. patches/alchemy@2.0.0-beta.83.patch hands hasChanged the Worker's own build options.
import { NodeServices } from "@effect/platform-node"
import { Effect, Exit } from "effect"
import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { describe, expect, test } from "vitest"
import * as ChatApi from "../worker/ChatApi.ts"
import * as ElectricGateway from "./ElectricGateway.ts"

const MVP = fileURLToPath(new URL("..", import.meta.url))
const ALCHEMY = realpathSync(join(MVP, "node_modules", "alchemy"))
const PROVIDER = join(ALCHEMY, "lib", "Cloudflare", "Workers", "WorkerProvider.js")

/** A Worker's settings, as far as bundling reads them. */
interface WorkerProps {
  readonly main: string
  readonly compatibility: { readonly date: string; readonly flags: ReadonlyArray<string> }
  readonly build?: unknown
}

/** What this test reads of Alchemy's internals; Alchemy's export map doesn't publish them. */
interface Bundler {
  readonly build: (options: Record<string, unknown>) => Effect.Effect<unknown, unknown>
}
const internals = async () => ({
  WorkerBundle: (await import(pathToFileURL(join(ALCHEMY, "lib", "Cloudflare", "Workers", "Sources", "Rolldown.js")).href))
    .WorkerBundle as Effect.Effect<Bundler>,
  stripEffects: (await import(pathToFileURL(join(ALCHEMY, "lib", "Diff.js")).href)).stripEffects as <A>(value: A) => A,
})

/** Bundles `props` as WorkerProvider.prepareBundle does, with `build` as the bundle's extra options. */
const bundle = async (id: string, props: WorkerProps, build: unknown) => {
  const { WorkerBundle } = await internals()
  const program = Effect.gen(function* () {
    const bundler = yield* WorkerBundle
    return yield* bundler.build({
      id,
      main: props.main,
      compatibility: props.compatibility,
      entry: { kind: "effect", exports: {} },
      stack: { name: "smithers-mvp", stage: "test" },
      extraOptions: build,
    })
  })
  return Effect.runPromiseExit(program.pipe(Effect.provide(NodeServices.layer)))
}

const WORKERS: ReadonlyArray<readonly [string, WorkerProps]> = [
  ["ChatApi", ChatApi.props],
  ["ElectricGateway", ElectricGateway.props],
]

describe("the Workers alchemy plan bundles", () => {
  test("the installed Alchemy hands hasChanged the Worker's own build options", () => {
    expect(readFileSync(PROVIDER, "utf8")).toContain("hasChanged(id, fqn, { ...news, build: desired.build }, output")
  })

  // What the patched diff hands hasChanged: the Worker's own build options.
  test.each(WORKERS)("%s bundles with its own build options", async (id, props) => {
    const exit = await bundle(id, props, props.build)
    expect(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "").toBe(true)
  }, 120_000)

  // Alchemy's own stripped props: fails while the upstream bug stands. When this starts passing, Alchemy keeps build
  // plugins through stripEffects, and the patch can go.
  test.fails("ChatApi bundles from the props Alchemy's stripEffects leaves", async () => {
    const { stripEffects } = await internals()
    const exit = await bundle("ChatApi", ChatApi.props, stripEffects(ChatApi.props).build)
    expect(Exit.isSuccess(exit)).toBe(true)
  }, 120_000)
})
