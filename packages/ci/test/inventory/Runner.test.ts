import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  commitQuestion,
  eventsVariable,
  expand,
  readsCommit,
  runValues,
  runVariables,
  script,
  shell
} from "../../src/contract/Inventory.vibe"
import { type Residual, type Value, variable } from "../../src/inventory/Expression.ts"
import {
  commitMark,
  type JobFacts,
  parentMark,
  quote,
  settled,
  type StepFacts,
  variableKinds,
  write
} from "../../src/inventory/Runner.ts"

interface Place {
  readonly repo: string
  readonly tmp: string
  readonly home: string
  readonly git: (...args: ReadonlyArray<string>) => string
}

interface Ran {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

interface Options {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly job?: JobFacts
  readonly variant?: Readonly<Record<string, string>>
  /** The step was split from another, as `Step.from` says. */
  readonly part?: boolean
  /** The job the step is run for, as a baseline tells it. */
  readonly unit?: string
  /** The directory Smithers build keeps its cache in, which it writes into the text of a target's step. */
  readonly cacheDirectory?: string
}

const roots: Array<string> = []

/** A temporary directory with a git repository of `commits` commits, and a `TMPDIR` of its own. */
const place = (commits: number): Place => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "smithers-runner-test-")))
  roots.push(home)
  const repo = join(home, "repo")
  const tmp = join(home, "tmp")
  mkdirSync(repo)
  mkdirSync(tmp)
  const git = (...args: ReadonlyArray<string>): string => {
    const ran = spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args],
      { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } }
    )
    if (ran.status !== 0) throw new Error(ran.stderr)
    return ran.stdout.trim()
  }
  git("init", "-q")
  for (let index = 1; index <= commits; index += 1) {
    writeFileSync(join(repo, "a.txt"), `commit ${index}\n`)
    git("add", ".")
    git("commit", "-qm", `commit ${index}`)
  }
  return { repo, tmp, home, git }
}

let at: Place

