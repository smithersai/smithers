/**
 * Telling an invalid probe from a failing check.
 *
 * A non-zero exit is a runner's verdict about the code it ran. It is not the
 * runner's verdict about the command it was handed. When an invocation names a
 * test, a file, a module, an environment, or a program that does not exist, the
 * runner never reaches any code and still exits non-zero — and at the tool
 * boundary that is indistinguishable from the bug reproducing. A SWE-bench run
 * lost thirty-nine frames to exactly that: the reproduction named a test method
 * the class does not define, so it read `exitCode: 1` before the edit and
 * `exitCode: 1` after it, and the agent could not tell it had already won.
 *
 * This module names that class. The taxonomy is one idea — *the invocation
 * named something that does not exist* — and {@link Reason} enumerates the five
 * things that something can be. The recognisers are evidence for the class, not
 * a catalogue of runners: two of them are the POSIX exit codes every shell
 * reports, and the rest are the phrases runners print when name resolution
 * fails before execution begins. Nothing here knows a repository, a path, or a
 * benchmark instance, and nothing that does may be added.
 *
 * Those phrases are not exclusive to load time, which is the whole precision
 * problem: a bug that *is* an import error prints `No module named` from inside
 * a test that ran, and a test that asserts on a shell message prints `command
 * not found` inside its own diff. Reading either as an invalid probe would
 * suppress the reproduction it is meant to protect. So a runner's own report
 * that it executed tests vetoes every wording recogniser, and the recognisers
 * themselves match whole lines rather than substrings.
 *
 * The veto costs recall in two places, and both are the cheap direction: a
 * compound command whose first check ran and whose second named nothing reads
 * as an ordinary failure, and so does any refusal a runner prints after a
 * tally. A missed invalid probe leaves the reader exactly the output it would
 * have had; a false one tells the reader its reproduction proved nothing.
 *
 * One residual false positive has no evidence to read: a bare script that
 * raises `ModuleNotFoundError` from inside application code prints nothing to
 * say a check ran, so it still reads as an invalid probe. The message says what
 * the result does and does not prove and leaves the reading to the caller,
 * which is the safe shape for a call that cannot be decided at the boundary.
 *
 * A flow that can tell the difference reports it under the reserved output key
 * {@link key}. The harness reads that key off an otherwise opaque call result
 * and refuses to count such a result as evidence that anything about the tree
 * changed, which is what stops a broken probe from being cited as a
 * reproduction.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema"

/**
 * The reserved output key a flow reports an invalid probe under.
 *
 * Stated as a constant because it is a wire contract with the harness rather
 * than a shared type: `@smthrs/harness` reads this key off a `Schema.Json`
 * result and must not depend on the tool library to do it.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const key = "invalidProbe"

/**
 * What the invocation named that does not exist.
 *
 * Five members, and adding a recogniser means adding evidence for one of them
 * rather than adding a member.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Reason = Schema.Literals([
  "unknown-command",
  "unknown-test",
  "unknown-path",
  "unknown-module",
  "unknown-environment"
])

/**
 * What the invocation named that does not exist.
 *
 * @category models
 * @since 1.0.0
 */
export type Reason = typeof Reason.Type

/**
 * One command's failure, attributed to the command rather than to the tree.
 *
 * @category schemas
 * @since 1.0.0
 */
export const InvalidProbe = Schema.Struct({
  reason: Reason.annotate({ description: "Which kind of name the command could not resolve" }),
  evidence: Schema.String.annotate({ description: "The output line this classification was read from" }),
  message: Schema.String.annotate({ description: "What the failure does and does not prove, stated for the caller" })
})

/**
 * One command's failure, attributed to the command rather than to the tree.
 *
 * @category models
 * @since 1.0.0
 */
export type InvalidProbe = typeof InvalidProbe.Type

/** What each reason means, in the second half of one sentence. */
const named: Record<Reason, string> = {
  "unknown-command": "the shell could not find the program it was asked to run",
  "unknown-test": "the test runner could not find the test that was named",
  "unknown-path": "the file or directory that was named does not exist",
  "unknown-module": "the module that was imported does not exist here",
  "unknown-environment": "the runner has no environment by that name"
}

const explain = (reason: Reason): string =>
  `This command never ran a check: ${
    named[reason]
  }. The non-zero exit describes the command, not the code under test, so it is not a reproduction and reads the same before and after a correct fix. Find the real names, repair the command, and run it again before drawing any conclusion from it.`

/** How much of the matched line is kept as evidence. */
const evidenceWidth = 240

interface Recogniser {
  readonly reason: Reason
  readonly pattern: RegExp
}

/**
 * Phrases that mean a runner refused a name before it ran anything.
 *
 * Ordered most specific first, and every pattern is anchored on wording the
 * runner itself emits at load time. Precision is the design constraint: a
 * recogniser that fires on a genuine reproduction would suppress real evidence,
 * which is worse than missing an invalid probe.
 */
