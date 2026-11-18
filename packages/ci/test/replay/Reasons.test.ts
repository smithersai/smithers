import { describe, expect, it } from "vitest"
import type { TargetResult } from "../../src/contract/RunRecord.ts"
import {
  commandLine,
  failuresOf,
  nothingPassed,
  printedFailure,
  reasonOf,
  sentenceOf
} from "../../src/replay/Failures.ts"

const token = `ghp_${"a".repeat(30)}`

const failed = (label: string, extra: Partial<TargetResult> = {}): TargetResult => ({
  label,
  status: "failed",
  key: "",
  durationMs: 1,
  ...extra
})

describe("why a command failed", () => {
  it.each([
    ["bash", "bash: line 1: docker: command not found"],
    ["a script", "./ci.sh: line 3: docker: command not found"],
    ["a bare shell", "docker: command not found"],
    ["dash", "sh: 1: docker: not found"],
    ["zsh", "zsh:1: command not found: docker"],
    ["env", "/usr/bin/env: 'docker': No such file or directory"],
    ["env with curved quotes", "env: ‘docker’: No such file or directory"]
  ])("says a program is not installed when %s cannot find it", (_shell, line) => {
    expect(reasonOf({ exitCode: 127, stderr: `warming up\n${line}\n`, stdout: "" }))
      .toBe("`docker` is not installed on this machine")
  })

  it("names the program the last line names: that is the command that stopped the step", () => {
    const stderr = "bash: line 1: first: command not found\nbash: line 2: second: command not found\n"
    expect(reasonOf({ exitCode: 127, stderr, stdout: "" })).toBe("`second` is not installed on this machine")
  })

  it("keeps the raw line when exit 127 names a path, which is no program to install", () => {
    const line = "bash: line 1: ./gradlew: No such file or directory"
    expect(reasonOf({ exitCode: 127, stderr: line, stdout: "" })).toBe(line)
    expect(reasonOf({ exitCode: 127, stderr: "bash: ./run: not found", stdout: "" })).toBe("bash: ./run: not found")
  })

  it("does not read not-found words under another exit code", () => {
    expect(reasonOf({ exitCode: 1, stderr: "grep: pattern: not found", stdout: "" })).toBe("grep: pattern: not found")
    expect(reasonOf({ stderr: "docker: command not found", stdout: "" })).toBe("docker: command not found")
  })

  it("is the first line of the error output, without its colors", () => {
    expect(reasonOf({ exitCode: 1, stderr: "\n\u001b[31;1mfirst\u001b[0m problem\nsecond\n", stdout: "ignored" }))
      .toBe("first problem")
  })

  it("is the last printed line when the command wrote no error, and says when it printed nothing", () => {
    expect(reasonOf({ exitCode: 1, stderr: " \n", stdout: "running\n3 tests failed\n\n" })).toBe("3 tests failed")
    expect(reasonOf({ exitCode: 1, stderr: "", stdout: "" })).toBe("it printed nothing")
  })

  it("is cut to one short line", () => {
    expect(reasonOf({ exitCode: 1, stderr: "x".repeat(5000), stdout: "" })).toHaveLength(200)
  })

  it("withholds what is shaped like a credential, wherever the line comes from", () => {
    expect(reasonOf({ exitCode: 1, stderr: `bad token ${token}`, stdout: "" })).toBe("bad token [withheld]")
    expect(reasonOf({ exitCode: 1, stderr: "", stdout: "push to https://me:hunter2@example.com/r" }))
      .toBe("push to [withheld]example.com/r")
    expect(reasonOf({ exitCode: 1, stderr: "API_TOKEN=abc123 was refused", stdout: "" }))
      .toBe("[withheld] was refused")
    expect(commandLine(`curl -H "Authorization: Bearer ${token}" x\nsecond`)).not.toContain(token)
  })
})

