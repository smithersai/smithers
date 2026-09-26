/**
 * Repository environments over host-directory machines, with real `git`,
 * `sh`, and `tar`: a prepared base is made once per key, later commits sync
 * onto it, checks run against a prepared tree, and every step that can fail
 * reports how. `WorkspaceMicrovm.test.ts` prepares a real pnpm project in
 * real microVMs.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import type { Session } from "@smthrs/sandbox/Sandbox"
import { Effect, Fiber, Layer } from "effect"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Workspace from "../src/Workspace.ts"
import { tempDir } from "./support.ts"
import { git, hostMachines } from "./workspaceSupport.ts"

const service = Workspace.Workspace

const within = <A, E>(
  effect: Effect.Effect<A, E, Workspace.Workspace>,
  options: Partial<Workspace.Options> & { readonly machines: Workspace.Machines }
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Workspace.layer({ maxConcurrentVMs: 1, ...options }).pipe(Layer.provide(NodeServices.layer)))
    )
  )

const failing = <A>(
  effect: Effect.Effect<A, Workspace.WorkspaceError, Workspace.Workspace>,
  options: Partial<Workspace.Options> & { readonly machines: Workspace.Machines }
) => within(Effect.flip(effect), options)

/**
 * A repository whose "dependencies" are named by `deps.lock`: `vendor/` and
 * `node_modules/` are ignored, `vendor/tracked.txt` is tracked anyway, and
 * `check.sh` passes only when `lib.txt` says `hello world`.
 */
const environmentRepo = () => {
  const repo = tempDir()
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(join(repo, "lib.txt"), "hello\n")
  writeFileSync(join(repo, "README.md"), "# Fixture\n")
  writeFileSync(join(repo, "deps.lock"), "left-pad 1.3.0\n")
  writeFileSync(join(repo, ".gitignore"), "vendor/\nnode_modules/\n")
  mkdirSync(join(repo, "vendor"))
  writeFileSync(join(repo, "vendor", "tracked.txt"), "tracked\n")
  writeFileSync(
    join(repo, "check.sh"),
    "grep -qx 'hello world' lib.txt && echo ok || { echo 'lib.txt is wrong' >&2; exit 1; }\n"
  )
  git(repo, "add", "-A")
  git(repo, "add", "-f", "vendor/tracked.txt")
  git(repo, "commit", "-q", "-m", "initial")
  return { repo, commit: git(repo, "rev-parse", "HEAD") }
}

const commitAll = (repo: string, message: string, change: () => void) => {
  change()
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", message)
  return git(repo, "rev-parse", "HEAD")
}

/** A prepare command that installs `deps.lock`, leaves one unignored file, and counts its runs. */
const installing = (counter: string, extra = "") =>
  `mkdir -p node_modules && cp deps.lock node_modules/installed && echo generated > generated.txt && echo run >> ${counter}${extra}`

const environment = (counter: string, overrides: Partial<Workspace.Prepare> = {}): Workspace.Environment => ({
  prepare: {
    run: installing(counter),
    key: ["deps.lock", "missing.lock"],
    network: ["registry.npmjs.org"],
    ...overrides
  },
  network: "none",
  checks: [{ name: "installed", argv: ["sh", "-c", "test -f node_modules/installed && echo installed"] }]
})

const runs = (counter: string) => existsSync(counter) ? readFileSync(counter, "utf8").split("\n").length - 1 : 0

const prepare = (repoPath: string, commit: string, key: string) =>
  Effect.flatMap(service, (workspace) => workspace.prepare({ key, repoPath, commit }))

const collect = (prepared: Workspace.Prepared) => Effect.flatMap(service, (workspace) => workspace.collect(prepared))

const write = (key: string, path: string, text: string) =>
  Effect.scoped(Effect.gen(function*() {
    const session = yield* (yield* service).session(key)
    yield* session.writeFile(`${session.workdir}/${path}`, new TextEncoder().encode(text))
  }))

const broken = (message: string) => Effect.fail(new ProviderError({ code: "unavailable", message }))

/** Machines whose sessions answer commands matching `fault` with exit 3, or fail them when `fatal`. */
const faulty = (base: Workspace.Machines, fault: RegExp, fatal = false): Workspace.Machines => {
  const wrap = (session: Session): Session => ({
    ...session,
    spawn: (command, options) =>
      fault.test(command)
        ? fatal ? broken("the machine died") : session.spawn("echo injected >&2; exit 3", options)
        : session.spawn(command, options)
  })
  return {
    ...base,
    workspace: (key, boot) => Effect.map(base.workspace(key, boot), wrap),
    fresh: (key, boot) => Effect.map(base.fresh(key, boot), wrap)
  }
}

