/**
 * A markdown flow on the shipped native host that hands a sub-task to a second
 * markdown flow with `ctx.call`, on a host sealed to one container.
 *
 * The model is the one external input: a request executor answers each frame
 * with a scripted cell, choosing the caller's script or the child's by the
 * task the request carries. The first case's `docker` is a stub that records
 * every command it is asked to run, so it runs on any host; the second runs
 * against a real container and is skipped where no container engine answers.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Stream } from "effect"
import type * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "smithers-markdown-child-")))
const hostPath = process.env.PATH

afterEach(() => {
  process.env.PATH = hostPath
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
})

const usage = { input_tokens: 10, output_tokens: 7, total_tokens: 17 }

const sse = (text: string): string =>
  [
    { type: "response.output_text.delta", item_id: "msg_1", delta: text },
    { type: "response.output_text.done", item_id: "msg_1" },
    { type: "response.completed", response: { id: "resp_child", usage } }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

const cell = (lines: ReadonlyArray<string>): string => `\`\`\`cell\n${lines.join("\n")}\n\`\`\``

/** The text only the child's task carries, which tells its requests from the caller's. */
const workerBody = "WORKER-BODY: do what the arguments ask, then answer with ctx.done."

const flows = {
  lead: [
    "---",
    "name: lead",
    "description: Hands the task's sub-task to a worker.",
    "model: openai:gpt-4o-mini",
    "effort: low",
    "---",
    "",
    "Delegate the sub-task to the worker.",
    ""
  ].join("\n"),
  // No `model:`: the child runs on the caller's seat.
  worker: ["---", "name: worker", "description: Does one sub-task it is handed.", "---", "", workerBody, ""].join(
    "\n"
  )
}

/** The caller's one frame: hand the sub-task over, then finish on the child's answer. */
const leadFrames = [
  cell([
    "const answer = await ctx.call(\"worker\", { args: \"do the sub-task\" })",
    "ctx.done(\"lead got \" + (typeof answer === \"string\" ? answer : JSON.stringify(answer)))"
  ])
]

interface Observed {
  readonly events: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>
  readonly bodies: { readonly lead: ReadonlyArray<string>; readonly worker: ReadonlyArray<string> }
}

/** Runs `lead` on the shipped native host, to its terminal status. */
const run = async (
  root: string,
  environment: Readonly<Record<string, string>>,
  workerFrames: ReadonlyArray<string>
): Promise<Observed> => {
  for (const [name, text] of Object.entries(flows)) {
    mkdirSync(join(root, ".smithers", "flows", name), { recursive: true })
    writeFileSync(join(root, ".smithers", "flows", name, "flow.mdx"), text)
  }
  const bodies = { lead: [] as Array<string>, worker: [] as Array<string> }
  const executor = RequestExecutor.RequestExecutor.of({
    execute: (request: HttpClientRequest.HttpClientRequest) =>
      Effect.sync(() => {
        const body = request.body._tag === "Uint8Array"
          ? request.body.text ?? new TextDecoder().decode(request.body.body)
          : ""
        const asked = body.includes(workerBody) ? bodies.worker : bodies.lead
        const frames = body.includes(workerBody) ? workerFrames : leadFrames
        const text = frames[Math.min(asked.length, frames.length - 1)]!
        asked.push(body)
        return HttpClientResponse.fromWeb(
          request,
          new Response(sse(text), { status: 200, headers: { "content-type": "text/event-stream" } })
        )
      })
  })
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const runs = NodeControl.layerExecutor(registry, engine, root, {
    environment: { OPENAI_API_KEY: "test-key", SMITHERS_ASKS: "refuse", ...environment },
    evaluator: ScriptedJudge.layerAll,
    grants: GrantStore.layerNoop,
    requestExecutor: Layer.succeed(RequestExecutor.RequestExecutor)(executor)
  })
  const layer = Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>
  const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])
  const events = await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const card = yield* control.plan({ flowId: "lead", input: {} })
      yield* control.approve(card.approval)
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "markdown-child"
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("not accepted")
      return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
        Stream.takeUntil((event) => terminal.has(event.kind)),
        Stream.runCollect,
        Effect.map((collected) => Array.from(collected))
      )
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie)
  )
  return { events, bodies }
}

const ofKind = (observed: Observed, kind: string) => observed.events.filter((event) => event.kind === kind)

