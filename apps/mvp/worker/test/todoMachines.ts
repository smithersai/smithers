// TODO tests and evals use the real sandbox tools and command jobs over one scratch checkout per attempt.
// GitHub is a scripted outside provider; each checkout starts at exactly the commit the attempt names.
import { type SandboxTools } from "@smthrs/sandbox"
import { Effect, Layer } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { onTestFinished } from "vitest"
import { Machines } from "../branch/Machines.ts"
import type { SandboxBranch } from "../branch/Sandboxes.ts"
import type { ScriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as Box from "./box.ts"
import { instantCommands } from "./commands.ts"

/** Real machines by default; `run` injects command failures only in explicitly unhappy-path tests. */
export const machines = (
  github: ScriptedGitHub,
  run?: (command: string) => number,
  options: { readonly onRun?: (command: string) => void; readonly checkout?: (branch: SandboxBranch) => string } = {},
) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-todo-machines-")))
  const jobs = new Map<string, Effect.Effect<void, unknown>>()
  let closing: Promise<void> | undefined
  const close = () => closing ??= Effect.runPromise(
    Effect.forEach([...jobs.values()], cancel => cancel, { discard: true }).pipe(
      Effect.andThen(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    ),
  )
  onTestFinished(close)
  const copies = new Map<string, { readonly workdir: string; readonly base: string; readonly initial: ReadonlyMap<string, string>; readonly bases: Map<string, string>; readonly service: Machines["Service"] }>()
  const calls: Array<{ readonly branchId: string; readonly branch: string; readonly ownerId: string; readonly callId: string; readonly tool: string }> = []
  const results = new Map<string, typeof SandboxTools.RunResult.Type>()
  const checkout = (branch: SandboxBranch) => {
    const known = copies.get(branch.branchId)
    if (known !== undefined) return known
    const workdir = mkdtempSync(join(root, "checkout-"))
    const git = (...args: Array<string>) => execFileSync("git", [
      "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "-c", "commit.gpgsign=false", ...args,
    ], { cwd: workdir, encoding: "utf8" }).trim()
    git("init", "-q")
    const source = options.checkout?.(branch) ?? github.refs.get(branch.branch) ?? branch.branch
    const initial = new Map(github.commits.get(source)?.files)
    for (const [path, content] of initial) {
      const target = join(workdir, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    git("add", "-f", ".")
    git("commit", "-q", "--allow-empty", "-m", "base")
    git("checkout", "-q", "--detach")
    const base = git("rev-parse", "HEAD")
    const box = Box.boxAt({ workdir, homes: mkdtempSync(join(root, "homes-")) })
    const copy = { workdir, base, initial, bases: new Map([[source, base]]), service: Box.machinesOn(box.box) }
    copies.set(branch.branchId, copy)
    return copy
  }
  // A published GitHub commit may be compared before the checkout fetches it. Materialize its exact tree in
  // this object's Git store through an independent index, without modifying the checkout or its real index.
  const baseFor = (copy: ReturnType<typeof checkout>, sha: string) => {
    const known = copy.bases.get(sha)
    if (known !== undefined) return known
    const source = github.commits.get(sha)
    if (source === undefined) return sha
    const scratch = mkdtempSync(join(root, "base-"))
    const files = join(scratch, "files")
    mkdirSync(files)
    try {
      for (const [path, content] of source.files) {
        const target = join(files, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, content)
      }
      const git = (...args: Array<string>) => execFileSync("git", [
        "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "-c", "commit.gpgsign=false",
        "--git-dir", join(copy.workdir, ".git"), "--work-tree", files, ...args,
      ], { cwd: files, env: { ...process.env, GIT_INDEX_FILE: join(scratch, "index") }, encoding: "utf8" }).trim()
      git("add", "-f", "-A")
      const base = git("commit-tree", git("write-tree"), "-m", "base")
      copy.bases.set(sha, base)
      return base
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  const record = (branch: SandboxBranch, ownerId: string, callId: string, tool: string) =>
    calls.push({ branchId: branch.branchId, branch: branch.branch, ownerId, callId, tool })
  const service = Machines.of({
    tool: (branch, ownerId, callId, call) =>
      Effect.suspend(() => {
        record(branch, ownerId, callId, call.tool)
        if (call.tool === "run") {
          options.onRun?.(call.command)
          if (run !== undefined) return Effect.map(instantCommands(run, undefined, results).start(call, callId).pipe(
            Effect.andThen(instantCommands(run, undefined, results).collect(callId)),
            Effect.orDie,
          ), (result) => ({ result, generation: 1 }))
        }
        const copy = checkout(branch)
        // The outside provider uses synthetic commit ids; the real checkout has the corresponding real base.
        const local = call.tool === "status" && call.base !== undefined ? { ...call, base: baseFor(copy, call.base) } : call
        return copy.service.tool(branch, ownerId, callId, local)
      }),
    commands: (branch, ownerId, callId) => {
      const started = (key: string, call: typeof SandboxTools.Run.Type) => {
        record(branch, ownerId, key, "run")
        options.onRun?.(call.command)
      }
      if (run !== undefined) return instantCommands(run, started, results)
      const commands = checkout(branch).service.commands(branch, ownerId, callId)
      return {
        ...commands,
        start: (call, key) => Effect.suspend(() => {
          started(key, call)
          // Reserve cleanup before the asynchronous start: a lost answer can still leave a detached process.
          jobs.set(JSON.stringify([branch.branchId, ownerId, key]), commands.cancel(key))
          return commands.start(call, key)
        }),
      }
    },
    sleepIfIdle: () => Effect.die("the todo run never puts a machine to sleep"),
  })
  return { calls, copies, close, service, layer: Layer.succeed(Machines, service) }
}
