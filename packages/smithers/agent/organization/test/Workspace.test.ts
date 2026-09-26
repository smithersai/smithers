/**
 * The workspace service over host-directory machines, with real `git`, `sh`,
 * and `tar`: every success path, every refusal, and the failure of each step
 * a machine or the host can fail at. `WorkspaceMicrovm.test.ts` runs the
 * same lifecycle in real microVMs.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import type { Session } from "@smthrs/sandbox/Sandbox"
import { Context, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Workspace from "../src/Workspace.ts"
import { checkoutState, fixtureRepo, git, hostMachines } from "./workspaceSupport.ts"

type Options = Partial<Workspace.Options> & { readonly services?: Layer.Layer<any> }

const within = <A, E>(effect: Effect.Effect<A, E, Workspace.Workspace>, options: Options = {}) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Workspace.layer({ machines: options.machines ?? hostMachines().machines, maxConcurrentVMs: 1, ...options })
          .pipe(Layer.provide(options.services ?? NodeServices.layer))
      )
    )
  )

const failing = <A>(effect: Effect.Effect<A, Workspace.WorkspaceError, Workspace.Workspace>, options?: Options) =>
  within(Effect.flip(effect), options)

const service = Workspace.Workspace

/** The Node services with one of them replaced. */
const overriding = <S>(tag: Context.Key<NodeServices.NodeServices, S>, replace: (real: S) => S) =>
  Layer.effectContext(
    Effect.map(Effect.context<NodeServices.NodeServices>(), (context) =>
      Context.add(context, tag, replace(Context.get(context, tag))))
  ).pipe(Layer.provide(NodeServices.layer))

/** Machines whose commands matching `fault` exit 3 instead of running. */
const faulty = (fault: RegExp, base = hostMachines().machines): Workspace.Machines => {
  const wrap = (session: Session): Session => ({
    ...session,
    spawn: (command, options) => session.spawn(fault.test(command) ? "echo injected >&2; exit 3" : command, options)
  })
  return {
    workspace: (key, boot) => Effect.map(base.workspace(key, boot), wrap),
    fresh: (key, boot) => Effect.map(base.fresh(key, boot), wrap),
    dispose: base.dispose,
    bases: base.bases
  }
}

const broken = (message: string) => Effect.fail(new ProviderError({ code: "unavailable", message }))

/** Machines whose sessions fail one operation. */
const failingSession = (operation: "spawn" | "writeFile", base = hostMachines().machines): Workspace.Machines => {
  const wrap = (session: Session): Session => ({
    ...session,
    ...(operation === "spawn" ? { spawn: () => broken("the machine died") } : {
      writeFile: () => broken("the disk is full")
    })
  })
  return {
    workspace: (key, boot) => Effect.map(base.workspace(key, boot), wrap),
    fresh: (key, boot) => Effect.map(base.fresh(key, boot), wrap),
    dispose: base.dispose,
    bases: base.bases
  }
}

const unopenable: Workspace.Machines = {
  workspace: () => broken("no machine"),
  fresh: () => broken("no machine"),
  dispose: () => broken("no machine"),
  bases: {
    identity: "none",
    exists: () => broken("no machine"),
    capture: () => broken("no machine"),
    remove: () => broken("no machine")
  }
}

const prepare = (repoPath: string, commit: string, key = "run-1/example/demo/build") =>
  Effect.flatMap(service, (workspace) => workspace.prepare({ key, repoPath, commit }))

