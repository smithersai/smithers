/**
 * A hosted developer box's coding tools. The box runs no machine broker, so
 * its host composes the workspace owner's local edit provider, confines the
 * agent's reads to the workspace, offers no `bash`, and says so to the agent.
 */
import { NodeServices } from "@effect/platform-node"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import * as Cell from "@smthrs/harness/Cell"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Executable from "@smthrs/registry/Executable"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import * as Edit from "@smthrs/std/Edit"
import * as Ls from "@smthrs/std/Ls"
import * as Read from "@smthrs/std/Read"
import { StdError } from "@smthrs/std/StdError"
import * as Write from "@smthrs/std/Write"
import { Effect, FileSystem, Layer, Option, Path, type PlatformError } from "effect"
import { ChildProcessSpawner } from "effect/process"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import * as Application from "../../../packages/smithers/src/Application.ts"
import * as HostLanguageServers from "../../../packages/smithers/src/internal/HostLanguageServers.ts"
import * as NativeControl from "../../../packages/smithers/src/internal/NativeControl.ts"
import { platform } from "../../../packages/smithers/src/internal/NodeControlHost.ts"
import * as CodingFileSystem from "../coding/filesystem.ts"
import { nativePlatform, type Options } from "../coding/host.ts"
import { hostedAdapters, hostedTeaching, hostedTools } from "../coding/serve-host.ts"

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

/** The provider anchors every access on Linux directory descriptors. */
const anchored = CodingFileSystem.Anchored.available() ? false : "Directory-anchored file access needs Linux"

const workspace = async (t: TestContext) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coding-hosted-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/** The hosted composition's coding filesystem over the real local disk. */
const hostedFiles = (root: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const options = hostedAdapters()
    const coding = CodingFileSystem.confineReads(
      CodingFileSystem.make(
        { repositoryPath: root },
        fs,
        yield* ChildProcessSpawner.ChildProcessSpawner,
        root,
        options.fileMutationProvider!(root)
      ),
      root
    )
    return { coding, path: yield* Path.Path }
  })

const asAgent = <A, E, R>(coding: FileSystem.FileSystem, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(FileSystem.FileSystem, coding),
    Effect.provideService(Read.ReadSession, "hosted-run")
  )

test(
  "a hosted box's local provider writes, edits and patches the workspace as its owner",
  { skip: anchored },
  async (t) => {
    const root = await workspace(t)
    await writeFile(join(root, "run.sh"), "echo alpha\n")
    await chmod(join(root, "run.sh"), 0o755)
    await Effect.runPromise(
      Effect.gen(function*() {
        const { coding } = yield* hostedFiles(root)
        assert.equal(CodingFileSystem.mutable(coding), true)
        yield* asAgent(coding, Read.run({ path: join(root, "run.sh") }))
        yield* asAgent(coding, Edit.run({ path: join(root, "run.sh"), oldString: "alpha", newString: "beta" }))
        assert.equal(readFileSync(join(root, "run.sh"), "utf8"), "echo beta\n")
        // The replacement keeps the file's mode.
        assert.equal((statSync(join(root, "run.sh"))).mode & 0o777, 0o755)
        yield* asAgent(coding, Write.run({ path: join(root, "src", "deep", "new.txt"), content: "created\n" }))
        assert.equal(readFileSync(join(root, "src", "deep", "new.txt"), "utf8"), "created\n")
        yield* asAgent(
          coding,
          ApplyPatch.run({
            input: [
              "*** Begin Patch",
              `*** Add File: ${join(root, "added.txt")}`,
              "+added",
              `*** Update File: ${join(root, "run.sh")}`,
              "@@",
              "-echo beta",
              "+echo gamma",
              "*** End Patch"
            ].join("\n")
          })
        )
        assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n")
        assert.equal(readFileSync(join(root, "run.sh"), "utf8"), "echo gamma\n")
        // An outside change makes the next edit stale; nothing is written.
        writeFileSync(join(root, "run.sh"), "outside\n")
        const stale = yield* Effect.flip(asAgent(coding, Write.run({ path: join(root, "run.sh"), content: "mine\n" })))
        assert.equal(stale.code, "stale_read")
        assert.equal(readFileSync(join(root, "run.sh"), "utf8"), "outside\n")
        // No temporary file is left beside a replaced one.
        assert.deepEqual((yield* coding.readDirectory(root)).filter((name) => name.includes(".smithers-")), [])
      }).pipe(Effect.provide(NodeServices.layer))
    )
  }
)

