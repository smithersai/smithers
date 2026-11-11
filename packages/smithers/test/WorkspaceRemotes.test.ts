/** How the host turns the workspace's `S.Remotes` into `Remotes.Remotes` sessions. */
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import * as TestGrantStore from "@smthrs/kernel/test/TestGrantStore"
import { Remotes } from "@smthrs/sandbox"
import { Effect, Layer, Stream } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll } from "vitest"
import * as WorkspaceRemotes from "../src/internal/WorkspaceRemotes.ts"

const modules = fileURLToPath(new URL("../node_modules", import.meta.url))
const made: Array<string> = []
afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

// A project whose workspace file is `workspace`, or that has none.
const project = (workspace?: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-workspace-remotes-")))
  made.push(root)
  symlinkSync(modules, join(root, "node_modules"), "dir")
  if (workspace !== undefined) {
    mkdirSync(join(root, ".smithers"))
    writeFileSync(
      join(root, ".smithers", "WORKSPACE.ts"),
      `import { Smithers as S } from "@smthrs/targets"\n${workspace}\n`
    )
  }
  return root
}

const declaring = (remotes: string) =>
  project(`export const Workspace = S.Workspace("remotes", {
  repository: "git+https://example.invalid/remotes.git",
  cache: S.Cache({ directory: ".flows" }),
  remotes: S.Remotes({ ${remotes} })
})`)

const remotes = (root: string, environment: Readonly<Record<string, string | undefined>> = {}) =>
  Effect.provide(
    Effect.gen(function*() {
      return yield* Remotes.Remotes
    }),
    WorkspaceRemotes.layer({ root, environment }).pipe(
      Layer.provide([TestGrantStore.layerAllow, NodeServices.layer, FetchHttpClient.layer])
    )
  )

// What one command prints on a session of `remote` under `session`.
const run = (root: string, remote: string, session: string, command: string) =>
  Effect.gen(function*() {
    const service = yield* remotes(root)
    return yield* Effect.scoped(Effect.gen(function*() {
      const opened = yield* service.acquire(remote, session)
      const process = yield* opened.spawn(command, { cwd: opened.workdir })
      const [out] = yield* Effect.all([Stream.mkString(Stream.decodeText(process.stdout)), process.exitCode])
      return out.trim()
    }))
  })

describe("WorkspaceRemotes", () => {
  it.effect("places each session key on one machine of a command remote, in a directory of its own", () =>
    Effect.gen(function*() {
      const guest = realpathSync(mkdtempSync(join(tmpdir(), "smithers-workspace-remotes-guest-")))
      made.push(guest)
      const root = declaring(
        `pair: S.Remote.Command({ machines: [["env", "MACHINE=1"], ["env", "MACHINE=2"]], workdir: ${
          JSON.stringify(`${guest}/`)
        } })`
      )
      const answers = yield* Effect.forEach(
        ["a", "b", "c", "d", "e", "f", "g", "h"],
        (key) => run(root, "pair", key, "printf '%s %s' \"$MACHINE\" \"$(pwd)\"")
      )
      // Both machines take sessions, and the trailing slash adds no empty segment.
      expect(new Set(answers.map((answer) => answer.split(" ")[0]))).toEqual(new Set(["1", "2"]))
      expect(answers[0]).toMatch(new RegExp(`^[12] ${guest}/a-[0-9a-f]{12}$`))
      // The same key lands where it landed before.
      expect(yield* run(root, "pair", "a", "printf '%s %s' \"$MACHINE\" \"$(pwd)\"")).toBe(answers[0])
    }))

  it.effect("refuses every remote of a project that has no workspace file, or no remotes in it", () =>
    Effect.gen(function*() {
      const bare = project(`export const Workspace = S.Workspace("bare", {
  repository: "git+https://example.invalid/bare.git",
  cache: S.Cache({ directory: ".flows" })
})`)
      for (const root of [project(), bare]) {
        const error = yield* Effect.flip(run(root, "fuzz", "key", "true"))
        expect(error).toMatchObject({
          code: "not_found",
          message: "the workspace declares no remote \"fuzz\"; it declares none (S.Workspace remotes)"
        })
      }
    }))

  it.effect("names the declared remotes when an action asks for another", () =>
    Effect.gen(function*() {
      const root = declaring(
        `here: S.Remote.Command({ machines: [[]], workdir: "/tmp" }), there: S.Remote.Command({ machines: [[]], workdir: "/tmp" })`
      )
      const error = yield* Effect.flip(run(root, "fuzz", "key", "true"))
      expect(error).toMatchObject({
        code: "not_found",
        message: expect.stringContaining("; it declares here, there (")
      })
    }))

  it.effect("fails an acquire, not the host, when the workspace file does not evaluate", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(run(project(`throw new Error("broken workspace")`), "fuzz", "key", "true"))
      expect(error).toMatchObject({
        code: "unavailable",
        message: expect.stringContaining("the workspace's remotes could not be read")
      })
    }))

  it.effect("asks for an HTTP remote's token by its variable, then sends it to the service", () =>
    Effect.gen(function*() {
      // A service that refuses every request and records who asked.
      const seen: Array<string | undefined> = []
      const server = yield* Effect.acquireRelease(
        Effect.callback<Server>((resume) => {
          const listening = createServer((request, response) => {
            seen.push(request.headers.authorization)
            response.writeHead(401, { "content-type": "application/json" }).end("{}")
          })
          listening.listen(0, "127.0.0.1", () => resume(Effect.succeed(listening)))
        }),
        (listening) => Effect.callback<void>((resume) => void listening.close(() => resume(Effect.void)))
      )
      const { port } = server.address() as AddressInfo
      const root = declaring(
        `boxes: S.Remote.Http({ url: "http://127.0.0.1:${port}", token: S.Secret("REMOTES_TEST_TOKEN"), machines: 1, workdir: "/work", limits: { cpus: 2 } })`
      )
      const acquire = (environment: Readonly<Record<string, string>>) =>
        Effect.flip(
          Effect.scoped(Effect.flatMap(remotes(root, environment), (service) => service.acquire("boxes", "key")))
        )
      expect(yield* acquire({})).toMatchObject({
        code: "unavailable",
        message: "remote boxes's token is not set: export REMOTES_TEST_TOKEN"
      })
      expect(seen).toEqual([])
      yield* acquire({ REMOTES_TEST_TOKEN: "secret" })
      expect(seen[0]).toBe("Bearer secret")
    }))
})