describe("prepare and collect", () => {
  it("seeds a commit, reuses the same seed, and collects exactly the change", async () => {
    const { repo, commit } = fixtureRepo()
    const { machines, root } = hostMachines()
    const outcome = await within(
      Effect.gen(function*() {
        const workspace = yield* service
        const prepared = yield* prepare(repo, "main")
        const again = yield* prepare(repo, commit)
        const edits = Effect.scoped(Effect.gen(function*() {
          const session = yield* workspace.session(prepared.key)
          yield* session.writeFile(`${session.workdir}/lib.txt`, new TextEncoder().encode("hello world\n"))
          yield* session.writeFile(`${session.workdir}/image.bin`, new Uint8Array([0, 1, 2, 255]))
        }))
        yield* edits
        const diff = yield* workspace.collect(prepared)
        yield* workspace.dispose(prepared)
        return { prepared, again, diff }
      }),
      { machines }
    )
    expect(outcome.prepared.commit).toBe(commit)
    expect(outcome.again).toEqual(outcome.prepared)
    expect(outcome.diff.files).toEqual([
      { path: "image.bin", added: null, deleted: null },
      { path: "lib.txt", added: 1, deleted: 1 }
    ])
    expect(outcome.diff.added).toBe(1)
    expect(outcome.diff.patch).toContain("GIT binary patch")
    expect(readdirSync(root)).toEqual([])
  })

  it("prepares a checker's machine with a collected change applied once", async () => {
    const { repo, commit } = fixtureRepo()
    const { machines } = hostMachines()
    const outcome = await within(
      Effect.gen(function*() {
        const workspace = yield* service
        const built = yield* prepare(repo, commit)
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* workspace.session(built.key)
          yield* session.writeFile(`${session.workdir}/lib.txt`, new TextEncoder().encode("hello world\n"))
        }))
        const { patch } = yield* workspace.collect(built)
        const request = { key: "run-1/example/demo/check-1", repoPath: repo, commit, patch }
        const checking = yield* workspace.prepare(request)
        const again = yield* workspace.prepare(request)
        const seen = yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* workspace.session(checking.key)
          return new TextDecoder().decode(yield* session.readFile(`${session.workdir}/lib.txt`))
        }))
        const collected = yield* workspace.collect(checking)
        const refused = yield* Effect.flip(
          workspace.prepare({ ...request, key: "run-1/example/demo/check-2", patch: "not a patch\n" })
        )
        return { checking, again, seen, collected, patch, refused }
      }),
      { machines }
    )
    expect(outcome.again).toEqual(outcome.checking)
    expect(outcome.seen).toBe("hello world\n")
    expect(outcome.collected.patch).toBe(outcome.patch)
    expect(outcome.refused.code).toBe("patch-does-not-apply")
  })

  it("refuses a key, commit, or seed it cannot use", async () => {
    const { repo, commit } = fixtureRepo()
    expect((await failing(prepare(repo, commit, "../escape"))).code).toBe("invalid-request")
    expect((await failing(prepare(repo, "--upload-pack=x"))).code).toBe("invalid-request")
    expect((await failing(prepare(repo, "no-such-branch"))).code).toBe("not-a-commit")
    expect((await failing(prepare(repo, commit), { limits: { archiveBytes: 16 } })).code).toBe("too-large")

    // Seeded at one commit, the workspace refuses another.
    const { machines } = hostMachines()
    writeFileSync(join(repo, "lib.txt"), "hello again\n")
    git(repo, "commit", "-qam", "second")
    await within(prepare(repo, commit), { machines })
    const occupied = await failing(prepare(repo, "main"), { machines })
    expect(occupied.code).toBe("occupied")
  })

  it("refuses a session in a machine that holds no seeded workspace, or one seeded at another commit", async () => {
    const { repo, commit } = fixtureRepo()
    const { machines } = hostMachines()
    const open = (key: string, options?: Workspace.SessionOptions) =>
      Effect.scoped(Effect.flatMap(service, (workspace) => Effect.asVoid(workspace.session(key, options))))

    // A machine lost with its host comes back empty: nothing to work in.
    const lost = await failing(open("run-1/example/demo/build"), { machines })
    expect(lost.code).toBe("unseeded")
    expect(lost.message).toContain("workspace run-1/example/demo/build holds no seeded checkout")

    const prepared = await within(prepare(repo, commit), { machines })
    await within(open(prepared.key, { commit }), { machines })
    await within(open(prepared.key), { machines })
    const other = "0".repeat(40)
    const moved = await failing(open(prepared.key, { commit: other }), { machines })
    expect(moved.code).toBe("occupied")
    expect(moved.message).toBe(`workspace ${prepared.key} is seeded at ${commit}, not ${other}`)
    expect((await failing(open(prepared.key), { machines: faulty(/^cat /, machines) })).code).toBe("unseeded")
  })

  it("starts over an interrupted seed of the same key", async () => {
    const { repo, commit } = fixtureRepo()
    const { machines } = hostMachines()
    await within(Effect.scoped(Effect.gen(function*() {
      const session = yield* machines.workspace("run-1/example/demo/build")
      yield* session.writeFile(`${session.workdir}/half-extracted.txt`, new Uint8Array([1]))
    })))
    const prepared = await within(prepare(repo, commit), { machines })
    expect(existsSync(join(prepared.workdir, "half-extracted.txt"))).toBe(false)
    expect(existsSync(join(prepared.workdir, "lib.txt"))).toBe(true)
  })

  it("reports an archive git cannot write", async () => {
    const { repo, commit } = fixtureRepo()
    const blob = git(repo, "rev-parse", `${commit}:lib.txt`)
    rmSync(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)))
    expect((await failing(prepare(repo, commit))).code).toBe("archive-failed")
  })

  it("reports each machine step that fails", async () => {
    const { repo, commit } = fixtureRepo()
    const at = async (fault: RegExp) => (await failing(prepare(repo, commit), { machines: faulty(fault) })).message
    expect(await at(/^tar /)).toContain("the archive could not be extracted: injected")
    expect(await at(/^find /)).toContain("an interrupted seed could not be cleared")
    expect(await at(/^git init/)).toContain("the baseline commit could not be recorded")
    expect((await failing(prepare(repo, commit), { machines: unopenable })).message).toContain(
      "the workspace machine could not be opened: no machine"
    )
    expect((await failing(prepare(repo, commit), { machines: failingSession("writeFile") })).message).toContain(
      "the archive could not be copied into the machine"
    )
    expect((await failing(prepare(repo, commit), { machines: failingSession("spawn") })).message).toContain(
      "the machine did not run a command"
    )

    const collectWith = async (machines: Workspace.Machines) => {
      const prepared = await within(prepare(repo, commit), { machines })
      return failing(Effect.flatMap(service, (workspace) => workspace.collect(prepared)), { machines })
    }
    const base = hostMachines().machines
    expect((await collectWith(faulty(/^git -c .* add -A$/, base))).message).toContain("the change could not be staged")
    expect((await collectWith(faulty(/^git diff --numstat/, hostMachines().machines))).message).toContain(
      "the change could not be read"
    )
    const { machines } = hostMachines()
    const prepared = await within(prepare(repo, commit), { machines })
    await within(
      Effect.scoped(Effect.gen(function*() {
        const session = yield* (yield* service).session(prepared.key)
        yield* session.writeFile(`${session.workdir}/big.txt`, new TextEncoder().encode("x\n".repeat(10_000)))
      })),
      { machines }
    )
    expect(
      (await failing(Effect.flatMap(service, (w) => w.collect(prepared)), { machines, limits: { diffBytes: 1_000 } }))
        .code
    )
      .toBe("too-large")
    expect((await failing(Effect.flatMap(service, (w) => w.collect(prepared)), { machines: unopenable })).code).toBe(
      "unavailable"
    )
    expect(
      (await failing(Effect.scoped(Effect.flatMap(service, (w) => w.session("k"))), { machines: unopenable })).code
    )
      .toBe("unavailable")
    expect((await failing(Effect.flatMap(service, (w) => w.dispose(prepared)), { machines: unopenable })).code).toBe(
      "unavailable"
    )
  })

  it("reports a host without a runnable git", async () => {
    const { repo, commit } = fixtureRepo()
    const noGit = overriding(
      ChildProcessSpawner,
      () =>
        makeSpawner(() =>
          Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }))
        )
    )
    const refused = await failing(prepare(repo, commit), { services: noGit })
    expect(refused.code).toBe("git-failed")
    expect(refused.message).toContain("git rev-parse could not run")
  })
})