test("the local provider refuses links, the outside and version-control metadata, for reads and writes", {
  skip: anchored
}, async (t) => {
  const root = await workspace(t)
  const outside = await workspace(t)
  await writeFile(join(outside, "profile"), "secret\n")
  await mkdir(join(root, ".git", "hooks"), { recursive: true })
  await writeFile(join(root, ".git", "config"), "[core]\n")
  // Committed links: a home file, the process's own /proc entry and /etc.
  await symlink(join(outside, "profile"), join(root, "profile"))
  await symlink("/proc/self", join(root, "proc"))
  await symlink("/etc", join(root, "etc"))
  await symlink(outside, join(root, "elsewhere"))
  const provider = hostedAdapters().fileMutationProvider!(root)
  const refusedPaths = [
    "profile",
    "proc/environ",
    "etc/passwd",
    "elsewhere/profile",
    "elsewhere/new.txt",
    "../escape.txt",
    ".git",
    ".git/config",
    ".git/hooks/post-checkout",
    ".jj/repo/store/extra",
    "nested/.git/config"
  ]
  await Effect.runPromise(
    Effect.gen(function*() {
      for (const path of refusedPaths) {
        const read = yield* Effect.flip(provider.read!(path))
        assert.equal(read.code, "permission_denied", `read ${path}`)
        for (const base of ["absent", hash("secret\n")]) {
          const write = yield* Effect.flip(
            provider.commit("hosted-run", [{ path, base_digest: base, content: new TextEncoder().encode("planted\n") }])
          )
          assert.equal(write.code, "permission_denied", `write ${path}`)
        }
      }
      // A batch with one refused path changes none of its files.
      const batch = yield* Effect.flip(provider.commit("hosted-run", [
        { path: "fine.txt", base_digest: "absent", content: new TextEncoder().encode("fine\n") },
        { path: ".git/hooks/post-checkout", base_digest: "absent", content: new TextEncoder().encode("#!/bin/sh\n") }
      ]))
      assert.equal(batch.code, "permission_denied")
    })
  )
  assert.equal(await readFile(join(outside, "profile"), "utf8"), "secret\n")
  assert.equal(await readFile(join(root, ".git", "config"), "utf8"), "[core]\n")
  for (
    const absent of [join(root, ".git", "hooks", "post-checkout"), join(outside, "new.txt"), join(root, "fine.txt")]
  ) {
    assert.equal(await lstat(absent).then(() => true, () => false), false, absent)
  }
  assert.equal((await lstat(join(root, "profile"))).isSymbolicLink(), true, "the link itself is untouched")
})

test("the hosted agent reads and lists nothing outside the workspace", async (t) => {
  const root = await workspace(t)
  const outside = await workspace(t)
  await writeFile(join(outside, "profile"), "secret\n")
  await writeFile(join(root, "inside.txt"), "inside\n")
  await symlink(join(outside, "profile"), join(root, "profile"))
  await symlink("/proc/self", join(root, "proc"))
  await symlink("/etc", join(root, "etc"))
  // A link that stays inside the tree, as a package manager's do, still reads.
  await symlink(join(root, "inside.txt"), join(root, "alias.txt"))
  await Effect.runPromise(
    Effect.gen(function*() {
      const { coding } = yield* hostedFiles(root)
      const refused = [
        "/proc/self/environ",
        "/proc/1/environ",
        "../../.profile",
        join(homedir(), ".cache", "smithers", "git-credential", "socket"),
        "/etc/passwd",
        "/etc/smithers/egress-ca.pem",
        join(root, "..", "escape.txt"),
        join(root, "profile"),
        join(root, "proc", "environ"),
        join(root, "etc", "passwd")
      ]
      for (const path of refused) {
        const read = yield* Effect.flip(asAgent(coding, Read.run({ path })))
        assert.equal(read.code, "permission_denied", `read ${path}: ${read.message}`)
        // A refusal carries no byte of what it refused.
        assert.ok(!JSON.stringify(read).includes("secret"), JSON.stringify(read))
        const written = yield* Effect.flip(asAgent(coding, Write.run({ path, content: "planted\n" })))
        assert.ok(
          ["permission_denied", "provider_unavailable"].includes(written.code),
          `write ${path}: ${written.code}`
        )
      }
      for (const directory of ["/proc", join(homedir(), ".cache"), join(root, "etc")]) {
        const listed = yield* Effect.flip(asAgent(coding, Ls.run({ path: directory })))
        assert.equal(listed.code, "permission_denied", `ls ${directory}: ${listed.message}`)
      }
      assert.equal((yield* asAgent(coding, Read.run({ path: join(root, "alias.txt") }))).content, "inside")
    }).pipe(Effect.provide(NodeServices.layer))
  )
  assert.equal(await readFile(join(outside, "profile"), "utf8"), "secret\n")
})

