import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../../examples/02-run-durably.vibe"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("runs a flow durably and journals its lifecycle", () =>
  Effect.gen(function*() {
    const summary = yield* (main(join(directory, "build.sqlite")))
    expect(summary.result).toBe("dist/server.js?target=server")
    expect(summary.eventTypes.length).toBeGreaterThan(0)
  }))