describe("runChecks", () => {
  const checks: ReadonlyArray<Workspace.Check> = [{ name: "fixture", argv: ["sh", "check.sh"] }]

  const change = async (repo: string, commit: string) => {
    const { machines } = hostMachines()
    return within(
      Effect.gen(function*() {
        const workspace = yield* service
        const prepared = yield* prepare(repo, commit)
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* workspace.session(prepared.key)
          yield* session.writeFile(`${session.workdir}/lib.txt`, new TextEncoder().encode("hello world\n"))
        }))
        return (yield* workspace.collect(prepared)).patch
      }),
      { machines }
    )
  }

  const checked = (request: Omit<Workspace.ChecksRequest, "key"> & { readonly key?: string }, options?: Options) =>
    within(
      Effect.flatMap(service, (workspace) => workspace.runChecks({ key: "run-1/example/demo/checks", ...request })),
      options
    )

  it("passes with the patch applied in a fresh machine, and fails without it", async () => {
    const { repo, commit } = fixtureRepo()
    const patch = await change(repo, commit)
    const { machines, root } = hostMachines()
    const passed = await checked({ repoPath: repo, commit, patch, checks }, { machines })
    expect(passed).toMatchObject({ commit, passed: true })
    expect(passed.receipts[0]).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: { text: "ok\n", bytes: 3, truncated: false }
    })
    expect(readdirSync(root)).toEqual([])

    const failed = await checked({
      repoPath: repo,
      commit,
      patch: "",
      checks: [...checks, { name: "loud", argv: ["sh", "-c", "yes | head -c 100000"], timeoutMs: 20_000 }, {
        name: "slow",
        argv: ["sleep", "20"],
        timeoutMs: 200
      }]
    }, { limits: { outputBytes: 1_000 } })
    expect(failed.passed).toBe(false)
    expect(failed.receipts.map((receipt) => [receipt.name, receipt.exitCode, receipt.timedOut])).toEqual([
      ["fixture", 1, false],
      ["loud", 0, false],
      ["slow", null, true]
    ])
    expect(failed.receipts[0]!.stderr.text).toBe("lib.txt is wrong\n")
    expect(failed.receipts[1]!.stdout).toMatchObject({ bytes: 100_000, truncated: true })
    expect(failed.receipts[1]!.stdout.text).toHaveLength(1_000)
  })

  it("refuses bad requests and a patch that does not apply", async () => {
    const { repo, commit } = fixtureRepo()
    const refuse = (request: Partial<Workspace.ChecksRequest>, options?: Options) =>
      failing(
        Effect.flatMap(service, (workspace) =>
          workspace.runChecks({ key: "run-1/x/checks", repoPath: repo, commit, patch: "", checks, ...request })),
        options
      )
    expect((await refuse({ key: "" })).code).toBe("invalid-request")
    expect((await refuse({ checks: [{ name: "", argv: [] }] as never })).code).toBe("invalid-request")
    expect((await refuse({ patch: "diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-a\n+b\n" })).code)
      .toBe("patch-does-not-apply")
    expect((await refuse({}, { machines: unopenable })).message).toContain("the check machine could not be opened")
    expect((await refuse({ patch: "x" }, { machines: failingSession("writeFile") })).message).toContain(
      "could not be copied into the machine"
    )
  })

  it("reports a check the machine could not start", async () => {
    const { repo, commit } = fixtureRepo()
    const base = hostMachines().machines
    const dying: Workspace.Machines = {
      ...base,
      fresh: (key) =>
        Effect.map(base.fresh(key), (session) => ({
          ...session,
          spawn: (command, options) =>
            command.startsWith("'") ? broken("the machine died") : session.spawn(command, options)
        }))
    }
    const refused = await failing(
      Effect.flatMap(
        service,
        (workspace) => workspace.runChecks({ key: "run-1/x/checks", repoPath: repo, commit, patch: "", checks })
      ),
      { machines: dying }
    )
    expect(refused.message).toBe("check fixture did not run: the machine died")
  })
})