/** The assembled host reads through the descriptor-relative helper a box ships. */
AtomicFileSystem.resolveHelper()

const hostedOptions = (root: string): Options => ({
  repositoryPath: root,
  systemFlows: [],
  gatewayId: "hosted-test",
  implementationModel: "test:implementation-model",
  ...hostedAdapters()
})

/** The assembled native host the hosted coding composition builds, as its agent sees it. */
const assembled = async (root: string, options: Options, environment: Record<string, string> = {}) => {
  let host: AgentAction.Host | undefined
  const modules = Layer.effect(Executable.Catalog)(Effect.gen(function*() {
    host = yield* AgentAction.Host
    return Executable.Catalog.of({ executables: [], refused: [] })
  })).pipe(Layer.orDie)
  const native = NativeControl.make(nativePlatform(platform, options, ScriptedJudge.layerAll))
  const registry = native.layerRegistry(root)
  const engine = native.engineDurable(root, registry)
  const executor = native.layerExecutor(registry, engine, root, {
    evaluator: ScriptedJudge.layerAll,
    environment,
    grants: GrantStore.layerNoop,
    modules
  })
  return {
    application: Application.layer({ root }, registry, engine, executor) as Layer.Layer<Control.Control>,
    host: () => host!
  }
}

const callOf = (flowName: string, input: unknown, session = "hosted-run", ordinal = 0) =>
  new Cell.Call({
    flowName,
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    identity: new Cell.CallIdentity({
      session,
      frame: 0,
      cell: "cell",
      ordinal,
      declaration: "declaration",
      layers: []
    })
  })

test("the hosted composition offers edits and no bash, tells the agent so, and writes the workspace", {
  timeout: 120_000
}, async (t) => {
  const root = await workspace(t)
  const workspaceRoot = join(root, "workspace")
  await mkdir(workspaceRoot)
  await writeFile(join(workspaceRoot, "greeting.mjs"), "export const greeting = \"hello\"\n")
  // A declared test command still offers no `test`: the box runs no command.
  const { application, host } = await assembled(workspaceRoot, hostedOptions(workspaceRoot), {
    SMITHERS_TEST_COMMAND: "node --test"
  })
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      const offered = (yield* Effect.forEach(host().flows ?? [], (source) => source.bindings())).flat()
      const names = offered.map((binding) => binding.descriptor.name)
      for (const name of ["read", "write", "edit", "apply_patch", "ls", "glob", "grep"]) {
        assert.ok(names.includes(name), `${name} in ${names.join(",")}`)
      }
      assert.ok(!names.includes("bash") && !names.includes("test"), names.join(","))
      t.diagnostic(`offered: ${names.join(", ")}`)
      // No tool creates a link or moves a directory.
      for (const name of ["shell_command", "lsp", "symlink", "link", "rename", "move", "mkdir", "relocate"]) {
        assert.ok(!names.includes(name), `${name} in ${names.join(",")}`)
      }
      assert.deepEqual(host().system, hostedTeaching)
      const write = offered.find((binding) => binding.descriptor.name === "write")!
      const result = yield* write.run(
        callOf("write", { path: join(workspaceRoot, "notes", "todo.md"), content: "- ship\n" })
      )
      assert.equal(result.outcome, "success", JSON.stringify(result))
      const outside = yield* write.run(callOf("write", { path: "/proc/self/environ", content: "x" }))
      assert.equal(outside.outcome, "failure")
      // The composed read and search tools refuse the host's own process files.
      const bound = (name: string) => offered.find((binding) => binding.descriptor.name === name)!
      for (const path of ["/proc/self/environ", "/proc/1/environ", "/etc/passwd"]) {
        const read = yield* bound("read").run(callOf("read", { path }))
        assert.equal(read.outcome, "failure", JSON.stringify(read))
        assert.ok(!JSON.stringify(read).includes("PATH="), JSON.stringify(read))
      }
      const searched = yield* bound("grep").run(callOf("grep", { pattern: "PATH", root: "/proc/self" }))
      assert.ok(!JSON.stringify(searched).includes("PATH="), JSON.stringify(searched))
    }).pipe(Effect.provide(application), Effect.scoped)
  )
  assert.equal(await readFile(join(workspaceRoot, "notes", "todo.md"), "utf8"), "- ship\n")
})

