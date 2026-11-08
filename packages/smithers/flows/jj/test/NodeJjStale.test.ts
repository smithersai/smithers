import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jj } from "../src/Jj.vibe"
import * as NodeJj from "../src/node/NodeJj.ts"
import { budgeted } from "./budgeted.ts"

it.effect("refuses a real sibling workspace without touching uncommitted files", () =>
  Effect.gen(function*() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "jj-sibling-real-")))
    yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(root, { recursive: true, force: true })))
    const jj = (...args: Array<string>) =>
      execFileSync("jj", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    jj("git", "init", ".")
    const original = jj("op", "log", "--no-graph", "-T", "id", "--limit", "1")
    jj("new", "-m", "working copy operation")
    const heads = join(root, ".jj", "repo", "op_heads", "heads")
    const previous = readdirSync(heads)
    jj("--at-op", original, "--ignore-working-copy", "new", "-m", "sibling operation")
    // Retain only the sibling head, reproducing a working-copy operation
    // outside the repo head's ancestry without running any recovery command.
    for (const head of previous) unlinkSync(join(heads, head))
    writeFileSync(join(root, "precious.txt"), "uncommitted work\n")
    const result = yield* Effect.result(
      Effect.flatMap(Jj, (service) => service.status()).pipe(Effect.provide(budgeted(NodeJj.layerAt(root))))
    )
    expect(readFileSync(join(root, "precious.txt"), "utf8")).toBe("uncommitted work\n")
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("stale_workspace")
      expect(result.failure.message).toContain(root)
      expect(result.failure.message).toContain("commit or back up")
    }
  }).pipe(Effect.scoped))
