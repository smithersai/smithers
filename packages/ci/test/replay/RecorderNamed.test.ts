/** The recorder a replay names: the one the runs of the real `smthrs` name in their records. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { chmodSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { Options, run } from "../../src/replay/index.ts"
import { html, text } from "../../src/report/index.ts"
import { job, linkTargets, makeEmptyDirectory, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (path: string): string => {
  created.push(path)
  return path
}
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

const base = parts("none") as unknown as ReplayParts<never>

/**
 * The real `smthrs`, whose record then names `recorder`, as the record of a run with a step to observe does.
 * The steps of the test repository ask for no observation, so the real one names none.
 */
const naming = (recorder: object): string => {
  const command = join(track(makeEmptyDirectory()), "smthrs")
  const rewrite = [
    "const fs = require(\"node:fs\")",
    "const record = JSON.parse(fs.readFileSync(process.argv[1], \"utf8\"))",
    "fs.writeFileSync(process.argv[1], JSON.stringify({ ...record, recorder: JSON.parse(process.argv[2]) }))"
  ].join("; ")
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      `results=$(echo "$*" | sed -n 's/.*--results-file \\([^ ]*\\).*/\\1/p')`,
      `${smthrs} "$@"`,
      "status=$?",
      `[ -n "$results" ] && [ -f "$results" ] && ${process.execPath} -e '${rewrite}' "$results" '${
        JSON.stringify(recorder)
      }'`,
      "exit $status",
      ""
    ].join("\n")
  )
  chmodSync(command, 0o755)
  return command
}

const replay = (root: string, command: string) =>
  Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"] }, base).pipe(
      Effect.provide(Layer.provideMerge(
        Layer.succeed(Options, {
          smthrs: [command] as const,
          reruns: 0,
          prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
          confine: unconfined
        }) as never,
        NodeServices.layer
      ))
    ) as Effect.Effect<ReplayReport, Failure>
  )

describe("the recorder a replay names", { timeout: 600_000 }, () => {
  it("is the one the runs name, in the report and in the line under the counts", async () => {
    const root = track(makeSmallRepository([job("works", "true")]))
    const recorder = {
      name: "strace",
      why: "this installation of @smthrs/build-cli holds no smthrs-observe for linux-x64"
    } as const
    const report = await replay(root, naming(recorder))
    expect(report.commits[0]?.normal.ok).toBe(true)
    expect(Schema.decodeUnknownSync(ReplayReport)(report).recorder).toEqual(recorder)
    const line = `what the steps read was recorded by strace: ${recorder.why}`
    expect(text(report).split("\n")).toContain(line)
    expect(html(report)).toContain(`<p class="summary">${line}</p>`)
  })

  it("is not named where no run had a step to observe", async () => {
    const root = track(makeSmallRepository([job("works", "true")]))
    const report = await replay(root, smthrs)
    expect(report.commits[0]?.normal.ok).toBe(true)
    expect(report).not.toHaveProperty("recorder")
    expect(text(report)).not.toContain("what the steps read")
  })
})
