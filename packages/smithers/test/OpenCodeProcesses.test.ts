import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Effect, Exit, Fiber, Scope } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as OpenCode from "../src/commands/OpenCode.ts"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

it("closes the server's shell scope within two seconds when a child ignores SIGTERM", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-opencode-process-"))
  const ready = join(root, "ready")
  const program = `
    process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid));
    setInterval(() => {}, 1000);
  `
  try {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const owned = yield* Scope.make()
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const child = yield* spawner.spawn(ChildProcess.make(process.execPath, ["-e", program])).pipe(
          Effect.provideService(Scope.Scope, owned)
        )
        const pid = Number(child.pid)
        // The regression is bounded even on the broken implementation. Only
        // the exact pid this case spawned is signalled during cleanup.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(pid, "SIGKILL")
            } catch {
              // The successful case already stopped it.
            }
          }).pipe(Effect.andThen(Scope.close(owned, Exit.void)))
        )
        yield* Effect.promise(async () => {
          for (let attempt = 0; attempt < 500 && !existsSync(ready); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          expect(existsSync(ready)).toBe(true)
        })
        const began = Date.now()
        const closing = yield* Effect.forkDetach(Scope.close(owned, Exit.void))
        const stopped = yield* Effect.raceFirst(
          Effect.as(Fiber.join(closing), true),
          Effect.as(Effect.sleep("1800 millis"), false)
        )
        return { stopped, alive: alive(pid), elapsed: Date.now() - began }
      }).pipe(Effect.provide(OpenCode.nodeHost(root, {}).platform), Effect.scoped)
    )
    expect(result.stopped).toBe(true)
    expect(result.alive).toBe(false)
    expect(result.elapsed).toBeLessThan(2000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