describe("what smthrs printed for a failed target", () => {
  const printed = (fields: Record<string, unknown>) =>
    JSON.stringify({
      _tag: "smithers-build/ExecError",
      argv: ["bash", "-e", "-c", "docker run x"],
      code: "exit_status",
      cwd: ".",
      exitCode: 127,
      stderr: "bash: line 1: docker: command not found\n",
      stdout: "",
      ...fields
    })

  it("gives the exit code, the command a shell ran, and the reason", () => {
    expect(printedFailure(printed({}))).toEqual({
      error: "`docker` is not installed on this machine",
      exitCode: 127,
      command: "docker run x"
    })
  })

  it("joins the arguments of a command no shell ran", () => {
    expect(printedFailure(`${printed({ exitCode: 1, stderr: "boom" })}\na note from smthrs`).error).toBe("boom")
    expect(printedFailure(printed({ argv: ["node", "build.js"], exitCode: 1, stderr: "boom" }))).toEqual({
      error: "boom",
      exitCode: 1,
      command: "node build.js"
    })
  })

  it("has no exit code for a command that was stopped or never started", () => {
    expect(printedFailure(printed({ exitCode: -1, code: "timed_out", stderr: "timed out after 5s" }))).toEqual({
      error: "timed out after 5s",
      command: "docker run x"
    })
  })

  it("withholds a credential in the command and the output", () => {
    const shown = JSON.stringify(printedFailure(printed({
      argv: ["bash", "-c", `deploy ${token}`],
      exitCode: 1,
      stderr: `refused ${token}`
    })))
    expect(shown).not.toContain(token)
  })

  it("reads the form a shell target's failure is printed in", () => {
    const block = "command failed (exit 3): /bin/sh -c make test\nfirst error\nsecond"
    expect(printedFailure(block)).toEqual({ error: "first error", exitCode: 3, command: "make test" })
    expect(printedFailure("command failed (exit 3): make test")).toEqual({
      error: "it printed nothing",
      exitCode: 3,
      command: "make test"
    })
    expect(printedFailure("command failed (exit -1): /bin/sh -c x\nkilled")).toEqual({ error: "killed", command: "x" })
  })

  it("finds the output after a command of many lines", () => {
    const quoted =
      "command failed (exit 7): /bin/sh -c bash -e -c 'one\ntwo '\\''three'\\''\nfour'\nthe check broke\nmore"
    expect(printedFailure(quoted)).toEqual({ error: "the check broke", exitCode: 7, command: "bash -e -c 'one" })
    const doubled = `command failed (exit 2): sh -c echo "a\nb 'c" \\\nd\nreal error`
    expect(printedFailure(doubled).error).toBe("real error")
  })

  it("finds the output after a script that follows other statements, as a job's middle step is written", () => {
    // What `smthrs` prints for a generated step that is not its job's last: two statements, then the step's
    // script as one quoted word, then what the step printed, error output first.
    const middle = [
      "command failed (exit 7): /bin/sh -c mkdir -p .flows/ci || exit",
      ": > .flows/ci/ci.yml-build-2 || exit",
      "bash -e -c '__smithers_ci_unit='\\'''\\''",
      "__smithers_ci_step() {",
      "set +e",
      "}",
      "__smithers_ci_step '\\''echo \"middle starts\"",
      "echo \"the middle broke\" >&2",
      "exit 7'\\'''",
      "the middle broke",
      "middle starts"
    ].join("\n")
    expect(printedFailure(middle)).toMatchObject({ error: "the middle broke", exitCode: 7 })
    // A script on one line ends at its line break, whatever a later line quotes.
    const oneLine = "command failed (exit 1): /bin/sh -c bash -c 'exit 1' now\nit said 'no\nand' more\nlast"
    expect(printedFailure(oneLine).error).toBe("it said 'no")
    // Only a command's first lines can hold its script: later, a quoted word over lines is what it printed.
    const late = [
      "command failed (exit 1): make",
      ...Array.from({ length: 9 }, (_, n) => `line ${n}`),
      "sh -c 'a",
      "b'"
    ]
    expect(printedFailure(late.join("\n")).error).toBe("line 0")
  })

  it("ends a command whose quotes never close at its first line break", () => {
    expect(printedFailure("command failed (exit 1): sh -c echo 'open\nthe error")).toMatchObject({ error: "the error" })
    expect(printedFailure("command failed (exit 1): sh -c echo 'open")).toMatchObject({ error: "it printed nothing" })
    expect(printedFailure("command failed (exit 1): true\nsh -c 'open\nthe error")).toMatchObject({
      error: "sh -c 'open"
    })
  })

  it("reads any other text as its first line", () => {
    expect(printedFailure(`host binary "go" is not present\nmore`)).toEqual({
      error: `host binary "go" is not present`
    })
    expect(printedFailure(`{"_tag":"other"}`)).toEqual({ error: `{"_tag":"other"}` })
  })
})

describe("the failures of a run", () => {
  it("lists every failed result, by the name its step has, and nothing else", () => {
    const names = new Map([["//:a", { step: "lint", command: "make lint\nmake more" }]])
    const results: ReadonlyArray<TargetResult> = [
      failed("//:a", { error: "bad", exitCode: 2, command: "ignored" }),
      failed("//:b", { command: "own command" }),
      { label: "//:c", status: "ran", key: "", durationMs: 1 },
      { label: "//:d", status: "skipped", key: "", durationMs: 0 }
    ]
    expect(failuresOf(results, names)).toEqual([
      { step: "lint", reason: "bad", exitCode: 2, command: "make lint" },
      { step: "//:b", reason: "no reason was given", command: "own command" }
    ])
  })

  it("keeps the label when the step's name has nothing to show", () => {
    const names = new Map([["//:a", { step: "\n", command: "" }]])
    expect(failuresOf([failed("//:a", { error: `leak ${token}` })], names)).toEqual([
      { step: "//:a", reason: "leak [withheld]" }
    ])
  })

  it("reads as one sentence, with its exit code when it has one", () => {
    expect(sentenceOf({ step: "lint", reason: "bad", exitCode: 2 })).toBe("lint failed with exit code 2: bad")
    expect(sentenceOf({ step: "lint", reason: "bad" })).toBe("lint failed: bad")
  })
})

describe("a baseline that never passed", () => {
  it("names the step, command, exit code and error of the newest commit's first failure", () => {
    const record = (commit: string, reason: string) => ({
      ok: false,
      counts: { hit: 0, ran: 0, failed: 2, skipped: 0 },
      commit,
      results: [failed("//:a", { error: reason, exitCode: 127 }), failed("//:b", { error: "later" })]
    })
    const names = new Map([["//:a", { step: "licenses", command: "docker run x" }]])
    expect(nothingPassed([record("a".repeat(40), "old"), record("b".repeat(40), "new")], names)).toBe([
      "this repository's CI does not pass on this machine, so there is no speedup to measure. No step passed at any of the 2 replayed commits.",
      "First failure at bbbbbbb:",
      "  step     licenses",
      "  command  docker run x",
      "  exit     127",
      "  error    new"
    ].join("\n"))
  })
})
