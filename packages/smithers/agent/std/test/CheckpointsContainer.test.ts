/**
 * Checkpoints for a host whose `bash` runs in a container with a filesystem
 * of its own.
 *
 * On the paired SWE-bench Pro run of 2026-10-14 the repository lived only in
 * the task container and the CLI ran in an empty host directory. The host
 * store looked there, and 112 of 123 trials read "Checkpoint base could not
 * be checked out … No commit resolves from refs/flows/capture-base or HEAD in
 * /tmp/smithers-bench-…" (why-codex-won.md). The container here is a double
 * that runs each program in the directory the request names, or in the
 * container's working directory, so the host directory never sees the
 * repository — which is the whole of that host's shape.
 */
import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, Layer, type Schema } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import * as Checkpoints from "../src/Checkpoints.ts"
import * as Container from "../src/Container.vibe"

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

const scratch = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)))

/** The task's repository, at one commit, as only the container sees it. */
const repository = (): string => {
  const root = scratch("flows-container-app-")
  writeFileSync(join(root, "mod.py"), "value = 'pristine'\n")
  writeFileSync(join(root, "probe.sh"), "#!/bin/bash\ncat mod.py\n", { mode: 0o755 })
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "rig@localhost"])
  git(root, ["config", "user.name", "rig"])
  git(root, ["add", "-A"])
  git(root, ["commit", "-qm", "base"])
  return root
}

const inDirectory = [
  "const { spawnSync } = require(\"node:child_process\")",
  "const [cwd, file, ...args] = process.argv.slice(1)",
  "const result = spawnSync(file, args, { cwd, stdio: \"inherit\" })",
  "if (result.error) throw result.error",
  "process.exit(result.status ?? 1)"
].join("\n")

/** A container named `task` whose working directory is `workdir`. */
const task = (workdir: string, shellPreamble = ""): Container.Container =>
  Container.make({
    exec: (request) =>
      request.container === "task"
        ? Effect.succeed({
          file: process.execPath,
          args: [
            "--eval",
            inDirectory,
            request.cwd ?? workdir,
            request.file,
            ...request.args.map((arg, index) => request.file === "sh" && index === 1 ? shellPreamble + arg : arg)
          ],
          env: request.env
        })
        : Effect.fail(Container.unavailable(request.container))
  })

const services = (workdir: string, shellPreamble = "") =>
  Layer.mergeAll(NodeServices.layer, Layer.succeed(Container.Container)(task(workdir, shellPreamble)))

/** Runs `call` at checkpoint `id` through the store and the relocation the harness uses. */
const at = (checkpoints: Checkpoints.Checkpoints, id: string, call: Bash.Input & Schema.Json) =>
  checkpoints.materialize(id, (found) => {
    const relocated = Checkpoints.relocate("bash", call, found)
    return relocated._tag === "Relocated" ? Bash.run(relocated.input as Bash.Input) : Effect.die(relocated)
  })

