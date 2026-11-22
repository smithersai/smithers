/**
 * A replay whose recorder stopped before a step ended: it keeps the report of the commits it finished, names the
 * step, and stops. The run of Smithers build that fails is a `smthrs` that fails as Smithers build does when
 * `smthrs-observe` was killed, at one commit, and runs the real one everywhere else.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
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
import { recorderStopped } from "../../src/replay/Reads.ts"
import { text } from "../../src/report/index.ts"
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

/** What Smithers build prints when `smthrs-observe` stopped before the step it records ended. */
const killed = (label: string): string =>
  `${label}: smthrs-observe stopped before the step ended, so its run says nothing about the step`

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Stop", "-c", "user.email=stop@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  })

describe("recorderStopped", () => {
  const names = new Map([["//:ci.yml-test-1", { step: "ci.yml:test:1" }]])

  it("names the step and the commit when a run failed because its recorder stopped", () => {
    const cause = {
      code: "command-failed",
      message: `smthrs ci wrote no run record: ┌ ci\n${killed("//:ci.yml-test-1")}`
    }
    expect(recorderStopped(cause, "3f2a1c9d0e", names)).toBe(
      "the replay stopped at 3f2a1c9: smthrs-observe, which records what ci.yml:test:1 reads, stopped before the step ended, so its run says nothing about the step. Run the replay again, or set SMTHRS_OBSERVE_WITH=strace to record with strace"
    )
    // A label the names do not hold is shown as it is.
    expect(recorderStopped({ message: `message: "${killed("//:other")}"` }, "3f2a1c9d0e", names)).toContain(
      "which records what //:other reads"
    )
  })

  it("is nothing for any other failure", () => {
    for (const cause of [{ message: "smthrs ci wrote no run record: out of space" }, new Error("x"), "text", null]) {
      expect(recorderStopped(cause, "3f2a1c9d0e", names)).toBeUndefined()
    }
  })
})

/** A `smthrs` that fails as Smithers build does when the recorder was killed, at the commit whose subject is `at`. */
const killedAt = (at: string): string => {
  const directory = track(mkdtempSync(join(tmpdir(), "recorder-stopped-")))
  const command = join(directory, "smthrs")
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      "case \" $* \" in *\" --plan \"*) exec " + smthrs + " \"$@\";; esac",
      `if [ "$(git log -1 --format=%s)" = "${at}" ]; then echo '${killed("//:runs0_0")}'; exit 1; fi`,
      `exec ${smthrs} "$@"`,
      ""
    ].join("\n")
  )
  chmodSync(command, 0o755)
  return command
}

const replay = (root: string, command: string, commits: number) =>
  Effect.runPromise(
    run({ root, commits, modes: ["normal"] }, parts("none") as unknown as ReplayParts<never>).pipe(
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

describe("a replay whose recorder stopped", { timeout: 600_000 }, () => {
  const repository = () => {
    const root = track(makeSmallRepository([job("runs", "sh a.sh")]))
    git(root, "commit", "--quiet", "--allow-empty", "-m", "two")
    git(root, "commit", "--quiet", "--allow-empty", "-m", "three")
    return root
  }

  it("keeps the report of the commits it finished and says which step's recorder stopped", async () => {
    const root = repository()
    const two = git(root, "rev-parse", "HEAD~1").trim()
    const three = git(root, "rev-parse", "HEAD").trim()
    const report = await replay(root, killedAt("three"), 2)
    expect(report.commits.map((commit) => commit.commit)).toEqual([two])
    expect(report.commits[0]?.normal.ok).toBe(true)
    expect(report.stopped).toMatch(
      new RegExp(
        `^the replay stopped at ${
          three.slice(0, 7)
        }: smthrs-observe, which records what .+ reads, stopped before the step ended, so its run says nothing about the step\\. `
      )
    )
    expect(report.stopped).not.toContain("//:runs0_0")
    expect(text(report).split("\n")[0]).toMatch(/^The replay stopped at \w{7}: smthrs-observe/)
  })

  it("reports no commit and says why when it stops at its first commit", async () => {
    const root = repository()
    const report = await replay(root, killedAt("three"), 1)
    expect(report.commits).toEqual([])
    expect(report.stopped).toMatch(/^the replay stopped at \w{7}: smthrs-observe, which records what /)
    expect(text(report).split("\n")[0]).toMatch(/^The replay stopped at \w{7}: smthrs-observe/)
  })

  it("says nothing of the recorder for a run that failed for another reason", async () => {
    const root = repository()
    const directory = track(mkdtempSync(join(tmpdir(), "recorder-other-")))
    const command = join(directory, "smthrs")
    writeFileSync(
      command,
      `#!/bin/sh\ncase " $* " in *" --plan "*) exec ${smthrs} "$@";; esac\nif [ "$(git log -1 --format=%s)" = three ]; then echo broken; exit 1; fi\nexec ${smthrs} "$@"\n`
    )
    chmodSync(command, 0o755)
    const report = await replay(root, command, 2)
    expect(report.stopped).toMatch(/^the replay stopped at \w{7} on an error of its own: smthrs ci wrote no run record/)
    expect(report.stopped).not.toContain("smthrs-observe")
  })
})
