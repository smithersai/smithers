import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main } from "../src/36-detached-children.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

// `it.live` rather than `it.effect`: the child port waits for the child's run
// row by sleeping, and a test clock never advances those sleeps on its own.
it.live("keeps a detached child alive past its parent and collects it later", () =>
  Effect.gen(function*() {
    const summary = yield* main(join(directory, "children.sqlite"))
    // The parent is done and the child was not taken down with it.
    expect(summary.parentStatus).toBe("completed")
    expect(summary.childCancelRequested).toBe(false)
    // EngineChildren's documented v2 identity length-prefixes the parent and
    // label, keeping retries stable without the old /child/ path collisions.
    expect(summary.child).toBe("child-v2:8:triage-16:digest")
    // Collected by an engine that never spawned anything.
    expect(summary.output).toBe("summary of rfc")
  }))
