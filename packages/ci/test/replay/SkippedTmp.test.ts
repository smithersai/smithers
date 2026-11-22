import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { exitCodes } from "../../src/contract/Command.ts"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import { skippedPart } from "../../src/replay/Environment.ts"
import { run } from "../../src/replay/index.ts"
import { bin, commit, git, remove, spawn, temporary } from "../cli/repo.ts"
import { job, makeSmallRepository } from "./fixture.ts"
import { options, parts } from "./TestParts.vibe"

const made: Array<string> = []
afterAll(() => {
  for (const path of made) remove(path)
})

describe("a replay's temporary directory", () => {
  it("is never under a directory a tool skips a project's own configuration under", async () => {
    // Biome 2.6.6 skips every nested biome.json of a project under a directory named .cache, so a lint the CI passes
    // would fail in a replay whose checkouts are there. The replay stops at once and says what to change.
    const root = temporary("skipped-repo")
    const outside = temporary("skipped-tmp")
    made.push(root, outside)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "first", {
      ".github/workflows/ci.yml": "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"
    })
    const under = join(outside, ".cache", "tmp")
    mkdirSync(under, { recursive: true })
    const outcome = await spawn(bin, ["replay", "--commits", "1"], root, { ...process.env, TMPDIR: under })
    expect(outcome.code).toBe(exitCodes.unsupported)
    expect(outcome.stderr).toContain(
      `is under a directory named .cache, where tools such as Biome skip a project's own configuration files, so a ` +
        `check the CI passes could fail here. Set TMPDIR to a directory with no part named .cache, .git, .hg, ` +
        `.output, .svn, .yarn, node_modules.`
    )
    // It left no directory of its own behind.
    expect(readdirSync(under).filter((name) => name.startsWith("smithers-ci-"))).toEqual([])
  })

  it("stops the replay before anything runs, with the reason and what to change", async () => {
    const outside = temporary("skipped-in-process")
    const root = makeSmallRepository([job("a", "true")])
    made.push(outside, root)
    const under = join(outside, ".cache", "tmp")
    mkdirSync(under, { recursive: true })
    const before = process.env["TMPDIR"]
    process.env["TMPDIR"] = under
    try {
      const failure = await Effect.runPromise(
        Effect.flip(
          run({ root, commits: 1, modes: ["normal"] }, parts("none") as unknown as ReplayParts<never>).pipe(
            Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
          ) as Effect.Effect<unknown, Failure>
        )
      )
      expect(failure).toMatchObject({ code: "unsupported", part: "replay" })
      expect(failure.message).toContain(`${under}/smithers-ci-replay-`)
      expect(failure.message).toContain("is under a directory named .cache")
    } finally {
      if (before === undefined) delete process.env["TMPDIR"]
      else process.env["TMPDIR"] = before
    }
    expect(readdirSync(under).filter((name) => name.startsWith("smithers-ci-"))).toEqual([])
  })

  it("names the first part of a path that is such a directory, and only a whole part", () => {
    expect(skippedPart("/tmp/smithers-ci-replay-x/normal/repo")).toBeUndefined()
    expect(skippedPart("/home/me/.cache/tmp/smithers-ci-replay-x")).toBe(".cache")
    expect(skippedPart("/srv/node_modules/.cache/x")).toBe("node_modules")
    expect(skippedPart("/srv/.cachex/tmp/.temp/dist/build")).toBeUndefined()
  })
})
