/**
 * A scripted run on the shipped native host, sealed to a real container, that
 * edits the container's files with the file flows.
 *
 * The task's repository lives only in the container, as it does on a
 * benchmark host, and the container runs as an ordinary user. The model is
 * the one external input: an Undici transport answers each frame with a
 * scripted cell. The cells search, read, edit and patch through `grep`,
 * `read`, `edit` and `apply_patch`, then try to write a truncated read back,
 * which the call boundary refuses exactly as it does on a host. Everything is
 * read back from the container itself.
 */
import { NodeHttpClient } from "@effect/platform-node"
import { MockAgent } from "@effect/platform-node/Undici"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Application from "../src/Application.vibe"
import * as NodeControl from "../src/NodeControl.ts"

const engineAvailable = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }).status === 0
const missingEngine = engineAvailable ? undefined : "no container engine answers `docker info` on this host"
const container = `smithers-sealed-files-${process.pid}`
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "smithers-sealed-files-")))

afterAll(() => {
  if (engineAvailable) spawnSync("docker", ["rm", "--force", container], { stdio: "ignore" })
  rmSync(scratch, { recursive: true, force: true })
})

/** A shell line in the container as root, for setup and for reading what the run left. */
const inside = (script: string): string =>
  execFileSync("docker", ["exec", "-u", "0", container, "sh", "-c", script], { encoding: "utf8" })

const sse = (text: string): string =>
  [
    { type: "response.output_text.delta", item_id: "msg_1", delta: text },
    { type: "response.output_text.done", item_id: "msg_1" },
    {
      type: "response.completed",
      response: { id: "resp_sealed", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } }
    }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

const cell = (lines: ReadonlyArray<string>): string => `\`\`\`cell\n${lines.join("\n")}\n\`\`\``

/** What the scripted seat answers each frame with. */
const frames = [
  cell([
    "const hits = await ctx.call(\"grep\", { pattern: \"needle\" })",
    "const page = await ctx.call(\"read\", { path: \"src/mod.py\" })",
    "const edited = await ctx.call(\"edit\", { path: \"src/mod.py\", oldString: \"naïve\", newString: \"café\" })",
    "const patched = await ctx.call(\"apply_patch\", {",
    "  input: \"*** Begin Patch\\n*** Add File: src/added.py\\n+value = \\\"ü\\\"\\n*** End Patch\"",
    "})",
    "console.log(JSON.stringify({",
    "  hits: hits.matches.map((match) => `${match.file}:${match.line}`),",
    "  content: page.content,",
    "  hunk: edited.hunk,",
    "  added: patched.added",
    "}))"
  ]),
  cell([
    "const big = await ctx.call(\"read\", { path: \"big.txt\" })",
    "const attempt = await ctx.call(\"edit\", { path: \"src/mod.py\", startLine: 1, endLine: 1, newString: big.content })",
    "console.log(JSON.stringify({ truncated: big.truncated, attempt }))"
  ]),
  cell(["ctx.done(\"edited\")"])
]

const flow = [
  "---",
  "name: fix",
  "description: Edits a repository that lives in a container.",
  "model: openai:gpt-4o-mini",
  "flows: [\"bash\", \"apply_patch\", \"edit\", \"read\", \"grep\"]",
  "---",
  "",
  "Fix the repository.",
  ""
].join("\n")

describe.skipIf(engineAvailable)("a sealed host's file flows against a real container", () => {
  it(`is skipped because ${missingEngine ?? "this host runs a container engine"}`, () => {
    expect(missingEngine).toEqual(expect.any(String))
  })
})

describe.skipIf(!engineAvailable)("a sealed host's file flows against a real container", () => {
  it(
    "searches, reads, edits and patches the container's files as its user, and refuses a truncated write",
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
      inside(
        [
          "mkdir -p /app/src",
          "printf 'def needle():\\n    return \"naïve 日本語\"\\n' > /app/src/mod.py",
          "i=0; while [ $i -lt 2500 ]; do echo \"line $i of a long file\"; i=$((i+1)); done > /app/big.txt",
          "chown -R 1000:1000 /app"
        ].join(" && ")
      )
      const root = join(scratch, "workspace")
      mkdirSync(join(root, ".smithers", "flows", "fix"), { recursive: true })
      writeFileSync(join(root, ".smithers", "flows", "fix", "flow.mdx"), flow)

      const agent = new MockAgent()
      agent.disableNetConnect()
      let sent = 0
      agent.get("https://api.openai.com").intercept({ method: "POST", path: "/v1/responses" }).reply(
        200,
        () => sse(frames[Math.min(sent++, frames.length - 1)]!),
        { headers: { "content-type": "text/event-stream" } }
      ).persist()
      const client = await Effect.runPromise(
        NodeHttpClient.makeUndici.pipe(Effect.provideService(NodeHttpClient.Dispatcher, agent))
      )
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const runs = NodeControl.layerExecutor(registry, engine, root, {
        evaluator: ScriptedJudge.layerAll,
        environment: {
          OPENAI_API_KEY: "test-key",
          SMITHERS_BASH_CONTAINER: container,
          SMITHERS_TEST_CWD: "/app",
          SMITHERS_ASKS: "refuse"
        },
        grants: GrantStore.layerNoop,
        requestExecutor: Layer.effect(RequestExecutor.RequestExecutor)(
          RequestExecutor.make.pipe(Effect.provideService(HttpClient.HttpClient, client))
        )
      })
      const layer = Application.layer({ root }, registry, engine, runs) as Layer.Layer<Control.Control>
      // The agent's own settlement is what this case reads; the run's terminal
      // status follows it and is not what is under test.
      const settled = new Set([
        "control.agent.resolved",
        "control.run.completed",
        "control.run.failed",
        "control.run.cancelled"
      ])
      const events = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const card = yield* control.plan({ flowId: "fix", input: {} })
          yield* control.approve(card.approval)
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: "sealed-files"
          })
          if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("not accepted")
          return yield* control.watch({ runId: receipt.runId, follow: true }).pipe(
            Stream.takeUntil((event) => settled.has(event.kind)),
            Stream.runCollect,
            Effect.map((collected) => Array.from(collected))
          )
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie)
      )
      await agent.close()

      const journaled = JSON.stringify(events)
      expect(events.at(-1)?.kind, journaled.slice(-4000)).toBe("control.agent.resolved")
      const printed = events
        .filter((event) => event.kind === "control.agent.cell-printed")
        .map((event) => JSON.stringify(event.payload))
      expect(printed.join("\n")).toContain(
        JSON.stringify(JSON.stringify({
          hits: ["src/mod.py:1"],
          content: "def needle():\n    return \"naïve 日本語\"",
          hunk: "def needle():\n    return \"café 日本語\"",
          added: ["src/added.py"]
        })).slice(1, -1)
      )
      // The page came back cut, and writing it over a file was refused before the edit ran.
      const refused = printed.find((text) => text.includes("truncated_write"))
      expect(refused).toContain("\\\"truncated\\\":true")
      expect(refused).toContain("byte-identical to output this run already returned truncated")
      // The container's files changed, as the container's user, and nothing landed here.
      expect(inside("cat /app/src/mod.py")).toBe("def needle():\n    return \"café 日本語\"\n")
      expect(inside("cat /app/src/added.py")).toBe("value = \"ü\"\n")
      expect(inside("stat -c '%u:%g' /app/src/mod.py /app/src/added.py")).toBe("1000:1000\n1000:1000\n")
      expect(existsSync(join(root, "src"))).toBe(false)
    },
    180_000
  )
})