beforeEach(() => {
  mark = undefined
  shared = true
  begun.clear()
  placed.length = 0
  at = place(2)
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const job = (overrides: Partial<JobFacts> = {}): JobFacts => ({
  id: "build",
  matrixKeys: [],
  variables: { GITHUB_ACTIONS: "true" },
  event: "{}",
  ...overrides
})

const defaults: StepFacts = {
  key: "STEP",
  after: "none",
  second: false,
  apart: false,
  job: "build",
  before: [],
  cwd: "",
  directory: undefined,
  start: ["bash", "-e"],
  own: [],
  keeps: [],
  condition: undefined,
  outer: [],
  env: [],
  fills: [],
  commit: false
}

/**
 * A step's facts as a test gives them: `first` for the job's first step, whose mark the steps after it name, and
 * `alone` for a first step that is the only step of its job.
 */
type Facts = Partial<StepFacts> & { readonly first?: boolean; readonly alone?: boolean }

/** The mark of the first step the test last ran. */
let mark: string | undefined

/** The jobs that have run a step after the first step the test last ran: their next step is not their second. */
const begun = new Set<string>()

/** The keys of the steps run since the first step the test last ran, in order: a step reads what each left. */
const placed: Array<string> = []

/** True when the first step the test last ran was given no job, so the job's second step copies what it left. */
let shared = true

/** Writes the runner text of a step, composes it as `Inventory.script` does and runs it with `Inventory.shell`. */
const run = ({ alone, first: started, ...facts }: Facts, command: string, options: Options = {}): Ran => {
  // A step a replay may leave out has no place: it neither starts the steps nor counts as one of them.
  const apart = facts.apart === true
  const first = !apart && (started === true || alone === true)
  const after = first ? undefined : apart ? mark : mark ?? "none"
  const facts_ = options.job ?? job()
  const state = `${facts_.id} ${JSON.stringify(options.variant ?? {})}`
  const second = !first && after !== undefined && shared && !begun.has(state)
  // A first step is given no job unless the test gives it one, as a step that asks for none is.
  const told = first && !("job" in facts) ? { job: undefined } : {}
  // A step the test gives no key is the next step of the job. One it names again reads what the steps before its
  // first run left, as the same step of a workflow does when it runs again.
  const key = facts.key ?? (first ? "STEP" : `STEP_${placed.length + 1}`)
  const before = first ? [] : placed.includes(key) ? placed.slice(0, placed.indexOf(key)) : [...placed]
  const step = { ...defaults, after, second, before, ...told, ...facts, key }
  const written = write(facts_, step, command)
  if (!("text" in written)) throw new Error(written.problem)
  if (first) {
    mark = written.mark
    shared = step.job === undefined
    begun.clear()
    placed.length = 0
  } else if (!apart) begun.add(state)
  if (!apart && !placed.includes(key)) placed.push(key)
  const runner = alone === true ? written.alone : written.text
  const composed = expand(
    script({ command, runner, ...(options.part === true ? { from: "whole" } : {}) }, options.unit),
    options.variant ?? {}
  )
  const text = options.cacheDirectory === undefined
    ? composed
    : composed.replaceAll("{smthrs:cache-directory}", options.cacheDirectory)
  const [program, ...flags] = shell
  const ran = spawnSync(program, [...flags, text], {
    cwd: options.cwd ?? at.repo,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: at.home, TMPDIR: at.tmp, ...options.env },
    encoding: "utf8"
  })
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

/** Runs a step and fails the test with its error output when it does not exit 0. */
const pass = (facts: Facts, command: string, options: Options = {}): string => {
  const ran = run(facts, command, options)
  expect(ran.stderr).toBe("")
  expect(ran.status).toBe(0)
  return ran.stdout
}

const residual = (context: ReturnType<typeof variable>): Residual =>
  (context as { readonly residual: Residual }).residual
const named = (id: string, nullable = false, typed = false): Residual => residual(variable(id, id, nullable, typed))
const output = (name: string, typed = false): Residual => named(`output:SET/${name}`, true, typed)
const literal = (value: Value): Residual => ({ kind: "literal", value })
const not = (operand: Residual): Residual => ({ kind: "not", operand })
const call = (name: string, ...args: ReadonlyArray<Residual>): Residual => ({ kind: "call", name, args })
const binary = (operator: "==" | "!=" | "&&" | "||" | "<", left: Residual, right: Residual): Residual => ({
  kind: "binary",
  operator,
  left,
  right
})

/** The value an expression has while the job runs, written into a step's script as `${{ }}` is. */
const valueOf = (expression: Residual, options: Options = {}): string =>
  pass({ fills: [["${{ x }}", expression]] }, `printf '[%s]' "\${{ x }}"`, options)

/** RUNNER_ARCH: X64 or ARM64 on this machine. */
const machine = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim()
const arch = machine === "x86_64" || machine === "amd64"
  ? "X64"
  : machine === "arm64" || machine === "aarch64"
  ? "ARM64"
  : machine

const sha256 = (data: Buffer | string): Buffer => createHash("sha256").update(data).digest()

describe("write", () => {
  // Default environment variables: GITHUB_WORKSPACE, GITHUB_SHA, RUNNER_ARCH, RUNNER_TEMP, RUNNER_TOOL_CACHE,
  // GITHUB_EVENT_PATH, and the file commands' GITHUB_OUTPUT, GITHUB_ENV, GITHUB_PATH, GITHUB_STEP_SUMMARY and
  // GITHUB_STATE.
  it("gives a step GitHub's default environment variables", () => {
    // What a shell would expand, or end a quote with, is written as it is: a branch may be named `$(x)`.
    const text = "a \"q\" 'b' \\ c `x` $HOME $(echo no) $GITHUB_SHA"
    const event = JSON.stringify({ after: commitMark, before: parentMark, text })
    const stdout = pass(
      { first: true, commit: true },
      [
        `printf '%s\\n' "$GITHUB_WORKSPACE" "$GITHUB_SHA" "$RUNNER_ARCH" "$CI" "$GITHUB_ACTIONS"`,
        `test -d "$RUNNER_TEMP" && test -d "$RUNNER_TOOL_CACHE" && cat "$GITHUB_EVENT_PATH"`,
        `for f in "$GITHUB_OUTPUT" "$GITHUB_ENV" "$GITHUB_PATH" "$GITHUB_STEP_SUMMARY" "$GITHUB_STATE"; do`,
        `  test -f "$f" && test ! -s "$f" && echo file`,
        `done`
      ].join("\n"),
      { job: job({ event }) }
    )
    const lines = stdout.split("\n")
    expect(lines.slice(0, 5)).toEqual([at.repo, at.git("rev-parse", "HEAD"), arch, "true", "true"])
    expect(JSON.parse(lines[5] as string)).toEqual({
      after: at.git("rev-parse", "HEAD"),
      before: at.git("rev-parse", "HEAD^"),
      text
    })
    expect(lines.slice(6)).toEqual(["file", "file", "file", "file", "file", ""])
  })

  it("fails a later step when the job's first step has not run", () => {
    const ran = run({}, "echo ran")
    expect(ran.status).toBe(1)
    expect(ran.stdout).toBe("")
    expect(ran.stderr).toContain(`smithers-ci: the first step of this job has not run in ${at.repo}`)
  })

  // Only a job's second step starts its state. A step after that one finds it, or stops.
  it("fails a third step when the job's second step has not run", () => {
    pass({ first: true }, "true")
    const ran = run({ second: false }, "echo ran")
    expect(ran.status).toBe(1)
    expect(ran.stdout).toBe("")
    expect(ran.stderr).toContain(`smithers-ci: the steps before this one have not run in ${at.repo}`)
  })

  // RUNNER_TEMP is emptied at the beginning of each job.
  it("empties RUNNER_TEMP and what earlier steps wrote when a job starts again", () => {
    pass({ first: true }, `touch "$RUNNER_TEMP/left"; echo KEPT=1 >> "$GITHUB_ENV"`)
    expect(pass({}, `ls "$RUNNER_TEMP"; echo "$KEPT"`)).toBe("left\n1\n")
    expect(pass({ first: true }, `ls "$RUNNER_TEMP"; echo "[$KEPT]"`)).toBe("[]\n")
  })

  // Workflow commands: Setting an environment variable, and multiline strings.
  it("loads both forms of GITHUB_ENV into later steps, except the step's own and the runner's names", () => {
    pass(
      { first: true },
      [
        `printf 'PLAIN=one=two\\n\\nHEREDOC<<EOF\\nline 1\\n\\nline 3\\nEOF\\n' >> "$GITHUB_ENV"`,
        `printf 'ARROW=x<<y\\nOWN=from-env\\nGITHUB_SHA=bad\\nRUNNER_ARCH=bad\\nEMPTY=\\n' >> "$GITHUB_ENV"`,
        `printf '__SAVED=ignored\\nIFS=ignored\\n' >> "$GITHUB_ENV"`,
        `printf 'LAST<<END\\nno newline\\nEND' >> "$GITHUB_ENV"`
      ].join("\n")
    )
    const stdout = pass(
      { own: ["OWN", "OTHER"], fills: [["@IFS@", named("process:IFS")]] },
      [
        `printf '[%s]\\n' "$PLAIN" "$HEREDOC" "$ARROW" "$OWN" "$RUNNER_ARCH" "$LAST" "\${EMPTY-unset}"`,
        `test "$GITHUB_SHA" != bad && test -z "\${__SAVED+x}" && test '@IFS@' != ignored`
      ].join("\n"),
      { env: { OWN: "mine" } }
    )
    expect(stdout.split("\n")).toEqual([
      "[one=two]",
      "[line 1",
      "",
      "line 3]",
      "[x<<y]",
      "[mine]",
      `[${arch}]`,
      "[no newline]",
      "[]",
      ""
    ])
  })

  // Workflow commands: Setting an environment variable. GitHub refuses NODE_OPTIONS and lines it cannot read.
  it.each([
    ["NODE_OPTIONS", "NODE_OPTIONS=--inspect", "a step may not set NODE_OPTIONS for later steps"],
    ["a name a shell cannot hold", "1A=x", "under a name a shell cannot hold"],
    ["a name with a dash", "A-B=x", "under a name a shell cannot hold"],
    ["an empty name", "=x", "under a name a shell cannot hold"],
    ["a line that is neither form", "junk", "is neither NAME=value nor NAME<<MARK"],
    ["a heredoc with no closing line", "A<<EOF\\nvalue", "has no closing line"]
  ])("fails a step that writes %s to GITHUB_ENV", (_name, line, message) => {
    const ran = run({ first: true }, `printf '${line}\\n' >> "$GITHUB_ENV"`)
    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain(message)
  })

  // Workflow commands: Adding a system path. The newest directory comes first.
  it("puts what earlier steps wrote to GITHUB_PATH first on PATH, newest first", () => {
    pass({ first: true }, `printf '/one\\n\\n/two\\n' >> "$GITHUB_PATH"`)
    expect(pass({}, `printf %s "$PATH" | cut -d: -f1-2`)).toBe("/two:/one\n")
    pass({}, `printf '/three' >> "$GITHUB_PATH"`)
    expect(pass({}, `printf %s "$PATH" | cut -d: -f1-3`)).toBe("/three:/two:/one\n")
  })

  // Workflow commands: Setting an output parameter. Contexts: steps.<step_id>.outputs.
  it("keeps what a step wrote to GITHUB_OUTPUT for later steps", () => {
    pass(
      { key: "SET", first: true },
      `printf 'name=value\\nMixed_case=m\\nmulti<<EOF\\na\\nb\\nEOF\\nbad.name=dropped\\n=empty\\n' >> "$GITHUB_OUTPUT"`
    )
    expect(valueOf(output("NAME"))).toBe("[value]")
    expect(valueOf(output("MIXED_CASE"))).toBe("[m]")
    expect(valueOf(output("MULTI"))).toBe("[a\nb]")
    expect(valueOf(output("BAD.NAME"))).toBe("[]")
    expect(valueOf(output("NONE"))).toBe("[]")
  })

  // Contexts: steps.<step_id>.outcome is success or skipped; a false if: skips the step and the job goes on.
  it("skips a step whose condition is false and records each step's outcome", () => {
    pass({ key: "SET", first: true }, `echo ran > "$RUNNER_TEMP/set"`)
    const skipped = run({ key: "SKIP", condition: output("MISSING") }, `echo ran; exit 9`)
    expect(skipped).toEqual({ status: 0, stdout: "smithers-ci: not run, its condition is false\n", stderr: "" })
    expect(valueOf(named("outcome:SET"))).toBe("[success]")
    expect(valueOf(named("outcome:SKIP"))).toBe("[skipped]")
    expect(valueOf(named("outcome:NEVER"))).toBe("[]")
    expect(pass({ condition: binary("==", named("outcome:SET"), literal("success")) }, "echo ran")).toBe("ran\n")
  })

  describe("conditions, as GitHub evaluates expressions", () => {
    beforeEach(() => {
      pass(
        { key: "SET", first: true },
        `printf 'HELLO=Hello\\nEMPTY=\\nZERO= 0 \\nHEX=0x0\\nEXP=-0.0e3\\nWORD=abc\\nSTAR=A*B\\n' >> "$GITHUB_OUTPUT"`
      )
    })

    const missing = output("MISSING")
    it.each<[string, Residual, boolean]>([
      // Operators: null and text are compared as numbers, and empty text is 0.
      ["null == '0'", binary("==", missing, literal("0")), true],
      ["null == ''", binary("==", missing, literal("")), true],
      ["null == 'true'", binary("==", missing, literal("true")), false],
      ["' 0 ' == null", binary("==", output("ZERO"), literal(null)), true],
      ["'0x0' == null", binary("==", output("HEX"), literal(null)), true],
      ["'-0.0e3' == null", binary("==", output("EXP"), literal(null)), true],
      ["'' == null", binary("==", output("EMPTY"), literal(null)), true],
      ["'abc' == null", binary("==", output("WORD"), literal(null)), false],
      ["null == null", binary("==", missing, literal(null)), true],
      ["null != null", binary("!=", missing, output("ALSO_MISSING")), false],
      // Operators: text is compared without case.
      ["'' == '0', text with text", binary("==", output("EMPTY"), literal("0")), false],
      ["'Hello' == 'hELLO'", binary("==", output("HELLO"), literal("hELLO")), true],
      ["'Hello' != 'hello'", binary("!=", output("HELLO"), literal("hello")), false],
      ["'Hello' == 'world'", binary("==", output("HELLO"), literal("world")), false],
      // Operators: ! and the falsy values '', null, false, 0.
      ["!null", not(missing), true],
      ["!'Hello'", not(output("HELLO")), false],
      ["!''", not(output("EMPTY")), true],
      ["0", literal(0), false],
      ["true", literal(true), true],
      ["''", literal(""), false],
      ["'0', non-empty text", output("ZERO"), true],
      // Functions: contains, startsWith, endsWith, without case.
      ["contains('A*B', '*b')", call("contains", output("STAR"), literal("*b")), true],
      ["contains('A*B', '?')", call("contains", output("STAR"), literal("?")), false],
      ["contains('Hello', 'x')", call("contains", output("HELLO"), literal("x")), false],
      ["startsWith('Hello', 'he')", call("startswith", output("HELLO"), literal("he")), true],
      ["startsWith('Hello', 'lo')", call("startswith", output("HELLO"), literal("lo")), false],
      ["endsWith('Hello', 'LO')", call("endswith", output("HELLO"), literal("LO")), true],
      ["endsWith('Hello', 'he')", call("endswith", output("HELLO"), literal("he")), false],
      // Operators: && and || give back an operand.
      ["null && 'x'", binary("&&", missing, literal("x")), false],
      ["'Hello' && null", binary("&&", output("HELLO"), missing), false],
      ["'Hello' && 'x'", binary("&&", output("HELLO"), literal("x")), true],
      ["null || 'Hello'", binary("||", missing, output("HELLO")), true],
      ["'Hello' || null", binary("||", output("HELLO"), missing), true],
      ["null || ''", binary("||", missing, output("EMPTY")), false],
      // `a == 'b' && 'one' || 'two'` is always text, so it can be compared.
      [
        "('Hello' == 'hello' && 'one' || 'two') == 'one'",
        binary(
          "==",
          binary("||", binary("&&", binary("==", output("HELLO"), literal("hello")), literal("one")), literal("two")),
          literal("one")
        ),
        true
      ],
      [
        "('Hello' == 'x' && 'one' || 'two') == 'one'",
        binary(
          "==",
          binary("||", binary("&&", binary("==", output("HELLO"), literal("x")), literal("one")), literal("two")),
          literal("one")
        ),
        false
      ],
      [
        "'Hello' == format('{0}', 'hello')",
        binary("==", output("HELLO"), call("format", literal("{0}"), literal("hello"))),
        true
      ],
      ["'Hello' && 1", binary("&&", output("HELLO"), literal(1)), true],
      ["'Hello' && 0", binary("&&", output("HELLO"), literal(0)), false]
    ])("%s", (_name, condition, runs) => {
      const stdout = pass({ condition }, "echo ran")
      expect(stdout).toBe(runs ? "ran\n" : "smithers-ci: not run, its condition is false\n")
    })

    // Operators: && and || give back an operand; Functions: format.
    it.each<[string, Residual, string]>([
      ["'Hello' && 'y'", binary("&&", output("HELLO"), literal("y")), "y"],
      ["null && 'y'", binary("&&", missing, literal("y")), ""],
      ["null || 'fallback'", binary("||", missing, literal("fallback")), "fallback"],
      ["'Hello' || 'fallback'", binary("||", output("HELLO"), literal("fallback")), "Hello"],
      ["'' || null || 'last'", binary("||", output("EMPTY"), binary("||", missing, literal("last"))), "last"],
      [
        "format('{0}-{1}', 'Hello', 'abc')",
        call("format", literal("{0}-{1}"), output("HELLO"), output("WORD")),
        "Hello-abc"
      ],
      ["format('{{{0}}}', 'Hello')", call("format", literal("{{{0}}}"), output("HELLO")), "{Hello}"],
      ["format('{1}{0}', 'Hello', null)", call("format", literal("{1}{0}"), output("HELLO"), missing), "Hello"],
      ["format('plain')", call("format", literal("plain")), "plain"],
      ["format of a typed value", call("format", literal("<{0}>"), output("WORD", true)), "<abc>"],
      ["contains('Hello', 'ELL')", call("contains", output("HELLO"), literal("ELL")), "true"],
      ["startsWith('Hello', 'x')", call("startswith", output("HELLO"), literal("x")), "false"],
      ["'Hello' == 'HELLO'", binary("==", output("HELLO"), literal("HELLO")), "true"],
      ["!null", not(missing), "true"],
      ["a number", literal(2), "2"],
      ["a value with shell characters", output("STAR"), "A*B"]
    ])("gives %s", (_name, expression, value) => {
      expect(valueOf(expression)).toBe(`[${value}]`)
    })
  })

  // Contexts: github.sha, github.workspace, github.event.before, runner.temp, runner.tool_cache, runner.arch, env.
  it("reads each kind of variable a step may name", () => {
    expect(variableKinds).toEqual([
      "output",
      "outcome",
      "env",
      "process",
      "kept",
      "hash",
      "glob",
      "matrix",
      "path",
      "base",
      "before",
      "sha",
      "runid",
      "runnumber",
      "runattempt",
      "os",
      "workspace",
      "temp",
      "toolcache",
      "arch"
    ])
    pass({ first: true }, `echo SETV=from-env >> "$GITHUB_ENV"`)
    const fills: Array<readonly [string, Residual]> = [
      ["@1@", named(`env:${JSON.stringify({ name: "SETV", held: "fallback" })}`)],
      ["@2@", named(`env:${JSON.stringify({ name: "UNSET", held: "fallback" })}`)],
      ["@3@", named(`env:${JSON.stringify({ name: "UNSET", held: null })}`, true)],
      ["@4@", named("path:sub dir/it's")],
      ["@5@", named("base:the pull request")],
      ["@6@", named("before")],
      ["@7@", named("sha")],
      ["@8@", named("workspace")],
      ["@9@", named("temp")],
      ["@A@", named("toolcache")],
      ["@B@", named("arch")]
    ]
    const stdout = pass(
      { fills },
      `printf '%s\\n' "@1@" "@2@" "[@3@]" "@4@" "@5@" "@6@" "@7@" "@8@" "@9@" "@A@" "@B@" `
        + `"$RUNNER_TEMP" "$RUNNER_TOOL_CACHE" "$RUNNER_ARCH"`
    )
    const lines = stdout.split("\n")
    expect(lines.slice(0, 9)).toEqual([
      "from-env",
      "fallback",
      "[]",
      `${at.repo}/sub dir/it's`,
      at.git("rev-parse", "HEAD^"),
      at.git("rev-parse", "HEAD^"),
      at.git("rev-parse", "HEAD"),
      at.repo,
      lines[11]
    ])
    expect(lines.slice(9, 11)).toEqual(lines.slice(12, 14))
    expect(lines[8]).toMatch(/\/temp$/)
    // An env value a step did not set, with no value of its own, is null and false.
    expect(pass({ condition: named(`env:${JSON.stringify({ name: "UNSET", held: null })}`, true) }, "echo ran"))
      .toBe("smithers-ci: not run, its condition is false\n")
  })

  // Functions: hashFiles, the SHA-256 of each file's SHA-256, skipping files that do not exist.
  it("hashes files as hashFiles does", () => {
    writeFileSync(join(at.repo, "b.txt"), "bee\n")
    writeFileSync(join(at.repo, "c.bin"), Buffer.from([0, 1, 2, 255, 10]))
    pass({ first: true }, "true")
    const digests = ["b.txt", "c.bin"].map((name) => sha256(readFileSync(join(at.repo, name))))
    const expected = createHash("sha256").update(Buffer.concat(digests)).digest("hex")
    expect(valueOf(named(`hash:${JSON.stringify(["b.txt", "gone.txt", "c.bin"])}`))).toBe(`[${expected}]`)
    expect(valueOf(named(`hash:${JSON.stringify(["gone.txt"])}`))).toBe("[]")
  })

  // Contexts: matrix. Each variant of a job keeps its own state.
  // For a cache key only: the files patterns name, hashed in sorted order. GitHub hashes them in an order of its
  // own, so this value is another than GitHub's, and the same from one run to the next.
  it("hashes the files patterns name in sorted order, and gives nothing when they name none", () => {
    const files: Readonly<Record<string, string>> = {
      "lock.json": "root\n",
      "pkg/a/lock.json": "a\n",
      "pkg/b/lock.json": "b\n",
      "vendor/x/lock.json": "vendored\n",
      "pkg/a/other.txt": "other\n"
    }
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(at.repo, name, ".."), { recursive: true })
      writeFileSync(join(at.repo, name), text)
    }
    const glob = (take: ReadonlyArray<string>, leave: ReadonlyArray<string> = []): Residual =>
      named(`glob:${JSON.stringify({ take, leave })}`)
    const hashed = (...names: ReadonlyArray<string>): string =>
      `[${createHash("sha256").update(Buffer.concat(names.map((name) => sha256(files[name]!)))).digest("hex")}]`
    const locks = "^(.*/)?lock\\.json(/.*)?$"
    pass({ first: true }, "true")
    expect(valueOf(glob([locks]))).toBe(hashed("lock.json", "pkg/a/lock.json", "pkg/b/lock.json", "vendor/x/lock.json"))
    expect(valueOf(glob([locks], ["^vendor/.*(/.*)?$", "^pkg/b(/.*)?$"]))).toBe(hashed("lock.json", "pkg/a/lock.json"))
    expect(valueOf(glob(["^pkg/a(/.*)?$", "^lock\\.json(/.*)?$"]))).toBe(
      hashed("lock.json", "pkg/a/lock.json", "pkg/a/other.txt")
    )
    expect(valueOf(glob(["^none(/.*)?$"]))).toBe("[]")
    expect(valueOf(glob([locks], ["^.*$"]))).toBe("[]")
    const ordered = { take: [locks, "^pkg/a/lock"], leave: ["^pkg/"], order: [0, -1, 1] }
    expect(valueOf(named(`glob:${JSON.stringify(ordered)}`))).toBe(
      hashed("lock.json", "pkg/a/lock.json", "vendor/x/lock.json")
    )
    writeFileSync(join(at.repo, "line\nbreak"), "one file")
    const literal = named(`hash:${JSON.stringify(["line\nbreak"])}`)
    expect(valueOf(glob(["^line[^/]*break$"]))).toBe(valueOf(literal))
    expect(valueOf(literal)).toBe(`[${createHash("sha256").update(sha256("one file")).digest("hex")}]`)
    // A file no pattern names changes nothing, and one that a pattern names changes the value.
    writeFileSync(join(at.repo, "pkg/a/other.txt"), "changed\n")
    expect(valueOf(glob([locks]))).toBe(hashed("lock.json", "pkg/a/lock.json", "pkg/b/lock.json", "vendor/x/lock.json"))
    writeFileSync(join(at.repo, "pkg/b/lock.json"), "changed\n")
    expect(valueOf(glob([locks]))).not.toBe(
      hashed("lock.json", "pkg/a/lock.json", "pkg/b/lock.json", "vendor/x/lock.json")
    )
  })

  it("preserves delimiter lines and quotes in a workflow name", () => {
    const name = "A team's workflow\n__SMITHERS_CI_LIB__\nlast line"
    expect(pass({ alone: true }, "printf %s \"$GITHUB_WORKFLOW\"", {
      job: job({ variables: { GITHUB_WORKFLOW: name } })
    })).toBe(name)
  })

  it("refuses an unrepresentable matrix axis before emitting a wrapper", () => {
    expect(write(job({ matrixKeys: ["node version"] }), defaults, "true")).toHaveProperty("problem")
  })

  it("fills in matrix values and keeps each variant's state apart", () => {
    const matrixJob = job({ matrixKeys: ["os"] })
    const linux = { job: matrixJob, variant: { os: "linux" } }
    pass({ first: true }, `echo "WHO=\${{ matrix.os }}" >> "$GITHUB_ENV"`, linux)
    expect(valueOf(named("matrix:os"), linux)).toBe("[linux]")
    expect(pass({}, `echo "$WHO"`, linux)).toBe("linux\n")
    const mac = run({}, "echo ran", { job: matrixJob, variant: { os: "mac" } })
    expect(mac.status).toBe(1)
    expect(mac.stderr).toContain("the first step of this job has not run")
  })

  // Contexts: github.event.before is 40 zeros for a commit with no parent.
  it("fails a base that does not exist and gives 40 zeros for before at a root commit", () => {
    at = place(1)
    pass({ first: true }, "true", { job: job({ event: JSON.stringify({ before: parentMark }) }) })
    expect(pass({ commit: true }, `cat "$GITHUB_EVENT_PATH"`)).toBe(`{"before":"${"0".repeat(40)}"}\n`)
    expect(valueOf(named("before"))).toBe(`[${"0".repeat(40)}]`)
    const ran = run({ fills: [["@B@", named("base:the pull request")]] }, "echo @B@")
    expect(ran.status).toBe(1)
    expect(ran.stdout).toBe("")
    expect(ran.stderr).toContain("smithers-ci: this commit has no parent to stand for the base of the pull request")
  })

  // Variables: a job's env is replaced by GITHUB_ENV, and a step's env replaces both.
  it("exports outer variables before GITHUB_ENV and the step's env after it", () => {
    pass(
      { key: "SET", first: true },
      `printf 'X=from-env\\nY=from-env\\n' >> "$GITHUB_ENV"; echo V=out >> "$GITHUB_OUTPUT"`
    )
    const stdout = pass(
      {
        outer: [
          ["X", ["outer"]],
          ["Z", ["pre-", { residual: output("V"), written: "${{ steps.set.outputs.v }}" }, "-post"]]
        ],
        env: [["Y", ["step's"]]]
      },
      `printf '%s\\n' "$X" "$Y" "$Z"`
    )
    expect(stdout).toBe("from-env\nstep's\npre-out-post\n")
  })

  // "Workflow syntax: jobs.<job_id>.steps[*].working-directory": a directory of the repository.
  it("enters a directory decided while the job runs, and stops at one that is not in the repository", () => {
    mkdirSync(join(at.repo, "packages/app"), { recursive: true })
    pass(
      { key: "SET", first: true },
      `printf 'IN=packages/app\\nOUT=../..\\nGONE=nowhere\\nABS=/tmp\\n' >> "$GITHUB_OUTPUT"`
    )
    const at_ = (name: string): Partial<StepFacts> => ({ directory: [{ residual: output(name), written: "" }] })
    expect(pass(at_("IN"), "pwd")).toBe(`${join(at.repo, "packages/app")}\n`)
    expect(pass({ directory: [{ residual: named("workspace"), written: "" }, "/packages/app"] }, "pwd")).toBe(
      `${join(at.repo, "packages/app")}\n`
    )
    expect(pass({ directory: [{ residual: named("workspace"), written: "" }] }, "pwd")).toBe(`${at.repo}\n`)
    expect(pass({ directory: [] }, "pwd")).toBe(`${at.repo}\n`)
    expect(run(at_("OUT"), "pwd").stderr).toBe("smithers-ci: the step's directory ../.. is outside the repository\n")
    expect(run(at_("ABS"), "pwd").stderr).toBe("smithers-ci: the step's directory /tmp is outside the repository\n")
    expect(run(at_("GONE"), "pwd").stderr).toBe("smithers-ci: the step's directory nowhere is not in the repository\n")
  })

  // "Contexts: inputs": the values an action is given are worked out when the action starts.
  it("works a value out once and keeps it for later steps, whatever changes after", () => {
    pass({ key: "SET", first: true }, `echo "FOO=one" >> "$GITHUB_ENV"`)
    const foo = named(`env:${JSON.stringify({ name: "FOO", held: null })}`, true)
    const keeps: StepFacts["keeps"] = [["ACT.0", [{ residual: foo, written: "" }]], ["ACT.1", ["plain"]], ["ACT.2", []]]
    pass({ keeps }, `echo "FOO=two" >> "$GITHUB_ENV"`)
    expect(valueOf(foo)).toBe("[two]")
    expect(valueOf(named("kept:ACT.0"))).toBe("[one]")
    expect(valueOf(named("kept:ACT.1"))).toBe("[plain]")
    expect(valueOf(named("kept:ACT.2"))).toBe("[]")
  })

  it("reads a variable of the job as the step finds it once GITHUB_ENV is loaded", () => {
    pass({ first: true }, `echo "LEVEL=written" >> "$GITHUB_ENV"`)
    const level = named("process:LEVEL")
    expect(valueOf(level, { env: { LEVEL: "job" } })).toBe("[written]")
    expect(valueOf(named("process:OTHER"), { env: { OTHER: "job" } })).toBe("[job]")
    expect(valueOf(named("process:UNSET"))).toBe("[]")
  })

  // "Variables: Default environment variables": CI is always true, and a workflow may set it to something else.
  // What the machine holds under that name is the person's, and Smithers build passes the machine's `CI` on to
  // every step: the step is told `true` all the same.
  it("sets CI to true whatever the machine holds, unless the workflow sets it", () => {
    pass({ first: true }, `test "$CI" = true`)
    expect(pass({}, `echo "[$CI]"`, { env: { CI: "1" } })).toBe("[true]\n")
    expect(pass({}, `echo "[$CI]"`, { env: { CI: "" } })).toBe("[true]\n")
    // The workflow's own value is in the step's environment when it starts, and stays.
    expect(pass({ ownCi: true }, `echo "[$CI]"`, { env: { CI: "false" } })).toBe("[false]\n")
    expect(pass({ ownCi: true }, `echo "[$CI]"`, { env: { CI: "" } })).toBe("[]\n")
    expect(pass({ ownCi: true }, `echo "[$CI]"`)).toBe("[true]\n")
  })

  // Turbo reports its use to a server unless `DO_NOT_TRACK` is 1 (turbo.build/repo/docs/telemetry). The call decides
  // nothing a step does, but a step that made it cannot be reused. A runner does not set the variable: a workflow
  // that sets it keeps its own value, and the machine's own value never reaches a step.
  // Wrangler sends usage metrics unless `WRANGLER_SEND_METRICS` is false (workers-sdk/packages/wrangler/telemetry.md),
  // and its banner asks npm for a newer version unless `WRANGLER_HIDE_BANNER` is true (Wrangler's system environment
  // variables). Measured on eliza's `wrangler deploy --dry-run`: 74 connections, 26 with metrics off, 0 with both.
  it("tells every tool not to report its use, unless the workflow says otherwise", () => {
    pass({ first: true }, `test "$DO_NOT_TRACK" = 1`)
    const all = `echo "[$DO_NOT_TRACK $WRANGLER_SEND_METRICS $WRANGLER_HIDE_BANNER]"`
    expect(pass({}, all)).toBe("[1 false true]\n")
    const persons = { DO_NOT_TRACK: "0", WRANGLER_SEND_METRICS: "true", WRANGLER_HIDE_BANNER: "false" }
    expect(pass({}, all, { env: persons })).toBe("[1 false true]\n")
    expect(pass({ ownQuiet: ["DO_NOT_TRACK"] }, all, { env: persons })).toBe("[0 false true]\n")
    expect(pass({ ownQuiet: ["WRANGLER_SEND_METRICS", "WRANGLER_HIDE_BANNER"] }, all, { env: persons })).toBe(
      "[1 true false]\n"
    )
    expect(pass({ ownQuiet: ["DO_NOT_TRACK"] }, `echo "[\${DO_NOT_TRACK-unset}]"`)).toBe("[unset]\n")
  })

  // GitHub fills every `${{ }}` of a script in one pass: a value that holds the text of another is left as it is.
  it("puts each value in its place once, even one that holds another's text or a slash", () => {
    pass({ key: "SET", first: true }, `printf 'A=\${{ b }}\\nB=second\\nS=a/b\\n' >> "$GITHUB_OUTPUT"`)
    const fills: StepFacts["fills"] = [
      ["${{ a }}", output("A")],
      ["${{ b }}", output("B")],
      ["${{ format('{0}/it''s', s) }}", output("S")]
    ]
    const command = `printf '%s\\n' 'a=\${{ a }} b=\${{ b }} \${{ b }}' "\${{ format('{0}/it''s', s) }}"`
    expect(pass({ fills }, command)).toBe("a=${{ b }} b=second second\na/b\n")
  })

  // GitHub compares text without case in every alphabet. Here only a to z are folded, so text with other letters
  // that differs is not decided: the step stops, and never takes the wrong side.
  it("stops a step that compares text with letters beyond a to z, unless the two are equal as written", () => {
    pass(
      { key: "SET", first: true },
      `printf 'E=\\303\\251\\nUP=\\303\\211\\nWORD=caf\\303\\251\\n' >> "$GITHUB_OUTPUT"`
    )
    expect(pass({ condition: binary("==", output("E"), literal("é")) }, "echo ran")).toBe("ran\n")
    expect(pass({ condition: call("contains", output("WORD"), literal("é")) }, "echo ran")).toBe("ran\n")
    expect(pass({ condition: call("endswith", output("WORD"), literal("fé")) }, "echo ran")).toBe("ran\n")
    for (
      const condition of [
        binary("==", output("E"), literal("É")),
        // Only the letters a to z differ here, and the text still holds one that is not: it is not decided either.
        call("startswith", output("WORD"), literal("CAF")),
        call("contains", output("WORD"), literal("É")),
        call("startswith", output("WORD"), literal("é")),
        call("endswith", output("WORD"), literal("É"))
      ]
    ) {
      const ran = run({ condition }, "echo ran")
      expect(ran.status).toBe(1)
      expect(ran.stderr).toBe(
        "smithers-ci: text with letters beyond a to z is compared without case, which only GitHub decides\n"
      )
    }
  })

  // `hashFiles` of a directory takes in every file under it, in an order only the runner's disk decides.
  it("stops a step that hashes a directory", () => {
    mkdirSync(join(at.repo, "dist"))
    writeFileSync(join(at.repo, "dist/a.txt"), "a")
    pass({ first: true }, "true")
    const ran = run({ fills: [["@H@", named(`hash:${JSON.stringify(["dist"])}`)]] }, "echo @H@")
    expect(ran.status).toBe(1)
    expect(ran.stderr).toBe("smithers-ci: hashFiles of the directory dist is worked out only on GitHub\n")
  })

  describe("where a job keeps its state", () => {
    const stateRoot = `/tmp/smithers-ci-runner-${process.getuid?.()}`

    it("keeps it under /tmp whatever a step's own TMPDIR is, in a directory of this user alone", () => {
      pass({ first: true }, `echo "KEPT=yes" >> "$GITHUB_ENV"`)
      expect(pass({}, `echo "$KEPT $RUNNER_TEMP"`, { env: { TMPDIR: "/var/tmp" } })).toMatch(
        new RegExp(`^yes ${stateRoot}/\\d+-\\d+/temp\n$`)
      )
      expect(statSync(stateRoot).mode & 0o077).toBe(0)
    })

    it("keeps it in the temporary directory of the job's machine, where Smithers build made one", () => {
      const machine = join(at.tmp, "machine")
      mkdirSync(machine)
      const env = { SMTHRS_MACHINE_TMP: machine, TMPDIR: "/var/tmp" }
      pass({ first: true }, `echo "KEPT=yes" >> "$GITHUB_ENV"`, { env })
      // The steps of the job find the state there, and the step's own script is not told the variable.
      expect(pass({}, `echo "$KEPT $RUNNER_TEMP \${SMTHRS_MACHINE_TMP-unset}"`, { env })).toMatch(
        new RegExp(`^yes ${machine}/smithers-ci-runner-${process.getuid?.()}/\\d+-\\d+/temp unset\n$`)
      )
      expect(statSync(join(machine, `smithers-ci-runner-${process.getuid?.()}`)).mode & 0o077).toBe(0)
      // The name of the state there holds no path of the checkout: the same job in another checkout, in its own
      // directory, keeps its state under the same name. Under /tmp the two checkouts have two names.
      const other = place(1)
      const elsewhere = join(other.tmp, "machine")
      mkdirSync(elsewhere)
      const tempIn = (cwd: string, own: string | undefined): string =>
        pass({ first: true }, `echo "$RUNNER_TEMP"`, {
          cwd,
          env: own === undefined ? {} : { SMTHRS_MACHINE_TMP: own }
        }).trim()
      expect(tempIn(other.repo, elsewhere).slice(elsewhere.length)).toBe(tempIn(at.repo, machine).slice(machine.length))
      expect(tempIn(other.repo, undefined)).not.toBe(tempIn(at.repo, undefined))
      // The state there holds no path either, where one under /tmp holds its checkout's.
      const rootOf = (temp: string): string => readFileSync(join(temp, "..", "root"), "utf8")
      expect(rootOf(tempIn(at.repo, machine))).toBe("")
      expect(rootOf(tempIn(at.repo, undefined))).toBe(at.repo)
      // A directory that cannot be written is not the job's own: the state goes under /tmp, named after the place.
      expect(tempIn(at.repo, "/proc")).toBe(tempIn(at.repo, undefined))
    })

    it("keeps interleaved workflow runs in the same checkout independent", () => {
      const invocation = (id: string) => ({ env: { GITHUB_RUN_ID: id, GITHUB_RUN_ATTEMPT: "1", VALUE: id } })
      const start = "printf \"HELD=%s\\n\" \"$VALUE\" >> \"$GITHUB_ENV\""
      pass({ first: true, job: "build" }, start, invocation("21"))
      pass({ first: true, job: "build" }, start, invocation("22"))
      expect(pass({ before: ["STEP"] }, "printf %s \"$HELD\"", invocation("21"))).toBe("21")
      expect(pass({ before: ["STEP"] }, "printf %s \"$HELD\"", invocation("22"))).toBe("22")
    })

    it("reclaims a dead local invocation and expires an inactive workflow after a week", () => {
      const start = (id?: string) => {
        const env = id === undefined ? {} : { GITHUB_RUN_ID: id }
        return join(pass({ first: true, job: "build" }, "echo \"$RUNNER_TEMP\"", { env }).trim(), "..")
      }
      const local = start()
      const legacy = start("20")
      rmSync(join(legacy, "owner"))
      const workflow = start("21")
      expect(readFileSync(join(local, "owner"), "utf8").trim()).toBe(String(process.pid))
      expect(readFileSync(join(workflow, "owner"), "utf8").trim()).toBe(`workflow ${process.pid}`)
      const exited = spawnSync("sh", ["-c", "true"]).pid
      writeFileSync(join(local, "owner"), `${exited}\n`)
      writeFileSync(join(workflow, "owner"), `workflow ${exited}\n`)

      start("22")
      expect(existsSync(local)).toBe(false)
      expect(existsSync(workflow)).toBe(true)
      expect(existsSync(legacy)).toBe(true)
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
      utimesSync(join(workflow, "owner"), old, old)
      utimesSync(join(legacy, "root"), old, old)
      start("23")
      expect(existsSync(workflow)).toBe(false)
      expect(existsSync(legacy)).toBe(false)
    })

    it("keeps concurrently started workflow states while both jobs sweep a dead owner", () => {
      const state = join(pass({ first: true, job: "build" }, "echo \"$RUNNER_TEMP\"").trim(), "..")
      writeFileSync(join(state, "owner"), `${spawnSync("sh", ["-c", "true"]).pid}\n`)
      const command = "echo \"$RUNNER_TEMP\""
      const written = write(job(), { ...defaults, after: undefined }, command)
      if ("problem" in written) throw new Error(written.problem)
      const both = spawnSync("bash", [
        "-c",
        [
          "GITHUB_RUN_ID=first bash -c \"$1\" > \"$TMPDIR/first\" & a=$!",
          "GITHUB_RUN_ID=second bash -c \"$1\" > \"$TMPDIR/second\" & b=$!",
          "wait \"$a\" && wait \"$b\""
        ].join("\n"),
        "runs",
        script({ command, runner: written.text })
      ], {
        cwd: at.repo,
        env: { HOME: at.home, TMPDIR: at.tmp, PATH: process.env.PATH },
        encoding: "utf8"
      })
      expect(both.stderr).toBe("")
      expect(both.status).toBe(0)
      const states = ["first", "second"].map((id) => readFileSync(join(at.tmp, id), "utf8").trim())
      expect(new Set(states).size).toBe(2)
      expect(states.every((temp) => existsSync(temp))).toBe(true)
      expect(existsSync(state)).toBe(false)
    })

    it("removes the state of a checkout that is gone when the next job starts", () => {
      const gone = place(1)
      const temp = pass({ first: true }, `echo "$RUNNER_TEMP"`, { cwd: gone.repo }).trim()
      expect(existsSync(temp)).toBe(true)
      rmSync(gone.repo, { recursive: true, force: true })
      pass({ first: true }, "true")
      expect(existsSync(temp)).toBe(false)
    })

    it("stops when the job's state cannot be named", () => {
      // A `cksum` that prints nothing would name every job's state alike.
      const bin = join(at.home, "bin")
      mkdirSync(bin)
      writeFileSync(join(bin, "cksum"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      const ran = run({ first: true }, "echo ran", { env: { PATH: `${bin}:${process.env.PATH}` } })
      expect(ran).toEqual({
        status: 1,
        stdout: "",
        stderr: "smithers-ci: cksum gave no checksum to name the job's state with\n"
      })
    })

    it("keeps two variants apart whose values run together the same way", () => {
      const pair = job({ matrixKeys: ["a", "b"] })
      const first = pass({ first: true }, `echo "$RUNNER_TEMP"`, { job: pair, variant: { a: "x y", b: "z" } })
      const second = pass({ first: true }, `echo "$RUNNER_TEMP"`, { job: pair, variant: { a: "x", b: "y z" } })
      expect(first).not.toBe(second)
      // A value may hold the very text that parts two values.
      const temp = (variant: Readonly<Record<string, string>>): string =>
        pass({ first: true }, `echo "$RUNNER_TEMP"`, { job: pair, variant })
      expect(temp({ a: "1", b: "2|b=3" })).not.toBe(temp({ a: "1|b=2", b: "3" }))
      expect(temp({ a: "1", b: "2|b=1:3" })).not.toBe(temp({ a: "1|b=1:2", b: "3" }))
    })

    // Two first steps that start together: one reads the other's `root` before it is written. A state whose
    // place cannot be read is being written, and is not the state of a checkout that is gone.
    it("leaves alone a state whose place is not written yet", () => {
      const half = join(stateRoot, `half-${process.pid}`)
      mkdirSync(half, { recursive: true })
      writeFileSync(join(half, "root"), "")
      // Every checkout of this user keeps its states in the one directory, and a step of an older smithers-ci
      // may remove this one. So the test reads what this step asked `rm` to remove, not what is left.
      const real = spawnSync("sh", ["-c", "command -v rm"], { encoding: "utf8" }).stdout.trim()
      const removed = join(at.tmp, "removed")
      const bin = join(at.tmp, "bin")
      mkdirSync(bin)
      writeFileSync(join(bin, "rm"), `#!/bin/sh\necho "$@" >> ${quote(removed)}\nexec ${quote(real)} "$@"\n`, {
        mode: 0o755
      })
      try {
        pass({ first: true }, "true", { env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` } })
        expect(existsSync(removed) ? readFileSync(removed, "utf8") : "").not.toContain(half)
      } finally {
        rmSync(half, { recursive: true, force: true })
      }
    })

    // `go mod download` leaves directories nothing can be written into.
    it("empties RUNNER_TEMP when a step left a read-only directory in it", () => {
      const cache =
        `mkdir -p "$RUNNER_TEMP/mod/pkg"; echo x > "$RUNNER_TEMP/mod/pkg/file"; chmod 555 "$RUNNER_TEMP/mod/pkg"`
      for (const _ of [1, 2]) {
        expect(pass({ first: true }, `ls "$RUNNER_TEMP"; ${cache}`)).toBe("")
        expect(pass({}, `ls "$RUNNER_TEMP"; echo "LATER=1" >> "$GITHUB_ENV"`)).toBe("mod\n")
        expect(pass({}, `echo "$LATER"`)).toBe("1\n")
      }
    })

    // A file of the first step that cannot be read stops the copy. Nothing half-made is left.
    it("leaves no half-made state when the job's state cannot be started", () => {
      const mine = (): ReadonlyArray<string> =>
        readdirSync(stateRoot).filter((name) => {
          const place = join(stateRoot, name, "root")
          return existsSync(place) && readFileSync(place, "utf8") === at.repo
        })
      pass({ first: true }, `echo x > "$RUNNER_TEMP/secret"; chmod 000 "$RUNNER_TEMP/secret"`)
      const ran = run({}, "echo ran")
      expect(ran.status).toBe(1)
      expect(ran.stdout).toBe("")
      expect(mine()).toHaveLength(1)
    })
  })

  it("diagnoses invalid runner variables independently of expression depth", () => {
    expect(write(job(), { ...defaults, fills: [["value", named("future-kind")]] }, "true")).toEqual({
      problem: "the expression names an unknown runner variable"
    })
    expect(write(job(), { ...defaults, fills: [["value", named("hash:invalid")]] }, "true")).toEqual({
      problem: "the expression carries malformed runner data"
    })
  })

  it("analyzes a repeated operand a bounded number of times per occurrence", () => {
    let reads = 0
    const name = { id: "process:VALUE", name: "VALUE", typed: false, nullable: false }
    const operand: Residual = {
      kind: "variable",
      get variable() {
        reads += 1
        return name
      }
    }
    let chain = operand as Residual
    const length = 200
    for (let index = 1; index < length; index += 1) chain = binary("||", chain, operand)
    const written = write(job({ variants: [{}] }), { ...defaults, condition: chain }, "true")
    expect("text" in written).toBe(true)
    expect(reads).toBeLessThan(4 * length)
  })

  it("refuses an expression nested too deep to finish in a shell", () => {
    let deep: Residual = output("V")
    for (let depth = 0; depth < 20_000; depth += 1) deep = not(deep)
    expect(write(job(), { ...defaults, condition: deep }, "true")).toEqual({
      problem: "it nests too deep to finish in a shell"
    })
  })

  // jobs.<job_id>.steps[*].shell: bash runs as `bash -e {0}`, and the default as
  // `bash --noprofile --norc -eo pipefail {0}`.
  it("runs the command with the step's shell", () => {
    pass({ first: true }, "true")
    expect(run({}, "false | true; echo after")).toEqual({ status: 0, stdout: "after\n", stderr: "" })
    const piped = run({ start: ["bash", "--noprofile", "--norc", "-eo", "pipefail"] }, "false | true; echo after")
    expect(piped).toEqual({ status: 1, stdout: "", stderr: "" })
  })

  // jobs.<job_id>.steps[*].working-directory.
  it("runs a step in a subdirectory of the repository", () => {
    const app = join(at.repo, "packages", "app")
    mkdirSync(app, { recursive: true })
    pass({ first: true }, `echo FROM_ROOT=1 >> "$GITHUB_ENV"`)
    expect(pass({ cwd: "packages/app" }, `printf '%s\\n' "$PWD" "$GITHUB_WORKSPACE" "$FROM_ROOT"`, { cwd: app }))
      .toBe(`${app}\n${at.repo}\n1\n`)
  })

  // A `working-directory` that is a symbolic link: the step is started in the directory the link names, whose
  // path does not end with the link's. The root is found without git, so also in a tree that has no `.git`: git
  // is asked for the commit alone, and a tree with none runs the step without one.
  it("finds the repository when the step's directory is reached through a link, without asking git", () => {
    const plain = mkdtempSync(join(tmpdir(), "smithers-runner-export-"))
    roots.push(plain)
    const tree = realpathSync(plain)
    mkdirSync(join(tree, "real", "deep"), { recursive: true })
    symlinkSync("real/deep", join(tree, "link"))
    const asked = join(at.tmp, "asked")
    const bin = join(at.tmp, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> ${quote(asked)}\nexit 1\n`, { mode: 0o755 })
    const options = { cwd: join(tree, "real", "deep"), env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` } }
    expect(pass({ first: true, cwd: "link" }, `printf '%s\\n' "$GITHUB_WORKSPACE" "$PWD"`, options)).toBe(
      `${tree}\n${join(tree, "real", "deep")}\n`
    )
    // The runner text asks which commit is checked out with a git marked as its own: what it reads is no step's.
    expect(readFileSync(asked, "utf8")).toBe(`-c ${commitQuestion} -C ${tree} rev-parse --verify --quiet HEAD\n`)
    // A step that names the commit asks git itself: what it reads is the step's.
    rmSync(asked)
    expect(run({ first: true, cwd: "link", commit: true }, "echo $GITHUB_SHA", options).status).toBe(1)
    expect(readFileSync(asked, "utf8")).toBe(`-C ${tree} rev-parse --verify --quiet HEAD\n`)
    const outside = run({ first: true, cwd: "packages/app" }, "echo ran", { cwd: at.tmp })
    expect(outside.status).toBe(1)
    expect(outside.stdout).toBe("")
    expect(outside.stderr).toContain(`smithers-ci: ${at.tmp} is not packages/app in a repository`)
  })

  // A failed step fails the job: its exit status is the step's, and what it wrote is not passed on.
  it("gives a failing command's exit status and records no outcome", () => {
    pass({ first: true }, "true")
    const failed = run({ key: "FAIL" }, `echo LATE=1 >> "$GITHUB_ENV"; echo out=1 >> "$GITHUB_OUTPUT"; exit 3`)
    expect(failed.status).toBe(3)
    expect(valueOf(named("outcome:FAIL"))).toBe("[]")
    expect(valueOf(named("output:FAIL/OUT", true))).toBe("[]")
    expect(pass({}, `echo "[\${LATE-unset}]"`)).toBe("[unset]\n")
  })

  it("replaces every copy of a ${{ }} text in the command with its value", () => {
    pass({ key: "SET", first: true }, `printf 'V=a&b\\\\c\\n' >> "$GITHUB_OUTPUT"`)
    const stdout = pass({ fills: [["${{ v }}", output("V")]] }, `printf '%s\\n' '\${{ v }}' '\${{ v }}'`)
    expect(stdout).toBe("a&b\\c\na&b\\c\n")
  })

  it("says when an expression is true or false whatever its variables hold", () => {
    expect(settled(binary("&&", output("V"), literal(false)))).toBe(false)
    expect(settled(binary("||", output("V"), literal("fallback")))).toBe(true)
    expect(settled(binary("==", output("V"), literal("a")))).toBeUndefined()
    expect(settled(binary("||", output("V"), literal(["a"])))).toBeUndefined()
  })

  it("quotes a word for a shell", () => {
    expect(quote("it's")).toBe(`'it'\\''s'`)
    expect(existsSync(at.repo)).toBe(true)
  })

  describe("a job's first step", () => {
    // Two jobs that start with the same step run it once in one checkout. What it left is each job's to start from.
    it("has the same text for two jobs that start alike, and leaves each job a state of its own", () => {
      const facts: Facts = { key: "INSTALL", first: true }
      const install =
        `echo "TOOL=ready" >> "$GITHUB_ENV"; echo "at=first" >> "$GITHUB_OUTPUT"; echo x > "$RUNNER_TEMP/made"`
      const lint = write(
        job({ id: "ci.yml:lint" }),
        { ...defaults, ...facts, after: undefined, job: undefined },
        install
      )
      const test = write(
        job({ id: "ci.yml:test" }),
        { ...defaults, ...facts, after: undefined, job: undefined },
        install
      )
      expect(lint).toEqual(test)
      // Another command, or another job named to it, is other work: it leaves its own state.
      const other = write(job({ id: "ci.yml:lint" }), { ...defaults, ...facts, after: undefined }, install)
      const told = write(job(), { ...defaults, ...facts, after: undefined, job: undefined }, "echo other")
      expect(new Set([lint, other, told].map((written) => "mark" in written ? written.mark : "")).size).toBe(3)

      pass(facts, install)
      const from = named("output:INSTALL/AT", true)
      const seen = (id: string, command: string) =>
        pass({ fills: [["@AT@", from]] }, command, { job: job({ id }) }).trim()
      const read = `echo "@AT@ $TOOL $(cat "$RUNNER_TEMP/made") $GITHUB_JOB"`
      expect(seen("ci.yml:lint", `${read}; echo "TOOL=lint" >> "$GITHUB_ENV"`)).toBe("first ready x build")
      // What `lint` set after the shared step is not `test`'s.
      expect(seen("ci.yml:test", read)).toBe("first ready x build")
      expect(seen("ci.yml:lint", read)).toBe("first lint x build")
    })

    // Nothing reads what the only step of a job leaves. It leaves nothing, and it looks at no state but its own,
    // so what it reads does not change with what other jobs leave beside it.
    it("leaves no state when it is the only step of its job, whether it passes or fails", () => {
      const base = join("/tmp", `smithers-ci-runner-${process.getuid?.() ?? ""}`)
      const states = (): ReadonlyArray<string> =>
        readdirSync(base).filter((name) => {
          const root = join(base, name, "root")
          return existsSync(root) && readFileSync(root, "utf8") === at.repo
        })
      const show = `echo "$GITHUB_WORKSPACE"; test -d "$RUNNER_TEMP" && echo "A=1" >> "$GITHUB_ENV"`
      expect(pass({ alone: true, job: undefined }, show)).toBe(`${at.repo}\n`)
      expect(states()).toEqual([])
      expect(run({ alone: true, job: undefined }, "exit 3").status).toBe(3)
      expect(states()).toEqual([])
      // The same step with a step after it is other work, and leaves its state for that step.
      const written = write(job(), { ...defaults, after: undefined, job: undefined }, show)
      expect("text" in written && written.text !== written.alone).toBe(true)
      pass({ first: true, job: undefined }, show)
      expect(states()).toHaveLength(1)
      expect(pass({}, `echo "$A"`)).toBe("1\n")
    })

    // "RUNNER_TEMP is emptied at the beginning of each job": a job that starts again starts from nothing.
    it("starts every job that follows it anew each time it runs", () => {
      pass({ first: true }, `echo "RUN=one" >> "$GITHUB_ENV"`)
      pass({}, `echo "LATER=kept" >> "$GITHUB_ENV"; echo x > "$RUNNER_TEMP/left"`)
      expect(pass({}, `echo "$RUN $LATER"`)).toBe("one kept\n")
      pass({ first: true }, `echo "RUN=two" >> "$GITHUB_ENV"`)
      expect(pass({}, `echo "$RUN [\${LATER-}] $(ls "$RUNNER_TEMP")"`)).toBe("two [] \n")
    })

    // The splitter turns one step into several, each with the step's runner text. The ones split from a job's
    // second step all start from what the first step left, and each keeps what the ones before it wrote.
    it("is copied once for the steps split from the job's second step", () => {
      pass({ key: "INSTALL", first: true }, `echo "FROM=first" >> "$GITHUB_ENV"`)
      const part = (command: string): string => pass({ key: "TEST", second: true }, command, { part: true })
      expect(part(`echo "$FROM"; echo a > "$RUNNER_TEMP/a.log"; echo "A=done" >> "$GITHUB_ENV"`)).toBe("first\n")
      expect(part(`echo "$FROM $A"; echo b > "$RUNNER_TEMP/b.log"`)).toBe("first done\n")
      expect(pass({}, `ls "$RUNNER_TEMP"`)).toBe("a.log\nb.log\n")
      // The first step runs again: the job starts from nothing but what that step leaves.
      pass({ key: "INSTALL", first: true }, `echo "FROM=first" >> "$GITHUB_ENV"`)
      expect(part(`echo "$FROM [\${A-}] $(ls "$RUNNER_TEMP")"; echo "A=again" >> "$GITHUB_ENV"`)).toBe("first [] \n")
      // The workflow changes and the job starts with another step: what the job had is not carried over.
      pass({ key: "INSTALL", first: true }, `echo "FROM=changed" >> "$GITHUB_ENV"`)
      expect(part(`echo "$FROM [\${A-}]"`)).toBe("changed []\n")
    })

    // Three jobs start with the same step and one of them needs another, so the step runs twice in one run: once
    // for two of the jobs, and later for the third. The second run takes nothing from a job that is mid-way.
    it("leaves a job that is mid-way its state when it runs again for another job", () => {
      const lint = { job: job({ id: "lint" }) }
      const install = `echo "FROM=first" >> "$GITHUB_ENV"`
      pass({ key: "INSTALL", first: true }, install)
      pass({ key: "KEEP" }, `echo "KEPT=yes" >> "$GITHUB_ENV"; echo x > "$RUNNER_TEMP/made"`, lint)
      pass({ key: "INSTALL", first: true }, install)
      const third = { key: "USE", second: false, before: ["INSTALL", "KEEP"] }
      expect(pass(third, `echo "$FROM $KEPT $(ls "$RUNNER_TEMP")"`, lint)).toBe("first yes made\n")
    })

    // A second step that fails is run again alone. It starts from what the first step left, as it did before.
    it("starts a second step that runs again from what the first step left, with nothing a later step wrote", () => {
      pass({ key: "INSTALL", first: true }, `echo "FROM=first" >> "$GITHUB_ENV"`)
      const second = `echo "$FROM [\${SELF-}] [\${LATER-}] $(ls "$RUNNER_TEMP")"; echo "SELF=1" >> "$GITHUB_ENV"`
      expect(pass({ key: "TWO" }, second)).toBe("first [] [] \n")
      pass({ key: "THREE" }, `echo "LATER=1" >> "$GITHUB_ENV"; echo x > "$RUNNER_TEMP/later"`)
      expect(pass({ key: "TWO", second: true }, second)).toBe("first [] [] \n")
    })

    // The jobs of a baseline run at once in one checkout. `Inventory.script` tells each step its job, and each job
    // keeps what its first step left to itself.
    it("is each job's own where the caller names the job", () => {
      const install = `echo "N=$(cat n.txt)" >> "$GITHUB_ENV"`
      const a = { job: job({ id: "a" }), unit: "a" }
      const b = { job: job({ id: "b" }), unit: "b" }
      writeFileSync(join(at.repo, "n.txt"), "1\n")
      pass({ key: "INSTALL", first: true }, install, a)
      writeFileSync(join(at.repo, "n.txt"), "2\n")
      pass({ key: "INSTALL", first: true }, install, b)
      expect(pass({ second: true }, `echo "$N"`, a)).toBe("1\n")
      expect(pass({ second: true }, `echo "$N"`, b)).toBe("2\n")
    })

    // "Default environment variables: RUNNER_TEMP: the path to a temporary directory on the runner", one for the
    // job. A first step that asks for it is its job's alone, and every step of the job has that one directory.
    it("starts the job's own state when it is given its job, so every step has the same RUNNER_TEMP", () => {
      const temp = pass({ first: true, job: "build" }, `echo "$RUNNER_TEMP"; mkdir "$RUNNER_TEMP/work"`).trim()
      expect(pass({}, `echo "$RUNNER_TEMP"; echo built > "$RUNNER_TEMP/work/artifact"`)).toBe(`${temp}\n`)
      expect(pass({}, `cat "${temp}/work/artifact"`)).toBe("built\n")
      // Run again, it starts the job from nothing.
      expect(pass({ first: true, job: "build" }, `echo "$RUNNER_TEMP"; ls "$RUNNER_TEMP"`)).toBe(`${temp}\n`)
    })

    // "Default environment variables: GITHUB_JOB". A first step is told its job when its caller names it.
    it("is given GITHUB_JOB when its caller names its job, and every later step is", () => {
      expect(pass({ first: true, job: undefined }, `echo "[\${GITHUB_JOB-unset}]"`)).toBe("[unset]\n")
      expect(pass({ first: true, job: "lint" }, `echo "[$GITHUB_JOB]"`)).toBe("[lint]\n")
      expect(pass({ job: "lint" }, `echo "[$GITHUB_JOB]"`)).toBe("[lint]\n")
    })
  })

  // A step that only installs packages is left out of a replay on a machine that has them. The steps around it
  // must run the same with it and without it, so it has no place among them.
  describe("a step a replay may leave out", () => {
    const states = (): ReadonlyArray<string> => {
      const base = join("/tmp", `smithers-ci-runner-${process.getuid?.() ?? ""}`)
      return readdirSync(base).filter((name) => {
        const root = join(base, name, "root")
        return existsSync(root) && readFileSync(root, "utf8") === at.repo
      })
    }

    it("runs before any other step with the runner's variables, and leaves no state", () => {
      const show = `echo "$GITHUB_WORKSPACE $CI"; test -d "$RUNNER_TEMP"`
      expect(pass({ apart: true, job: undefined }, show)).toBe(`${at.repo} true\n`)
      expect(states()).toEqual([])
    })

    it("starts from what the steps before it left, and the steps after it find nothing of it", () => {
      pass({ key: "ONE", first: true }, `echo "A=1" >> "$GITHUB_ENV"; echo x > "$RUNNER_TEMP/one.txt"`)
      const seen = `echo "$A [\${B-}] $(ls "$RUNNER_TEMP")"`
      // Between the first step and the second: it reads what the first left.
      expect(pass({ apart: true }, `${seen}; echo junk > "$RUNNER_TEMP/junk"`)).toBe("1 [] one.txt\n")
      // The step after it is the job's second step, as it is when the step is left out.
      expect(pass({ key: "TWO" }, `${seen}; echo "B=2" >> "$GITHUB_ENV"`)).toBe("1 [] one.txt\n")
      // After the second step: it reads the job's own state.
      expect(pass({ apart: true }, `${seen}; echo junk > "$RUNNER_TEMP/junk"`)).toBe("1 [2] one.txt\n")
      expect(pass({ key: "THREE" }, seen)).toBe("1 [2] one.txt\n")
      // The first step's state and the job's: the step kept its own apart and removed it.
      expect(states()).toHaveLength(2)
    })

    it.each(["GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH"])(
      "stops when it wrote to %s: left out, it could not give later steps that value",
      (file) => {
        const ran = run({ apart: true }, `echo "X=1" >> "$${file}"`)
        expect(ran.status).toBe(1)
        expect(ran.stderr).toBe(
          "smithers-ci: a step that only installs packages wrote a value for later steps, which a replay that "
            + "leaves the step out cannot give them\n"
        )
      }
    )

    it("fails when the steps before it have not run", () => {
      for (const second of [true, false]) {
        const ran = run({ apart: true, after: "none", second }, "echo ran")
        expect(ran.status).toBe(1)
        expect(ran.stdout).toBe("")
        expect(ran.stderr).toContain(`smithers-ci: the steps before this one have not run in ${at.repo}`)
      }
    })
  })

  describe("a step that reads the commit", () => {
    it("says so in its runner text, whether its script names the commit or an expression of it does", () => {
      const noted = (facts: Partial<StepFacts>): boolean => {
        const written = write(job(), { ...defaults, ...facts }, "true")
        return readsCommit({ runner: "text" in written ? written.text : "" })
      }
      expect(noted({})).toBe(false)
      expect(noted({ commit: true })).toBe(true)
      expect(noted({ fills: [["@S@", named("sha")]] })).toBe(true)
      expect(noted({ fills: [["@R@", named("runid")]] })).toBe(true)
      expect(noted({ fills: [["@N@", named("runnumber")]] })).toBe(true)
      expect(noted({ fills: [["@A@", named("runattempt")]] })).toBe(true)
      expect(noted({ condition: binary("==", named("base:the pull request"), literal("x")) })).toBe(true)
      expect(noted({ env: [["BEFORE", [{ residual: named("before"), written: "" }]]] })).toBe(true)
      expect(noted({ fills: [["@W@", named("workspace")]] })).toBe(false)
    })

    // "Default environment variables": a runner sets the commit, the run's id, number and attempt and the event
    // file for every step, whatever its script names. A step no run gave them works them out: the run's number is
    // the count of commits, and its id is made from the commit.
    it("gives every step the commit, the run's numbers and the event file when no run gave them", () => {
      const head = at.git("rev-parse", "HEAD")
      // An event file alone is not a run's: the commit says whether a run gave the step its variables.
      const env = { GITHUB_EVENT_PATH: "/machine.json", GITHUB_JOB: "machine" }
      const show = `echo "$GITHUB_SHA $GITHUB_WORKFLOW_SHA $GITHUB_RUN_ID $GITHUB_RUN_NUMBER $GITHUB_RUN_ATTEMPT `
        + `[\${GITHUB_JOB-unset}]"; cat "$GITHUB_EVENT_PATH"`
      const numbers = `${head} ${head} ${10_000_000_000 + Number.parseInt(head.slice(0, 9), 16)} 2 1`
      const options = { env, job: job({ event: JSON.stringify({ after: commitMark, before: parentMark }) }) }
      const file = `{"after":"${head}","before":"${at.git("rev-parse", "HEAD^")}"}\n`
      expect(pass({ first: true, job: undefined }, show, options)).toBe(`${numbers} [unset]\n${file}`)
      expect(pass({}, show, options)).toBe(`${numbers} [build]\n${file}`)
      // `github.run_id`, `github.run_number` and `github.run_attempt` are what the variables hold.
      const fills: StepFacts["fills"] = [["@I@", named("runid")], ["@N@", named("runnumber")], [
        "@A@",
        named("runattempt")
      ]]
      expect(pass({ fills }, "echo @I@ @N@ @A@")).toBe(
        `${10_000_000_000 + Number.parseInt(head.slice(0, 9), 16)} 2 1\n`
      )
    })

    // A runner, and a replay for the commit it replays, give every step the commit and the run's numbers. The step
    // takes them as given and asks git nothing, so it reads nothing that is another at the next commit.
    it("takes the commit, the run's numbers and the event file from the run that gave them, and never asks git", () => {
      const asked = join(at.tmp, "asked")
      const bin = join(at.tmp, "bin")
      mkdirSync(bin)
      writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> ${quote(asked)}\nexit 1\n`, { mode: 0o755 })
      const events = join(at.tmp, "events")
      mkdirSync(events)
      writeFileSync(join(events, "pull_request.json"), "{\"event\":\"a pull request\"}\n")
      writeFileSync(join(events, "push.json"), "{\"event\":\"a push\"}\n")
      const given = runValues("c".repeat(40), 7)
      const env = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, ...given, [eventsVariable]: events }
      const show = `echo "$GITHUB_SHA $GITHUB_WORKFLOW_SHA $GITHUB_RUN_ID $GITHUB_RUN_NUMBER $GITHUB_RUN_ATTEMPT"; `
        + `cat "$GITHUB_EVENT_PATH"`
      const numbers = `${"c".repeat(40)} ${"c".repeat(40)} ${10_000_000_000 + Number.parseInt("c".repeat(9), 16)} 7 1`
      const options = { env, job: job({ eventName: "pull_request" }) }
      expect(pass({ first: true }, show, options)).toBe(`${numbers}\n{"event":"a pull request"}\n`)
      expect(pass({ commit: true }, show, options)).toBe(`${numbers}\n{"event":"a pull request"}\n`)
      // A workflow no change starts is replayed as a push.
      expect(pass({ first: true }, show, { env })).toBe(`${numbers}\n{"event":"a push"}\n`)
      expect(pass({ fills: [["@S@", named("sha")], ["@N@", named("runnumber")]] }, "echo @S@ @N@", { env })).toBe(
        `${"c".repeat(40)} 7\n`
      )
      // On a GitHub runner no replay wrote an event file: the runner's own stays.
      const runner = { PATH: env.PATH, ...given, GITHUB_EVENT_PATH: join(events, "push.json") }
      expect(pass({ first: true }, show, { env: runner, job: job({ eventName: "pull_request" }) })).toBe(
        `${numbers}\n{"event":"a push"}\n`
      )
      expect(existsSync(asked)).toBe(false)
    })

    // The directory a replay wrote the event files to is told to the runner text and to nothing after it.
    it("gives the step's own script the event file and no variable of the program that runs it", () => {
      const events = join(at.tmp, "events")
      mkdirSync(events)
      writeFileSync(join(events, "push.json"), "{\"event\":\"a push\"}\n")
      const env = { ...runValues("c".repeat(40), 7), [eventsVariable]: events }
      const show = "env | grep -E '^(SMITHERS_|SMTHRS_)' || echo none; cat \"$GITHUB_EVENT_PATH\""
      expect(pass({ first: true }, show, { env })).toBe("none\n{\"event\":\"a push\"}\n")
      expect(pass({}, show, { env })).toBe("none\n{\"event\":\"a push\"}\n")
    })

    // Smithers build reuses a step's result at another commit unless the step's own text names one of the
    // variables a run gives. The text every step starts with therefore names none of them.
    it("names none of the run's variables in a step's text unless the step's own script or expressions do", () => {
      const textOf = (facts: Partial<StepFacts>, command: string): string => {
        const written = write(job({ event: JSON.stringify({ after: commitMark }) }), { ...defaults, ...facts }, command)
        if (!("text" in written)) throw new Error(written.problem)
        return `${script({ command, runner: written.text })}\n${script({ command, runner: written.alone })}`
      }
      // Where the event file is tells as much as the commit: a step held to its files is keyed on the run when
      // its text names that variable too.
      const named_ = (text: string): ReadonlyArray<string> =>
        [...runVariables, "GITHUB_EVENT_PATH"].filter((name) => text.includes(name))
      for (const after of [undefined, "none"]) {
        expect(named_(textOf({ after }, "npm test"))).toEqual([])
        expect(named_(textOf({ after, apart: true }, "npm test"))).toEqual([])
        expect(named_(textOf({ after, limit: 60, action: "lint" }, "npm test"))).toEqual([])
      }
      expect(named_(textOf({ after: undefined, commit: true }, "echo \"$GITHUB_SHA\""))).toEqual(["GITHUB_SHA"])
      expect(named_(textOf({ fills: [["@R@", named("runid")]] }, "echo @R@"))).toEqual(["GITHUB_RUN_ID"])
      expect(named_(textOf({ after: undefined, commit: true }, "cat \"$GITHUB_EVENT_PATH\""))).toEqual([
        "GITHUB_EVENT_PATH"
      ])
      expect(named_(textOf({ fills: [["@S@", named("sha")]] }, "echo @S@"))).toEqual(["GITHUB_SHA"])
    })

    // Each step writes the event file into the state it runs in. A job's own state starts without the file its
    // first step was given, so no step reads the event of another commit.
    it("writes the event file for itself, in the state it runs in", () => {
      const event = JSON.stringify({ after: commitMark })
      const head = at.git("rev-parse", "HEAD")
      const options = { job: job({ event }) }
      const show = `echo "$GITHUB_EVENT_PATH"; cat "$GITHUB_EVENT_PATH"`
      const [first, ...shown] = pass({ first: true }, show, options).split("\n")
      expect(shown).toEqual([`{"after":"${head}"}`, ""])
      const [later, ...again] = pass({}, show, options).split("\n")
      expect(again).toEqual(shown)
      expect(later).not.toBe(first)
      expect(pass({}, `echo "$GITHUB_EVENT_PATH"`, options)).toBe(`${later}\n`)
    })

    // A shallow checkout whose history git cannot count still has a commit: the run's number is then 1.
    it("numbers the run 1 where git cannot count the commits", () => {
      const bin = join(at.tmp, "bin")
      mkdirSync(bin)
      const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
      writeFileSync(
        join(bin, "git"),
        `#!/bin/sh\ncase " $* " in *" rev-list "*) exit 1;; esac\nexec ${quote(real)} "$@"\n`,
        { mode: 0o755 }
      )
      const env = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }
      expect(pass({ first: true }, `echo "$GITHUB_SHA $GITHUB_RUN_NUMBER"`, { env })).toBe(
        `${at.git("rev-parse", "HEAD")} 1\n`
      )
    })

    // "Default environment variables: GITHUB_ACTION", "GITHUB_ARTIFACTS", "GITHUB_ARTIFACTS_LIST", and the
    // variables only GitHub can fill, which the job's own values replace.
    it("gives a step its own name, the files artifacts are declared in, and the job's stand-in values", () => {
      const options = {
        job: job({ standIns: { GITHUB_HEAD_REF: "smithers-ci", GITHUB_ACTIONS: "stand-in" } })
      }
      const show = `echo "[\${GITHUB_ACTION-unset}] $GITHUB_HEAD_REF $GITHUB_ACTIONS"; cat "$GITHUB_ARTIFACTS_LIST"; `
        + `test ! -s "$GITHUB_ARTIFACTS" && echo " empty"; echo x >> "$GITHUB_ARTIFACTS"`
      expect(pass({ first: true, action: "lint" }, show, options)).toBe("[lint] smithers-ci true\n{} empty\n")
      expect(pass({}, show, options)).toBe("[unset] smithers-ci true\n{} empty\n")
    })

    // A later step run alone at a new commit, as a step that failed is: the event file is that commit's.
    it("writes the event file anew each time, for the commit it runs at", () => {
      const options = { job: job({ event: JSON.stringify({ after: commitMark }) }) }
      const show = `cat "$GITHUB_EVENT_PATH"`
      pass({ first: true }, "true", options)
      expect(pass({ commit: true }, show, options)).toBe(`{"after":"${at.git("rev-parse", "HEAD")}"}\n`)
      writeFileSync(join(at.repo, "a.txt"), "another commit\n")
      at.git("commit", "-qam", "another")
      expect(pass({ commit: true }, show, options)).toBe(`{"after":"${at.git("rev-parse", "HEAD")}"}\n`)
    })

    it("fails where git cannot be read, and any other step runs with no commit set", () => {
      const plain = mkdtempSync(join(tmpdir(), "smithers-runner-plain-"))
      try {
        const at = { cwd: plain }
        const without = run({ first: true }, `echo "[\${GITHUB_SHA-unset}]"`, at)
        expect(without.stdout).toBe("[unset]\n")
        const needs = run({ first: true, commit: true }, "echo ran", at)
        expect(needs.status).toBe(1)
        expect(needs.stderr).toContain("this step reads the commit, and git cannot be read in")
      } finally {
        rmSync(plain, { recursive: true, force: true })
      }
    })
  })

  describe("an expression over the matrix", () => {
    const go = named("matrix:go", false, true)
    const os = named("matrix:os")
    const variants = [{ os: "linux", go: "17" }, { os: "mac", go: "17" }, { os: "mac", go: "24" }]
    const matrix = job({ matrixKeys: ["go", "os"], variants })
    const at = (variant: Readonly<Record<string, string>>, facts = matrix) => ({ job: facts, variant })
    /** The expression's value in the first step of a job. */
    const valueAt = (expression: Residual, options: Options): string =>
      pass({ first: true, fills: [["${{ x }}", expression]] }, `printf '[%s]' "\${{ x }}"`, options)
    const flags = binary(
      "||",
      binary("&&", binary("&&", binary("==", os, literal("mac")), binary("<", go, literal(24))), literal("-x")),
      literal("")
    )

    it("is worked out for the variant that runs, by GitHub's rules", () => {
      expect(valueAt(flags, at({ os: "mac", go: "17" }))).toBe("[-x]")
      expect(valueAt(flags, at({ os: "mac", go: "24" }))).toBe("[]")
      expect(valueAt(flags, at({ os: "linux", go: "17" }))).toBe("[]")
      // Text is ordered without case, which a shell does not do.
      expect(valueAt(binary("<", os, literal("M")), at({ os: "linux", go: "17" }))).toBe("[true]")
      expect(valueAt(binary("<", os, literal("M")), at({ os: "mac", go: "17" }))).toBe("[false]")
    })

    it("compares typed operands with runtime text using their numeric values", () => {
      for (
        const [held, runtime, expected] of [
          [Number.NaN, "NaN", false],
          [Infinity, "1e9999", true],
          [-Infinity, "-1e9999", true],
          [Infinity, "-1e9999", false],
          [Infinity, "Infinity", false],
          [20, "20", true],
          [20, "0", false],
          [20, "0x14", true],
          [true, "1", true],
          [false, "", true],
          [true, "true", false],
          ["20", "020", false]
        ] as const
      ) {
        const variant = { n: String(held) }
        const facts = job({ matrixKeys: ["n"], variants: [variant], typedVariants: [{ n: held }] })
        const expression = binary("==", named("matrix:n", false, true), named("process:VALUE"))
        expect(valueAt(expression, { ...at(variant, facts), env: { VALUE: runtime } })).toBe(`[${expected}]`)
      }
      const facts = job({ matrixKeys: ["constructor"], variants: [{}], typedVariants: [{}] })
      const expression = binary("==", named("matrix:constructor", false, true), named("process:VALUE"))
      expect(valueAt(expression, { ...at({ constructor: "" }, facts), env: { VALUE: "0" } })).toBe("[true]")
    })

    it("gives a key written as a number or a boolean that type, and keeps other text", () => {
      const typed = (key: string) => named(`matrix:${key}`, false, true)
      const facts = job({
        matrixKeys: ["n", "on", "v"],
        variants: [{ n: "0", on: "true", v: "1.20" }, { n: "2", on: "false", v: "beta" }]
      })
      const first = at({ n: "0", on: "true", v: "1.20" }, facts)
      const second = at({ n: "2", on: "false", v: "beta" }, facts)
      // The number 0 is false; the text "0" would be true.
      expect(valueAt(binary("||", typed("n"), literal("zero")), first)).toBe("[zero]")
      expect(valueAt(binary("||", typed("n"), literal("zero")), second)).toBe("[2]")
      expect(valueAt(not(typed("on")), first)).toBe("[false]")
      expect(valueAt(not(typed("on")), second)).toBe("[true]")
      expect(valueAt(typed("v"), first)).toBe("[1.20]")
      expect(valueAt(typed("v"), second)).toBe("[beta]")
    })

    it("reads a key a variant lacks as null", () => {
      const facts = job({ matrixKeys: ["n"], variants: [{ n: "5" }, {}] })
      const less = binary("<", named("matrix:n", false, true), literal(2))
      expect(valueAt(less, at({ n: "5" }, facts))).toBe("[false]")
      expect(valueAt(less, at({ n: "" }, facts))).toBe("[true]")
    })

    it("decides a step's condition", () => {
      const facts = { condition: binary("<", go, literal(24)) }
      const ranAt = (variant: Readonly<Record<string, string>>) => {
        const ran = run({ first: true, ...facts }, "echo ran", at(variant))
        return `${ran.stdout}${ran.stderr}`.trim()
      }
      expect(ranAt({ os: "mac", go: "17" })).toBe("ran")
      expect(ranAt({ os: "mac", go: "24" })).toBe("smithers-ci: not run, its condition is false")
    })

    it("treats NaN and negative zero as false in a step condition", () => {
      for (const n of [Number.NaN, -0]) {
        const variant = { n: String(n) }
        const facts = job({ matrixKeys: ["n"], variants: [variant], typedVariants: [{ n }] })
        expect(pass({ first: true, condition: named("matrix:n", false, true) }, "echo ran", at(variant, facts)))
          .toBe("smithers-ci: not run, its condition is false\n")
      }
    })

    it("compares non-ASCII matrix text for each variant and refuses an unknown variant", () => {
      const facts = job({ matrixKeys: ["os"], variants: [{ os: "Étape" }, { os: "Test" }] })
      const condition = binary("==", os, literal("étape"))
      expect(pass({ first: true, condition }, "echo ran", at({ os: "Étape" }, facts))).toBe("ran\n")
      expect(pass({ first: true, condition }, "echo ran", at({ os: "Test" }, facts))).toContain("condition is false")
      const unknown = run({ first: true, condition }, "echo ran", at({ os: "other" }, facts))
      expect(unknown.status).toBe(1)
      expect(unknown.stderr).toContain("matrix values match no known variant")
    })

    it.each<[string, Residual, string]>([
      ["text that is not JSON", call("fromjson", named("matrix:j", false, true)), "fromJSON was given text"],
      ["a list", call("fromjson", named("matrix:l", false, true)), "a list or mapping"],
      ["a value read while the job runs", binary("<", go, output("V")), "< orders values"]
    ])("refuses %s", (_name, expression, problem) => {
      const facts = job({ matrixKeys: ["go", "j", "l"], variants: [{ go: "1", j: "{", l: "[1]" }] })
      const written = write(facts, { ...defaults, fills: [["x", expression]] }, "true")
      expect("problem" in written ? written.problem : written.text).toContain(problem)
    })
  })

  describe("refuses an expression a shell cannot finish", () => {
    const typed = output("N", true)
    it.each<[string, Partial<StepFacts>, string]>([
      ["a list literal", { condition: call("contains", literal(["a"]), output("V")) }, "a list or mapping"],
      ["a mapping literal", { fills: [["x", literal({ a: "b" })]] }, "a list or mapping"],
      ["join of a run-time value", { condition: call("join", output("V"), literal(",")) }, "join of a value decided"],
      ["format with a value it lacks", { condition: call("format", literal("{0}{1}"), output("V")) }, "names a value"],
      [
        "format with a lone brace",
        { env: [["E", [{ residual: call("format", literal("{x"), output("V")), written: "" }]]] },
        "names a value"
      ],
      ["format of a non-literal", { condition: call("format", output("V"), literal("a")) }, "format of a value"],
      ["format with no template", { condition: call("format") }, "format of a value"],
      ["== with a number", { condition: binary("==", output("V"), literal(1)) }, "not both text"],
      ["!= with a boolean", { condition: binary("!=", literal(true), output("V")) }, "not both text"],
      [
        "== with a comparison",
        { condition: binary("==", output("V"), binary("==", output("V"), literal("a"))) },
        "not both text"
      ],
      ["< with a variable", { condition: binary("<", output("V"), literal("1")) }, "< orders values"],
      ["a typed variable as the condition", { condition: typed }, "may be a number or a list"],
      ["a typed variable under !", { condition: not(typed) }, "may be a number or a list"],
      ["a typed variable left of &&", { condition: binary("&&", typed, literal("x")) }, "may be a number or a list"],
      // A matrix value 0 is false on GitHub and its text "0" is true: whatever reaches a test must be told apart.
      ["a typed variable right of ||", { condition: binary("||", output("V"), typed) }, "may be a number or a list"],
      [
        "a typed variable under ! through &&",
        { condition: not(binary("&&", literal("a"), typed)) },
        "may be a number or a list"
      ],
      ["a typed variable in ==", { condition: binary("==", literal("1"), typed) }, "not both text"],
      ["a list that may be the condition", { condition: binary("||", output("V"), literal(["a"])) }, "or a list"],
      [
        "a refusal in an outer variable",
        { outer: [["O", [{ residual: call("join", output("V")), written: "" }]]] },
        "join of"
      ]
    ])("%s", (_name, facts, problem) => {
      const written = write(job(), { ...defaults, ...facts }, "true")
      expect("problem" in written ? written.problem : written.text).toContain(problem)
    })
  })
})

// "Workflow syntax: jobs.<job_id>.steps[*].timeout-minutes": "The maximum number of minutes to run the step before
// killing the process."
describe("a step with a time limit", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Waits until a process is gone, for as long as a loaded machine may take to end one. */
  const gone = async (pid: number): Promise<boolean> => {
    for (let waited = 0; waited < 300 && alive(pid); waited += 1) await new Promise((done) => setTimeout(done, 100))
    return !alive(pid)
  }

  it("stops a step that runs past it, with the programs the step started, and the step has failed", async () => {
    pass({ first: true }, "true")
    const pids = join(at.home, "pids")
    const ran = run(
      { key: "SLOW", limit: 1 },
      `sleep 300 & echo "$! $$" > ${quote(pids)}; echo started; sleep 300; echo LATE=1 >> "$GITHUB_ENV"; echo never`
    )
    expect(ran.status).toBe(124)
    expect(ran.stdout).toBe("started\n")
    expect(ran.stderr).toContain("smithers-ci: stopped, it ran longer than the 1 second its timeout-minutes allows")
    const [child, step] = readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number]
    expect(await gone(step)).toBe(true)
    expect(await gone(child)).toBe(true)
    // It left nothing for later steps, as a step that failed leaves nothing.
    expect(valueOf(named("outcome:SLOW"))).toBe("[]")
    expect(pass({}, `echo "[\${LATE-unset}]"`)).toBe("[unset]\n")
  })

  // A runner ends a step that does not stop when asked.
  it("ends a step that refuses to stop", async () => {
    pass({ first: true }, "true")
    const pids = join(at.home, "pids")
    const began = Date.now()
    const ran = run({ limit: 1 }, `trap '' TERM; echo $$ > ${quote(pids)}; while :; do sleep 1; done`)
    expect(ran.status).toBe(124)
    expect(Date.now() - began).toBeGreaterThanOrEqual(11_000)
    expect(await gone(Number(readFileSync(pids, "utf8")))).toBe(true)
  })

  // What the step started is ended too, when it outlives the step and refuses to stop.
  it("ends a program the step started that refuses to stop, after the step itself has stopped", async () => {
    pass({ first: true }, "true")
    const pids = join(at.home, "pids")
    const began = Date.now()
    const ran = run({ limit: 1 }, `(trap '' TERM; echo $BASHPID > ${quote(pids)}; sleep 300) & sleep 300`)
    expect(ran.status).toBe(124)
    expect(Date.now() - began).toBeGreaterThanOrEqual(11_000)
    expect(alive(Number(readFileSync(pids, "utf8")))).toBe(false)
  })

  it("stops the step at its limit when it cannot write down that the limit ran out", () => {
    pass({ first: true }, "true")
    const began = Date.now()
    // The step takes away the right to write where the job keeps its state, and gives it back as it ends.
    const ran = run(
      { limit: 2 },
      `state=$(dirname "$(dirname "$GITHUB_OUTPUT")"); chmod u-w "$state"; trap 'chmod u+w "$state"' EXIT; sleep 300`
    )
    expect(ran.status).not.toBe(0)
    expect(Date.now() - began).toBeLessThan(60_000)
  })

  // macOS `sleep` refuses a number of seconds past 2,147,483,647. Here a `sleep` that refuses one number stands in.
  it("runs the step with no limit when the limit cannot be waited for", () => {
    pass({ first: true }, "true")
    const bin = join(at.home, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "sleep"), `#!/bin/sh\n[ "$1" = 777 ] && exit 1\nexec /bin/sleep "$@"\n`, { mode: 0o755 })
    const env = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }
    expect(pass({ limit: 777 }, "sleep 1; echo ran", { env })).toBe("ran\n")
  })

  it("runs a step that ends within it as any other step, and leaves no program behind", async () => {
    pass({ first: true }, "true")
    // What waits to stop the step sleeps for the limit: a number of seconds no other program on the machine sleeps.
    const limit = 31_337 + (process.pid % 1000)
    const waiting = (): string => spawnSync("pgrep", ["-fx", `sleep ${limit}`], { encoding: "utf8" }).stdout
    const stdout = pass(
      { key: "QUICK", limit },
      `cat; echo KEPT=1 >> "$GITHUB_ENV"; echo out=x >> "$GITHUB_OUTPUT"; pgrep -fx 'sleep ${limit}' > /dev/null && echo $$`
    )
    expect(valueOf(named("outcome:QUICK"))).toBe("[success]")
    expect(valueOf(named("output:QUICK/OUT", true))).toBe("[x]")
    expect(pass({}, `echo "$KEPT"`)).toBe("1\n")
    // It waited while the step ran. The step's shell is gone, and so is what waited.
    expect(await gone(Number(stdout))).toBe(true)
    expect(waiting()).toBe("")
  })

  it("gives the exit status of a step that fails within it", () => {
    pass({ first: true }, "true")
    const failed = run({ key: "FAIL", limit: 300 }, "echo before; exit 7")
    expect(failed.status).toBe(7)
    expect(failed.stdout).toBe("before\n")
    expect(failed.stderr).toBe("")
  })

  it("says the limit in minutes, as timeout-minutes gives it", () => {
    const text = (limit: number | undefined): string => {
      const written = write(job(), { ...defaults, limit }, "true")
      return "text" in written ? written.text : written.problem
    }
    expect(text(60)).toContain(`__limit=60; __allowed='1 minute'`)
    expect(text(600)).toContain(`__limit=600; __allowed='10 minutes'`)
    expect(text(90)).toContain(`__limit=90; __allowed='90 seconds'`)
    expect(text(undefined)).not.toContain("__limit=")
  })

  /** Starts a step with a time limit as a process, and gives it and where its script wrote its process id. */
  const started = async (command: (pids: string) => string) => {
    pass({ first: true }, "true")
    const pids = join(at.home, "pids")
    const written = write(job(), { ...defaults, after: mark, second: true, before: ["STEP"], limit: 300 }, "")
    if (!("text" in written)) throw new Error(written.problem)
    const [program, ...flags] = shell
    const child = spawn(program, [...flags, script({ command: command(pids), runner: written.text })], {
      cwd: at.repo,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: at.home, TMPDIR: at.tmp },
      stdio: "ignore"
    })
    const ended = new Promise<number | null>((done) => child.on("exit", (code) => done(code)))
    for (let waited = 0; waited < 600 && !existsSync(pids); waited += 1) {
      await new Promise((done) => setTimeout(done, 100))
    }
    return { child, ended, step: Number(readFileSync(pids, "utf8")) }
  }

  // A replay that is stopped stops its steps: the signal reaches the script, which runs in a group of its own.
  it("passes a signal on to the step, and waits until the step is gone", async () => {
    const done = join(at.home, "done")
    const { child, ended, step } = await started((pids) =>
      `trap 'sleep 1; echo cleaned > ${quote(done)}; exit 0' TERM; echo $$ > ${quote(pids)}; sleep 300 & wait`
    )
    expect(alive(step)).toBe(true)
    child.kill("SIGTERM")
    // The step ended itself with success, and its shell still says it was stopped.
    expect(await ended).toBe(143)
    expect(readFileSync(done, "utf8")).toBe("cleaned\n")
    expect(alive(step)).toBe(false)
  })

  it("ends a step that refuses a signal passed on to it", async () => {
    const { child, ended, step } = await started((pids) => `trap '' TERM; echo $$ > ${quote(pids)}; sleep 300`)
    const began = Date.now()
    child.kill("SIGTERM")
    child.kill("SIGTERM")
    expect(await ended).toBe(137)
    expect(Date.now() - began).toBeGreaterThanOrEqual(9_000)
    expect(await gone(step)).toBe(true)
  })
})

