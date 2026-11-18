/**
 * The real `smithers-ci` replays a real repository whose job finds software as a step on a GitHub runner finds it:
 * through the variables the runner image sets, which no step names in its workflow. The list is GitHub's, from the
 * "Environment variables" tables of
 * https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { runnerSoftware } from "../../src/contract/Inventory.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { softwareEnvironment } from "../../src/replay/Environment.ts"
import { bin, commit, git, remove, spawnWith, temporary } from "../cli/repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const runner = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"

const workflow = `
on: push
jobs:
  android:
    runs-on: ${runner}
    steps:
      - uses: actions/checkout@v4
      - run: sh check.sh
      - run: test "$JAVA_HOME" = /the/step/own
        env:
          JAVA_HOME: /the/step/own
`

const check = [
  "[ -f \"$ANDROID_HOME/platforms/android-36/android.jar\" ] || { echo 'no Android platform' >&2; exit 1; }",
  "[ \"$ANDROID_SDK_ROOT\" = \"$ANDROID_HOME\" ] || { echo 'no SDK root' >&2; exit 1; }",
  "[ -z \"${CONDA+set}\" ] || { echo 'a variable this machine does not set' >&2; exit 1; }",
  "cat src.txt",
  ""
].join("\n")

describe("the software a runner comes with", () => {
  it("is told to a step as this machine has it, in the baseline and as a target", async () => {
    const root = temporary("replay-software")
    // A jailed step has a `/tmp` of its own, so the software is kept where a machine keeps it: outside that.
    const sdk = realpathSync(mkdtempSync("/var/tmp/replay-software-sdk-"))
    made.push(root, sdk)
    mkdirSync(join(sdk, "platforms", "android-36"), { recursive: true })
    writeFileSync(join(sdk, "platforms", "android-36", "android.jar"), "")
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", { ".github/workflows/ci.yml": workflow, "check.sh": check, "src.txt": "one\n" })
    commit(root, "a source change", { "src.txt": "two\n" })

    const outcome = await spawnWith(bin, ["--commits", "2", "--json", "--no-trial"], root, {
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      CONDA: "",
      JAVA_HOME: "/the/machine/own"
    })
    expect(outcome.stderr).not.toContain("error")
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.notReplayed ?? []).toEqual([])
    expect(report.commits).toHaveLength(2)
    for (const replayed of report.commits) {
      expect(replayed.baseline.ok).toBe(true)
      expect(replayed.normal.ok).toBe(true)
      expect(replayed.mismatches).toEqual([])
    }
    expect(outcome.code).toBe(0)
  }, 900_000)

  it("stops with the step's own error when this machine has none of it", async () => {
    const root = temporary("replay-no-software")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "base", { ".github/workflows/ci.yml": workflow, "check.sh": check, "src.txt": "one\n" })

    const outcome = await spawnWith(bin, ["--commits", "1", "--json", "--no-trial"], root, {
      ANDROID_HOME: "",
      ANDROID_SDK_ROOT: ""
    })
    // No job can pass here, so there is nothing to measure, and the person is told what stopped it.
    expect(outcome.code).toBe(3)
    expect(`${outcome.stdout}${outcome.stderr}`).toContain("no Android platform")
  }, 900_000)

  it("keeps only the names on GitHub's list that this machine sets to something", () => {
    expect(softwareEnvironment({
      ANDROID_HOME: "/sdk",
      CHROMEWEBDRIVER: undefined,
      CONDA: "",
      JAVA_HOME_17_X64: "/jdk",
      SECRET_TOKEN: "not on the list"
    })).toEqual({ ANDROID_HOME: "/sdk", JAVA_HOME_17_X64: "/jdk" })
    expect(runnerSoftware).toContain("JAVA_HOME")
    expect(runnerSoftware.every((name) => !/^(GITHUB|RUNNER)_/.test(name))).toBe(true)
  })
})
