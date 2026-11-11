import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/process/ChildProcessSpawner"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll } from "vitest"
import * as CommandSandbox from "../src/CommandSandbox/index.ts"
import { userPidDirectory } from "../src/internal/pidDirectory.ts"
import { sessionSlug } from "../src/internal/sessionSlug.ts"
import { platform } from "./helpers/containedPlatform.ts"

const pidDirectory = userPidDirectory(String(process.getuid!()))

const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-heartbeat-local-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("CommandSandbox local heartbeat", () => {
  for (const [name, services] of [["NodeServices", NodeServices.layer], ["contained platform", platform]] as const) {
    it.effect(
      `keeps a real local command alive through repeated boot probes with ${name}`,
      () =>
        Effect.gen(function*() {
          const local = yield* ChildProcessSpawner
          let launches = 0
          // Count transports while retaining the real process, stdin, and supervision.
          const spawner = makeSpawner((command) => {
            launches++
            return local.spawn(command)
          })
          // A beat must answer within twice the heartbeat. Real spawns on a
          // loaded host take hundreds of milliseconds, so the interval leaves
          // that deadline seconds wide; 20 s still spans several beats.
          const session = yield* CommandSandbox.make({
            spawner,
            prefix: [],
            heartbeat: "2 seconds",
            workdir: root
          }).acquire(`${basename(root)}-${name}`)
          const child = yield* session.spawn("printf 'ready|'; sleep 20; printf done", {})
          const before = launches
          expect(yield* child.exitCode).toBe(0)
          expect(yield* Stream.mkString(Stream.decodeText(child.stdout))).toBe("ready|done")
          // No file/ping operations run in this interval: these are heartbeat probes.
          expect(launches - before).toBeGreaterThanOrEqual(3)
        }).pipe(Effect.scoped, Effect.provide(services)),
      45_000
    )
  }

  it.effect(
    "does not treat completed probes with slow scope cleanup as a silent machine",
    () =>
      Effect.gen(function*() {
        const local = yield* ChildProcessSpawner
        let launches = 0
        const id = `${basename(root)}-slow-cleanup`
        const record = join(pidDirectory, sessionSlug(id), "0.pid")
        let startingGuest = false
        // Delay scope cleanup only: probe execution and all process supervision
        // remain real. This reproduces cleanup exceeding the response deadline.
        const spawner = makeSpawner((command) => {
          launches++
          const awaitRecord = startingGuest
          startingGuest = false
          return local.spawn(command).pipe(
            // Isolate cleanup from startup: the real shell must finish its boot
            // and pid records before this adapter returns the guest handle.
            Effect.tap(() =>
              awaitRecord
                ? Effect.promise(async () => {
                  const deadline = Date.now() + 5000
                  while (
                    !existsSync(`${record}.boot`) || !existsSync(record) || readFileSync(record, "utf8").trim() === ""
                  ) {
                    if (Date.now() >= deadline) {
                      throw new Error(`guest did not write its boot and pid records: ${record}`)
                    }
                    await new Promise((resolve) => setTimeout(resolve, 10))
                  }
                })
                : Effect.void
            ),
            Effect.tap(() =>
              Effect.addFinalizer(() => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 1500))))
            )
          )
        })
        const session = yield* CommandSandbox.make({
          spawner,
          prefix: [],
          // Cleanup (1.5 s) outlasts the response deadline (twice this, 1 s),
          // which still leaves real spawns on a loaded host room to answer.
          heartbeat: "500 millis",
          workdir: root
        }).acquire(id)
        startingGuest = true
        const child = yield* session.spawn("printf 'ready|'; sleep 8; printf done", {})
        const before = launches
        expect(yield* child.exitCode).toBe(0)
        expect(yield* Stream.mkString(Stream.decodeText(child.stdout))).toBe("ready|done")
        expect(launches - before).toBeGreaterThanOrEqual(2)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
  )

  it.effect(
    "keeps a command whose startup has not yet written its boot record running on an unchanged boot",
    () =>
      Effect.gen(function*() {
        const local = yield* ChildProcessSpawner
        let launches = 0
        let startingGuest = false
        // Delay only the guest's stdin, so the bootstrap cannot read its framed
        // script and write the boot record before several beats reach the
        // live, unchanged machine. Probes and supervision stay real.
        const spawner = makeSpawner((command) => {
          launches++
          const delayed = startingGuest
          startingGuest = false
          if (!delayed || command._tag !== "StandardCommand" || !Stream.isStream(command.options.stdin)) {
            return local.spawn(command)
          }
          const stdin = Stream.concat(
            Stream.fromEffectDrain(
              Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2500)))
            ),
            command.options.stdin
          )
          return local.spawn(ChildProcess.make(command.command, command.args, { ...command.options, stdin }))
        })
        const session = yield* CommandSandbox.make({
          spawner,
          prefix: [],
          // The delayed script (2.5 s) spans several beats; the 1 s response
          // deadline leaves real spawns on a loaded host room to answer.
          heartbeat: "500 millis",
          workdir: root
        }).acquire(`${basename(root)}-delayed-startup`)
        startingGuest = true
        const input = new Uint8Array([0, 255, 10, 105, 110, 10])
        const child = yield* session.spawn("od -An -tu1 | tr -s ' \\n' ' '; printf 'ready|'; sleep 10; printf done", {
          stdin: input
        })
        const before = launches
        expect(yield* child.exitCode).toBe(0)
        // The original input bytes arrive intact behind the delayed script frame.
        expect(yield* Stream.mkString(Stream.decodeText(child.stdout))).toBe(" 0 255 10 105 110 10 ready|done")
        // Beats ran while startup was still pending and after it recorded its boot.
        expect(launches - before).toBeGreaterThanOrEqual(10)
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000
  )

  // A platform timer holds at most 2^31 - 1 milliseconds and fires after 1 ms
  // for anything longer, so an interval past ~24.8 days, or infinity, used to
  // probe in a tight loop and end every command as a silent machine.
  for (const heartbeat of [Duration.infinity, Duration.days(30)]) {
    it.effect(
      `never probes within a heartbeat of ${Duration.format(heartbeat)}`,
      () =>
        Effect.gen(function*() {
          const local = yield* ChildProcessSpawner
          let launches = 0
          const spawner = makeSpawner((command) => {
            launches++
            return local.spawn(command)
          })
          const session = yield* CommandSandbox.make({ spawner, prefix: [], heartbeat, workdir: root })
            .acquire(`${basename(root)}-long-${Duration.toMillis(heartbeat)}`)
          const before = launches
          const child = yield* session.spawn("sleep 1; printf done", {})
          expect(yield* child.exitCode).toBe(0)
          expect(yield* Stream.mkString(Stream.decodeText(child.stdout))).toBe("done")
          // The one launch is the command itself.
          expect(launches - before).toBe(1)
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      15_000
    )
  }
})
