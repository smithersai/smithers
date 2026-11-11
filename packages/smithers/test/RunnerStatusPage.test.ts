/**
 * `smthrs runner status --port`: the status page and its `workstreams.json`, served from the same fold `runner status`
 * prints, read again on every request.
 */
import { Context, Effect, Layer } from "effect"
import * as HttpServer from "effect/http/HttpServer"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { afterEach, beforeEach, expect, test } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as StatusPage from "../src/runner/StatusPage.ts"
import * as Lanes from "./fixtures/runner/lanes.ts"

let lanes: Lanes.Lanes

beforeEach(() => {
  lanes = Lanes.make()
})

afterEach(async () => {
  await lanes.close()
})

test("serves the page and the workstreams read now; a runner it can't read answers 500 naming no path", async () => {
  lanes.configure({ workstreams: { alpha: { title: "Alpha", tasks: [{ id: "notes", title: "Write the notes" }] } } })
  await Effect.runPromise(
    Effect.gen(function*() {
      const server = yield* Layer.build(RunnerCmd.statusServer(lanes.configPath, 0))
      const { address } = Context.get(server, HttpServer.HttpServer)
      if (address._tag === "UnixPathAddress") throw new Error("not a TCP server")
      const origin = `http://127.0.0.1:${address.port}`
      const page = yield* Effect.promise(() => fetch(`${origin}/`))
      expect([page.status, page.headers.get("content-type")]).toEqual([200, "text/html"])
      expect(yield* Effect.promise(() => page.text())).toBe(StatusPage.PAGE)
      const read = () =>
        Effect.promise(() => fetch(`${origin}/workstreams.json`).then(async (r) => [r.status, await r.json()]))
      expect(yield* read()).toEqual([200, { workstreams: yield* RunnerCmd.status(lanes.configPath) }])
      // The plan changes: the next read shows it, with no restart.
      lanes.configure({ workstreams: { beta: { title: "Beta" } } })
      expect(((yield* read())[1] as { workstreams: ReadonlyArray<{ id: string }> }).workstreams.map((w) => w.id))
        .toEqual(["beta"])
      writeFileSync(lanes.configPath, "{")
      expect(yield* read()).toEqual([500, { message: "the workstreams can't be read" }])
    }).pipe(Effect.scoped)
  )
}, 120_000)

test("smthrs runner status --port serves the page until stopped and logs where", async () => {
  lanes.configure({ workstreams: { alpha: { title: "Alpha" } } })
  const child = spawn(process.execPath, [Lanes.BIN, "runner", "status", "--config", lanes.configPath, "--port", "0"], {
    cwd: lanes.root,
    stdio: ["ignore", "pipe", "pipe"]
  })
  try {
    let log = ""
    child.stderr.on("data", (chunk) => (log += chunk))
    child.stdout.on("data", (chunk) => (log += chunk))
    await Lanes.until(() => /url: '(http:[^']+)'/.test(log), 60_000, "page served")
    const url = /url: '(http:[^']+)'/.exec(log)![1]!
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const read = await fetch(`${url}/workstreams.json`)
    expect(await read.json()).toMatchObject({ workstreams: [{ id: "alpha", title: "Alpha" }] })
  } finally {
    child.kill("SIGTERM")
  }
}, 120_000)
