import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as NodeControlHost from "../src/internal/NodeControlHost.ts"

const events = ["end", "data", "error", "close", "keypress"] as const
const listeners = () => events.map((event) => process.stdin.rawListeners(event))

// #3702: the aggregate `NodeServices.layer` acquires `NodeTerminal`, which holds a
// process-wide stdin `end` listener for as long as its scope is open. A renderer
// that owns stdin and opens these layers per read accumulated one listener per
// concurrent open until Node printed `MaxListenersExceededWarning` over the screen.
const subjects: ReadonlyArray<readonly [string, (file: string) => Layer.Layer<never, unknown>]> = [
  ["host", () => NodeControlHost.platform.host as unknown as Layer.Layer<never, unknown>],
  ["database", (file) => NodeControlHost.platform.database(file) as unknown as Layer.Layer<never, unknown>]
]

for (const [name, build] of subjects) {
  it(`the Node control ${name} layer leaves process stdin to its owner (#3702)`, async () => {
    const root = mkdtempSync(join(tmpdir(), "control-stdin-"))
    const unrelated = () => {}
    for (const event of events) process.stdin.on(event, unrelated)
    const baseline = listeners()
    try {
      const inside: Array<ReturnType<typeof listeners>> = []
      await Effect.runPromise(
        Effect.scoped(Effect.flatMap(
          Layer.build(build(join(root, "control.db"))),
          () => Effect.sync(() => inside.push(listeners()))
        ))
      )
      expect(inside).toHaveLength(1)
      expect(inside[0]).toEqual(baseline)
      expect(listeners()).toEqual(baseline)
    } finally {
      for (const event of events) process.stdin.off(event, unrelated)
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
}