test("a host without a mutation provider offers no edit tool and no teaching", {
  timeout: 120_000
}, async (t) => {
  const root = await workspace(t)
  const { application, host } = await assembled(root, {
    repositoryPath: root,
    systemFlows: [],
    gatewayId: "unprovided-test",
    implementationModel: "test:implementation-model"
  })
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      const names = (yield* Effect.forEach(host().flows ?? [], (source) => source.bindings())).flat()
        .map((binding) => binding.descriptor.name)
      for (const name of ["write", "edit", "apply_patch", "bash"]) assert.ok(!names.includes(name), names.join(","))
      assert.ok(names.includes("read"))
      assert.equal(host().system, undefined)
    }).pipe(Effect.provide(application), Effect.scoped)
  )
})

test("the startup self-check names the offered tool whose provider is missing", () => {
  assert.equal(
    NativeControl.offeredWithoutProvider(["read", "write"], { fileMutations: false, terminal: true })?.message,
    "Host self-check: write is offered but its file-mutation provider is missing"
  )
  assert.equal(
    NativeControl.offeredWithoutProvider(["bash"], { fileMutations: true, terminal: false })?.message,
    "Host self-check: bash is offered but its terminal provider is missing"
  )
  assert.equal(
    NativeControl.offeredWithoutProvider(["test"], { fileMutations: true, terminal: false })?.message,
    "Host self-check: test is offered but its terminal provider is missing"
  )
  assert.equal(
    NativeControl.offeredWithoutProvider(["read", "ls"], { fileMutations: false, terminal: false }),
    undefined
  )
})

test("a provider failure the agent did not cause is typed and leaves the bytes", { skip: anchored }, async (t) => {
  const root = await workspace(t)
  await writeFile(join(root, "a.txt"), "a\n")
  await Effect.runPromise(
    Effect.gen(function*() {
      const provider = hostedAdapters().fileMutationProvider!(root)
      // A directory where a file is expected is never replaced.
      mkdirSync(join(root, "dir"))
      const directory = yield* Effect.flip(
        provider.commit("hosted-run", [{ path: "dir", base_digest: "absent", content: new TextEncoder().encode("x") }])
      )
      assert.ok(directory instanceof StdError)
      assert.equal(directory.code, "permission_denied")
      const empty = yield* Effect.flip(provider.commit("hosted-run", []))
      assert.equal(empty.code, "provider_unavailable")
    })
  )
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "a\n")
})

/** Swaps `dir` for a link to `outside` right after the provider's `count`-th anchored walk. */
const swapAfterWalk = (count: number, ws: string, outside: string) => {
  const original = CodingFileSystem.Anchored.directories
  let walks = 0
  CodingFileSystem.Anchored.directories = async (...args) => {
    const walked = await original(...args)
    if (++walks === count) {
      await rename(join(ws, "dir"), join(ws, "original-dir"))
      await symlink(outside, join(ws, "dir"))
    }
    return walked
  }
  return () => {
    CodingFileSystem.Anchored.directories = original
  }
}

test("a directory swapped for an outside link during a commit never redirects the write", {
  skip: anchored
}, async (t) => {
  for (const count of [1, 2]) {
    const ws = await workspace(t)
    const outside = await workspace(t)
    await mkdir(join(ws, "dir"))
    await writeFile(join(ws, "dir", "file"), "old")
    await writeFile(join(outside, "file"), "old")
    const restore = swapAfterWalk(count, ws, outside)
    const exit = await Effect.runPromiseExit(
      hostedAdapters().fileMutationProvider!(ws).commit("hosted-run", [
        { path: "dir/file", base_digest: hash("old"), content: new TextEncoder().encode("changed") }
      ])
    ).finally(restore)
    // The outside file is never touched, however the swap is timed.
    assert.equal(await readFile(join(outside, "file"), "utf8"), "old", `swap after walk ${count}`)
    if (count === 1) {
      // Swapped between the base check and the write: the write's own walk refuses the link.
      assert.equal(exit._tag, "Failure")
      assert.equal(await readFile(join(ws, "original-dir", "file"), "utf8"), "old")
    } else {
      // Swapped after the write's directory was opened: the write lands in that directory.
      assert.equal(exit._tag, "Success")
      assert.equal(await readFile(join(ws, "original-dir", "file"), "utf8"), "changed")
    }
  }
})

test("the hosted wrappers keep the one precondition policy the mutation lock is keyed on", async (t) => {
  const root = await workspace(t)
  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const coding = CodingFileSystem.make(
        { repositoryPath: root },
        fs,
        yield* ChildProcessSpawner.ChildProcessSpawner,
        root,
        hostedAdapters().fileMutationProvider!(root)
      )
      const confined = CodingFileSystem.confineReads(coding, root) as Read.VersionedFileSystem
      assert.ok(coding[Read.Preconditions] !== undefined)
      assert.equal(confined[Read.Preconditions], coding[Read.Preconditions])
      assert.equal(CodingFileSystem.mutable(confined), true)
    }).pipe(Effect.provide(NodeServices.layer))
  )
})

