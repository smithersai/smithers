/**
 * Runs each example against `node:fs/promises` in a temp directory, the same
 * real backend the adapter's own suite uses, so the examples stay type-checked
 * and keep doing what their comments say.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import * as NodeFsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as WorkWithFiles from "../examples/work-with-files.vibe"

let scratch = ""

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "platform-browser-examples-"))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe("examples", () => {
  it.effect("work-with-files appends, refuses the exclusive create, lists, streams, and types the refusal", () =>
    Effect.gen(function*() {
      const result = yield* WorkWithFiles.main(NodeFsPromises, join(scratch, "workspace"))

      expect(result).toEqual({
        notes: "first\nsecond\n",
        exclusive: "already exists",
        tree: ["logs", "logs/app.log", "notes.txt"],
        slice: ["234", "5"],
        symlink: "the browser backend does not support symlink",
        missing: false
      })
    }))
})
