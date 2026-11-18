/** The program refuses to replay as root, unless told to, and says so in one line. */
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { expect, it } from "vitest"
import { cli, RunningUser } from "../../src/cli/Cli.vibe"
import { layer } from "../../src/cli/Host.vibe"
import { runningAsRoot } from "../../src/cli/Root.ts"
import { exitCodes } from "../../src/contract/Command.ts"
import { parts } from "./parts.vibe"
import { recorder, remove, repository, temporary } from "./repo.ts"

const line =
  "smithers-ci: refusing to run as root, where a past commit's commands could change this machine; run it as another user, or pass --allow-root to accept that\n"

/** Runs the program in process as the user given. */
const run = async (args: ReadonlyArray<string>, isRoot: boolean) => {
  const root = repository()
  const home = temporary("root-home")
  const sink = recorder()
  const program = cli(args, root, parts, root).pipe(
    Effect.provideService(RunningUser, { isRoot: () => isRoot }),
    Effect.provide(layer({ HOME: home, PATH: process.env["PATH"] })),
    Effect.provideService(Console.Console, sink.service as never)
  )
  const code = await Effect.runPromise(program as Effect.Effect<number>)
  remove(root)
  remove(home)
  return { code, stdout: sink.stdout(), stderr: sink.stderr() }
}

it("a replay as root stops at one line, before anything runs", async () => {
  for (const args of [["--commits", "1", "--no-apply-check"], ["replay", "--commits", "1", "--no-apply-check"]]) {
    expect(await run(args, true)).toEqual({ code: exitCodes.usage, stdout: "", stderr: line })
  }
})

it("--allow-root lets it run", async () => {
  const outcome = await run(["--commits", "1", "--no-apply-check", "--allow-root"], true)
  expect(outcome.code).toBe(exitCodes.ok)
  expect(outcome.stderr).not.toContain("refusing")
})

it("another user is not asked for the flag", async () => {
  expect((await run(["--commits", "1", "--no-apply-check"], false)).code).toBe(exitCodes.ok)
})

it("reading the CI runs no step, so root may do it", async () => {
  expect((await run(["inventory"], true)).code).toBe(exitCodes.ok)
})

it("knows the user this process runs as", () => {
  expect(runningAsRoot()).toBe(process.getuid?.() === 0)
})