/** What every run here shows whatever the container: the child answered its caller, attributed and counted. */
const expectDelegated = (observed: Observed, answer: string) => {
  const journaled = JSON.stringify(observed.events)
  expect(observed.events.at(-1)?.kind, journaled.slice(-4000)).toBe("control.run.completed")
  // The child's answer is the value of the caller's call, and the caller finished on it.
  expect(JSON.stringify(ofKind(observed, "control.agent.transition-applied"))).toContain(`lead got ${answer}`)
  // One model request each: the caller's frame and the child's.
  expect(observed.bodies.lead).toHaveLength(1)
  expect(observed.bodies.worker).toHaveLength(1)
  // The caller is offered the worker and never itself; the child is offered no markdown flow.
  expect(observed.bodies.lead[0]).toContain("Does one sub-task it is handed.")
  expect(observed.bodies.lead[0]).not.toContain("Hands the task's sub-task to a worker.")
  expect(observed.bodies.worker[0]).not.toContain("Does one sub-task it is handed.")
  // Same seat, same effort: the child declares neither, so it runs on the caller's.
  for (const body of [...observed.bodies.lead, ...observed.bodies.worker]) {
    expect(JSON.parse(body)).toMatchObject({ model: "gpt-4o-mini", reasoning: { effort: "low" } })
  }
  // The child's frames are in the run's control journal, filed under the caller's call.
  const started = ofKind(observed, "control.agent.cell-call-started").filter((event) =>
    (event.payload as { readonly flowName: string }).flowName === "worker"
  )
  expect(started).toHaveLength(1)
  const { callId } = started[0]!.payload as { readonly callId: string }
  const child = observed.events.filter((event) => event.kind.startsWith("control.child."))
  expect(child.length).toBeGreaterThan(0)
  for (const event of child) expect(event.payload).toMatchObject({ child: { callId, flow: "worker" } })
  const settled = ofKind(observed, "control.child.model-settled")
  expect(settled).toHaveLength(1)
  expect(settled[0]!.payload).toMatchObject({ usage: { inputTokens: 10, outputTokens: 7 } })
  // The caller's own trail holds one frame and one model call.
  expect(ofKind(observed, "control.agent.turn-opened")).toHaveLength(1)
  expect(ofKind(observed, "control.agent.model-settled")).toHaveLength(1)
}

describe("a markdown child on a host sealed to a stub container", () => {
  it(
    "runs the child on the caller's seat, in the one container, and journals it under the call",
    async () => {
      const base = join(scratch, "stub")
      const root = join(base, "workspace")
      const bin = join(base, "bin")
      const record = join(base, "docker-calls")
      mkdirSync(root, { recursive: true })
      mkdirSync(bin, { recursive: true })
      // A `docker` that reaches no daemon: it records each call's argv outside
      // the workspace and answers every exec with one listing.
      writeFileSync(
        join(bin, "docker"),
        [
          `#!${process.execPath}`,
          `process.getBuiltinModule("node:fs").appendFileSync(${
            JSON.stringify(record)
          }, JSON.stringify(process.argv.slice(2)) + "\\n")`,
          "process.stdout.write(\"app.py\\n\")"
        ].join("\n"),
        { mode: 0o755 }
      )
      // A transport process is found on this process's own PATH.
      process.env.PATH = `${bin}:${hostPath}`

      const observed = await run(root, {
        PATH: `${bin}:/usr/bin:/bin`,
        SMITHERS_BASH_CONTAINER: "task",
        SMITHERS_TEST_CWD: "/app"
      }, [
        cell([
          // Names no container: on a sealed host it runs in the sealed one.
          "const listed = await ctx.call(\"bash\", { command: \"touch host-marker && ls\" })",
          "ctx.done(\"worker saw \" + listed.stdout.trim())"
        ])
      ])

      expectDelegated(observed, "worker saw app.py")
      const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Array<string>)
      // The child's command reached the container through the transport, as
      // data at the end of one `docker exec`, and every process the run
      // started names that container.
      const command = calls.find((argv) => argv.at(-1) === "touch host-marker && ls")
      expect(command?.slice(0, 5), JSON.stringify(calls)).toEqual(["exec", "-w", "/app", "--", "task"])
      expect(command?.slice(-3)).toEqual(["bash", "-lc", "touch host-marker && ls"])
      for (const argv of calls) expect(argv.slice(0, 5)).toEqual(["exec", "-w", "/app", "--", "task"])
      // Nothing ran on this host: the command would have left its marker here.
      expect(existsSync(join(root, "host-marker"))).toBe(false)
      const call = ofKind(observed, "control.child.cell-call-started")
      expect(call.map((event) => (event.payload as { readonly flowName: string }).flowName)).toEqual(["bash"])
    },
    180_000
  )
})

const engineAvailable = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0
const missingEngine = engineAvailable ? undefined : "no container engine answers `docker info` on this host"
const container = `smithers-markdown-child-${process.pid}`

describe.skipIf(engineAvailable)("a markdown child on a host sealed to a real container", () => {
  it(`is skipped because ${missingEngine ?? "this host runs a container engine"}`, () => {
    expect(missingEngine).toEqual(expect.any(String))
  })
})

describe.skipIf(!engineAvailable)("a markdown child on a host sealed to a real container", () => {
  afterAll(() => {
    spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" })
  })

  it(
    "writes and reads the container's files from the child, and nothing lands on this host",
    async () => {
      execFileSync("docker", [
        "run",
        "-d",
        "--name",
        container,
        "--network",
        "none",
        "--user",
        "1000:1000",
        "alpine:3.20",
        "sleep",
        "600"
      ])
      execFileSync("docker", ["exec", "-u", "0", container, "sh", "-c", "mkdir -p /app && chown -R 1000:1000 /app"])
      const root = join(scratch, "real", "workspace")
      mkdirSync(root, { recursive: true })

      const observed = await run(root, { SMITHERS_BASH_CONTAINER: container, SMITHERS_TEST_CWD: "/app" }, [
        cell([
          "await ctx.call(\"write\", { path: \"from-child.txt\", content: \"child was here\" })",
          "const page = await ctx.call(\"read\", { path: \"from-child.txt\" })",
          "ctx.done(page.content)"
        ])
      ])

      expectDelegated(observed, "child was here")
      expect(
        execFileSync("docker", ["exec", "-u", "0", container, "cat", "/app/from-child.txt"], { encoding: "utf8" })
      ).toBe("child was here")
      expect(existsSync(join(root, "from-child.txt"))).toBe(false)
    },
    180_000
  )
})