test("parallel composed writes to one file never overlap and never lose an update", {
  skip: anchored,
  timeout: 120_000
}, async (t) => {
  const root = await workspace(t)
  const workspaceRoot = join(root, "workspace")
  await mkdir(workspaceRoot)
  let inFlight = 0, most = 0, commits = 0
  const counted = (provider: CodingFileSystem.MutationProvider): CodingFileSystem.MutationProvider => ({
    ...provider,
    commit: (session, changes) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          commits++
          most = Math.max(most, ++inFlight)
        }),
        // Long enough that two unserialized commits would overlap.
        () => Effect.andThen(Effect.sleep("50 millis"), provider.commit(session, changes)),
        () => Effect.sync(() => void inFlight--)
      )
  })
  const { application, host } = await assembled(workspaceRoot, {
    ...hostedOptions(workspaceRoot),
    fileMutationProvider: (canonical) => counted(CodingFileSystem.localProvider(canonical))
  })
  const target = join(workspaceRoot, "shared.txt")
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      const offered = (yield* Effect.forEach(host().flows ?? [], (source) => source.bindings())).flat()
      const write = offered.find((binding) => binding.descriptor.name === "write")!
      // One run: the second write's base is the first's result, so it applies on top.
      const same = yield* Effect.all([
        write.run(callOf("write", { path: target, content: "first\n" }, "run-a", 0)),
        write.run(callOf("write", { path: target, content: "second\n" }, "run-a", 1))
      ], { concurrency: "unbounded" })
      assert.deepEqual(same.map((result) => result.outcome), ["success", "success"])
      assert.equal(most, 1)
      assert.ok(["first\n", "second\n"].includes(readFileSync(target, "utf8")))
      // Two runs: the one that did not read the other's write is refused stale.
      const before = readFileSync(target, "utf8")
      yield* Effect.all([
        offered.find((binding) => binding.descriptor.name === "read")!.run(callOf("read", { path: target }, "run-b")),
        offered.find((binding) => binding.descriptor.name === "read")!.run(callOf("read", { path: target }, "run-c"))
      ])
      const raced = yield* Effect.all([
        write.run(callOf("write", { path: target, content: "from b\n" }, "run-b", 2)),
        write.run(callOf("write", { path: target, content: "from c\n" }, "run-c", 3))
      ], { concurrency: "unbounded" })
      assert.equal(most, 1)
      const outcomes = raced.map((result) => result.outcome).sort()
      assert.deepEqual(outcomes, ["failure", "success"], JSON.stringify(raced))
      const loser = raced.find((result) => result.outcome === "failure")!
      assert.match(JSON.stringify(loser), /stale_read|Re-read/)
      const winner = raced.findIndex((result) => result.outcome === "success")
      assert.equal(readFileSync(target, "utf8"), winner === 0 ? "from b\n" : "from c\n")
      assert.notEqual(readFileSync(target, "utf8"), before)
      assert.equal(commits >= 3, true)
    }).pipe(Effect.provide(application), Effect.scoped)
  )
})

test("a change made between the base check and the write is refused, not overwritten", {
  skip: anchored
}, async (t) => {
  const ws = await workspace(t)
  await mkdir(join(ws, "dir"))
  await writeFile(join(ws, "dir", "file"), "old")
  const original = CodingFileSystem.Anchored.directories
  let walks = 0
  CodingFileSystem.Anchored.directories = async (...args) => {
    const walked = await original(...args)
    // After the write's own walk, before its compare, another writer changes the file.
    if (++walks === 2) await writeFile(join(ws, "dir", "file"), "theirs")
    return walked
  }
  const exit = await Effect.runPromiseExit(
    hostedAdapters().fileMutationProvider!(ws).commit("hosted-run", [
      { path: "dir/file", base_digest: hash("old"), content: new TextEncoder().encode("mine") }
    ])
  ).finally(() => {
    CodingFileSystem.Anchored.directories = original
  })
  assert.equal(exit._tag, "Failure")
  assert.match(JSON.stringify(exit), /stale_read/)
  assert.equal(await readFile(join(ws, "dir", "file"), "utf8"), "theirs")
})

