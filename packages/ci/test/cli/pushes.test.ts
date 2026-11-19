/**
 * `smithers-ci` on a repository whose CI pushes: a job a push starts, with no
 * secret and no write permission, whose steps push to a neighbour repository
 * by URL, through a remote they add, and through a push URL they set. The
 * whole program, every part on `main`, real `git` and real `smthrs`.
 */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { cli } from "../../src/cli/Cli.vibe"
import { layer } from "../../src/cli/Host.vibe"
import { parts } from "../../src/cli/parts.ts"
import { pushRefused } from "../../src/replay/Environment.ts"
import { Options } from "../../src/replay/index.ts"
import { probe, unjailed } from "../../src/replay/Jail.ts"
import { git, recorder, remove, temporary } from "./repo.ts"

const made: Array<string> = []
const keep = (path: string): string => {
  made.push(path)
  return path
}
afterAll(() => made.forEach(remove))

const environment = { HOME: keep(temporary("home")), PATH: process.env["PATH"] }

// A jailed step has a `/tmp` of its own, so what a step is to find beside the repository is kept out of it.
const beside = (name: string): string => keep(mkdtempSync(join("/var/tmp", `smithers-ci-${name}-`)))

const bare = (name: string): string => {
  const root = beside(name)
  execFileSync("git", ["init", "--quiet", "--bare", root])
  return root
}

/**
 * The repository, its remote, a neighbour, and the file its steps log to, which is outside every copy. The `pushes`
 * job is the ship review's fixture: its steps run in order and stop at the first that fails. Each push is tried
 * again in a job of its own, which goes on to its push when it cannot write its log.
 */
const fixture = () => {
  const remote = bare("pushes-remote")
  const other = bare("pushes-other")
  const log = join(beside("pushes-log"), "log")
  const root = keep(temporary("pushes"))
  const pushes = {
    "explicit-url": `git push file://${other} HEAD:refs/heads/pushed`,
    "added-remote": `git remote add up file://${other} && git push up HEAD:refs/heads/pushed2`,
    "push-url-reset": `git remote set-url --push origin file://${remote} && git push origin HEAD:refs/heads/pushed3`
  }
  const jobOf = (id: string, steps: ReadonlyArray<string>): ReadonlyArray<string> => [
    `  ${id}:`,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    ...steps.map((step) => `      - run: ${step}`)
  ]
  const workflow = [
    "name: CI",
    "on: [push]",
    "jobs:",
    ...jobOf("pushes", Object.entries(pushes).map(([name, push]) => `./rec.sh ${name} && ${push}`)),
    ...Object.entries(pushes).flatMap(([name, push]) =>
      jobOf(`alone-${name}`, [`./rec.sh alone-${name} || true; ${push}`])
    ),
    // A job that passes, as most of a repository's CI does.
    ...jobOf("plain", ["./rec.sh plain || true"]),
    ""
  ].join("\n")
  git(root, "init", "--quiet", "--initial-branch=main")
  mkdirSync(join(root, ".github", "workflows"), { recursive: true })
  writeFileSync(join(root, ".github", "workflows", "ci.yml"), workflow)
  writeFileSync(join(root, "rec.sh"), `#!/bin/bash\necho "$1 ran; home=$HOME" >> ${log}\n`)
  chmodSync(join(root, "rec.sh"), 0o755)
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", "c1")
  git(root, "remote", "add", "origin", `file://${remote}`)
  git(root, "push", "--quiet", "origin", "main")
  return { root, log, refs: () => [git(remote, "for-each-ref"), git(other, "for-each-ref")] }
}

/** Runs the program in `root`. With `refusal`, the machine says it cannot jail a step. */
const program = async (root: string, refusal?: string) => {
  const sink = recorder()
  // The job that pushes fails, and this test is about what it did at every step: it is not left out.
  const run = cli(["--commits", "1", "--no-apply-check", "--no-trial"], root, parts)
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

describe("smithers-ci on a repository whose CI pushes", () => {
  it.skipIf(!jailable)("pushes nothing and writes nothing outside its copies", async () => {
    const { log, refs, root } = fixture()
    const before = refs()
    const outcome = await program(root)

    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain("0 mismatches")
    expect(refs()).toEqual(before)
    expect(existsSync(log)).toBe(false)
    expect(outcome.stderr).not.toContain("jail")
  }, 1_800_000)

  it("pushes nothing and shows no step the person's home on a machine with no jail", async () => {
    const { log, refs, root } = fixture()
    const before = refs()
    const refusal = "bwrap is not on PATH (install the bubblewrap package)"
    const outcome = await program(root, refusal)

    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain("0 mismatches")
    expect(refs()).toEqual(before)
    const lines = readFileSync(log, "utf8").trim().split("\n")
    const homes = new Set(lines.map((line) => /home=(.*)$/.exec(line)?.[1]))
    // Every step ran in the home of its job's machine, where Smithers build keeps that machine: at the same path in
    // the baseline and in normal mode, as a runner gives a job one home.
    expect(
      [...homes].every((home) =>
        /\/smithers-ci-replay-[^/]+\/machines\/[0-9a-f]{16}\/[^/]+-[0-9a-f]{8}\/home$/.test(home ?? "")
      )
    ).toBe(true)
    const byStep = new Map<string, Set<string>>()
    for (const line of lines) {
      const [step, home] = line.split(" ran; home=") as [string, string]
      byStep.set(step, new Set([...(byStep.get(step) ?? []), home]))
    }
    expect([...byStep.values()].map((each) => each.size)).toEqual([...byStep.values()].map(() => 1))
    // Each job has a home of its own.
    expect(new Set([...byStep.values()].flatMap((each) => [...each])).size).toBe(byStep.size)
    expect(homes).not.toContain(homedir())
    expect(homes).not.toContain(environment.HOME)
    expect(homes).not.toContain(undefined)
    // Each push was tried: the three kinds are in the log.
    const steps = ["explicit-url", "alone-explicit-url", "alone-added-remote", "alone-push-url-reset", "plain"]
    for (const step of steps) expect(lines.some((line) => line.startsWith(`${step} ran`))).toBe(true)
    // The first push of the `pushes` job failed, so the steps after it never ran.
    expect(lines.some((line) => line.startsWith("added-remote ran"))).toBe(false)
    // The report names each refused push: the step, the ways it failed in, its exit code and the line the hook
    // printed, which is the first line of the step's error output.
    expect(pushRefused).toBe("smithers-ci: a replayed step may not push; nothing was sent")
    const refusedIn = (job: string): ReadonlyArray<string> =>
      outcome.stdout.split("\n").filter((line) => line.endsWith(`  ci.yml:${job}:1  exit 1: ${pushRefused}`)).map(
        (line) => line.split("  ")[1] as string
      )
    // A step that does nothing but push fails with that line in the baseline and as a target alike.
    expect(refusedIn("alone-explicit-url")).toEqual(["baseline, normal"])
    expect(refusedIn("alone-push-url-reset")).toEqual(["baseline, normal"])
    // The other two were refused with it in the baseline, where each run starts from a fresh checkout.
    for (const job of ["pushes", "alone-added-remote"]) {
      expect(refusedIn(job)).toHaveLength(1)
      expect(refusedIn(job)[0]).toMatch(/^baseline/)
    }
    expect(outcome.stderr.split("\n").filter((line) => line.includes("jail"))).toEqual([
      `smithers-ci: ${unjailed(refusal)}`
    ])
  }, 1_800_000)
})
