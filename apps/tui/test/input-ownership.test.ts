import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as BunControl from "@smthrs/cli/BunControl"
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as Registry from "@smthrs/registry/Registry"
import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as Host from "../src/host.vibe"

const events = ["end", "data", "error", "close", "keypress"] as const
const listeners = () => events.map((event) => process.stdin.rawListeners(event))

for (const [name, control] of [["Node", NodeControl], ["Bun", BunControl]] as const) {
  for (const outcome of ["success", "error", "cancel"] as const) {
    test(`${name} registry scopes leave stdin to its owner on ${outcome}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "tui-input-owner-"))
      mkdirSync(join(root, ".smithers", "flows", "review"), { recursive: true })
      writeFileSync(
        join(root, ".smithers", "flows", "review", "flow.mdx"),
        "---\ndescription: Review\n---\nAnswer only.\n"
      )
      const unrelated = () => {}
      for (const event of events) process.stdin.on(event, unrelated)
      const baseline = listeners()
      try {
        // Hold sixteen separately scoped public registry acquisitions concurrently,
        // beyond EventEmitter's default warning limit, then repeat the lifecycle.
        for (let cycle = 0; cycle < 2; cycle++) {
          const ready = Array.from({ length: 16 }, () => Deferred.makeUnsafe<void>())
          const release = Deferred.makeUnsafe<void>()
          const fibers = ready.map((started) =>
            Effect.runFork(
              Effect.gen(function*() {
                const registry = yield* Registry.Registry
                const listed = yield* registry.list()
                expect(listed.map((flow) => flow.name)).toContain("review")
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
                if (outcome === "error") return yield* Effect.fail("scan failed")
              }).pipe(Effect.provide(control.layerRegistry(root)))
            )
          )
          try {
            await Effect.runPromise(Effect.all(ready.map(Deferred.await)))
            expect(listeners()).toEqual(baseline)
          } finally {
            if (outcome === "cancel") {
              await Effect.runPromise(Effect.all(fibers.map(Fiber.interrupt)))
            } else {
              await Effect.runPromise(Deferred.succeed(release, undefined))
            }
            const exits = await Effect.runPromise(Effect.all(fibers.map(Fiber.await)))
            expect(exits.every(outcome === "success" ? Exit.isSuccess : Exit.isFailure)).toBe(true)
          }
          expect(listeners()).toEqual(baseline)
        }
      } finally {
        for (const event of events) process.stdin.off(event, unrelated)
        rmSync(root, { recursive: true, force: true })
      }
    }, 20_000)
  }
}

for (const outcome of ["success", "error", "cancel"] as const) {
  test(`agent host leaves stdin owned across repeated ${outcome} and disposal`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tui-host-input-"))
    const replay = join(root, "reply.jsonl")
    writeFileSync(
      replay,
      [
        { _tag: "model-requested" },
        { _tag: "model-delta", delta: { type: "text-start", id: "cell" } },
        { _tag: "model-delta", delta: { type: "text-delta", id: "cell", text: "```cell\nctx.done('ok')\n```" } },
        { _tag: "model-delta", delta: { type: "text-end", id: "cell" } },
        { _tag: "model-settled", message: { stopReason: "stop" } }
      ].map((event) => JSON.stringify({ at: 0, event })).join("\n")
    )
    const unrelated = () => {}
    for (const event of events) process.stdin.on(event, unrelated)
    const baseline = listeners()
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const host = Host.make({
          cwd: root,
          environment: {},
          available: { models: [], defaultSeat: undefined, workerSeat: undefined, environment: {} },
          judge: ScriptedJudge.layerAll,
          seats: Layer.succeed(SeatResolver.SeatResolver)({ resolve: () => Effect.die("Unexpected live seat") })
        })
        try {
          const running = host.run({
            prompt: "answer",
            role: "coordinator",
            seat: `replay:${outcome === "error" ? join(root, "missing.jsonl") : replay}`,
            history: [],
            onEvent: (event) => {
              expect(listeners()).toEqual(baseline)
              if (outcome === "cancel" && event._tag === "model-requested") running.cancel()
            }
          })
          expect((await running.done)._tag).toBe(
            outcome === "success" ? "done" : outcome === "error" ? "failed" : "cancelled"
          )
          expect(listeners()).toEqual(baseline)
        } finally {
          await host.dispose()
        }
        expect(listeners()).toEqual(baseline)
      }
    } finally {
      for (const event of events) process.stdin.off(event, unrelated)
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
}
