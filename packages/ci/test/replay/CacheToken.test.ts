/**
 * The shared cache's token: the replay hands it to Smithers build through the program `smthrsWithToken` names,
 * on that program's standard input, and nowhere else.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import type { ReplayParts } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { Options, run } from "../../src/replay/index.vibe"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"

const made: Array<string> = []
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true })
})

const replayed = (root: string, options: Partial<typeof Options.Service>, cache?: string) =>
  Effect.runPromise(
    run(
      { root, commits: 1, modes: ["normal"], ...(cache === undefined ? {} : { cache }) },
      parts("none") as unknown as ReplayParts<never>
    )
      .pipe(Effect.provide(Layer.provideMerge(
        Layer.succeed(Options, {
          smthrs: [smthrs],
          reruns: 1,
          prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
          confine: unconfined,
          ...options
        }) as never,
        NodeServices.layer
      ))) as Effect.Effect<ReplayReport>
  )

it("starts Smithers build through the program that reads the shared cache's token from a pipe", async () => {
  const root = makeSmallRepository([job("a", "true")])
  const scratch = mkdtempSync(join(tmpdir(), "replay-token-"))
  made.push(root, scratch)
  const seen = join(scratch, "seen")
  const starter = join(scratch, "starter.mjs")
  // A real program in smthrs' place: it keeps what it read from its standard input, then runs smthrs.
  writeFileSync(
    starter,
    [
      `import { readFileSync, writeFileSync } from "node:fs"`,
      `import { spawnSync } from "node:child_process"`,
      `writeFileSync(${JSON.stringify(seen)}, readFileSync(0, "utf8"))`,
      `const ran = spawnSync(${JSON.stringify(smthrs)}, process.argv.slice(2), { stdio: "inherit" })`,
      `process.exit(ran.status ?? 1)`
    ].join("\n")
  )
  const report = await replayed(
    root,
    {
      environment: { ...process.env, SMITHERS_CACHE_TOKEN: "a-test-token" },
      smthrsWithToken: [process.execPath, starter]
    },
    "https://cache.example.invalid"
  )
  expect(readFileSync(seen, "utf8")).toBe("a-test-token")
  expect(report.commits[0]?.normal.counts.failed).toBe(0)
}, 600_000)