test("a write made after the write's own compare is refused, not overwritten", { skip: anchored }, async (t) => {
  const ws = await workspace(t)
  await writeFile(join(ws, "target.txt"), "old")
  const original = CodingFileSystem.Anchored.read
  let reads = 0
  CodingFileSystem.Anchored.read = async (...args) => {
    const result = await original(...args)
    // Read 1 is the batch's base check and read 2 the write's own compare:
    // another writer lands while the new bytes are being written and synced.
    if (++reads === 2) await writeFile(join(ws, "target.txt"), "theirs")
    return result
  }
  const exit = await Effect.runPromiseExit(
    CodingFileSystem.localProvider(ws).commit("run", [
      { path: "target.txt", base_digest: hash("old"), content: new TextEncoder().encode("mine") }
    ])
  ).finally(() => {
    CodingFileSystem.Anchored.read = original
  })
  assert.equal(exit._tag, "Failure")
  assert.match(JSON.stringify(exit), /stale_read/)
  assert.equal(await readFile(join(ws, "target.txt"), "utf8"), "theirs")
  // The refused write leaves no temporary file behind.
  assert.deepEqual(readdirSync(ws), ["target.txt"])
})

test("two providers racing one base never both succeed", { skip: anchored }, async (t) => {
  for (let round = 0; round < 20; round++) {
    const ws = await workspace(t)
    await writeFile(join(ws, "target.txt"), "old")
    const commit = (content: string) =>
      Effect.runPromiseExit(
        CodingFileSystem.localProvider(ws).commit("run", [
          { path: "target.txt", base_digest: hash("old"), content: new TextEncoder().encode(content) }
        ])
      )
    const exits = await Promise.all([commit("first"), commit("second")])
    assert.deepEqual(exits.map((exit) => exit._tag).sort(), ["Failure", "Success"], `round ${round}`)
    assert.match(JSON.stringify(exits.find((exit) => exit._tag === "Failure")), /stale_read/)
    const winner = exits[0]._tag === "Success" ? "first" : "second"
    assert.equal(await readFile(join(ws, "target.txt"), "utf8"), winner)
  }
})

/** Another process holding the workspace's edit lock until `release` is called. */
const lockHolder = async (t: TestContext, ws: string) => {
  const holder = spawn("flock", ["-x", ws, "sh", "-c", "echo held; cat"], { stdio: ["pipe", "pipe", "inherit"] })
  const exited = new Promise<void>((done) => holder.once("exit", () => done()))
  const release = () => {
    holder.stdin.end()
    return exited
  }
  // A failed assertion must not leave the holder, and so the test process, alive.
  t.after(release)
  await new Promise<void>((held, failed) => {
    holder.once("error", failed)
    holder.stdout.once("data", () => held())
  })
  return release
}

test("a commit waits for another process's edit lock, then compares against what that process wrote", {
  skip: anchored
}, async (t) => {
  const ws = await workspace(t)
  await writeFile(join(ws, "target.txt"), "old")
  const release = await lockHolder(t, ws)
  let settled = false
  const commit = Effect.runPromiseExit(
    CodingFileSystem.localProvider(ws).commit("run", [
      { path: "target.txt", base_digest: hash("old"), content: new TextEncoder().encode("mine") }
    ])
  ).finally(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(settled, false)
  assert.equal(await readFile(join(ws, "target.txt"), "utf8"), "old")
  // The lock's holder finishes its own edit before it lets go.
  await writeFile(join(ws, "target.txt"), "theirs")
  await release()
  const exit = await commit
  assert.equal(exit._tag, "Failure")
  assert.match(JSON.stringify(exit), /stale_read/)
  assert.equal(await readFile(join(ws, "target.txt"), "utf8"), "theirs")
})

test("a commit that cannot get the edit lock in time changes nothing and says so", { skip: anchored }, async (t) => {
  const ws = await workspace(t)
  await writeFile(join(ws, "target.txt"), "old")
  const release = await lockHolder(t, ws)
  const original = CodingFileSystem.Anchored.exclusive
  CodingFileSystem.Anchored.exclusive = (root) => original(root, 200)
  const exit = await Effect.runPromiseExit(
    CodingFileSystem.localProvider(ws).commit("run", [
      { path: "target.txt", base_digest: hash("old"), content: new TextEncoder().encode("mine") }
    ])
  ).finally(async () => {
    CodingFileSystem.Anchored.exclusive = original
    await release()
  })
  assert.equal(exit._tag, "Failure")
  assert.match(JSON.stringify(exit), /provider_unavailable/)
  assert.equal(await readFile(join(ws, "target.txt"), "utf8"), "old")
  // The lock is free again: the same commit now applies.
  await Effect.runPromise(
    CodingFileSystem.localProvider(ws).commit("run", [
      { path: "target.txt", base_digest: hash("old"), content: new TextEncoder().encode("mine") }
    ])
  )
  assert.equal(await readFile(join(ws, "target.txt"), "utf8"), "mine")
})

/** The box's own read stack: the kernel guard over the descriptor-relative helper. */
const helperFiles = (root: string) =>
  KernelFileSystem.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(GrantStore.layerNoop, Workspace.layer(root))),
    Layer.provideMerge(AtomicFileSystem.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provideMerge(NodeServices.layer)
  )

