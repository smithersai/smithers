/**
 * The model server's command line, run in process: record against an upstream
 * (itself a model server over a scripted model, so nothing leaves loopback),
 * then replay the file with no upstream at all.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type { ModelRequest } from "@smthrs/model/ModelRequest"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as BuiltinScript from "../src/BuiltinScript.ts"
import * as ModelServer from "../src/ModelServer.ts"
import * as ModelServerCli from "../src/ModelServerCli.ts"

const key = "test-upstream-credential-value"

const answer: ReadonlyArray<ModelEvent.ModelEvent> = [
  { type: "text-start", id: "text-0" },
  { type: "text-delta", id: "text-0", text: "recorded answer" },
  { type: "text-end", id: "text-0" },
  { type: "settle", stopReason: "stop" },
  { type: "usage", inputTokens: 5, outputTokens: 2 }
]

/** An upstream that answers `answer` and keeps every request it was sent. */
const upstream = (seen: Array<ModelRequest>) =>
  ModelServer.make({
    model: Model.make({ stream: (request) => Stream.suspend(() => (seen.push(request), Stream.fromIterable(answer))) }),
    evaluator: {
      evaluate: () => Effect.succeed({ answers: { done: { type: "boolean", probability: 0.75 } }, latencyMs: 1 })
    }
  })

const chatBody = (text: string) => ({
  model: "openai/requested",
  messages: [{ role: "system", content: "Teach." }, { role: "user", content: text }],
  stream: true,
  stream_options: { include_usage: true }
})

const post = (url: string, path: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await fetch(new URL(path, url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    return { status: response.status, body: await response.text() }
  })

const evaluationBody = { state: { todo: "x" }, questions: { done: { type: "boolean", instructions: "Done?" } } }

const withDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "model-server-cli-"))),
    use,
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  )

/** Runs the command until `stop`, returning the line it printed and the run's fiber. */
const start = (argv: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) =>
  Effect.gen(function*() {
    const printed = yield* Deferred.make<string>()
    const stop = yield* Deferred.make<void>()
    const fiber = yield* Effect.forkChild(Effect.promise(() =>
      ModelServerCli.run(argv, env, {
        print: (line) => Effect.runSync(Deferred.succeed(printed, line)),
        stopped: Effect.runPromise(Deferred.await(stop))
      })
    ))
    const line = yield* Deferred.await(printed)
    return {
      url: (JSON.parse(line) as { readonly url: string }).url,
      stop: Deferred.succeed(stop, undefined).pipe(Effect.andThen(Fiber.join(fiber)))
    }
  })

describe("ModelServerCli.parse", () => {
  it("reads every flag", () => {
    expect(ModelServerCli.parse([
      "--fixture",
      "f.json",
      "--record",
      "--upstream",
      "https://gateway.example",
      "--upstream-model",
      "openai/gpt-5-mini",
      "--key-env",
      "KEY",
      "--hold",
      "\\[HOLD (\\w+)\\]",
      "--normalize",
      "/tmp/run-\\d+",
      "--host",
      "localhost",
      "--port",
      "4123"
    ], { KEY: key })).toMatchObject({
      fixture: "f.json",
      record: { upstream: "https://gateway.example", model: "openai/gpt-5-mini" },
      hold: [/\[HOLD (\w+)\]/],
      normalize: [/\/tmp\/run-\d+/g],
      hostname: "localhost",
      port: 4123
    })
  })

  it.each([
    [[], "--fixture is required"],
    [["--fixture"], "--fixture needs a value"],
    [["--fixture", "f", "--wat"], "Unknown argument --wat"],
    [["--fixture", "f", "--record"], "--record needs --upstream"],
    [["--fixture", "f", "--record", "--upstream", "https://x"], "--record needs --key-env"],
    [["--fixture", "f", "--record", "--upstream", "https://x", "--key-env", "KEY"], "KEY is empty"],
    [["--fixture", "f", "--upstream", "https://x"], "--upstream needs --record"],
    [["--fixture", "f", "--hold", "("], "--hold is not a regular expression"],
    [["--fixture", "f", "--hold", "HOLD"], "--hold needs one capture group"],
    [["--fixture", "f", "--normalize", "["], "--normalize is not a regular expression"],
    [["--fixture", "f", "--port", "x"], "--port must be an integer"]
  ])("refuses %j", (argv, message) => {
    expect(() => ModelServerCli.parse(argv, {})).toThrow(message)
  })
})