/** Machines whose sessions refuse to write a path matching `fault`. */
const unwritable = (base: Workspace.Machines, fault: RegExp): Workspace.Machines => {
  const wrap = (session: Session): Session => ({
    ...session,
    writeFile: (path, content) => fault.test(path) ? broken("the disk is full") : session.writeFile(path, content)
  })
  return {
    ...base,
    workspace: (key, boot) => Effect.map(base.workspace(key, boot), wrap),
    fresh: (key, boot) => Effect.map(base.fresh(key, boot), wrap)
  }
}

describe("prepared environments", () => {
  it("prepares a base once per key, syncs later commits onto it, and collects only the change", async () => {
    const { commit, repo } = environmentRepo()
    const counter = join(tempDir(), "runs")
    const host = hostMachines()
    const options = { machines: host.machines, environments: { [repo]: environment(counter) } }

    const first = await within(prepare(repo, commit, "run-1/demo/build"), options)
    expect(runs(counter)).toBe(1)
    expect(readFileSync(join(first.workdir, "node_modules", "installed"), "utf8")).toBe("left-pad 1.3.0\n")
    // The base was prepared with the prepare network; the workspace boots
    // from it with the environment's own.
    expect(host.boots.filter(({ key }) => !key.endsWith("/verify")).map(({ boot }) => boot)).toEqual([
      { network: ["registry.npmjs.org"] },
      { base: expect.stringMatching(/^[0-9a-f]{12}-[0-9a-f]{20}$/), network: "none" },
      { base: expect.any(String), network: "none" }
    ])

    // A tracked file under an ignored directory is part of the baseline, so
    // its edit is a change; what the preparation left is not.
    const diff = await within(
      Effect.andThen(
        Effect.all([write(first.key, "lib.txt", "hello world\n"), write(first.key, "vendor/tracked.txt", "edited\n")]),
        collect(first)
      ),
      options
    )
    expect(diff.files).toEqual([
      { path: "lib.txt", added: 1, deleted: 1 },
      { path: "vendor/tracked.txt", added: 1, deleted: 1 }
    ])

    // Checks run the environment's own first, against a prepared tree.
    const checks = await within(
      Effect.flatMap(service, (w) =>
        w.runChecks({
          key: "run-1/demo",
          repoPath: repo,
          commit,
          patch: diff.patch,
          checks: [{ name: "fixture", argv: ["sh", "check.sh"] }]
        })),
      options
    )
    expect(checks.passed).toBe(true)
    expect(checks.receipts.map((receipt) => [receipt.name, receipt.stdout.text])).toEqual([
      ["installed", "installed\n"],
      ["fixture", "ok\n"]
    ])

    // Another commit with the same lockfile reuses the base: the source
    // difference is synced and nothing is prepared again.
    const second = commitAll(repo, "second", () => {
      writeFileSync(join(repo, "lib.txt"), "hello again\n")
      writeFileSync(join(repo, "new.txt"), "new\n")
      git(repo, "rm", "-q", "README.md")
    })
    const synced = await within(prepare(repo, second, "run-2/demo/build"), options)
    expect(runs(counter)).toBe(1)
    expect(readFileSync(join(synced.workdir, "lib.txt"), "utf8")).toBe("hello again\n")
    expect(existsSync(join(synced.workdir, "README.md"))).toBe(false)
    expect(existsSync(join(synced.workdir, "node_modules", "installed"))).toBe(true)
    expect((await within(collect(synced), options)).files).toEqual([])
    // Preparing the same key again reuses the seeded workspace.
    expect(await within(prepare(repo, second, "run-2/demo/build"), options)).toEqual(synced)

    // A new lockfile is a new base; only the newest two of a repository are kept.
    for (const version of ["1.3.1", "1.3.2"]) {
      const next = commitAll(repo, version, () => writeFileSync(join(repo, "deps.lock"), `left-pad ${version}\n`))
      const prepared = await within(prepare(repo, next, `run-${version}/demo/build`), options)
      expect(readFileSync(join(prepared.workdir, "node_modules", "installed"), "utf8")).toBe(`left-pad ${version}\n`)
    }
    expect(runs(counter)).toBe(3)
    expect(readdirSync(host.bases)).toHaveLength(2)
  })

  it("replaces the tracked files from the archive when the source difference cannot be applied", async () => {
    const { repo } = environmentRepo()
    const withBig = commitAll(repo, "big", () => writeFileSync(join(repo, "big.bin"), randomBytes(40_000)))
    const counter = join(tempDir(), "runs")
    const host = hostMachines()
    // The preparation edits a tracked file, so a later edit of it conflicts.
    const options = {
      machines: host.machines,
      environments: { [repo]: environment(counter, { run: installing(counter, " && echo local >> README.md") }) }
    }
    await within(prepare(repo, withBig, "k/base"), options)

    // A difference over the byte bound (the deleted file's content) is not
    // sent; the archive of the commit is.
    const trimmed = commitAll(repo, "trim", () => git(repo, "rm", "-q", "big.bin"))
    const fromArchive = await within(prepare(repo, trimmed, "k/trim"), { ...options, limits: { archiveBytes: 30_000 } })
    expect(existsSync(join(fromArchive.workdir, "big.bin"))).toBe(false)
    expect(readFileSync(join(fromArchive.workdir, "README.md"), "utf8")).toBe("# Fixture\n")
    expect(existsSync(join(fromArchive.workdir, "node_modules", "installed"))).toBe(true)

    const conflicting = commitAll(repo, "readme", () => writeFileSync(join(repo, "README.md"), "# Changed\n"))
    const conflicted = await within(prepare(repo, conflicting, "k/conflict"), options)
    expect(readFileSync(join(conflicted.workdir, "README.md"), "utf8")).toBe("# Changed\n")
    expect(existsSync(join(conflicted.workdir, "node_modules", "installed"))).toBe(true)
    expect(runs(counter)).toBe(1)

    // A base prepared at a commit the repository no longer has syncs from the archive too.
    const lost = tempDir()
    git(lost, "init", "-q", "-b", "main")
    writeFileSync(join(lost, "deps.lock"), "left-pad 1.3.0\n")
    writeFileSync(join(lost, ".gitignore"), "node_modules/\n")
    git(lost, "add", "-A")
    git(lost, "commit", "-q", "-m", "root")
    git(lost, "checkout", "-q", "-b", "gone")
    const gone = commitAll(lost, "gone", () => writeFileSync(join(lost, "lib.txt"), "gone\n"))
    const lostOptions = { machines: host.machines, environments: { [lost]: environment(counter) } }
    await within(prepare(lost, gone, "lost/base"), lostOptions)
    git(lost, "checkout", "-q", "main")
    git(lost, "branch", "-q", "-D", "gone")
    git(lost, "reflog", "expire", "--expire=now", "--all")
    git(lost, "gc", "-q", "--prune=now")
    const kept = await within(prepare(lost, "main", "lost/main"), lostOptions)
    expect(existsSync(join(kept.workdir, "lib.txt"))).toBe(false)
    expect(existsSync(join(kept.workdir, "node_modules", "installed"))).toBe(true)
  })

  it("prepares one base for tasks that start together, and boots them without network by default", async () => {
    const { commit, repo } = environmentRepo()
    const counter = join(tempDir(), "runs")
    const host = hostMachines()
    const { network: _network, ...offline } = environment(counter)
    const options = { machines: host.machines, environments: { [repo]: offline }, maxConcurrentVMs: 2 }
    const both = await within(
      Effect.all([prepare(repo, commit, "a/build"), prepare(repo, commit, "b/build")], { concurrency: 2 }).pipe(
        // A later task of the same host trusts the base it already checked.
        Effect.tap(() => prepare(repo, commit, "c/build"))
      ),
      options
    )
    expect(runs(counter)).toBe(1)
    expect(both.map((prepared) => existsSync(join(prepared.workdir, "node_modules", "installed")))).toEqual([
      true,
      true
    ])
    const checks = await within(
      Effect.flatMap(service, (w) => w.runChecks({ key: "a", repoPath: repo, commit, patch: "", checks: [] })),
      options
    )
    expect(checks.passed).toBe(true)
    expect(
      host.boots.filter(({ boot, key }) => boot?.base !== undefined && !key.endsWith("/verify")).map(({ boot }) =>
        boot?.network
      )
    ).toEqual(
      Array(7).fill("none")
    )
  })

  it("reports a prepare command that fails or runs out of time, and captures nothing", async () => {
    const { commit, repo } = environmentRepo()
    const host = hostMachines()
    const attempt = (prepareSpec: Workspace.Prepare) =>
      failing(prepare(repo, commit, "run-1/demo/build"), {
        machines: host.machines,
        environments: { [repo]: { prepare: prepareSpec } }
      })
    const exited = await attempt({
      run: "echo resolving; echo 'no network' >&2; exit 4",
      key: ["deps.lock"],
      network: "all"
    })
    expect(exited.code).toBe("prepare-failed")
    expect(exited.message).toBe("the prepare command exited 4: resolving\nno network")
    const slow = await attempt({ run: "sleep 5", key: ["deps.lock"], network: "none", timeoutMs: 200 })
    expect(slow.message).toBe("the prepare command timed out")
    expect(readdirSync(host.bases)).toEqual([])
    expect(readdirSync(host.root)).toEqual([])
    // Checks cannot run without their base either.
    const checks = await failing(
      Effect.flatMap(service, (w) => w.runChecks({ key: "run-1/demo", repoPath: repo, commit, patch: "", checks: [] })),
      {
        machines: host.machines,
        environments: { [repo]: { prepare: { run: "exit 1", key: ["deps.lock"], network: "none" } } }
      }
    )
    expect(checks.code).toBe("prepare-failed")
  })

  it("replaces a workspace machine booted without its base, and refuses a base without a prepared tree", async () => {
    const { commit, repo } = environmentRepo()
    const counter = join(tempDir(), "runs")
    const host = hostMachines()
    const options = { machines: host.machines, environments: { [repo]: environment(counter) } }
    // A machine opened before the repository had an environment.
    await Effect.runPromise(Effect.scoped(host.machines.workspace("run-1/demo/build")))
    const prepared = await within(prepare(repo, commit, "run-1/demo/build"), options)
    expect(existsSync(join(prepared.workdir, "node_modules", "installed"))).toBe(true)

    // Bases whose check boot holds the tree, but whose workspaces and check
    // machines boot bare: the base changed after it was checked.
    const other = hostMachines()
    const bare: Workspace.Machines = {
      ...other.machines,
      workspace: (key, boot) => other.machines.workspace(key, key.startsWith("bases/") ? boot : undefined),
      fresh: (key, boot) => other.machines.fresh(key, key.endsWith("/verify") ? boot : undefined)
    }
    const refused = await failing(prepare(repo, commit, "run-2/demo/build"), { ...options, machines: bare })
    expect(refused).toMatchObject({
      code: "seed-failed",
      message: "the machine booted from the prepared base holds no prepared tree"
    })
    const checks = await failing(
      Effect.flatMap(service, (w) => w.runChecks({ key: "run-2/demo", repoPath: repo, commit, patch: "", checks: [] })),
      { ...options, machines: bare }
    )
    expect(checks.code).toBe("seed-failed")
  })

  it("prepares again a base that lost its prepared tree, and refuses one that keeps losing it", async () => {
    const { commit, repo } = environmentRepo()
    const counter = join(tempDir(), "runs")
    const environments = { [repo]: environment(counter) }
    // The capture loses the guest's last writes once, as a stop that is not
    // graceful can: the base is checked, removed, and prepared again.
    let lost = 0
    const once = hostMachines(tempDir(), tempDir(), { loseWrites: () => lost++ === 0 })
    const prepared = await within(prepare(repo, commit, "run-1/demo/build"), { machines: once.machines, environments })
    expect(existsSync(join(prepared.workdir, "node_modules", "installed"))).toBe(true)
    expect(runs(counter)).toBe(2)
    expect(readdirSync(once.bases)).toHaveLength(1)
    const losing = hostMachines(tempDir(), tempDir(), { loseWrites: () => true }).machines
    const failedRemoval = await failing(prepare(repo, commit, "run-5/demo/build"), {
      machines: { ...losing, bases: { ...losing.bases, remove: () => broken("busy") } },
      environments
    })
    expect(failedRemoval.message).toBe("a broken prepared base could not be removed: busy")

    // A capture that always loses them is refused, and nothing broken is kept.
    const shared = tempDir()
    const lossy = hostMachines(tempDir(), shared, { loseWrites: () => true })
    const refused = await failing(prepare(repo, commit, "run-2/demo/build"), { machines: lossy.machines, environments })
    expect(refused).toMatchObject({
      code: "prepare-failed",
      message: expect.stringMatching(/did not keep its prepared tree$/)
    })
    expect(readdirSync(shared)).toEqual([])

    // A base another process left without its tree is found before use,
    // removed, and prepared again.
    const good = hostMachines(tempDir(), shared)
    await within(prepare(repo, commit, "run-3/demo/build"), { machines: good.machines, environments })
    const name = readdirSync(shared)[0]!
    rmSync(join(shared, name, ".git", "smithers-prepared"))
    const before = runs(counter)
    const healed = await within(prepare(repo, commit, "run-4/demo/build"), { machines: good.machines, environments })
    expect(runs(counter)).toBe(before + 1)
    expect(existsSync(join(healed.workdir, "node_modules", "installed"))).toBe(true)
    expect(existsSync(join(shared, name, ".git", "smithers-prepared"))).toBe(true)
  })

  it("keeps the base a task is booting from while concurrent tasks of the repository prepare newer ones", async () => {
    const { commit, repo } = environmentRepo()
    const counter = join(tempDir(), "runs")
    const host = hostMachines()
    const environments = { [repo]: environment(counter) }
    const lockfile = (version: string) =>
      commitAll(repo, version, () => writeFileSync(join(repo, "deps.lock"), `left-pad ${version}\n`))
    const [second, third] = [lockfile("1.3.1"), lockfile("1.3.2")]
    // The first task's workspace boot waits until two newer bases exist:
    // pruning to the newest two would remove the base it is booting from.
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => release = resolve)
    let booting = false
    const waiting: Workspace.Machines = {
      ...host.machines,
      workspace: (key, boot) =>
        key === "first/build"
          ? Effect.andThen(
            Effect.andThen(Effect.sync(() => booting = true), Effect.promise(() => gate)),
            host.machines.workspace(key, boot)
          )
          : host.machines.workspace(key, boot)
    }
    const options = { machines: waiting, environments, maxConcurrentVMs: 4 }
    const booted = await within(
      Effect.gen(function*() {
        const first = yield* Effect.forkChild(prepare(repo, commit, "first/build"))
        while (!booting) yield* Effect.sleep(10)
        yield* Effect.all([prepare(repo, second, "second/build"), prepare(repo, third, "third/build")], {
          concurrency: 2
        })
        expect(readdirSync(host.bases)).toHaveLength(3)
        release()
        return yield* Fiber.join(first)
      }),
      options
    )
    expect(readFileSync(join(booted.workdir, "node_modules", "installed"), "utf8")).toBe("left-pad 1.3.0\n")
    // With nothing booting from it, the next preparation prunes it.
    await within(
      prepare(
        repo,
        commitAll(repo, "1.3.3", () => writeFileSync(join(repo, "deps.lock"), "left-pad 1.3.3\n")),
        "fourth/build"
      ),
      options
    )
    expect(readdirSync(host.bases)).toHaveLength(2)
    // Every checks run of the three commits concurrently boots from its own base.
    const checks = await within(
      Effect.all(
        [commit, second, third].map((at, index) =>
          Effect.flatMap(
            service,
            (w) => w.runChecks({ key: `c-${index}`, repoPath: repo, commit: at, patch: "", checks: [] })
          )
        ),
        { concurrency: 3 }
      ),
      options
    )
    expect(checks.map((result) => result.passed)).toEqual([true, true, true])
  })

  it("reports each step of preparing and syncing that fails", async () => {
    const { commit, repo } = environmentRepo()
    const counter = join(tempDir(), "runs")
    const environments = { [repo]: environment(counter) }
    const at = async (machines: (base: Workspace.Machines) => Workspace.Machines, key = "run-1/demo/build") =>
      (await failing(prepare(repo, commit, key), { machines: machines(hostMachines().machines), environments }))
        .message

    expect(await at((base) => ({ ...base, bases: { ...base.bases, exists: () => broken("no index") } }))).toBe(
      "the prepared base could not be read: no index"
    )
    expect(await at((base) => ({ ...base, bases: { ...base.bases, capture: () => broken("disk busy") } }))).toBe(
      "the prepared base could not be captured: disk busy"
    )
    expect(
      await at((base) => ({
        ...base,
        workspace: (key, boot) => key.startsWith("bases/") ? broken("no machine") : base.workspace(key, boot)
      }))
    ).toBe("the machine a base is prepared in could not be opened: no machine")
    expect(await at((base) => faulty(base, /smithers-prepare\.log 2>&1$/, true))).toContain(
      "the prepare command did not run"
    )
    expect(await at((base) => faulty(base, /^sync$/))).toBe("the prepared tree could not be flushed: injected")
    expect(await at((base) => faulty(base, /^rm -f \.git\/smithers-base && git -c .* add -A/))).toContain(
      "the baseline commit could not be recorded"
    )

    // With the base prepared, each sync step.
    const host = hostMachines()
    await within(prepare(repo, commit, "warm/build"), { machines: host.machines, environments })
    const second = commitAll(repo, "second", () => writeFileSync(join(repo, "lib.txt"), "hello again\n"))
    const sync = async (machines: Workspace.Machines, key: string) =>
      (await failing(prepare(repo, second, key), { machines, environments })).message
    expect(await sync(faulty(host.machines, /^git reset/), "s/reset")).toContain(
      "the prepared tree could not be restored"
    )
    expect(
      await sync(
        faulty(host.machines, /^git apply --binary --whitespace=nowarn \.smithers-sync|^git ls-files -z/),
        "s/clear"
      )
    )
      .toContain("the prepared tree could not be cleared")
    expect(await sync(unwritable(host.machines, /smithers-sync\.patch$/), "s/patch")).toContain(
      "the source difference could not be copied into the machine"
    )
    expect(await sync(unwritable(host.machines, /smithers-files$/), "s/files")).toContain(
      "the file list could not be copied into the machine"
    )
    const replacing: Workspace.Machines = { ...host.machines, dispose: () => broken("stuck") }
    await Effect.runPromise(Effect.scoped(host.machines.workspace("s/replace")))
    expect(await sync(replacing, "s/replace")).toBe("a machine without its base could not be replaced: stuck")
    const checks = await failing(
      Effect.flatMap(service, (w) => w.runChecks({ key: "c", repoPath: repo, commit: second, patch: "", checks: [] })),
      {
        machines: {
          ...host.machines,
          fresh: (key, boot) => key.endsWith("/verify") ? host.machines.fresh(key, boot) : broken("no machine")
        },
        environments
      }
    )
    expect(checks.message).toBe("the machine could not be opened: no machine")
    const unbootable = await failing(prepare(repo, second, "s/unbootable"), {
      machines: { ...host.machines, fresh: () => broken("no machine") },
      environments
    })
    expect(unbootable.message).toBe("the prepared base could not be booted: no machine")
  })

  it("reports a commit whose files cannot be listed", async () => {
    const { commit, repo } = environmentRepo()
    const counter = join(tempDir(), "runs")
    const host = hostMachines()
    const environments = { [repo]: environment(counter) }
    await within(prepare(repo, commit, "warm/build"), { machines: host.machines, environments })
    // The file list alone is over the byte bound.
    const refused = await failing(prepare(repo, commit, "listed/build"), {
      machines: host.machines,
      environments,
      limits: { archiveBytes: 100 }
    })
    expect(refused.code).toBe("archive-failed")
    expect(refused.message).toContain(`the files of ${commit} could not be listed`)
  })

  it("boots a repository without a prepare command with its declared network and runs its checks", async () => {
    const { commit, repo } = environmentRepo()
    const host = hostMachines()
    const options = {
      machines: host.machines,
      environments: {
        [repo]: {
          network: "all",
          checks: [{ name: "readme", argv: ["test", "-f", "README.md"] }]
        } satisfies Workspace.Environment
      }
    }
    await within(prepare(repo, commit, "plain/build"), options)
    const checks = await within(
      Effect.flatMap(service, (w) => w.runChecks({ key: "plain", repoPath: repo, commit, patch: "", checks: [] })),
      options
    )
    expect(checks.receipts.map((receipt) => [receipt.name, receipt.exitCode])).toEqual([["readme", 0]])
    expect(host.boots.map(({ boot }) => boot)).toEqual([
      { base: undefined, network: "all" },
      { base: undefined, network: "all" }
    ])
  })
})

