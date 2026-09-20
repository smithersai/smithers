/**
 * The local CLI's durable engine.
 *
 * The composition used to be `ControlRuntime.layerMemory()` over an in-memory
 * `TestJournal`, so nothing a local command did survived the process. These
 * cases run the real Node engine against a real SQLite file and then open a
 * second, independent engine over the same directory — which is what "the CLI
 * is no longer a demo" actually has to mean.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { PlanCard } from "@smthrs/control/ControlSchema"
import { Registry } from "@smthrs/registry"
import { Effect, Layer } from "effect"
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

let root = ""
let launched: { readonly card: PlanCard } | undefined

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flows-cli-engine-"))
})

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true })
})

/** Opens a fresh engine over `root` — one process's worth of lifetime. */
const withEngine = <A, E>(
  use: (control: Control.Service) => Effect.Effect<A, E, Control.Control>
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      return yield* use(control)
    }).pipe(
      Effect.provide(
        // The local branch has no external requirements; the declared return
        // type of `Application.layer` also covers the remote RPC branch.
        Application.layer({}, Registry.layerNoop(), NodeControl.engineDurable(root)) as Layer.Layer<Control.Control>
      ),
      Effect.scoped,
      Effect.orDie
    )
  )

describe("NodeControl.engineDurable", () => {
  it.skipIf(process.platform === "win32")(
    "restricts the execution database as well as the control database",
    async () => {
      const isolated = await mkdtemp(join(tmpdir(), "flows-cli-execution-permissions-"))
      try {
        const modes = await Effect.runPromise(
          Effect.gen(function*() {
            yield* Control.Control
            const databases = [NodeControl.databasePath(isolated), NodeControl.executionDatabasePath(isolated)]
            return databases.flatMap((file) => [file, `${file}-wal`, `${file}-shm`])
              .filter(existsSync).map((file) => [file, statSync(file).mode & 0o777] as const)
          }).pipe(Effect.provide(NodeControl.layer({ root: isolated, evaluator: ScriptedJudge.layer })), Effect.scoped)
        )
        expect(modes.map(([file]) => file)).toContain(NodeControl.executionDatabasePath(isolated))
        for (const [file, mode] of modes) expect([file, mode]).toEqual([file, 0o600])
      } finally {
        await rm(isolated, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === "win32").each([false, true])(
    "restricts new and existing state (existing: %s)",
    async (existing) => {
      const isolated = await mkdtemp(join(tmpdir(), "flows-cli-permissions-"))
      const state = join(isolated, ".flows")
      const database = NodeControl.databasePath(isolated)
      try {
        if (existing) {
          mkdirSync(state, { recursive: true })
          writeFileSync(database, "")
          chmodSync(state, 0o755)
          chmodSync(database, 0o644)
        }

        const modes = await Effect.runPromise(
          Effect.gen(function*() {
            const runtime = yield* ControlRuntime
            yield* runtime.plan({ flowId: "system/test", input: { permissions: true } })
            const files = [database, `${database}-wal`, `${database}-shm`].filter(existsSync)
            return {
              directory: statSync(state).mode & 0o777,
              files: files.map((file) => [file, statSync(file).mode & 0o777] as const)
            }
          }).pipe(Effect.provide(NodeControl.engineDurable(isolated).runtime), Effect.scoped, Effect.orDie)
        )

        expect(modes.directory).toBe(0o700)
        expect(modes.files.map(([file]) => file)).toEqual([database, `${database}-wal`, `${database}-shm`])
        for (const [file, mode] of modes.files) expect([file, mode]).toEqual([file, 0o600])
      } finally {
        await rm(isolated, { recursive: true, force: true })
      }
    }
  )

  it("stamps launch fences with the real process identity", async () => {
    const isolated = await mkdtemp(join(tmpdir(), "flows-cli-owner-"))
    try {
      const run = await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const { card } = yield* runtime.plan({ flowId: "system/test", input: { owner: true } })
          const token = yield* runtime.lookupApproval(card.approval.target)
          expect(
            (yield* Effect.flip(
              runtime.resolveApproval(token, "approved", { id: "test", kind: "test", stampedAt: 0 })
            ))._tag
          ).toBe("/control/Unauthorized")
          expect((yield* runtime.getPlan(card.planId)).decision).toBe("pending")
          yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
          const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
          if (launched._tag !== "Started") return yield* Effect.die("expected a started run")
          return launched.run
        }).pipe(Effect.provide(NodeControl.engineDurable(isolated).runtime), Effect.scoped, Effect.orDie)
      )
      const owner = JSON.parse(run.ownerId ?? "null") as {
        readonly hostId?: unknown
        readonly pid?: unknown
        readonly nonce?: unknown
      } | null

      expect(owner).toMatchObject({ hostId: hostname(), pid: process.pid, nonce: expect.any(String) })
      expect(process.pid).toBeGreaterThan(0)
    } finally {
      await rm(isolated, { recursive: true, force: true })
    }
  })

  it("keeps a plan, its approval, and its run across two independent engines", async () => {
    const first = await withEngine((control) =>
      Effect.gen(function*() {
        const card = yield* control.plan({ flowId: "system/test", input: { cli: true } })
        yield* control.approve({
          target: card.approval.target,
          scope: card.approval.scope,
          idempotencyKey: card.approval.idempotencyKey
        })
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "run:cli"
        })
        return { card, receipt }
      })
    )

    launched = { card: first.card }
    expect(first.receipt._tag).toBe("Accepted")
    expect(existsSync(NodeControl.databasePath(root))).toBe(true)

    // Nothing is carried across but the directory on disk.
    const second = await withEngine((control) => control.list({ _tag: "runs" }))

    expect(second).toMatchObject({
      _tag: "runs",
      items: [{ planId: first.card.planId, planDigest: first.card.digest, status: "accepted" }]
    })
  })

  it("replays a recorded mutation instead of launching a second run", async () => {
    const card = launched!.card
    const replay = await withEngine((control) =>
      control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "run:cli"
      })
    )
    const conflict = await withEngine((control) =>
      control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: "a different digest",
        envelope: card.envelope,
        idempotencyKey: "run:cli"
      })
    )
    const runs = await withEngine((control) => control.list({ _tag: "runs" }))

    // The mutation record outlived the engine that wrote it, so an identical
    // replay short-circuits and the same key under different arguments is a
    // conflict rather than a second run.
    expect(replay._tag).toBe("AlreadyApplied")
    expect(conflict._tag).toBe("Conflict")
    expect(runs).toMatchObject({ _tag: "runs", items: [{ status: "accepted" }] })
  })

  it("puts the database under the project root", () => {
    expect(NodeControl.databasePath("/tmp/project")).toBe(join("/tmp/project", ".flows", "control.db"))
  })
})
