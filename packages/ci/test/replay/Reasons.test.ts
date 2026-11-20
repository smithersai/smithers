import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { TargetResult } from "../../src/contract/RunRecord.ts"
import {
  commandLine,
  failuresOf,
  nothingPassed,
  printedFailure,
  printedLimitOf,
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

  it("is the last line of the error output that reports an error, without its colors", () => {
    expect(reasonOf({ exitCode: 1, stderr: "\n\u001b[31;1mfirst\u001b[0m failed\nsecond\n", stdout: "ignored" }))
      .toBe("first failed")
    expect(reasonOf({ exitCode: 1, stderr: "error: first\nnote\nerror: second\nnote\n", stdout: "" }))
      .toBe("error: second")
    // A line that reports an error is the reason though it holds a percentage.
    expect(reasonOf({ exitCode: 1, stderr: "error: 100% of the checks failed\nDownloading 5%\n", stdout: "" }))
      .toBe("error: 100% of the checks failed")
  })

  it("is the last lines of the output as they are when no line reports an error", () => {
    expect(reasonOf({ exitCode: 1, stderr: "\nfirst problem\nsecond\n", stdout: "" })).toBe("second")
    expect(reasonOf({ exitCode: 1, stderr: "\nfirst problem\nsecond\n", stdout: "printed last\n" }))
      .toBe("printed last")
    expect(reasonOf({ exitCode: 1, stderr: "", stdout: "running\nthe check broke\n" })).toBe("the check broke")
  })

  it("is the line that names the error when a heading comes first, as a test runner prints the file's name", () => {
    const stderr = [
      "tests/readme-exports.test.ts:",
      "",
      "# Unhandled error between tests",
      "-------------------------------",
      "error: Cannot find package 'fast-check' from 'tests/readme-exports.test.ts'",
      " 1 error"
    ].join("\n")
    expect(reasonOf({ exitCode: 1, stderr, stdout: "" }))
      .toBe("error: Cannot find package 'fast-check' from 'tests/readme-exports.test.ts'")
    expect(reasonOf({ exitCode: 1, stderr: "Traceback (most recent call last):\n  x\nValueError: no\n", stdout: "" }))
      .toBe("ValueError: no")
    expect(reasonOf({ exitCode: 1, stderr: "\u001b[31mTypeError\u001b[0m: x is not a function\n", stdout: "" }))
      .toBe("TypeError: x is not a function")
    // A count of errors reports none.
    expect(reasonOf({ exitCode: 1, stderr: "results:\nerrors: 0\nerror_log off\n", stdout: "" })).toBe("error_log off")
    // The last line that reports an error is the reason, though another came first.
    expect(reasonOf({ exitCode: 1, stderr: "push refused\nerror: failed to push some refs\n", stdout: "" }))
      .toBe("error: failed to push some refs")
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

interface Output {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

/**
 * Real output of failed steps: the reviewers' ni and is-plain-obj steps, npm, cargo and pytest, and each package
 * manager running a script that fails.
 */
const steps = JSON.parse(readFileSync(new URL("../fixtures/failed-steps.json", import.meta.url), "utf8")) as
  & Record<"ni" | "npm" | "cargo" | "pytest" | "isPlainObj" | "nodeAssert", Output>
  & { readonly managers: Record<"npm" | "pnpm" | "yarn" | "bun", Record<"error" | "silent", Output>> }

describe("a reason that is never a progress line", () => {
  it("is the line that says what failed when pnpm prints its progress around it", () => {
    expect(reasonOf(steps.ni)).toBe(
      `Check failed (404): {"url":"/check","statusCode":404,"statusMessage":"Not Found","message":"There is no workflow defined for RlitinZTAm","stack":""}`
    )
  })

  it("is npm's last line that reports an error, not where its log is or a bare code", () => {
    expect(reasonOf(steps.npm)).toBe(
      "npm error 404  The requested resource 'no-such-package-smithers-ci-xyz@1.0.0' could not be found or you do not have permission to access it."
    )
  })

  it("is cargo's last error, without its colors, past its progress and its warnings", () => {
    expect(reasonOf(steps.cargo)).toBe(
      `error: could not compile \`cr\` (bin "cr") due to 1 previous error; 1 warning emitted`
    )
  })

  it("is pytest's failed test, not its line of counts or its row of dots", () => {
    expect(reasonOf(steps.pytest)).toBe("FAILED test_x.py::test_y - assert 2 == 3")
  })

  it.each([
    ["pnpm", "Progress: resolved 12, reused 10, downloaded 2, added 12, done"],
    ["pnpm's packages", "Packages: +12"],
    ["a bar", "++++++++++++"],
    ["cargo's progress", "   Compiling cr v0.1.0 (/home/runner/work/cr/cr)"],
    ["a spinner", "⠋ Installing dependencies"],
    ["a percentage", "Unpacking objects:  45% (9/20)"],
    ["npm's bar", "[##########........] / reify:typescript: timing reifyNode"],
    ["counts", "Tests: 1 failed, 3 passed, 4 total"],
    ["a summary", "=== 1 failed, 3 passed in 0.12s ==="],
    ["a line rewritten in place", "Receiving objects:  10%\rReceiving objects:  90%"]
  ])("passes over %s for the line before it", (_kind, line) => {
    expect(reasonOf({ exitCode: 1, stderr: `error: the real cause\n${line}\n`, stdout: "" })).toBe(
      "error: the real cause"
    )
    expect(reasonOf({ exitCode: 1, stderr: `still going\n${line}\n`, stdout: "" })).toBe("still going")
  })

  it("is the script's own error under npm's account of it, not npm's echo of the script", () => {
    const stdout = `\n> c@1.0.0 test\n> node -e "console.error('c fails here'); process.exit(3)"\n\n`
    const stderr = [
      "c fails here",
      "npm error Lifecycle script `test` failed with error:",
      "npm error code 3",
      "npm error path /home/runner/work/c",
      "npm error workspace c@1.0.0",
      "npm error location /home/runner/work/c",
      "npm error command failed",
      `npm error command sh -c node -e "console.error('c fails here'); process.exit(3)"`
    ].join("\n")
    expect(reasonOf({ exitCode: 3, stderr, stdout })).toBe("c fails here")
  })

  it("is the line the replay wrote for a step it stopped, though git reports an error after it", () => {
    const stderr = [
      "smithers-ci: a replayed step may not push; nothing was sent",
      "error: failed to push some refs to 'https://example.com/r'"
    ].join("\n")
    expect(reasonOf({ exitCode: 1, stderr, stdout: "" })).toBe(
      "smithers-ci: a replayed step may not push; nothing was sent"
    )
  })

  it("is the last line as it is when the output holds nothing but progress", () => {
    const stderr = "Progress: resolved 1, reused 0\nProgress: resolved 2, reused 0\n"
    expect(reasonOf({ exitCode: 1, stderr, stdout: "" })).toBe("Progress: resolved 2, reused 0")
  })

  it("reads the end of a long error output, where the last error is", () => {
    const stderr = `${"Progress: resolved 1, reused 0\n".repeat(400)}error: at the end\n`
    expect(reasonOf({ exitCode: 1, stderr, stdout: "" })).toBe("error: at the end")
  })

  it("reads the error output and then what the step printed, as smthrs prints a failed target", () => {
    expect(reasonOf({ exitCode: 1, stderr: "warming up\n", stdout: "3 tests failed\ndone\n" })).toBe("3 tests failed")
    expect(reasonOf({ exitCode: 1, stderr: "error: here\n", stdout: "3 tests failed\n" })).toBe("3 tests failed")
    expect(reasonOf({ exitCode: 1, stderr: "error: here\n", stdout: "done\n" })).toBe("error: here")
  })
})

describe("a reason that is never what a package manager writes around a script", () => {
  it("is xo's error above its long stack trace, not npm's echo of `npm test`", () => {
    expect(reasonOf(steps.isPlainObj)).toBe("TypeError: util.isDate is not a function")
    // smthrs prints the error output and then what the step printed, as one text.
    const printed = { exitCode: 1, stderr: `${steps.isPlainObj.stderr}${steps.isPlainObj.stdout}`, stdout: "" }
    expect(reasonOf(printed)).toBe("TypeError: util.isDate is not a function")
  })

  it("is Node's failed assertion, not a property Node prints of the error under its stack", () => {
    expect(reasonOf(steps.nodeAssert)).toBe("AssertionError [ERR_ASSERTION]: a")
    // A property block that never closes ends after its most lines, and the lines after it are read again.
    const open = `TypeError: first\n    at f (/w/a.js:1:1) {\n${"  code: 'ERR_X',\n".repeat(60)}`
    expect(reasonOf({ exitCode: 1, stderr: open, stdout: "" })).toBe("code: 'ERR_X',")
  })

  it.each(["npm", "pnpm", "yarn", "bun"] as const)(
    "is the script's error under %s, not its echo, its account or a frame of the stack",
    (manager) => {
      expect(reasonOf(steps.managers[manager].error)).toBe("TypeError: check is not a function")
    }
  )

  it.each(["npm", "pnpm", "yarn", "bun"] as const)("says a script %s ran printed nothing when it did", (manager) => {
    expect(reasonOf(steps.managers[manager].silent)).toBe("it printed nothing")
  })

  it.each([
    ["npm's name of the script", "> c@1.0.0 test"],
    ["pnpm's name of the script and its directory", "> c@1.0.0 test /home/runner/work/c/c"],
    ["npm's and pnpm's command", "> xo && ava && tsd"],
    ["Yarn's start", "yarn run v1.22.22"],
    ["the command Yarn, pnpm and Bun run", "$ xo && ava && tsd"]
  ])("is never %s", (_kind, line) => {
    expect(reasonOf({ exitCode: 1, stderr: "the check broke\n", stdout: `${line}\n` })).toBe("the check broke")
    expect(reasonOf({ exitCode: 1, stderr: `error: the check broke\n${line}\n`, stdout: "" }))
      .toBe("error: the check broke")
    expect(reasonOf({ exitCode: 1, stderr: `${line}\n`, stdout: "" })).toBe("it printed nothing")
  })

  it.each([
    ["Python's", `ValueError: no\n  File "/w/lib/errors.py", line 3, in check\n`],
    ["Java's", "java.lang.IllegalStateException: no\n\tat org.c.errors.Check.run(Check.java:10)\n"]
  ])("passes over a frame of %s stack trace for the error above it", (_kind, stderr) => {
    expect(reasonOf({ exitCode: 1, stderr, stdout: "" })).toMatch(/: no$/)
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
      "command failed (exit 7): /bin/sh -c bash -e -c 'one\ntwo '\\''three'\\''\nfour'\nthe check failed\nmore"
    expect(printedFailure(quoted)).toEqual({ error: "the check failed", exitCode: 7, command: "bash -e -c 'one" })
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
      "echo \"the middle failed\" >&2",
      "exit 7'\\'''",
      "the middle failed",
      "middle starts"
    ].join("\n")
    expect(printedFailure(middle)).toMatchObject({ error: "the middle failed", exitCode: 7 })
    // A script on one line ends at its line break, whatever a later line quotes.
    const oneLine = "command failed (exit 1): /bin/sh -c bash -c 'exit 1' now\nit failed: 'no\nand' more\nlast"
    expect(printedFailure(oneLine).error).toBe("it failed: 'no")
    // Only a command's first lines can hold its script: later, a quoted word over lines is what it printed.
    const late = [
      "command failed (exit 1): make",
      "error: line 0",
      ...Array.from({ length: 8 }, (_, n) => `line ${n + 1}`),
      "sh -c 'a",
      "b'"
    ]
    expect(printedFailure(late.join("\n")).error).toBe("error: line 0")
  })

  // What `smthrs` prints for a generated step: the lines before the script, the script as one quoted word that
  // holds the step's runner text, and in it, last, the call that runs the step's command.
  const runnerText = (command: string, before: ReadonlyArray<string> = [], inside: ReadonlyArray<string> = []) =>
    [
      `command failed (exit 3): /bin/sh -c ${[...before, "bash -e -c '__smithers_ci_unit='\\'''\\''"].join("\n")}`,
      "__smithers_ci_step() {",
      "__ci_fail() { echo \"smithers-ci: $1\" >&2; exit 1; }",
      "  __ci_fail \"a step wrote a value a replay cannot give\"",
      ...inside,
      "}",
      `__smithers_ci_step '\\''${command}'\\'''`
    ].join("\n")

  it("says a step printed nothing when nothing follows its command, whatever lines stand before its script", () => {
    const nothing = { error: "it printed nothing", exitCode: 3 }
    // The script is the whole command.
    expect(printedFailure(runnerText("exit 3"))).toMatchObject(nothing)
    // Jobs that run apart: a line with the job's versions stands before the script.
    expect(printedFailure(runnerText("exit 3", ["# Runs under job silent."]))).toMatchObject({
      ...nothing,
      command: "# Runs under job silent."
    })
    // A job's middle step: two statements stand before the script.
    const middle = ["mkdir -p .flows/ci || exit", ": > .flows/ci/ci.yml-build-2 || exit"]
    expect(printedFailure(runnerText("exit 3", middle))).toMatchObject(nothing)
    // A command of many lines, with a quote of its own.
    expect(printedFailure(runnerText("echo '\\''a'\\'' > b\nexit 3", middle))).toMatchObject(nothing)
    // And with a script that is no runner text.
    const plain = "command failed (exit 3): /bin/sh -c cd -- 'a' || exit\nbash -e -c 'one\ntwo'"
    expect(printedFailure(plain)).toMatchObject(nothing)
  })

  it("gives the line a step printed after its runner text, never a line of the text", () => {
    const apart = ["# Runs under job says.", "cd -- 'sub' || exit"]
    expect(printedFailure(`${runnerText("echo no >&2\nexit 3", apart)}\nthe widget broke`)).toMatchObject({
      error: "the widget broke"
    })
    // A line before the call that opens a quote and never closes it: the output still starts after the call.
    const open = ["# Runs under node 18 it's."]
    expect(printedFailure(runnerText("exit 3", open)).error).toBe("it printed nothing")
    expect(printedFailure(`${runnerText("exit 3", open)}\nthe widget broke`).error).toBe("the widget broke")
    // So does it when `smthrs` withheld a word of the text and a quote with it.
    const withheld = ["  export PASSWORD=[REDACTED]\\''"]
    expect(printedFailure(runnerText("exit 3", [], withheld)).error).toBe("it printed nothing")
    expect(printedFailure(`${runnerText("exit 3", [], withheld)}\nthe widget broke`).error).toBe("the widget broke")
    // More lines before the script than a command written by hand has.
    const many = Array.from({ length: 12 }, (_, n) => `export A${n}=1`)
    expect(printedFailure(runnerText("exit 3", many)).error).toBe("it printed nothing")
  })

  it("reads a runner text whose call never closes as a command that printed nothing", () => {
    const cut = runnerText("exit 3").slice(0, -5)
    expect(printedFailure(cut).error).toBe("it printed nothing")
    expect(printedFailure(`${cut}\nmore of the command`).error).toBe("it printed nothing")
  })

  it("leaves out the line smthrs adds for a command a signal ended: the command did not print it", () => {
    const ended = "command failed (exit -1): /bin/sh -c bash -e -c 'sh check.sh'\n"
    expect(printedFailure(`${ended}\nthe tool was terminated by SIGKILL`)).toEqual({
      error: "it printed nothing",
      exitCode: 137,
      command: "bash -e -c 'sh check.sh'"
    })
    // A signal this machine has no number for.
    expect(printedFailure(`${ended}\nthe tool was terminated by SIGNOPE`)).toEqual({
      error: "it printed nothing",
      exitCode: 128,
      command: "bash -e -c 'sh check.sh'"
    })
    expect(printedFailure(`${ended}the check failed\nthe tool was terminated by SIGTERM\nit printed this`).error).toBe(
      "the check failed"
    )
    const json = printed({ exitCode: -1, code: "signal", stderr: "\nthe tool was terminated by SIGKILL" })
    expect(printedFailure(json)).toEqual({ error: "it printed nothing", exitCode: 137, command: "docker run x" })
    // A line that only holds those words is the command's own.
    expect(printedFailure(`${ended}error: the tool was terminated by SIGKILL, said the log`).error).toBe(
      "error: the tool was terminated by SIGKILL, said the log"
    )
  })

  it("ends a command whose quotes never close at its first line break", () => {
    expect(printedFailure("command failed (exit 1): sh -c echo 'open\nthe error")).toMatchObject({ error: "the error" })
    expect(printedFailure("command failed (exit 1): sh -c echo 'open")).toMatchObject({ error: "it printed nothing" })
    expect(printedFailure("command failed (exit 1): true\nsh -c 'open fails\nmore")).toMatchObject({
      error: "sh -c 'open fails"
    })
  })

  it("reads any other text as its first line", () => {
    expect(printedFailure(`host binary "go" is not present\nmore`)).toEqual({
      error: `host binary "go" is not present`
    })
    expect(printedFailure(`{"_tag":"other"}`)).toEqual({ error: `{"_tag":"other"}` })
  })
})

describe("how much of what smthrs prints a replay keeps", () => {
  it("keeps enough for every target asked for, and no less for a pattern", () => {
    expect(printedLimitOf(1)).toBe(8_000_000)
    expect(printedLimitOf(31)).toBe(8_000_000)
    expect(printedLimitOf(32)).toBe(8_192_000)
    expect(printedLimitOf(1000)).toBe(256_000_000)
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
