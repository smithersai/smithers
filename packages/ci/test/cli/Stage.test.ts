import { describe, expect, it } from "vitest"
import { broken, nothingTold, reasonOf, stageOf, stoppedCode, type Told, unanswered } from "../../src/cli/Stage.vibe"
import { exitCodes } from "../../src/contract/Command.vibe"

describe("the stage a progress line of a replay begins", () => {
  it("is the way and the commit of each run a replay announces", () => {
    expect(stageOf("2/5 3f2a1c9 baseline")).toEqual({ doing: "running the baseline", commit: "3f2a1c9" })
    expect(stageOf("2/5 3f2a1c9 normal")).toEqual({ doing: "running normal mode", commit: "3f2a1c9" })
    expect(stageOf("12/20 3f2a1c9 fast")).toEqual({ doing: "running fast mode", commit: "3f2a1c9" })
    expect(stageOf("5/5 adbc881 with the files apply writes")).toEqual({
      doing: "running normal mode with the files apply writes",
      commit: "adbc881"
    })
    expect(stageOf("first run 746ef07 baseline")).toEqual({
      doing: "running the first run of the baseline",
      commit: "746ef07"
    })
    expect(stageOf("first run 746ef07 fast")).toEqual({
      doing: "running the first run of fast mode",
      commit: "746ef07"
    })
  })

  it("is the check of what passes on this machine, for jobs and for a repository's own targets", () => {
    expect(stageOf("checking which jobs pass on this machine at 746ef07")).toEqual({
      doing: "checking which jobs pass on this machine",
      commit: "746ef07"
    })
    expect(stageOf("checking which targets pass on this machine at 746ef07")).toEqual({
      doing: "checking which targets pass on this machine",
      commit: "746ef07"
    })
  })

  it("is nothing for a line that begins no run", () => {
    for (
      const line of [
        "2/5 3f2a1c9 not replayed",
        "2/5 3f2a1c9 fast not measured",
        "fails here: ci.yml:build: exit 1 (at 746ef07 and adbc881)",
        "steps run without a file-system jail: bubblewrap is not installed",
        "2/5 3f2a1c9 normal ran again: //:a",
        ""
      ]
    ) expect(stageOf(line), line).toBeUndefined()
  })
})

const at: Told = {
  stage: { doing: "running normal mode", commit: "adbc881" },
  directories: ["/tmp/smithers-ci-replay-x"]
}
const preparing: Told = { stage: undefined, directories: ["/tmp/smithers-ci-replay-x"] }

describe("the line of a program that stopped without an exit code of its own", () => {
  it("says the replay stopped without an answer, and at which stage and commit", () => {
    expect(unanswered(at)).toBe("smithers-ci: replay: stopped without an answer while running normal mode at adbc881")
    expect(unanswered(preparing)).toBe("smithers-ci: replay: stopped without an answer while preparing the replay")
  })

  it("names no replay when none had begun", () => {
    expect(unanswered(nothingTold)).toBe("smithers-ci: stopped without an answer")
    expect(broken(nothingTold, new Error("no such file"))).toBe(
      "smithers-ci: stopped on an error of its own: no such file"
    )
  })

  it("gives an error's message after the stage", () => {
    expect(broken(at, new Error("EACCES: permission denied, rmdir '/tmp/x'"))).toBe(
      "smithers-ci: replay: stopped on an error of its own while running normal mode at adbc881: "
        + "EACCES: permission denied, rmdir '/tmp/x'"
    )
    expect(broken(preparing, "a plain value")).toBe(
      "smithers-ci: replay: stopped on an error of its own while preparing the replay: a plain value"
    )
  })

  it("exits with the code the command reference lists for a command that could not finish", () => {
    expect(stoppedCode).toBe(exitCodes.failed)
    expect(stoppedCode).toBe(4)
  })
})

describe("the reason a line gives", () => {
  it("is one line", () => {
    expect(reasonOf(new Error("first line\n    at second (file.js:1:1)\n"))).toBe("first line at second (file.js:1:1)")
  })

  it("holds no URL's user name or password", () => {
    expect(reasonOf(new Error("fetch https://someone:hunter2@example.invalid/x failed"))).toBe(
      "fetch https://example.invalid/x failed"
    )
    expect(reasonOf("clone of 'https://token@example.invalid/r.git' refused")).toBe(
      "clone of 'https://example.invalid/r.git' refused"
    )
  })

  it("is cut at 300 characters", () => {
    const reason = reasonOf(new Error("x".repeat(400)))
    expect(reason).toBe(`${"x".repeat(300)}…`)
    expect(reasonOf(new Error("y".repeat(300)))).toBe("y".repeat(300))
  })

  it("is a fixed phrase for a value that cannot say what it is", () => {
    const mute = {
      toString: () => {
        throw new Error("no words")
      }
    }
    expect(reasonOf(mute)).toBe("an error with no message")
    expect(reasonOf(undefined)).toBe("undefined")
  })
})