const canary = "CANARY-7f3a-hosted-instructions"

test("a committed instruction link out of the tree never reaches the hosted agent", {
  timeout: 120_000
}, async (t) => {
  const root = await workspace(t)
  const outside = await workspace(t)
  await writeFile(join(outside, "secret.md"), `${canary}\n`)
  const workspaceRoot = join(root, "workspace")
  await mkdir(workspaceRoot)
  // AGENTS.md links out of the tree; CLAUDE.md links at the host's own environment.
  await symlink(join(outside, "secret.md"), join(workspaceRoot, "AGENTS.md"))
  await symlink("/proc/self/environ", join(workspaceRoot, "CLAUDE.md"))
  const linked = await assembled(workspaceRoot, hostedOptions(workspaceRoot))
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      const instructions = JSON.stringify(linked.host().instructions ?? [])
      assert.ok(!instructions.includes(canary), instructions)
      assert.ok(!instructions.includes("PATH="), instructions)
      assert.deepEqual(linked.host().instructions ?? [], [])
    }).pipe(Effect.provide(linked.application), Effect.scoped)
  )
  // The root's own file is still the agent's instruction.
  await unlink(join(workspaceRoot, "AGENTS.md"))
  await writeFile(join(workspaceRoot, "AGENTS.md"), "Use tabs.\n")
  const plain = await assembled(workspaceRoot, hostedOptions(workspaceRoot))
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      assert.deepEqual(plain.host().instructions, [{ path: join(workspaceRoot, "AGENTS.md"), text: "Use tabs.\n" }])
    }).pipe(Effect.provide(plain.application), Effect.scoped)
  )
})

test("an instruction file swapped for an outside link just before its read is refused", {
  timeout: 120_000
}, async (t) => {
  const run = async (
    files: (root: string) => Layer.Layer<NodeServices.NodeServices, PlatformError.PlatformError>
  ) => {
    const root = await workspace(t)
    const outside = await workspace(t)
    await writeFile(join(outside, "secret.md"), `${canary}\n`)
    await writeFile(join(root, "AGENTS.md"), "Use tabs.\n")
    return Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const coding = CodingFileSystem.make(
          { repositoryPath: root },
          fs,
          yield* ChildProcessSpawner.ChildProcessSpawner,
          root,
          CodingFileSystem.localProvider(root)
        )
        // The swap lands after the containment check and before the read.
        const swapping: FileSystem.FileSystem = {
          ...coding,
          readFileString: (path, encoding) =>
            Effect.andThen(
              Effect.promise(async () => {
                if (path === join(root, "AGENTS.md")) {
                  await unlink(path)
                  await symlink(join(outside, "secret.md"), path)
                }
              }),
              coding.readFileString(path, encoding)
            )
        }
        return yield* NativeControl.confinedInstructions(CodingFileSystem.confineReads(swapping, root), root)
      }).pipe(Effect.provide(files(root)), Effect.provide(NodeServices.layer))
    )
  }
  // The box's descriptor-relative read refuses the swapped link.
  const anchoredRead = await run(helperFiles)
  assert.ok(!JSON.stringify(anchoredRead).includes(canary), JSON.stringify(anchoredRead))
  // The same swap over a plain path filesystem would have been followed: the test can see it.
  const plain = await run(() => NodeServices.layer)
  assert.ok(JSON.stringify(plain).includes(canary), JSON.stringify(plain))
})