describe("Checkpoints in a container with a filesystem of its own", () => {
  it("cannot be served by the host store, which looks in the CLI's own directory", async () => {
    // The defect, reproduced: the host directory holds no repository.
    const host = scratch("smithers-bench-")
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(
        Checkpoints.makeGit({ root: host }),
        (store) => store.materialize(Checkpoints.baseId, () => Effect.void)
      )
        .pipe(Effect.provide(NodeServices.layer))
    )
    expect(exit._tag).toBe("Failure")
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({
        message: expect.stringContaining(`${host} is not a git work tree`)
      })
    }
  }, 60_000)

  it("uses Git's object directory when the shell names the directory differently", async () => {
    const app = repository()
    const before = await Effect.runPromise(
      Effect.gen(function*() {
        const checkpoints = yield* Checkpoints.makeContainer({ container: "task" })
        return yield* at(checkpoints, Checkpoints.baseId, {
          mode: "unhermetic",
          container: "task",
          cwd: app,
          command: "cat mod.py"
        })
      }).pipe(Effect.provide(services(app, "pwd() { printf '/unusable/msys/path\\n'; };\n")))
    )
    expect(before.exitCode, before.stderr).toBe(0)
    expect(before.stdout).toBe("value = 'pristine'\n")
    expect(readdirSync(join(app, Checkpoints.scratchDirectory))).toEqual([])
  }, 60_000)

  it("runs a container-bound bash call at the opening tree after an edit, inside the container", async () => {
    const app = repository()
    const host = scratch("smithers-bench-")
    writeFileSync(join(app, "mod.py"), "value = 'fixed'\n")
    const index = readFileSync(join(app, ".git", "index"))
    const call = { mode: "unhermetic", container: "task", cwd: app, command: "bash probe.sh" } as const

    const [before, after] = await Effect.runPromise(
      Effect.gen(function*() {
        const checkpoints = yield* Checkpoints.makeContainer({ container: "task" })
        return [yield* at(checkpoints, Checkpoints.baseId, call), yield* Bash.run(call)] as const
      }).pipe(Effect.provide(services(app)))
    )

    // One command, two trees, one frame, all of it inside the container.
    expect(before.exitCode, before.stderr).toBe(0)
    expect(before.stdout).toBe("value = 'pristine'\n")
    expect(after.stdout).toBe("value = 'fixed'\n")
    // The edit stands, the agent's index and history are untouched, the
    // checkout is gone, and the host directory never held any of it.
    expect(git(app, ["status", "--porcelain"])).toBe(" M mod.py\n")
    expect(readFileSync(join(app, ".git", "index"))).toEqual(index)
    expect(readdirSync(join(app, Checkpoints.scratchDirectory))).toEqual([])
    expect(readdirSync(host)).toEqual([])
  }, 60_000)

  it("keeps the subdirectory a call names and prefers the recorded capture base over HEAD", async () => {
    const app = repository()
    git(app, ["update-ref", "refs/flows/capture-base", "HEAD"])
    writeFileSync(join(app, "mod.py"), "value = 'committed later'\n")
    git(app, ["commit", "-qam", "later"])
    const call = { mode: "unhermetic", container: "task", cwd: app, command: "pwd; cat ../mod.py" } as const

    const before = await Effect.runPromise(
      Effect.flatMap(
        Checkpoints.Checkpoints,
        (checkpoints) => at(checkpoints, Checkpoints.baseId, { ...call, cwd: `${app}/.git` })
      ).pipe(
        Effect.provide(Checkpoints.layerContainer({ container: "task", cwd: app })),
        Effect.provide(services("/"))
      )
    )

    const [cwd, content] = before.stdout.split("\n")
    expect(cwd).toMatch(new RegExp(`^${app}/${Checkpoints.scratchDirectory}/base-[0-9a-f-]+/\\.git$`))
    expect(`${content}\n`).toBe("value = 'pristine'\n")
  }, 60_000)

  it("pins the container's working tree for ctx.checkpoint() and reads it back after a later edit", async () => {
    const app = repository()
    writeFileSync(join(app, "mod.py"), "value = 'first'\n")
    const index = readFileSync(join(app, ".git", "index"))
    const call = { mode: "unhermetic", container: "task", cwd: app, command: "bash probe.sh" } as const

    const [snapshot, untouched, clean, pinned] = await Effect.runPromise(
      Effect.gen(function*() {
        const checkpoints = yield* Checkpoints.makeContainer({ container: "task" })
        const snapshot = yield* checkpoints.capture("cp-1-1")
        writeFileSync(join(app, "mod.py"), "value = 'second'\n")
        const pinned = yield* at(checkpoints, "cp-1-1", call)
        // Read before this test's own git touches the index below.
        const untouched = readFileSync(join(app, ".git", "index"))
        git(app, ["checkout", "-q", "--", "mod.py"])
        return [snapshot, untouched, yield* checkpoints.capture("cp-1-2"), pinned] as const
      }).pipe(Effect.provide(services(app)))
    )

    expect(pinned.stdout).toBe("value = 'first'\n")
    // Named in config, as the host store names it, and never in history.
    expect(git(app, ["config", "--get", "flows-checkpoint.cp-1-1"]).trim()).toBe(snapshot.ref)
    expect(git(app, ["log", "--all", "--format=%H"])).not.toContain(snapshot.ref)
    expect(untouched).toEqual(index)
    // A tree with nothing to record is the commit it is on.
    expect(clean.ref).toBe(git(app, ["rev-parse", "HEAD"]).trim())
  }, 60_000)

  it("refuses what it cannot pin or check out with a reason, and leaves nothing behind", async () => {
    const app = repository()
    const outcome = (effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.runPromise(Effect.match(effect, { onFailure: (error) => JSON.stringify(error), onSuccess: () => "ran" }))
    const run = <A, E>(use: (checkpoints: Checkpoints.Checkpoints) => Effect.Effect<A, E>) =>
      outcome(
        Effect.flatMap(Checkpoints.makeContainer({ container: "task" }), use).pipe(Effect.provide(services(app)))
      )

    expect(await run((store) => store.materialize("cp-9-9", () => Effect.void))).toContain(
      "No checkpoint is stored under cp-9-9"
    )
    expect(await run((store) => store.materialize("../x", () => Effect.void))).toContain("invalid_input")
    expect(await run((store) => store.capture("a.b"))).toContain("invalid_input")
    // A container the transport cannot reach.
    expect(
      await outcome(
        Effect.flatMap(Checkpoints.makeContainer({ container: "gone" }), (store) => store.capture("cp-1-1")).pipe(
          Effect.provide(services(app))
        )
      )
    ).toContain("provider_unavailable")
    // A directory that is not a repository.
    expect(
      await outcome(
        Effect.flatMap(
          Checkpoints.makeContainer({ container: "task", cwd: scratch("flows-container-empty-") }),
          (store) => store.materialize(Checkpoints.baseId, () => Effect.void)
        ).pipe(Effect.provide(services(app)))
      )
    ).toContain("not a git repository")
    expect(git(app, ["status", "--porcelain"])).toBe("")
  }, 60_000)

  it("answers the call when the checkout cannot be removed, and refuses a transport that cannot start", async () => {
    const app = repository()
    const inner = task(app)
    // The container refuses the removal; everything else runs.
    const stuck = Container.make({
      exec: (request) =>
        request.args[1]?.startsWith("rm -rf") === true
          ? Effect.succeed({ file: "false", args: [] })
          : inner.exec(request)
    })
    const call = { mode: "unhermetic", container: "task", cwd: app, command: "bash probe.sh" } as const
    const before = await Effect.runPromise(
      Effect.flatMap(Checkpoints.makeContainer({ container: "task" }), (store) => at(store, Checkpoints.baseId, call))
        .pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(Container.Container)(stuck))))
    )
    expect(before.stdout).toBe("value = 'pristine'\n")
    // Left for the operator to hear about, never silently lost.
    expect(readdirSync(join(app, Checkpoints.scratchDirectory))).toHaveLength(1)

    const missing = Container.make({ exec: () => Effect.succeed({ file: join(app, "no-such-docker"), args: [] }) })
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Checkpoints.makeContainer({ container: "task" }), (store) => store.capture("cp-1-1"))
        .pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Layer.succeed(Container.Container)(missing))))
    )
    expect(JSON.stringify(exit)).toContain("Command failed to start")
  }, 60_000)
})