// A cache step keeps its files outside the checkout and the home. Where is the runner's to say.
describe("a step that keeps files from one run to the next", () => {
  const where = `echo "$SMITHERS_CI_CACHE_STORE [\${SMITHERS_CI_STATE-unset}]"`

  it("is told the directory Smithers build keeps its cache in, when it is a target", () => {
    pass({ first: true }, "true")
    const directory = join(at.home, "it's a cache")
    // The variable a baseline is told by is not the target's, and reaches no script.
    expect(pass({ store: true }, where, { cacheDirectory: directory, env: { SMITHERS_CI_STATE: "/nowhere" } })).toBe(
      `${directory}/actions-cache [unset]\n`
    )
  })

  it("is told the directory a baseline names, and the variable that names it reaches no script", () => {
    pass({ first: true }, "true")
    const env = { SMITHERS_CI_STATE: join(at.home, "kept") }
    expect(pass({ store: true }, where, { env })).toBe(`${at.home}/kept/actions-cache [unset]\n`)
    expect(pass({}, `echo "[\${SMITHERS_CI_CACHE_STORE-unset}] [\${SMITHERS_CI_STATE-unset}]"`, { env })).toBe(
      "[unset] [unset]\n"
    )
  })

  it("is told the user's cache directory when nothing else says where", () => {
    pass({ first: true }, "true")
    expect(pass({ store: true }, where)).toBe(`${at.home}/.cache/smithers-ci/actions-cache [unset]\n`)
    expect(pass({ store: true }, where, { env: { XDG_CACHE_HOME: join(at.home, "xdg") } })).toBe(
      `${at.home}/xdg/smithers-ci/actions-cache [unset]\n`
    )
  })

  it("is the first step of its job as any other", () => {
    expect(pass({ first: true, store: true, job: "build" }, where)).toBe(
      `${at.home}/.cache/smithers-ci/actions-cache [unset]\n`
    )
  })
})
