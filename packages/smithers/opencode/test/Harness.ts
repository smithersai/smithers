import { type Duration, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as DemoScript from "../src/DemoScript.ts"
import * as Driver from "../src/Driver.ts"
import * as ScriptedDriver from "../src/ScriptedDriver.ts"
import * as Serve from "../src/Serve.ts"
import * as Store from "../src/Store.ts"

/** A served directory with a fresh SQLite store under it. */
export const scratchDirectory = (): { readonly directory: string; readonly remove: () => void } => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-opencode-"))
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) }
}

export interface Served {
  readonly directory: string
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
}

/**
 * The whole application as an in-process fetch handler over a scratch
 * directory, with the scripted driver replaying instantly.
 */
export const serve = (
  options: {
    readonly bind?: Partial<Serve.Bind> | undefined
    readonly driver?: Layer.Layer<Driver.Driver> | undefined
    readonly heartbeat?: Duration.Input | undefined
  } = {}
): Served => {
  const scratch = scratchDirectory()
  const driver = options.driver ?? ScriptedDriver.layer({ script: DemoScript.script, delay: 0 })
  const { dispose, handler } = HttpRouter.toWebHandler(
    Serve.app({
      directory: scratch.directory,
      bind: { ...Serve.defaultBind, ...options.bind },
      version: "test",
      seat: "scripted:demo",
      heartbeat: options.heartbeat ?? "15 seconds"
    }).pipe(Layer.provide(Layer.mergeAll(driver, Store.layerSqlite(Serve.databasePath(scratch.directory))))),
    { disableLogger: true }
  )
  return {
    directory: scratch.directory,
    handler,
    dispose: async () => {
      await dispose()
      scratch.remove()
    }
  }
}

export const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)

/** Waits until `check` answers true, polling every few milliseconds. */
export const until = async (check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting")
}