describe("ModelServerCli.parse --script", () => {
  it("serves the builtin script with no fixture, and traces turns", () => {
    expect(ModelServerCli.parse(["--script", "builtin", "--trace", "t.jsonl", "--trace-messages"], {})).toMatchObject({
      fixture: undefined,
      script: {},
      trace: { file: "t.jsonl", messages: true }
    })
    expect(ModelServerCli.parse(["--script", "builtin", "--trace", "t.jsonl"], {}).trace).toEqual({
      file: "t.jsonl",
      messages: false
    })
  })

  it("reads --script-config, with todoFlow read from a path relative to it", () => {
    const directory = mkdtempSync(join(tmpdir(), "model-server-cli-config-"))
    try {
      writeFileSync(join(directory, "flow.ts"), "Request.call(input)")
      const config = join(directory, "script.json")
      writeFileSync(config, JSON.stringify({ greeting: "Hi", todoFlow: "flow.ts", holdAt: ["coding/draft-plan"] }))
      expect(ModelServerCli.parse(["--script", "builtin", "--script-config", config], {}).script).toEqual({
        greeting: "Hi",
        todoFlow: "Request.call(input)",
        holdAt: ["coding/draft-plan"]
      })
      writeFileSync(config, JSON.stringify({ greeting: "Hi" }))
      expect(ModelServerCli.parse(["--script", "builtin", "--script-config", config], {}).script).toEqual({
        greeting: "Hi"
      })
      for (
        const [content, message] of [
          ["[1]", "is not a JSON object"],
          ["null", "is not a JSON object"],
          ["7", "is not a JSON object"],
          ["{", "is not readable JSON"],
          [JSON.stringify({ todoFlow: "absent.ts" }), "absent.ts does not exist"]
        ] as const
      ) {
        writeFileSync(config, content)
        expect(() => ModelServerCli.parse(["--script", "builtin", "--script-config", config], {})).toThrow(message)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    [["--script", "other"], "--script other is not a script"],
    [["--fixture", "f", "--script-config", "c.json"], "--script-config needs --script"],
    [["--fixture", "f", "--trace-messages"], "--trace-messages needs --trace"],
    [["--script", "builtin", "--record", "--upstream", "https://x", "--key-env", "KEY"], "--fixture is required"]
  ])("refuses %j", (argv, message) => {
    expect(() => ModelServerCli.parse(argv, { KEY: key })).toThrow(message)
  })
})

/** A turn as the coding host sends one step through the proxy. */
const stepBody = (teaching: string, payload: unknown) => ({
  model: "coder",
  messages: [{ role: "system", content: `${teaching}\nThe task for this run: ${JSON.stringify(payload)}` }, {
    role: "user",
    content: "Begin."
  }],
  stream: true
})

const getJson = (url: string, path: string) =>
  Effect.promise(() =>
    fetch(new URL(path, url)).then((response) => response.json() as Promise<Record<string, unknown>>)
  )

describe("ModelServerCli.run --script builtin", () => {
  it.live("answers builtin steps and judgments, settles any other turn, and traces each", () =>
    withDirectory((directory) =>
      Effect.gen(function*() {
        const trace = join(directory, "turns.jsonl")
        const server = yield* start(["--script", "builtin", "--trace", trace, "--trace-messages"])
        const lens = yield* post(
          server.url,
          ModelServer.paths.chat,
          stepBody(BuiltinScript.teachings["coding/review-lens"], {})
        )
        expect(lens.body).toContain("approve")
        expect((yield* post(server.url, ModelServer.paths.chat, chatBody("other"))).body).toContain("scripted")
        const judged = yield* post(server.url, ModelServer.paths.evaluation, {
          state: {},
          questions: { complete: { type: "boolean", instructions: "Done?" } }
        })
        expect(JSON.parse(judged.body)).toMatchObject({
          answers: { complete: { probability: 0.99 } },
          usage: { inputTokens: 120 }
        })
        const refused = yield* post(server.url, ModelServer.paths.evaluation, {
          state: {},
          questions: { pick: { type: "choice", instructions: "?", criteria: { a: "a", b: "b" } } }
        })
        expect(refused.status).toBe(400)
        expect(yield* getJson(server.url, ModelServer.paths.turns)).toEqual({
          total: 4,
          chat: 2,
          evaluation: 1,
          refused: 1,
          steps: { "coding/review-lens": 1, unscripted: 1, complete: 1, pick: 1 },
          held: []
        })
        yield* server.stop
        const lines = readFileSync(trace, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line))
        expect(lines[0]).toMatchObject({
          step: "coding/review-lens",
          messages: [{ role: "system" }, { role: "user", content: "Begin." }]
        })
        expect(lines[1]).toMatchObject({ step: "unscripted", system: "Teach.", last: "other" })
      })
    ))

  it.live("holds a TODO's edit, and the steps holdAt names, until the test releases its key", () =>
    withDirectory((directory) =>
      Effect.gen(function*() {
        const config = join(directory, "script.json")
        writeFileSync(config, JSON.stringify({ holdAt: ["coding/draft-plan"] }))
        const server = yield* start(["--script", "builtin", "--script-config", config])
        const planning = yield* Effect.forkChild(post(
          server.url,
          ModelServer.paths.chat,
          stepBody(BuiltinScript.teachings["coding/draft-plan"], { input: { prompt: "[HOLD t4] x" }, context: {} })
        ))
        yield* Effect.promise(() => fetch(`${server.url}${ModelServer.paths.held}`).then((r) => r.text())).pipe(
          Effect.repeat({ until: (body) => body === "[\"t4\"]" })
        )
        expect(yield* getJson(server.url, ModelServer.paths.turns)).toMatchObject({ held: ["t4"] })
        yield* post(server.url, `${ModelServer.paths.release}t4`, {})
        expect((yield* Fiber.join(planning)).body).toContain("[HOLD t4]")
        yield* server.stop
      })
    ))

  it.live("replays what it does not script from a fixture, and only names turns while recording", () =>
    withDirectory((directory) =>
      Effect.gen(function*() {
        const fixture = join(directory, "model.json")
        writeFileSync(fixture, JSON.stringify({ calls: [] }))
        const replaying = yield* start(["--script", "builtin", "--fixture", fixture])
        expect((yield* post(replaying.url, ModelServer.paths.chat, chatBody("other"))).status).toBe(501)
        yield* replaying.stop
        const seen: Array<ModelRequest> = []
        const origin = yield* upstream(seen)
        const recorded = join(directory, "recorded.json")
        const recording = yield* start([
          "--script",
          "builtin",
          "--fixture",
          recorded,
          "--record",
          "--upstream",
          origin.url,
          "--key-env",
          "UPSTREAM_KEY"
        ], { UPSTREAM_KEY: key })
        const lens = stepBody(BuiltinScript.teachings["coding/review-lens"], {})
        expect((yield* post(recording.url, ModelServer.paths.chat, lens)).body).toContain("recorded answer")
        expect((yield* post(recording.url, ModelServer.paths.chat, chatBody("other"))).body).toContain(
          "recorded answer"
        )
        expect((yield* getJson(recording.url, ModelServer.paths.turns)).steps).toEqual({
          "coding/review-lens": 1,
          recorded: 1
        })
        yield* recording.stop
        expect(seen).toHaveLength(2)
      })
    ))
})

describe("ModelServerCli.run", () => {
  it.live("records chat turns and judgments to the fixture, then replays them with no upstream", () =>
    withDirectory((directory) =>
      Effect.gen(function*() {
        const fixture = join(directory, "model.json")
        const seen: Array<ModelRequest> = []
        const origin = yield* upstream(seen)
        const recording = yield* start([
          "--fixture",
          fixture,
          "--record",
          "--upstream",
          origin.url,
          "--upstream-model",
          "openai/upstream",
          "--key-env",
          "UPSTREAM_KEY",
          "--normalize",
          "/tmp/run-\\d+"
        ], { UPSTREAM_KEY: key })
        const chat = yield* post(recording.url, ModelServer.paths.chat, chatBody("Hello from /tmp/run-1"))
        expect(chat.body).toContain("recorded answer")
        expect(seen.map((request) => request.modelId)).toEqual(["openai/upstream"])
        // The upstream is asked the original; the fixture keeps the normalized request.
        expect(JSON.stringify(seen[0]!.messages)).toContain("/tmp/run-1")
        const judged = yield* post(recording.url, ModelServer.paths.evaluation, evaluationBody)
        expect(JSON.parse(judged.body)).toEqual({ answers: { done: { type: "boolean", probability: 0.75 } } })
        yield* recording.stop
        const written = readFileSync(fixture, "utf8")
        expect(written).not.toContain(key)
        // The fixture keys the request as the install sent it.
        expect(written).toContain("openai/requested")
        expect(written).not.toContain("openai/upstream")
        expect(written).not.toContain("/tmp/run-1")

        const replay = yield* start(["--fixture", fixture, "--normalize", "/tmp/run-\\d+"])
        expect((yield* post(replay.url, ModelServer.paths.chat, chatBody("Hello from /tmp/run-2"))).body)
          .toContain("recorded answer")
        expect(JSON.parse((yield* post(replay.url, ModelServer.paths.evaluation, evaluationBody)).body))
          .toEqual({ answers: { done: { type: "boolean", probability: 0.75 } } })
        expect((yield* post(replay.url, ModelServer.paths.chat, chatBody("Unrecorded"))).status).toBe(501)
        yield* replay.stop
        expect(seen).toHaveLength(1)
        // Replay never writes: no journal, lock or rewrite is left behind.
        expect(readFileSync(fixture, "utf8")).toBe(written)
        expect(existsSync(`${fixture}.lock`)).toBe(false)
      })
    ))

  it.live("holds a matching turn until it is released over HTTP", () =>
    withDirectory((directory) =>
      Effect.gen(function*() {
        const fixture = join(directory, "model.json")
        const origin = yield* upstream([])
        const server = yield* start([
          "--fixture",
          fixture,
          "--record",
          "--upstream",
          origin.url,
          "--key-env",
          "UPSTREAM_KEY",
          "--hold",
          "\\[HOLD ([a-z0-9]+)\\]"
        ], { UPSTREAM_KEY: key })
        const held = yield* Effect.forkChild(post(server.url, ModelServer.paths.chat, chatBody("edit [HOLD t2]")))
        yield* Effect.promise(() => fetch(`${server.url}${ModelServer.paths.held}`).then((r) => r.text())).pipe(
          Effect.repeat({ until: (body) => body === "[\"t2\"]" })
        )
        yield* post(server.url, `${ModelServer.paths.release}t2`, {})
        expect((yield* Fiber.join(held)).body).toContain("recorded answer")
        expect((yield* post(server.url, ModelServer.paths.chat, chatBody("plain"))).body).toContain("recorded answer")
        // A key in a tool's arguments or result holds the turn too.
        yield* post(server.url, `${ModelServer.paths.release}t3`, {})
        const tooled = yield* post(server.url, ModelServer.paths.chat, {
          ...chatBody("go"),
          messages: [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }]
            },
            { role: "tool", tool_call_id: "c1", content: "[HOLD t3]" }
          ]
        })
        expect(tooled.body).toContain("recorded answer")
        yield* server.stop
      })
    ))

  it.live("refuses to replay a fixture that does not exist", () =>
    withDirectory((directory) =>
      Effect.gen(function*() {
        const fixture = join(directory, "absent.json")
        const exit = yield* Effect.tryPromise(() =>
          ModelServerCli.run(["--fixture", fixture], {}, { print: () => undefined, stopped: new Promise(() => {}) })
        ).pipe(Effect.exit)
        expect(String(exit)).toContain("absent.json does not exist")
        writeFileSync(fixture, "{\"calls\":7}")
        const broken = yield* Effect.tryPromise(() =>
          ModelServerCli.run(["--fixture", fixture], {}, { print: () => undefined, stopped: new Promise(() => {}) })
        ).pipe(Effect.exit)
        expect(broken._tag).toBe("Failure")
      })
    ))
})