describe("task bases", () => {
  /** A checkout of a bare remote, the checkout left behind while the remote advances. */
  const withRemote = () => {
    const remote = tempDir()
    git(remote, "init", "-q", "--bare", "-b", "main")
    const { repo, commit } = environmentRepo()
    git(repo, "remote", "add", "origin", remote)
    git(repo, "push", "-q", "origin", "main")
    const upstream = tempDir()
    git(upstream, "clone", "-q", remote, ".")
    const advanced = commitAll(upstream, "advance", () => writeFileSync(join(upstream, "lib.txt"), "hello world\n"))
    git(upstream, "push", "-q", "origin", "main")
    return { repo, commit, remote, advanced }
  }
  const resolved = (
    repo: string,
    environment: Workspace.Environment | undefined,
    commit?: string,
    options: Partial<Workspace.Options> = {}
  ) =>
    within(Effect.flatMap(service, (w) => w.resolveBase({ repoPath: repo, commit })), {
      machines: hostMachines().machines,
      environments: environment === undefined ? {} : { [repo]: environment },
      ...options
    })

  it("starts from the fetched remote branch, leaving the checkout's HEAD, index, and tree alone", async () => {
    const { repo, commit, advanced } = withRemote()
    writeFileSync(join(repo, "README.md"), "# Local edit\n")
    git(repo, "add", "README.md")
    writeFileSync(join(repo, "lib.txt"), "unstaged\n")
    const status = git(repo, "status", "--porcelain")

    expect(await resolved(repo, undefined)).toEqual({ ref: "HEAD", commit, fetched: false })
    expect(await resolved(repo, { base: "origin/main" })).toEqual({
      ref: "origin/main",
      commit: advanced,
      fetched: true
    })
    expect(git(repo, "rev-parse", "HEAD")).toBe(commit)
    expect(git(repo, "status", "--porcelain")).toBe(status)
    expect(readFileSync(join(repo, "lib.txt"), "utf8")).toBe("unstaged\n")

    // An explicit commit is what it names; a base that is no remote's branch
    // is resolved without fetching.
    expect(await resolved(repo, { base: "origin/main" }, commit)).toEqual({ ref: commit, commit, fetched: false })
    git(repo, "branch", "feature/x", commit)
    expect(await resolved(repo, { base: "feature/x" })).toEqual({ ref: "feature/x", commit, fetched: false })
    expect(await resolved(repo, { base: "main" })).toEqual({ ref: "main", commit, fetched: false })
  })

  it("fails a base whose fetch fails or does not finish, and one that names no commit", async () => {
    const { repo, remote } = withRemote()
    const refused = (environment: Workspace.Environment, options: Partial<Workspace.Options> = {}) =>
      failing(Effect.flatMap(service, (w) => w.resolveBase({ repoPath: repo })), {
        machines: hostMachines().machines,
        environments: { [repo]: environment },
        ...options
      })
    const gone = await refused({ base: "origin/gone" })
    expect(gone.code).toBe("fetch-failed")
    expect(gone.message).toContain("git fetch origin gone failed: fatal: couldn't find remote ref refs/heads/gone")
    git(repo, "config", "remote.origin.uploadpack", "sleep 5; git-upload-pack")
    const slow = await refused({ base: "origin/main" }, { fetchTimeoutMs: 200 })
    expect(slow).toMatchObject({ code: "fetch-failed", message: "git fetch origin main did not finish in 200 ms" })
    git(repo, "config", "--unset", "remote.origin.uploadpack")
    rmSync(remote, { recursive: true, force: true })
    expect((await refused({ base: "origin/main" })).code).toBe("fetch-failed")
    expect((await refused({ base: "nowhere/main" })).code).toBe("not-a-commit")
  })
})

