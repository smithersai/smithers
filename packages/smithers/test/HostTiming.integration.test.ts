/**
 * One scripted run on the shipped native host, read two ways: its control
 * journal, and what its process exports to an OTLP collector.
 *
 * The host is sealed to a container whose `docker` is a stub, its seat signs
 * with a scratch Codex login a stub `codex` refreshes, and the model transport
 * and the judge are scripted, so nothing leaves the process but the export to
 * the collector on loopback. Every token here is fabricated.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Schema, Stream } from "effect"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Application from "../src/Application.vibe"
import * as Telemetry from "../src/internal/Telemetry.ts"
import * as NodeControl from "../src/NodeControl.ts"

/** A syntactically valid JWT whose payload carries only the given expiry. */
const jwt = (marker: string, expiresInSeconds: number): string =>
  `eyJhbGciOiJub25lIn0.${
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds, marker })).toString("base64url")
  }.signature`

// Four minutes left is inside the five-minute margin, so the first sign-in asks Codex to refresh.
const stale = jwt("near-expiry", 4 * 60)
const rotated = jwt("rotated", 3600)
const accountId = "acct-fake-7f3a"
const secrets = [stale, rotated, accountId, "fake-refresh-0", "rotated-by-codex", "fake-id"]

/** What the stub `docker` prints for every exec, whatever it was asked to run. */
const printed = "app.py\nREADME.md\n"

/** A `codex` whose app-server refreshes `$CODEX_HOME/auth.json` the way the CLI does. */
const codex = `const fs = require("node:fs"), path = require("node:path")
let buffered = ""
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  buffered += chunk
  for (;;) {
    const end = buffered.indexOf("\\n")
    if (end < 0) break
    const message = JSON.parse(buffered.slice(0, end))
    buffered = buffered.slice(end + 1)
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n")
    if (message.method === "account/read") {
      const file = path.join(process.env.CODEX_HOME, "auth.json")
      const login = JSON.parse(fs.readFileSync(file, "utf8"))
      login.tokens.access_token = ${JSON.stringify(rotated)}
      login.tokens.refresh_token = "rotated-by-codex"
      fs.writeFileSync(file, JSON.stringify(login))
      process.stdout.write(JSON.stringify({ id: message.id, result: { account: null } }) + "\\n")
    }
  }
})
`

const sse = (text: string): string =>
  [
    { type: "response.output_text.delta", item_id: "msg_1", delta: text },
    { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 7 } } }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

/** The frames the scripted seat answers with: one `bash` call in the container, then done. */
const frames = [
  "```cell\nconst listed = await ctx.call(\"bash\", { mode: \"unhermetic\", container: \"task\", command: \"ls\" })\nconsole.log(JSON.stringify(listed))\n```",
  "```cell\nctx.done(\"listed\")\n```"
]

interface Span {
  readonly name: string
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano: string
  readonly attributes: Readonly<Record<string, unknown>>
}

/** A native event of the run, as the control journal holds it. */
interface Native {
  readonly eventType: string
  readonly payload: unknown
}

/** The host stream's lifetime records in a project's control journal. */
const lifetimesOf = (
  root: string
): ReadonlyArray<{ readonly stream: string; readonly lifetime: Telemetry.Lifetime }> => {
  const database = new DatabaseSync(NodeControl.databasePath(root), { readOnly: true })
  try {
    return database.prepare(
      "SELECT run_id, payload_json FROM flows_journal_events WHERE event_type = ? ORDER BY emitted_at_ms"
    ).all(Telemetry.lifetimeEvent).map((row) => ({
      stream: String(row["run_id"]),
      lifetime: Schema.decodeUnknownSync(Telemetry.Lifetime, { onExcessProperty: "error" })(
        JSON.parse(String(row["payload_json"]))
      )
    }))
  } finally {
    database.close()
  }
}

const observed: {
  kinds: ReadonlyArray<string>
  native: ReadonlyArray<Native>
  lifetimes: ReturnType<typeof lifetimesOf>
  spans: ReadonlyArray<Span>
  exported: string
  journaled: string
  sent: number
} = { kinds: [], native: [], lifetimes: [], spans: [], exported: "", journaled: "", sent: 0 }

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "smithers-host-timing-")))
const hostPath = process.env.PATH

