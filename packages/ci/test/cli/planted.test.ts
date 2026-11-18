/**
 * `smithers-ci` on a repository whose CI leaves commands in its copy's
 * `.git/config`: a file-system monitor, a pager and an alias. git runs a
 * monitor under `git status` and `git ls-files`, which the program itself asks
 * of that copy at the next commit, to read its CI, to split it and to build
 * fast mode's rows. The whole program in both modes, every part on `main` but
 * fast mode's judge, real `git` and real `smthrs`.
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { cli, type Parts } from "../../src/cli/Cli.vibe"
import { type Host, layer } from "../../src/cli/Host.vibe"
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

const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

/** Every part on `main`, with a judge that asks no model: it finds every target worth running. */
const judged: Parts<Host> = {
  ...parts,
  score: (rows) => Effect.succeed(rows.map((row) => ({ commit: row.commit, target: row.target, score: 1 })))
}

/**
 * A repository of two commits whose one CI step writes its copy's `.git/config`. The planted command is a script
 * beside the repository, outside every copy and outside a jailed step's `/tmp`. It appends who started it, and
 * with which home, to a file beside itself.
 */
const fixture = () => {
  const outside = keep(mkdtempSync(join("/var/tmp", "smithers-ci-planted-")))
  const ran = join(outside, "ran")
  const script = join(outside, "planted.sh")
  writeFileSync(script, `#!/bin/sh\n(echo "$1 home=$HOME" >> ${ran}) 2>/dev/null\nexit 0\n`)
  chmodSync(script, 0o755)
  const root = keep(temporary("planted"))
  const workflow = [
    "name: CI",
    "on: [push]",
    "jobs:",
    "  plant:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: ./plant.sh",
    ""
  ].join("\n")
  const plant = [
    "#!/bin/bash",
    "set -e",
    `git config core.fsmonitor "${script} fsmonitor"`,
    `git config core.pager "${script} pager"`,
    `git config alias.status "!${script} alias"`,
    ""
  ].join("\n")
  git(root, "init", "--quiet", "--initial-branch=main")
  mkdirSync(join(root, ".github", "workflows"), { recursive: true })
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), workflow)
  writeFileSync(join(root, "plant.sh"), plant)
  chmodSync(join(root, "plant.sh"), 0o755)
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", "c1")
  writeFileSync(join(root, "notes.txt"), "a second commit\n")
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", "c2")
  return { root, ran }
}

/** Replays both commits in both modes. With `refusal`, the machine says it cannot jail a step. */
const program = async (root: string, refusal?: string) => {
  const sink = recorder()
  const run = cli(["--commits", "2", "--no-apply-check", "--mode", "both"], root, judged)
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

const jailable = !("refusal" in probe())

describe("smithers-ci on a repository whose CI plants a command in .git/config", () => {
  it.skipIf(!jailable)("never runs the planted command outside the jail", async () => {
    const { ran, root } = fixture()
    const outcome = await program(root)

    expect(outcome.code, outcome.stderr).toBe(0)
    expect(outcome.stdout).toContain("2 commits · 0 mismatches")
    // The command can write its file only when something starts it outside the jail.
    expect(existsSync(ran)).toBe(false)
  }, 1_800_000)

  it("never runs the planted command on a machine with no jail: a job's checkout is the job's own", async () => {
    const { ran, root } = fixture()
    const outcome = await program(root, "bwrap is not on PATH (install the bubblewrap package)")

    expect(outcome.code, outcome.stderr).toBe(0)
    expect(outcome.stdout).toContain("2 commits · 0 mismatches")
    // The step wrote the configuration of its own job's checkout, which is gone with the job. The copy the program
    // asks at the second commit never held the command, so nothing started it. A copy that jobs do share, as the
    // recipes of a Justfile share one, is asked through `reading`: `test/replay/Jail.test.ts`.
    expect(existsSync(ran)).toBe(false)
  }, 1_800_000)
})