describe("smthrs-model-server", () => {
  const bin = fileURLToPath(new URL("../bin/smthrs-model-server.mjs", import.meta.url))

  it.live("serves a fixture as a process, prints its URL, and exits cleanly on SIGTERM", () =>
    withDirectory((directory) =>
      Effect.gen(function*() {
        const fixture = join(directory, "model.json")
        writeFileSync(fixture, JSON.stringify({ calls: [] }))
        // Windows TerminateProcess does not deliver a JavaScript SIGTERM event.
        // A test-only IPC preload delivers that event to the real CLI handler.
        const signal = join(directory, "signal.mjs")
        writeFileSync(signal, `process.once("message", () => { process.disconnect(); process.emit("SIGTERM") })`)
        const windows = process.platform === "win32"
        const child = spawn(process.execPath, [
          ...(windows ? ["--import", pathToFileURL(signal).href] : []),
          bin,
          "--fixture",
          fixture
        ], { stdio: ["ignore", "pipe", "pipe", ...(windows ? ["ipc" as const] : [])] })
        const line = yield* Effect.promise(() =>
          new Promise<string>((resolve) => child.stdout!.once("data", (data: Buffer) => resolve(data.toString())))
        )
        const { url } = JSON.parse(line) as { readonly url: string }
        expect(yield* Effect.promise(() => fetch(`${url}/health`).then((response) => response.text()))).toBe("ok")
        const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
        if (windows) child.send("SIGTERM")
        else child.kill("SIGTERM")
        expect(yield* Effect.promise(() => exited)).toBe(0)
      })
    ))

  it.live("exits 1 and names the problem when the command line is wrong", () =>
    Effect.gen(function*() {
      const child = spawn(process.execPath, [bin, "--wat"], { stdio: ["ignore", "pipe", "pipe"] })
      let stderr = ""
      child.stderr.on("data", (data: Buffer) => (stderr += data.toString()))
      const code = yield* Effect.promise(() => new Promise<number | null>((resolve) => child.once("exit", resolve)))
      expect(code).toBe(1)
      expect(stderr).toContain("Unknown argument --wat")
    }))
})
