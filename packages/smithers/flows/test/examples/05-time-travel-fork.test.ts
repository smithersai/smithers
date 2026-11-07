import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../../examples/05-time-travel-fork.vibe"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.effect("forks a finished run and replays its recorded attempts", () =>
  Effect.gen(function*() {
    const summary = yield* (main(join(directory, "analyse.sqlite")))
    expect(summary.parentResult).toBe("42")
    expect(summary.forkResult).toBe("42")
    expect(summary.forkRunId).not.toBe("analyse-1")
    expect(summary.dispatches).toBe(1)
    expect(summary.parentEntryCount).toBeGreaterThan(0)
  }))