beforeAll(async () => {
  const home = join(scratch, "codex-home")
  const bin = join(scratch, "bin")
  const root = join(scratch, "workspace")
  for (const directory of [home, bin, join(root, ".smithers", "flows", "survey")]) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: "fake-id", access_token: stale, refresh_token: "fake-refresh-0", account_id: accountId }
    }),
    { mode: 0o600 }
  )
  writeFileSync(join(bin, "codex"), `#!${process.execPath}\n${codex}`, { mode: 0o755 })
  writeFileSync(
    join(bin, "docker"),
    `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(printed)})\n`,
    { mode: 0o755 }
  )
  writeFileSync(
    join(root, ".smithers", "flows", "survey", "flow.mdx"),
    "---\nname: survey\ndescription: Lists the task's files.\nmodel: codex:sol\n---\n\nList the files.\n"
  )
  // A transport process is found on this process's own PATH.
  process.env.PATH = `${bin}:${hostPath}`

  const received: Array<{ readonly path: string; readonly body: any }> = []
  const collector = createServer((request, response) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      received.push({ path: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })
      response.writeHead(200, { "content-type": "application/json" })
      response.end("{}")
    })
  })
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve))
  const endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`

  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() =>
        HttpClientResponse.fromWeb(
          request,
          new Response(sse(frames[Math.min(observed.sent++, frames.length - 1)]!), {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          })
        )
      )
  })
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const runs = NodeControl.layerExecutor(registry, engine, root, {
    environment: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      CODEX_HOME: home,
      SMITHERS_BASH_CONTAINER: "task",
      SMITHERS_ASKS: "refuse"
    },
    evaluator: ScriptedJudge.layerAll,
    grants: GrantStore.layerNoop,
    requestExecutor: Layer.succeed(RequestExecutor.RequestExecutor)(executor)
  })
  const layer = Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>
  const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])
  const events = await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const card = yield* control.plan({ flowId: "survey", input: {} })
      yield* control.approve(card.approval)
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "host-timing"
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("Run was not accepted")
      return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
        Stream.takeUntil((event) => terminal.has(event.kind)),
        Stream.runCollect,
        Effect.map((collected) => Array.from(collected))
      )
    }).pipe(
      Effect.provide(layer),
      Effect.scoped,
      // The process's own export, exactly as a command installs it; closing it flushes.
      Effect.provide(Telemetry.layer({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint })),
      Effect.orDie
    )
  )
  await new Promise<void>((resolve) => collector.close(() => resolve()))

  observed.kinds = events.map((event) => event.kind)
  observed.native = events.filter((event) => event.kind === "control.engine.event").map((event) =>
    event.payload as unknown as Native
  )
  // The host has closed: its lifetime is in the control journal.
  observed.lifetimes = lifetimesOf(root)
  observed.journaled = JSON.stringify(events)
  observed.exported = JSON.stringify(received)
  const value = (attribute: any): unknown =>
    attribute.value.stringValue ?? attribute.value.boolValue ??
      (attribute.value.intValue === undefined ? attribute.value.doubleValue : Number(attribute.value.intValue))
  observed.spans = received.filter((entry) => entry.path === "/v1/traces").flatMap((entry) =>
    entry.body.resourceSpans.flatMap((resource: any) =>
      resource.scopeSpans.flatMap((scope: any) =>
        scope.spans.map((span: any): Span => ({
          name: span.name,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: Object.fromEntries(
            (span.attributes ?? []).map((attribute: any) => [attribute.key, value(attribute)])
          )
        }))
      )
    )
  )
}, 120_000)

afterAll(() => {
  process.env.PATH = hostPath
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
})

const records = <A>(eventType: string, schema: Schema.Schema<A>): ReadonlyArray<A> =>
  observed.native.filter((event) => event.eventType === eventType).map((event) =>
    Schema.decodeUnknownSync(schema as Schema.Codec<A>, { onExcessProperty: "error" })(event.payload)
  )

const spansNamed = (name: string | RegExp) =>
  observed.spans.filter((span) => typeof name === "string" ? span.name === name : name.test(span.name))

/** The record's own fields as they read on a span. */
const mirrored = (eventType: string, span: Span): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(span.attributes).filter(([key]) => key.startsWith(`${eventType}.`)).map((
      [key, value]
    ) => [key.slice(eventType.length + 1), value])
  )

const whole = (millis: number) => Number.isInteger(millis) && millis >= 0

/** A record's measurements, without the step it is keyed to. */
const measured = <A extends { readonly stepKeyDigest?: string | undefined }>({ stepKeyDigest: _, ...rest }: A) => rest

describe("a run's journal on a sealed host with a subscription seat", () => {
  it("completes: two frames, one command in the container", () => {
    expect(observed.kinds.at(-1)).toBe("control.run.completed")
    expect(observed.sent).toBe(2)
    expect(observed.kinds.filter((kind) => kind === "control.agent.cell-call-settled")).toHaveLength(1)
  })

  it("holds one sign-in per model request, the first with the refresh it ran", () => {
    const signIns = records(Telemetry.signInEvent, Telemetry.SignIn)

    expect(signIns).toHaveLength(2)
    expect(signIns[0]).toMatchObject({ trigger: "request", refreshed: true, refreshOutcome: "rotated", ok: true })
    expect(signIns[1]).toEqual({
      trigger: "request",
      readMs: expect.any(Number),
      lockWaitMs: 0,
      refreshed: false,
      totalMs: expect.any(Number),
      ok: true,
      stepKeyDigest: expect.any(String)
    })
    for (const signIn of signIns) {
      expect([signIn.readMs, signIn.lockWaitMs, signIn.totalMs, signIn.refreshMs ?? 0].every(whole)).toBe(true)
      // What it waited on and ran is inside the whole.
      expect(signIn.totalMs).toBeGreaterThanOrEqual(signIn.lockWaitMs + (signIn.refreshMs ?? 0))
    }
  })

  it("keys each sign-in to its model call and each container process to its cell call", () => {
    const signIns = records(Telemetry.signInEvent, Telemetry.SignIn).map((signIn) => signIn.stepKeyDigest)
    const commands = records(Telemetry.commandEvent, Telemetry.Command).map((command) => command.stepKeyDigest)
    // The engine brackets every step with attempt events that carry the step's digest.
    const attempts = observed.native.filter((event) => event.eventType === "flows.engine.attempt-started").map((
      event
    ) => (event.payload as { readonly stepKeyDigest: string }).stepKeyDigest)

    expect(new Set(signIns).size).toBe(2)
    for (const digest of signIns) expect(attempts).toContain(digest)
    // The one bash call is one step: its three processes share a digest, and it is no model call's.
    expect(new Set(commands).size).toBe(1)
    expect(attempts).toContain(commands[0])
    expect(signIns).not.toContain(commands[0])
    expect(records(Telemetry.startUpEvent, Telemetry.StartUp)[0]!.stepKeyDigest).toBe(signIns[0])
  })

  it("holds one record per process started in the container, its parts adding up", () => {
    const commands = records(Telemetry.commandEvent, Telemetry.Command)

    // The command, and a fingerprint of its working directory before and after it.
    expect(commands).toHaveLength(3)
    for (const command of commands) {
      expect([command.spawnMs, command.runMs, command.collectMs, command.totalMs].every(whole)).toBe(true)
      expect(command.spawnMs + command.runMs + command.collectMs).toBe(command.totalMs)
      expect(command).toMatchObject({ bytesOut: Buffer.byteLength(printed), exitCode: 0 })
    }
  })

  it("holds the process's start-up, its stages adding up to the first model request", () => {
    const [startUp, ...others] = records(Telemetry.startUpEvent, Telemetry.StartUp)

    expect(others).toEqual([])
    expect(startUp!.stages.map((stage) => stage.stage)).toEqual([
      "boot",
      "project",
      "journal",
      "executor",
      "launch",
      "seat",
      "request"
    ])
    expect(startUp!.stages.every((stage) => whole(stage.ms))).toBe(true)
    expect(startUp!.stages.reduce((sum, stage) => sum + stage.ms, 0)).toBe(startUp!.totalMs)
    expect(startUp!.processStartedAtMs).toBe(Math.floor(performance.timeOrigin))
    // It was written before the first model request settled.
    const written = observed.native.findIndex((event) => event.eventType === Telemetry.startUpEvent)
    expect(written).toBeGreaterThanOrEqual(0)
    expect(observed.kinds.indexOf("control.agent.model-requested")).toBeGreaterThanOrEqual(0)
  })

  it("holds the process's lifetime in the host stream once the host has closed", () => {
    const [startUp] = records(Telemetry.startUpEvent, Telemetry.StartUp)

    expect(observed.lifetimes.map((entry) => entry.stream)).toEqual([`flows.host:${hostname()}`])
    const { lifetime } = observed.lifetimes[0]!
    expect(lifetime).toMatchObject({ pid: process.pid, processStartedAtMs: startUp!.processStartedAtMs })
    // The same clock as the start-up record, read again at the close.
    expect(lifetime.stages).toEqual(startUp!.stages)
    expect(lifetime.endedAtMs).toBeGreaterThanOrEqual(lifetime.processStartedAtMs + startUp!.totalMs)
  })

  it("holds no token, account id or refresh token anywhere", () => {
    for (const secret of secrets) expect(observed.journaled).not.toContain(secret)
    for (const secret of secrets) expect(JSON.stringify(observed.lifetimes)).not.toContain(secret)
  })
})

describe("a process that sends no model request", { timeout: 240_000 }, () => {
  it("journals its own start, the stages it reached and its close", async () => {
    const root = join(scratch, "planned")
    mkdirSync(join(root, ".smithers", "flows", "survey"), { recursive: true })
    writeFileSync(
      join(root, ".smithers", "flows", "survey", "flow.mdx"),
      "---\nname: survey\ndescription: Lists the task's files.\nmodel: openai:gpt-4o-mini\n---\n\nList the files.\n"
    )
    const before = Date.now()

    // The real executable, as the benchmark starts it: `plan` is a process of its own.
    const planned = await new Promise<{ readonly status: number | null; readonly output: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--no-warnings",
          "--import",
          fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url)),
          fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
          "--json",
          "plan",
          "survey"
        ],
        { cwd: root, env: { HOME: root, PATH: hostPath, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] }
      )
      let output = ""
      child.stdout.on("data", (chunk) => output += chunk)
      child.stderr.on("data", (chunk) => output += chunk)
      child.once("close", (status) => resolve({ status, output }))
    })

    expect(planned.status, planned.output).toBe(0)
    const lifetimes = lifetimesOf(root)
    expect(lifetimes).toHaveLength(1)
    const { lifetime } = lifetimes[0]!
    expect(lifetime.stages.map((stage) => stage.stage)).toEqual(["boot", "project", "journal", "executor"])
    expect(lifetime.pid).not.toBe(process.pid)
    // It started after this test asked for it, and closed after every stage it reached.
    expect(lifetime.processStartedAtMs).toBeGreaterThanOrEqual(before)
    expect(lifetime.endedAtMs).toBeGreaterThanOrEqual(
      lifetime.processStartedAtMs + lifetime.stages.reduce((sum, stage) => sum + stage.ms, 0)
    )
  })
})

describe("the run's spans at an OTLP collector", () => {
  it("arrive for a model call, a cell call and a judge reading, each with its own times", () => {
    const model = spansNamed(/^chat /)
    const cell = spansNamed("execute_tool bash")
    const judge = spansNamed(/^Classifier\.evaluate\(/)

    expect(model).toHaveLength(2)
    expect(model[0]!.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-6.1-sol",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 7
    })
    expect(cell).toHaveLength(1)
    expect(cell[0]!.attributes).toMatchObject({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "bash" })
    expect(judge.length).toBeGreaterThan(0)
    for (const span of [...model, ...cell, ...judge]) {
      expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano))
    }
  })

  it("carry each sign-in on its Auth.sign span", () => {
    const signed = spansNamed("Auth.sign").map((span) => mirrored(Telemetry.signInEvent, span))

    expect(signed).toEqual(records(Telemetry.signInEvent, Telemetry.SignIn).map(measured))
  })

  it("carry each container process on a Command.exec span", () => {
    const executed = spansNamed("Command.exec").map((span) => mirrored(Telemetry.commandEvent, span))

    expect(executed).toEqual(records(Telemetry.commandEvent, Telemetry.Command).map(measured))
  })

  it("carry the start-up on the span of the first model request", () => {
    const [startUp] = records(Telemetry.startUpEvent, Telemetry.StartUp)
    const carrying = observed.spans.filter((span) => `${Telemetry.startUpEvent}.totalMs` in span.attributes)

    expect(carrying.map((span) => span.name)).toEqual(["flows/model/Route.stream"])
    expect(mirrored(Telemetry.startUpEvent, carrying[0]!)).toEqual({
      processStartedAtMs: startUp!.processStartedAtMs,
      totalMs: startUp!.totalMs,
      ...Object.fromEntries(startUp!.stages.map((stage) => [`stage.${stage.stage}`, stage.ms]))
    })
  })

  it("hold no token, account id or refresh token anywhere", () => {
    expect(observed.spans.length).toBeGreaterThan(0)
    for (const secret of secrets) expect(observed.exported).not.toContain(secret)
  })
})
