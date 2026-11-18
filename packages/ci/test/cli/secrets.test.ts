/**
 * `smithers-ci` started with tokens in its environment, on a repository whose
 * CI looks for them: a step that reads its own environment and the
 * environment of every process it can see. The whole program, every part on
 * `main`, real `git`, real `smthrs`, and on a machine that has one, the real
 * jail.
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import { cli } from "../../src/cli/Cli.vibe"
import { layer } from "../../src/cli/Host.vibe"
import { parts } from "../../src/cli/parts.ts"
import { Options } from "../../src/replay/index.ts"
import { probe } from "../../src/replay/Jail.ts"
import { git, recorder, remove, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))
afterEach(() => vi.unstubAllEnvs())

const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

/** A value no other process on this machine holds. Every token of the test starts with it. */
const canary = `smithers-ci-canary-${randomUUID()}`

/** The variables a person has set when they run the program: the two it reads, and two of other tools. */
const tokens = ["AI_GATEWAY_API_KEY", "SMITHERS_CACHE_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN"]

/**
 * The step. It fails when its own environment holds a canary, or the environment or command line of any process it
 * can read does: through `/proc` on Linux, through `ps` where there is none. It prints the name of what held one,
 * never a value.
 */
const look = [
  "#!/bin/bash",
  `canary=${canary}`,
  "if env | grep -q \"$canary\"; then echo \"a token is in the step's environment\" >&2; exit 1; fi",
  "for process in /proc/[0-9]*; do",
  "  for file in environ cmdline; do",
  "    if { tr '\\0' '\\n' < $process/$file; } 2>/dev/null | grep -aq \"$canary\"; then",
  "      echo \"a token is in $file of process ${process#/proc/}: $(tr '\\0' ' ' < $process/cmdline | cut -c1-60)\" >&2",
  "      exit 1",
  "    fi",
  "  done",
  "done",
  "if [ ! -d /proc/self ]; then",
  "  ps eww -ax > \"$HOME/processes\" 2>/dev/null",
  "  if grep -q \"$canary\" \"$HOME/processes\"; then echo \"a token is in what ps shows of a process\" >&2; exit 1; fi",
  "fi",
  ""
].join("\n")

const fixture = (): string => {
  const root = keep(temporary("secrets"))
  const workflow = [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  look:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: ./look.sh",
    ""
  ].join("\n")
  git(root, "init", "--quiet", "--initial-branch=main")
  mkdirSync(join(root, ".github", "workflows"), { recursive: true })
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), workflow)
  writeFileSync(join(root, "look.sh"), look)
  chmodSync(join(root, "look.sh"), 0o755)
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", "c1")
  return root
}

/** Runs the program in `root` with the tokens set. With `refusal`, the machine says it cannot jail a step. */
const program = async (root: string, refusal?: string) => {
  for (const [index, name] of tokens.entries()) vi.stubEnv(name, `${canary}-${index}`)
  const sink = recorder()
  const run = cli(["--commits", "1", "--json"], root, parts)
  const noJail = Layer.effect(
    Options,
    Effect.gen(function*() {
      return { ...(yield* Options), confine: () => ({ refusal: refusal as string }) }
    })
  )
  const code = await Effect.runPromise(
    (refusal === undefined ? run : Effect.provide(run, noJail)).pipe(
      Effect.provide(layer(environment)),
      Effect.provideService(Console.Console, sink.service as never)
    ) as Effect.Effect<number>
  )
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

/** What the report says of the one commit: how each way ended, and why a step failed. */
const ways = (stdout: string) => {
  const [commit] = (JSON.parse(stdout) as {
    readonly commits: ReadonlyArray<
      Readonly<
        Record<"baseline" | "normal", { readonly ok: boolean; readonly failures?: ReadonlyArray<{ reason: string }> }>
      >
    >
  }).commits
  const of = (way: "baseline" | "normal") => ({
    ok: commit?.[way].ok,
    reasons: (commit?.[way].failures ?? []).map((failure) => failure.reason)
  })
  return { baseline: of("baseline"), normal: of("normal") }
}

const jailable = !("refusal" in probe())
const passed = { ok: true, reasons: [] }

describe("smithers-ci started with tokens in its environment", () => {
  it.skipIf(!jailable)("shows a step none of them, in its environment or any process it can read", async () => {
    const outcome = await program(fixture())

    expect(ways(outcome.stdout)).toEqual({ baseline: passed, normal: passed })
    expect(outcome.code).toBe(0)
  }, 1_800_000)

  it("shows a step none of them on a machine with no jail", async () => {
    const outcome = await program(fixture(), "bwrap is not on PATH (install the bubblewrap package)")

    expect(ways(outcome.stdout)).toEqual({ baseline: passed, normal: passed })
    expect(outcome.code).toBe(0)
  }, 1_800_000)
})
