/**
 * A replay stopped by an error of its own: it keeps the report of the commits it finished and says what the error
 * was, as it does for a full disk and a stopped recorder. A failure of the repository's own, and a signal, end it as
 * before. The error is a real one: Smithers build failing at one commit, or a defect of the program's own, injected
 * as a process spawner that dies there.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { Options, run } from "../../src/replay/index.ts"
import { ownStop } from "../../src/replay/Replay.vibe"
import { text } from "../../src/report/index.ts"
import { diesAt } from "./Dying.vibe"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
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

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Own", "-c", "user.email=own@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  })

describe("what stops a replay when the error is its own", () => {
  it("is the message of a failure the replay raised", () => {
    const failed: Failure = { code: "command-failed", message: "smthrs ci wrote no run record: broken", part: "replay" }
    expect(ownStop(Cause.fail(failed))).toBe("smthrs ci wrote no run record: broken")
  })

  it("is what a defect says, with its kind and fields, never [object Object]", () => {
    expect(ownStop(Cause.die({ _tag: "SpawnBroke", at: "three" }))).toBe("SpawnBroke, at: three")
    expect(ownStop(Cause.die(new Error("EACCES: permission denied")))).toBe("EACCES: permission denied")
    expect(ownStop(Cause.die({}))).toBe("an error with no message")
  })

  it("is nothing for a failure of the repository's own or a signal", () => {
    for (const code of ["unsupported", "not-a-repository", "invalid-document", "model-unavailable"] as const) {
      expect(ownStop(Cause.fail({ code, message: "x", part: "replay" } satisfies Failure)), code).toBeUndefined()
    }
    expect(ownStop(Cause.interrupt())).toBeUndefined()
  })
})

/** A `smthrs` that fails as a broken Smithers build does at the commit whose subject is `at`. */
const brokenAt = (at: string): string => {
  const directory = track(mkdtempSync(join(tmpdir(), "own-error-")))
  const command = join(directory, "smthrs")
  writeFileSync(
    command,
    `#!/bin/sh\ncase " $* " in *" --plan "*) exec ${smthrs} "$@";; esac\nif [ "$(git log -1 --format=%s)" = "${at}" ]; then echo broken; exit 1; fi\nexec ${smthrs} "$@"\n`
  )
  chmodSync(command, 0o755)
  return command
}

const replay = (root: string, commits: number, command: string = smthrs, spawner?: ReturnType<typeof diesAt>) =>
  Effect.runPromise(
    run({ root, commits, modes: ["normal"] }, parts("none") as unknown as ReplayParts<never>).pipe(
      Effect.provide(Layer.provideMerge(
        Layer.succeed(Options, {
          smthrs: [command] as const,
          reruns: 0,
          prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
          confine: unconfined
        }) as never,
        spawner === undefined ? NodeServices.layer : Layer.provideMerge(spawner, NodeServices.layer)
      ))
    ) as Effect.Effect<ReplayReport, Failure>
  )

describe("a replay stopped by an error of its own", { timeout: 600_000 }, () => {
  const repository = () => {
    const root = track(makeSmallRepository([job("runs", "sh a.sh")]))
    git(root, "commit", "--quiet", "--allow-empty", "-m", "two")
    git(root, "commit", "--quiet", "--allow-empty", "-m", "three")
    return root
  }

  it("keeps the report of the commits it finished when Smithers build fails", async () => {
    const root = repository()
    const two = git(root, "rev-parse", "HEAD~1").trim()
    const three = git(root, "rev-parse", "HEAD").trim().slice(0, 7)
    const report = await replay(root, 2, brokenAt("three"))
    expect(report.commits.map((commit) => commit.commit)).toEqual([two])
    expect(report.commits[0]?.normal.ok).toBe(true)
    expect(report.stopped).toBe(
      `the replay stopped at ${three} on an error of its own: smthrs ci wrote no run record: broken`
    )
    expect(text(report).split("\n")[0]).toBe(
      `The replay stopped at ${three} on an error of its own: smthrs ci wrote no run record: broken.`
    )
  })

  it("keeps the report of the commits it finished on a defect, and names the defect by its kind and fields", async () => {
    const root = repository()
    const two = git(root, "rev-parse", "HEAD~1").trim()
    const three = git(root, "rev-parse", "HEAD").trim().slice(0, 7)
    const report = await replay(root, 2, smthrs, diesAt("three", { _tag: "SpawnBroke", at: "three" }))
    expect(report.commits.map((commit) => commit.commit)).toEqual([two])
    expect(report.stopped).toBe(`the replay stopped at ${three} on an error of its own: SpawnBroke, at: three`)
    expect(JSON.stringify(report)).not.toContain("[object Object]")
  })

  it("fails as before when it stops at its first commit, with nothing finished to report", async () => {
    const root = repository()
    const failed = await replay(root, 1, brokenAt("three")).then(() => undefined, (cause: Failure) => cause)
    expect(failed?.code).toBe("command-failed")
    expect(failed?.message).toContain("smthrs ci wrote no run record")
  })
})