describe("prepared tools", () => {
  const tools = (environment: Workspace.Environment, key = "doctor/tools", machines = hostMachines().machines) => {
    const { repo, commit } = environmentRepo()
    return {
      repo,
      found: () =>
        within(Effect.flatMap(service, (w) => w.findTools({ key, repoPath: repo, commit })), {
          machines,
          environments: { [repo]: environment }
        }),
      refused: () =>
        failing(Effect.flatMap(service, (w) => w.findTools({ key, repoPath: repo, commit })), {
          machines,
          environments: { [repo]: environment }
        })
    }
  }

  it("finds each declared tool in a machine booted from the prepared base", async () => {
    const counter = join(tempDir(), "runs")
    const found = await tools(environment(counter, { tools: ["git", "sh"] })).found()
    expect(found.base).toEqual(expect.any(String))
    expect(found.tools).toEqual([
      { name: "git", path: expect.stringMatching(/\/git$/) },
      { name: "sh", path: expect.stringMatching(/\/sh$/) }
    ])
    expect(await tools(environment(counter)).found()).toEqual({ base: expect.any(String), tools: [] })
    expect(await tools({ network: "none" }).found()).toEqual({ base: undefined, tools: [] })
  })

  it("refuses to capture a base that lacks a declared tool, and reports what it could not do", async () => {
    const counter = join(tempDir(), "runs")
    const missing = await tools(environment(counter, { tools: ["git", "smithers-no-such-tool"] })).refused()
    expect(missing).toMatchObject({ code: "prepare-failed", message: "the prepared base lacks smithers-no-such-tool" })
    expect((await tools(environment(counter), "").refused()).code).toBe("invalid-request")

    // Found in the base's own machine: one that cannot boot is unavailable.
    const base = hostMachines()
    const booting = tools(environment(counter, { tools: ["git"] }), "doctor/tools", base.machines)
    await booting.found()
    const unbootable: Workspace.Machines = {
      ...base.machines,
      fresh: (key, boot) =>
        key.includes("/tools-")
          ? Effect.fail(new ProviderError({ code: "unavailable", message: "no machine" }))
          : base.machines.fresh(key, boot)
    }
    const refused = await failing(
      Effect.flatMap(service, (w) => w.findTools({ key: "doctor/tools", repoPath: booting.repo, commit: "HEAD" })),
      { machines: unbootable, environments: { [booting.repo]: environment(counter, { tools: ["git"] }) } }
    )
    expect(refused.message).toBe("a machine could not be booted from the prepared base: no machine")
  })
})

