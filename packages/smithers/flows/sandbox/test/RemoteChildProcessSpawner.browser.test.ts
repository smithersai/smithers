import { expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { build } from "esbuild"
import { webcrypto } from "node:crypto"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { platform } from "./helpers/containedPlatform.ts"

it("runs remote commands with and without guest environment in a browser runtime", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import * as Effect from "effect/Effect"
        import * as ChildProcess from "effect/process/ChildProcess"
        import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
        import * as Remote from "./src/RemoteChildProcessSpawner/index.ts"

        globalThis.runBrowserProbe = async () => {
          const observed = []
          for (const env of [undefined, { REVIEW_VAR: "delivered", PATH: "/guest/bin", REMOVED: undefined }]) {
            const scripted = Remote.TestRemote.make({ scripts: { "printf hi": { stdout: "hi" } } })
            const received = []
            const provider = {
              ...scripted,
              spawn: (command, options) => {
                received.push(options.env)
                return scripted.spawn(command, options)
              }
            }
            const command = ChildProcess.make("printf", ["hi"], { env })
            const stdout = await Effect.runPromise(
              Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.string(command)).pipe(
                Effect.provide(Remote.layer(provider))
              )
            )
            observed.push({
              stdout,
              commands: scripted.state.commands,
              env: received[0],
              hasRemoval: received[0] !== undefined && Object.hasOwn(received[0], "REMOVED")
            })
          }
          return JSON.stringify({ processAbsent: typeof process === "undefined", observed })
        }
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url))
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false
  })
  const context = {
    AbortController,
    crypto: webcrypto,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder
  }
  runInNewContext(bundle.outputFiles[0]!.text, context)
  const run = (context as typeof context & { runBrowserProbe: () => Promise<string> }).runBrowserProbe
  const result = JSON.parse(await run())
  expect(result).toEqual({
    processAbsent: true,
    observed: [
      { stdout: "hi", commands: ["printf hi"], hasRemoval: false },
      {
        stdout: "hi",
        commands: ["printf hi"],
        env: { REVIEW_VAR: "delivered", PATH: "/guest/bin" },
        hasRemoval: true
      }
    ]
  })
})

it("runs directory and existing-container commands with injected host services and no process global", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import * as Effect from "effect/Effect"
        import * as Stream from "effect/Stream"
        import * as Directory from "./src/DirectorySandbox/index.ts"
        import * as Container from "./src/ContainerSandbox/index.ts"

        globalThis.runBootstrapProbe = async ({ fs, spawner, root }) => {
          const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
            const hostEnvironment = { USER: "injected-user", GH_TOKEN: "withheld" }
            const local = yield* Directory.make({ fs, spawner, root, hostEnvironment }).acquire("browser")
            const existing = Container.existing({
              container: "task", workdir: root, spawner, hostEnvironment,
              transport: { exec: request => Effect.succeed({ file: request.file, args: request.args }) }
            })
            const outputs = []
            const defaultLocal = yield* Directory.make({ fs, spawner, root }).acquire("browser-default")
            const defaultExisting = Container.existing({
              container: "task", workdir: root, spawner,
              transport: { exec: request => Effect.succeed({ file: request.file, args: request.args }) }
            })
            for (const session of [local, existing, defaultLocal, defaultExisting]) {
              const command = yield* session.spawn("printf '%s:%s' \\"$USER\\" \\"$GH_TOKEN\\"", {})
              outputs.push(yield* Stream.mkString(Stream.decodeText(command.stdout)))
            }
            return outputs
          })))
          return JSON.stringify({ processAbsent: typeof process === "undefined", observed })
        }
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url))
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false
  })
  const context = {
    AbortController,
    crypto: webcrypto,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder
  }
  runInNewContext(bundle.outputFiles[0]!.text, context)
  const run = (context as typeof context & {
    runBootstrapProbe: (services: unknown) => Promise<string>
  }).runBootstrapProbe
  const actual = await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped()
      return yield* Effect.promise(() => run({ fs, spawner, root }))
    })).pipe(Effect.provide(platform))
  )
  expect(JSON.parse(actual)).toEqual({
    processAbsent: true,
    observed: ["injected-user:", "injected-user:", ":", ":"]
  })
})
