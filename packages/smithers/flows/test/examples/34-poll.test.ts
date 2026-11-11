import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../../examples/34-poll.vibe"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it.live("resumes a poll across a restart without re-running a finished attempt", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "deploy.sqlite"))
    expect(summary.result).toBe("live:3")
    // The first engine made attempt one and parked; the second engine made
    // attempts two and three without re-running the first.
    expect(summary.checksBeforeRestart).toEqual([1])
    expect(summary.checks).toEqual([1, 2, 3])
  }), { timeout: 60_000 })
