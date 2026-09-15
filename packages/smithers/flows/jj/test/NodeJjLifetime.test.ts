/**
 * What a cancelled `jj` invocation leaves on the machine.
 *
 * `NodeJj.layer` is the one layer in this package that starts a process
 * without a host spawner, which is exactly the shape a containment audit has
 * to account for: a child outside the spawner is outside the host's kill
 * policy and outside its `ProcessLedger`. The layer is still the right default
 * for a program that has no spawner to offer, so what has to be true of it is
 * narrower and provable: a cancelled invocation leaves no `jj` behind.
 *
 * `jj` is short-lived and starts no long-lived children of its own, which is
 * why signalling the process the layer holds is enough here: every command
 * this layer runs writes to a pipe, so jj starts no pager, and none of them
 * opens an editor, which `packages/smithers/flows/jj/test/NodeJj.test.ts` pins with a marker
 * on `JJ_EDITOR`. A host that wants a process GROUP killed composes
 * `layerSpawner` under a contained spawner instead; `@smthrs/platform-node`'s
 * `NodeHostContainment` suite pins that side.
 *
 * The `jj` under test is a shim on `PATH`: a real `jj` command finishes far
 * too quickly to be cancelled, and the subject is the cancellation, not jj.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ProcessTable from "../../../../testing/src/ProcessTable.ts"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-jj-lifetime-"))
const marker = join(directory, "flows-jj-lifetime-shim")
const startedFile = join(directory, "started")

/**
 * A `jj` that never returns, so the invocation can be cancelled while it is
 * genuinely running. The unique path is what the survivor scan looks for.
 */
writeFileSync(
  marker,
  `#!/bin/sh\necho started > ${startedFile}\nwhile true; do sleep 0.2; done\n`
)
chmodSync(marker, 0o755)
writeFileSync(
  join(directory, "jj"),
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "jj 0.39.0"; exit 0; fi\nexec ${marker} "$@"\n`
)
chmodSync(join(directory, "jj"), 0o755)

process.on("exit", () => rmSync(directory, { recursive: true, force: true }))

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Every process on this machine whose command line names the shim. */
const survivors = (): ReadonlyArray<string> =>
  ProcessTable.query({ columns: ["pid", "ppid", "args"] })
    .split("\n")
    .filter((line) => line.includes(marker))

/** Waits until nothing names the shim any more, or gives up after `budgetMs`. */
const waitForNoSurvivor = async (budgetMs: number): Promise<ReadonlyArray<string>> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const found = survivors()
    if (found.length === 0) return found
    if (Date.now() > deadline) return found
    await sleep(20)
  }
}

/** Waits for the shim to say it is running. */
const waitForStart = async (): Promise<void> => {
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    try {
      if (readFileSync(startedFile, "utf8").trim() !== "") return
    } catch {
      // not written yet
    }
    await sleep(10)
  }
  throw new Error("the jj shim never started")
}

describe.skipIf(process.platform === "win32")("NodeJj.layer", () => {
  it.live("leaves no jj behind when the invocation is cancelled", () =>
    Effect.gen(function*() {
      const previousPath = process.env["PATH"]
      // Prepended, not replaced: the survivor scan runs `ps`.
      process.env["PATH"] = `${directory}:${previousPath ?? ""}`
      try {
        const fiber = yield* Effect.forkChild(
          Effect.exit(Effect.flatMap(Jj, (jj) => jj.status())).pipe(Effect.provide(NodeJj.layer)),
          { startImmediately: true }
        )
        yield* Effect.promise(waitForStart)
        expect(survivors().length).toBeGreaterThan(0)

        yield* Fiber.interrupt(fiber)

        // The layer holds the process it started, and cancelling the fiber is
        // what makes it use that handle. Nothing named the shim is left.
        expect(yield* Effect.promise(() => waitForNoSurvivor(3_000))).toEqual([])
      } finally {
        process.env["PATH"] = previousPath
      }
    }), 30_000)
})