describe("applyChange", () => {
  const land = (
    request: Partial<Workspace.ApplyRequest> & Pick<Workspace.ApplyRequest, "repoPath" | "parent">,
    options?: Options
  ) =>
    within(
      Effect.flatMap(service, (workspace) =>
        workspace.applyChange({
          branch: "smithers/change",
          patch: "",
          message: "Change it",
          runId: "run-1",
          principal: "builder",
          at: 1_790_000_000_000,
          ...request
        })),
      options
    )

  const refusal = (
    request: Partial<Workspace.ApplyRequest> & Pick<Workspace.ApplyRequest, "repoPath" | "parent">,
    options?: Options
  ) =>
    within(
      Effect.flip(Effect.flatMap(service, (workspace) =>
        workspace.applyChange({
          branch: "smithers/change",
          patch: "",
          message: "Change it",
          runId: "run-1",
          principal: "builder",
          at: 1_790_000_000_000,
          ...request
        }))),
      options
    )

  const patchOf = async (repo: string, commit: string) => {
    const { machines } = hostMachines()
    return within(
      Effect.gen(function*() {
        const workspace = yield* service
        const prepared = yield* prepare(repo, commit)
        yield* Effect.scoped(Effect.gen(function*() {
          const session = yield* workspace.session(prepared.key)
          yield* session.writeFile(`${session.workdir}/lib.txt`, new TextEncoder().encode("hello world\n"))
        }))
        return (yield* workspace.collect(prepared)).patch
      }),
      { machines }
    )
  }

  it("lands on a new branch with trailers, again idempotently, and never touches the checkout", async () => {
    const { repo, commit } = fixtureRepo()
    const patch = await patchOf(repo, commit)
    writeFileSync(join(repo, "untracked.txt"), "local work\n")
    git(repo, "add", "untracked.txt")
    const before = checkoutState(repo)
    const applied = await land({ repoPath: repo, parent: commit, patch })
    expect(applied).toMatchObject({ branch: "smithers/change", parent: commit, created: true })
    expect(git(repo, "rev-parse", "smithers/change")).toBe(applied.commit)
    expect(git(repo, "show", `${applied.commit}:lib.txt`)).toBe("hello world")
    expect(git(repo, "log", "-1", "--format=%an <%ae>%n%B", applied.commit)).toBe(
      "Smithers Organization <organization@smithers.invalid>\nChange it\n\nSmithers-Run: run-1\nSmithers-Principal: builder"
    )
    expect(checkoutState(repo)).toEqual(before)
    const again = await land({ repoPath: repo, parent: commit, patch })
    expect(again).toEqual({ ...applied, created: false })
    expect(git(repo, "remote")).toBe("")
  })

  it("refuses a branch that moved off the expected parent and leaves the checkout untouched", async () => {
    const { repo, commit } = fixtureRepo()
    const patch = await patchOf(repo, commit)
    git(repo, "branch", "smithers/change", commit)
    writeFileSync(join(repo, "lib.txt"), "moved\n")
    git(repo, "commit", "-qam", "moved main")
    git(repo, "update-ref", "refs/heads/smithers/change", "HEAD")
    const moved = git(repo, "rev-parse", "smithers/change")
    const before = checkoutState(repo)
    const refused = await refusal({ repoPath: repo, parent: commit, patch })
    expect(refused.code).toBe("moved-parent")
    expect(git(repo, "rev-parse", "smithers/change")).toBe(moved)
    expect(checkoutState(repo)).toEqual(before)
  })

  it("lands on an existing branch still at its parent, and refuses when the ref is locked mid-landing", async () => {
    const { repo, commit } = fixtureRepo()
    const patch = await patchOf(repo, commit)
    git(repo, "branch", "smithers/change", commit)
    expect(await land({ repoPath: repo, parent: commit, patch })).toMatchObject({ created: true })
    git(repo, "branch", "smithers/locked", commit)
    writeFileSync(join(repo, ".git", "refs", "heads", "smithers", "locked.lock"), "")
    const refused = await refusal({ repoPath: repo, parent: commit, patch, branch: "smithers/locked" })
    expect(refused.code).toBe("moved-parent")
    expect(refused.message).toContain("moved while landing")
  })

  it("refuses a checked-out branch, a bad request, a parent that is not a commit, and a patch that does not apply", async () => {
    const { repo, commit } = fixtureRepo()
    expect((await refusal({ repoPath: repo, parent: commit, branch: "main" })).code).toBe("checked-out")
    expect((await refusal({ repoPath: repo, parent: "abc" })).code).toBe("invalid-request")
    expect((await refusal({ repoPath: repo, parent: commit, runId: "a\nb" })).code).toBe("invalid-request")
    expect((await refusal({ repoPath: repo, parent: commit, principal: " builder" })).code).toBe("invalid-request")
    expect((await refusal({ repoPath: repo, parent: commit, message: "  " })).code).toBe("invalid-request")
    expect((await refusal({ repoPath: repo, parent: commit, at: -1 })).code).toBe("invalid-request")
    expect((await refusal({ repoPath: repo, parent: commit, branch: "-x" })).code).toBe("invalid-request")
    expect((await refusal({ repoPath: repo, parent: commit, branch: "a..b" })).code).toBe("invalid-request")
    expect((await refusal({ repoPath: repo, parent: "0".repeat(40) })).code).toBe("not-a-commit")
    git(repo, "tag", "-a", "v1", "-m", "tag")
    expect((await refusal({ repoPath: repo, parent: git(repo, "rev-parse", "v1") })).code).toBe("not-a-commit")
    expect((await refusal({ repoPath: repo, parent: commit, patch: "not a patch\n" })).code).toBe(
      "patch-does-not-apply"
    )
  })

  it("reports a scratch directory it cannot create or write", async () => {
    const { repo, commit } = fixtureRepo()
    const faultyFs = (method: "makeTempDirectoryScoped" | "writeFileString") =>
      overriding(FileSystem.FileSystem, (fs) => ({
        ...fs,
        [method]: () =>
          Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method }))
      }))
    expect(
      (await refusal({ repoPath: repo, parent: commit }, { services: faultyFs("makeTempDirectoryScoped") })).message
    )
      .toBe("a scratch directory could not be created")
    expect((await refusal({ repoPath: repo, parent: commit }, { services: faultyFs("writeFileString") })).message).toBe(
      "the change could not be staged on disk"
    )
  })
})