describe("microsandbox machines with environments", () => {
  it("boots from the image or a base with the declared network, and keeps its bases", async () => {
    const builds: Array<Record<string, unknown>> = []
    const snapshots: Array<string> = []
    const removed: Array<string> = []
    const sdk = {
      Sandbox: {
        builder: () => {
          const settings: Record<string, unknown> = {}
          const builder = new Proxy({}, {
            get: (_, method: string) =>
              method === "create"
                ? () => {
                  builds.push(settings)
                  return Promise.reject(new Error("no hypervisor in this test"))
                }
                : method === "network"
                ? (configure: (network: unknown) => unknown) => {
                  configure({ policy: (policy: unknown) => (settings["networkPolicy"] = policy, undefined) })
                  return builder
                }
                : (value: unknown) => {
                  settings[method] = value ?? true
                  return builder
                }
          })
          return builder
        },
        get: async (name: string) => ({
          status: "running",
          stop: async () => undefined,
          snapshot: async (snapshot: string) => void snapshots.push(`${name}->${snapshot}`),
          destroy: async () => undefined
        })
      },
      Snapshot: {
        get: async (name: string) => {
          if (!snapshots.some((entry) => entry.endsWith(`->${name}`))) {
            throw new Error(`GenericFailure [SnapshotNotFound] snapshot not found: ${name}`)
          }
          return {}
        },
        list: async () => snapshots.map((entry, index) => ({ name: entry.split("->")[1], createdAt: new Date(index) })),
        remove: async (name: string) => void removed.push(name)
      },
      defaultBackendKind: () => "local"
    } as never
    const machines = Workspace.microsandbox({ sdk, image: "node:26-bookworm", owner: "o", holder: "h", network: true })
    const boot = (boot: Workspace.Boot | undefined, fresh = false) =>
      Effect.runPromise(Effect.scoped(Effect.flip(fresh ? machines.fresh("k", boot) : machines.workspace("k", boot))))
    await boot(undefined)
    await boot({ network: "none" }, true)
    await boot({ base: "fam-base", network: ["registry.npmjs.org", "*.githubusercontent.com"] })
    const [image, none, based] = builds
    expect(image).toMatchObject({ image: "node:26-bookworm", rootDisk: Workspace.defaultDiskMib })
    expect(image!["disableNetwork"]).toBeUndefined()
    expect(image!["networkPolicy"]).toBeUndefined()
    expect(none).toMatchObject({ disableNetwork: true })
    expect(based!["image"]).toBeUndefined()
    expect(based!["rootDisk"]).toBeUndefined()
    expect(based!["fromSnapshot"]).toBe(`${Workspace.basePrefix("o")}fam-base`)
    expect(Workspace.basePrefix("o")).toMatch(/^smthrs-env-[0-9a-f]{8}-$/)
    expect(based!["networkPolicy"]).toEqual({
      defaultEgress: "deny",
      defaultIngress: "deny",
      rules: [
        {
          direction: "egress",
          destination: { kind: "group", group: "host" },
          protocols: ["udp", "tcp"],
          ports: [{ start: 53, end: 53 }],
          action: "allow"
        },
        {
          direction: "egress",
          destination: { kind: "domain", domain: "registry.npmjs.org" },
          protocols: [],
          ports: [],
          action: "allow"
        },
        {
          direction: "egress",
          destination: { kind: "domainSuffix", suffix: "githubusercontent.com" },
          protocols: [],
          ports: [],
          action: "allow"
        }
      ]
    })

    expect(machines.bases.identity).toBe(`microsandbox node:26-bookworm disk ${Workspace.defaultDiskMib}`)
    expect(await Effect.runPromise(machines.bases.exists("fam-1"))).toBe(false)
    for (const name of ["fam-1", "fam-2", "fam-3"]) {
      await Effect.runPromise(machines.bases.capture("smthrs-msb-bake", name, "fam", ["fam-1"]))
    }
    expect(await Effect.runPromise(machines.bases.exists("fam-3"))).toBe(true)
    // The oldest is kept while a machine is booting from it.
    expect(removed).toEqual([])
    await Effect.runPromise(machines.bases.capture("smthrs-msb-bake", "fam-4", "fam", []))
    expect(removed).toEqual([expect.stringMatching(/-fam-2$/), expect.stringMatching(/-fam-1$/)])
    await Effect.runPromise(machines.bases.remove("fam-4"))
    expect(removed.at(-1)).toMatch(/-fam-4$/)
  })
})