test("hosted write and edit start no language server even with one on PATH", {
  skip: anchored,
  timeout: 120_000
}, async (t) => {
  const root = await workspace(t)
  const workspaceRoot = join(root, "workspace")
  await mkdir(workspaceRoot)
  // A stand-in typescript-language-server that marks the moment it starts.
  const modules = join(root, "host", "node_modules")
  const cli = join(modules, "typescript-language-server", "lib", "cli.mjs")
  const started = join(modules, "typescript-language-server", "lib", "started")
  mkdirSync(join(modules, "typescript-language-server", "lib"), { recursive: true })
  writeFileSync(join(modules, "typescript-language-server", "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(
    cli,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"\nwriteFileSync(${
      JSON.stringify(started)
    }, "started")\n`
  )
  await chmod(cli, 0o755)
  mkdirSync(join(modules, "typescript", "lib"), { recursive: true })
  writeFileSync(join(modules, "typescript", "package.json"), JSON.stringify({ name: "typescript" }))
  writeFileSync(join(modules, "typescript", "lib", "tsserver.js"), "")
  mkdirSync(join(modules, ".bin"), { recursive: true })
  await symlink(cli, join(modules, ".bin", "typescript-language-server"))
  const environment = { PATH: `${join(modules, ".bin")}:${process.env.PATH ?? ""}` }
  // The server is installed: an unconfined host would select it.
  assert.ok(HostLanguageServers.typescript(workspaceRoot, environment) !== undefined)
  const { application, host } = await assembled(workspaceRoot, hostedOptions(workspaceRoot), environment)
  await Effect.runPromise(
    Effect.gen(function*() {
      yield* Control.Control
      const offered = (yield* Effect.forEach(host().flows ?? [], (source) => source.bindings())).flat()
      const bound = (name: string) => offered.find((binding) => binding.descriptor.name === name)!
      const path = join(workspaceRoot, "a.ts")
      const written = yield* bound("write").run(callOf("write", { path, content: "const a = 1\n" }))
      assert.equal(written.outcome, "success", JSON.stringify(written))
      const edited = yield* bound("edit").run(
        callOf("edit", { path, oldString: "const a = 1", newString: "const a = 2" }, "hosted-run", 1)
      )
      assert.equal(edited.outcome, "success", JSON.stringify(edited))
    }).pipe(Effect.provide(application), Effect.scoped)
  )
  assert.equal(readFileSync(join(workspaceRoot, "a.ts"), "utf8"), "const a = 2\n")
  assert.equal(existsSync(started), false, "no language server process started")
})

test("a hosted host that would offer any tool beyond its allowlist does not start", {
  timeout: 120_000
}, async (t) => {
  const root = await workspace(t)
  // An execution alias arriving through a source: a terminal makes `bash` offered.
  const { application } = await assembled(root, {
    ...hostedOptions(root),
    agentTerminal: () => ({
      execute: async function*() {
        yield { kind: "exit", code: 0 }
      },
      killRun: async () => {}
    })
  })
  const exit = await Effect.runPromiseExit(
    Effect.asVoid(Control.Control).pipe(Effect.provide(application), Effect.scoped)
  )
  assert.equal(exit._tag, "Failure")
  assert.match(
    JSON.stringify(exit) + String((exit as { cause?: unknown }).cause),
    /Host self-check: bash is offered but this host allows only read, write/
  )
})

test("the allowlist self-check names the first unlisted tool", () => {
  const providers = { fileMutations: true, terminal: true }
  assert.equal(NativeControl.offeredWithoutProvider([...hostedTools], providers, hostedTools), undefined)
  assert.equal(
    NativeControl.offeredWithoutProvider(["read", "shell_command"], providers, hostedTools)?.message,
    `Host self-check: shell_command is offered but this host allows only ${hostedTools.join(", ")}`
  )
  assert.equal(NativeControl.offeredWithoutProvider(["read", "shell_command"], providers), undefined)
})

test("the provider refuses a hard-linked file for reads and writes", { skip: anchored }, async (t) => {
  const root = await workspace(t)
  const outside = await workspace(t)
  await writeFile(join(outside, "secret"), "secret\n")
  await link(join(outside, "secret"), join(root, "linked"))
  const provider = hostedAdapters().fileMutationProvider!(root)
  await Effect.runPromise(
    Effect.gen(function*() {
      assert.equal((yield* Effect.flip(provider.read!("linked"))).code, "permission_denied")
      const write = yield* Effect.flip(
        provider.commit("hosted-run", [{
          path: "linked",
          base_digest: hash("secret\n"),
          content: new TextEncoder().encode("x")
        }])
      )
      assert.equal(write.code, "permission_denied")
    })
  )
  assert.equal(await readFile(join(outside, "secret"), "utf8"), "secret\n")
})

test("the hosted glob refuses a root outside the workspace", async (t) => {
  const root = await workspace(t)
  await Effect.runPromise(
    Effect.gen(function*() {
      const { coding } = yield* hostedFiles(root)
      const refused = yield* Effect.flip(coding.glob("**", { root: "/etc" }))
      assert.equal(refused.reason._tag, "PermissionDenied")
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
