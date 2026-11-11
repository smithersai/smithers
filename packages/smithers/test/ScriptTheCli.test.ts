import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import { childEnvironment, spawnNodeSync } from "./support/node-child.ts"

const guide = readFileSync(new URL("../docs/guides/script-the-cli.md", import.meta.url), "utf8")
const fences = (text: string) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]!)
const park = fences(guide).find((source) => source.includes("= \"Parked\""))!
const node = fences(guide).find((source) => source.includes("control.approval.requested"))!
const envelope = { budget: {}, capabilities: [], flows: [] }

describe("scripted approval examples", () => {
  it("launches a parked plan after granting the same payload and idempotency key", () => {
    const approval = {
      target: { _tag: "Plan", planId: "plan-1", digest: "digest", envelope },
      scope: "run",
      idempotencyKey: "launch-1"
    }
    const output = execFileSync("bash", [
      "-eu",
      "-c",
      `
granted=0
smthrs() {
  case "$1 $2" in
    "flow execute")
      [ "$3" = "$approval" ] || return 2
      if [ "$granted" = 1 ]; then
        printf '%s\\n' '{"_tag":"Accepted","receiptId":"launch-1","runId":"run-1"}'
      else
        printf '%s\\n' '{"_tag":"Parked","receiptId":"launch-1","planId":"plan-1","status":"waiting-approval"}'
        return 3
      fi ;;
    "approvals approve")
      [ "$3" = "$approval" ] && [ "$4 $5" = "--scope run" ] || return 2
      granted=1
      printf '%s\\n' '{"_tag":"Accepted","receiptId":"launch-1"}' ;;
    *) return 2 ;;
  esac
}
${park}
printf '%s\\n' "$receipt"
`
    ], { encoding: "utf8", timeout: 5_000, env: { ...process.env, approval: JSON.stringify(approval) } })

    expect(output.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { _tag: "Accepted", receiptId: "launch-1" },
      { _tag: "Accepted", receiptId: "launch-1", runId: "run-1" }
    ])
  })

  it("approves the current ask beyond the CI log page through the real CLI and store", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-script-approval-"))
    try {
      const engine = NodeControl.engineDurable(root)
      const run = <A, E>(effect: Effect.Effect<A, E, ControlRuntime.ControlRuntime | Journal.Journal>) =>
        Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(engine.runtime, engine.journal)), Effect.scoped))
      const { runId, approval, older } = await run(Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        const journal = yield* Journal.Journal
        const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
        yield* runtime.resolveApproval(
          yield* runtime.lookupApproval(card.approval.target),
          "approved",
          yield* runtime.stampPrincipal()
        )
        const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
        if (launched._tag !== "Started") throw new Error("expected launch")
        const runId = launched.run.runId
        const approval = {
          target: { _tag: "Node" as const, runId, requestId: "ask-2", digest: "digest", envelope },
          scope: "once" as const,
          idempotencyKey: "answer-2"
        }
        const older = {
          ...approval,
          target: { ...approval.target, requestId: "ask-1" },
          idempotencyKey: "answer-1"
        }
        const emit = (eventType: string, payload: unknown) =>
          journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: JournalEvent.RunId.make(runId),
              sourceId: JournalEvent.SourceId.make("script-approval"),
              eventType,
              payload
            })
          )
        yield* runtime.registerApproval(older.target)
        yield* runtime.registerApproval(approval.target)
        yield* emit("control.approval.requested", { question: "Earlier?", payload: older })
        for (let index = 0; index < 105; index++) yield* emit("control.run.progress", { index })
        yield* emit("control.approval.requested", { question: "Continue?", payload: approval })
        yield* emit("control.run.waiting-approval", {})
        yield* runtime.writeStatus(runId, yield* runtime.claimFence(runId), "waiting-approval")
        return { runId, approval, older }
      }))
      const cli = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
      const environment = childEnvironment({
        ...process.env,
        CI: "1",
        SMITHERS_REMOTE: "",
        SMITHERS_BACKEND: "sqlite",
        XDG_CONFIG_HOME: join(root, "config"),
        receipt: JSON.stringify({ _tag: "Accepted", runId }),
        SMITHERS_TEST_NODE: process.execPath,
        SMITHERS_TEST_CLI: cli,
        SMITHERS_TEST_ROOT: root
      })
      const page = spawnNodeSync([cli, "runs", "logs", runId, "--root", root, "--format", "jsonl"], {
        env: environment,
        encoding: "utf8",
        timeout: 120_000
      })
      expect(page.status, page.stdout + page.stderr).toBe(0)
      const events = page.stdout.trim().split("\n").map((line) => JSON.parse(line))
        .filter((event: { type: string }) => event.type === "chunk")
        .map((event) => event.data)
      expect(events, page.stdout).toHaveLength(100)
      expect(
        events.filter((event: { kind: string }) => event.kind === "control.approval.requested")
          .map((event: { payload: { payload: unknown } }) => event.payload.payload)
      ).toEqual([older])
      const output = execFileSync("bash", [
        "-euo",
        "pipefail",
        "-c",
        `
smthrs() {
  "$SMITHERS_TEST_NODE" "$SMITHERS_TEST_CLI" --root "$SMITHERS_TEST_ROOT" "$@"
}
${node}
`
      ], { encoding: "utf8", timeout: 120_000, env: environment })
      expect(JSON.parse(output)).toMatchObject({ _tag: "Accepted", receiptId: approval.idempotencyKey, runId })
      const decisions = await run(Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        return [
          (yield* runtime.registerApproval(older.target))._tag,
          (yield* runtime.registerApproval(approval.target))._tag
        ]
      }))
      expect(decisions).toEqual(["Pending", "Approved"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