const recognisers: ReadonlyArray<Recogniser> = [
  // unittest could not import or load the target it was given, so it
  // synthesises a placeholder case whose whole purpose is to report that.
  {
    reason: "unknown-test",
    pattern: /^(?:ERROR|FAIL):[^\n]*\(unittest\.loader\._FailedTest(?:\.[^)\s]+)?\)\s*$/m
  },
  // The class loaded and the method is not on it. This is the django case:
  // `type object 'AdminViewBasicTest' has no attribute 'test_catch_all_…'`.
  // The name must be shaped like a test method — `test_foo` or the older
  // `testFoo` — because `test` is also the start of ordinary attribute names
  // (`testing`, `tests`, `tested`) whose absence is an ordinary bug.
  {
    reason: "unknown-test",
    pattern: /^(?:E[ \t]+)?AttributeError:[^\n]* has no attribute '(?:test_[A-Za-z0-9_]*|test[A-Z][A-Za-z0-9_]*)'\s*$/m
  },
  // pytest resolved the file and could not resolve the node id inside it.
  { reason: "unknown-test", pattern: /^ERROR: not found:/m },
  { reason: "unknown-path", pattern: /^ERROR: file or directory not found:/m },
  // `python missing.py`, and every wrapper that shells out the same way.
  {
    reason: "unknown-path",
    pattern: /^[^\n:]+: can't open file '[^'\n]*': \[Errno 2\](?: No such file or directory)?\s*$/m
  },
  {
    reason: "unknown-module",
    pattern: /^(?:E[ \t]+)?(?:ModuleNotFoundError|ImportError): No module named(?:[ \t]+.*)?$/m
  },
  // tox and nox both phrase a missing environment this way.
  { reason: "unknown-environment", pattern: /^(?:ERROR:[ \t]+)?unknown environment\b[^\n]*$/im },
  // bash, sh and csh, which put the name first and the verdict last. Anchored
  // to the end of the line so the phrase quoted inside a test's own assertion
  // diff is not read as the shell having said it.
  { reason: "unknown-command", pattern: /^[^\n]*: command not found\s*$/m },
  // zsh, which puts the verdict first and the name last.
  { reason: "unknown-command", pattern: /^[^\n]*: command not found: \S+\s*$/m },
  // dash, which prints `sh: 1: pytest: not found`.
  { reason: "unknown-command", pattern: /^[^\n:]+: \d+: [^\n:]+: not found$/m }
]

/**
 * Phrases with which a runner reports that it executed tests.
 *
 * A runner that refused a name never reaches its own tally, so a tally is proof
 * the refusal wording came from somewhere else — a traceback inside a test that
 * ran, or a test's own assertion diff. Only outcomes a test must have executed
 * to earn are counted: `error` is what a collection failure reports and
 * `skipped` and `deselected` are what an unexecuted test reports, so none of
 * the three appear here. Zero counts are not evidence either, which is why
 * every count is anchored at one.
 *
 * Truncation keeps the tail of a captured stream, so a tally survives a run
 * whose output overflowed the capture limit.
 */
const executed: ReadonlyArray<RegExp> = [
  // unittest, which prints its tally after the run and before the verdict.
  /^Ran [1-9]\d* tests? in /m,
  // pytest's short summary.
  /\b[1-9]\d* (?:passed|failed|xpassed|xfailed)\b/
]

/** Whether the output carries the runner's own report that tests ran. */
const ranTests = (text: string): boolean => executed.some((pattern) => pattern.test(text))

/** The whole line one pattern matched, trimmed and clipped. */
const matchedLine = (text: string, pattern: RegExp): string | undefined => {
  const match = pattern.exec(text)
  if (match === null) return undefined
  const start = text.lastIndexOf("\n", match.index) + 1
  const end = text.indexOf("\n", match.index)
  const line = (end === -1 ? text.slice(start) : text.slice(start, end)).trim()
  return line.length > evidenceWidth ? `${line.slice(0, evidenceWidth - 1)}…` : line
}

const invalid = (reason: Reason, evidence: string): InvalidProbe => ({
  reason,
  evidence,
  message: explain(reason)
})

/**
 * Classifies one command result as an invalid probe, or as an ordinary result.
 *
 * A zero exit is never classified: a command that ran is a command that ran,
 * whatever it printed. Everything else is read for the two independent kinds of
 * evidence — the runner's own load-time wording, then the shell's reserved exit
 * codes — and the first that fires wins.
 *
 * The wording half is vetoed by the runner's own report that it executed tests.
 * That report outranks the wording because it is the stronger statement: a
 * runner that ran tests resolved every name it was given, so the phrase was
 * printed by something the run reached rather than by the runner refusing to
 * start. The exit-code half is not vetoed — 126 and 127 are the shell's verdict
 * on the command, and nothing a runner printed changes what the shell said.
 *
 * Pass the text the caller will actually return, so the evidence line is always
 * quotable from the output the reader can see.
 *
 * @category classification
 * @since 1.0.0
 */
export const classify = (result: {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}): InvalidProbe | undefined => {
  if (result.exitCode === 0) return undefined
  const text = result.stderr === ""
    ? result.stdout
    : result.stdout === ""
    ? result.stderr
    : `${result.stdout}\n${result.stderr}`
  if (!ranTests(text)) {
    for (const recogniser of recognisers) {
      const line = matchedLine(text, recogniser.pattern)
      if (line !== undefined) return invalid(recogniser.reason, line)
    }
  }
  // POSIX reserves these two for the shell's own refusal to start the command
  // at all: 127 is "not found", 126 is "found and not executable". No runner
  // reaches its own tests and then reports either one.
  return result.exitCode === 127 || result.exitCode === 126
    ? invalid("unknown-command", `the command exited ${result.exitCode}`)
    : undefined
}
