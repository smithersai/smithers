import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import * as ScoreStore from "../src/ScoreStore.vibe"
import * as SqlScoreStore from "../src/SqlScoreStore.vibe"

it("runs the documented quickstart twice over the same real journal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "scoring-quickstart-"))
  // Keep the executable beside this test so Node resolves the workspace
  // dependencies; run it in a separate empty workspace with an on-disk journal.
  const script = fileURLToPath(new URL(`./.quickstart-${process.pid}.ts`, import.meta.url))
  const page = readFileSync(new URL("../docs/quickstart.md", import.meta.url), "utf8")
  const source = [...page.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1]).join("\n")
  expect(source).toContain("NodeRuntime.layerHost")
  writeFileSync(script, source)
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      execFileSync(process.execPath, [script], { cwd: directory, timeout: 20_000, stdio: "pipe" })
    }
    const aggregate = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        return yield* store.aggregate("greet/ada")
      }).pipe(
        Effect.provide(SqlScoreStore.layer),
        Effect.provide(
          DurableWriter.layer().pipe(
            Layer.provideMerge(NodeDatabase.layer({ filename: join(directory, ".flows/scoring.sqlite") }))
          )
        )
      )
    )
    expect(aggregate).toEqual({ count: 1, mean: 1, min: 1, inconclusive: 0 })
  } finally {
    rmSync(script, { force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})