describe("parseNumstat", () => {
  it("reads text and binary records and skips anything else", () => {
    expect(Workspace.parseNumstat("1\t2\ta.txt\0-\t-\tb.bin\0garbage\0")).toEqual([
      { path: "a.txt", added: 1, deleted: 2 },
      { path: "b.bin", added: null, deleted: null }
    ])
  })
})

describe("microsandbox machines", () => {
  it("builds sticky and ephemeral providers and removes a machine by its remote id", async () => {
    const destroyed: Array<string> = []
    const sdk = {
      Sandbox: {
        get: async (name: string) => {
          if (name === "gone") throw Object.assign(new Error("gone"), { code: "sandboxNotFound" })
          if (name === "stuck") throw new Error("the daemon is down")
          return { destroy: async () => void destroyed.push(name) }
        }
      },
      defaultBackendKind: () => "cloud"
    } as never
    const machines = Workspace.microsandbox({ sdk, image: "node:26-bookworm", owner: "o", holder: "h" })
    await Effect.runPromise(machines.dispose("smthrs-msb-a"))
    await Effect.runPromise(machines.dispose("gone"))
    const stuck = await Effect.runPromise(Effect.flip(machines.dispose("stuck")))
    expect(stuck.message).toBe("microsandbox: stuck could not be removed")
    expect(destroyed).toEqual(["smthrs-msb-a"])
    // Both providers pin the local backend: a hosted default is refused before provisioning.
    for (const acquire of [machines.workspace, machines.fresh]) {
      const refused = await Effect.runPromise(Effect.scoped(Effect.flip(acquire("k"))))
      expect(refused.message).toContain("the SDK's default backend is cloud")
    }
  })
})
