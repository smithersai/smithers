import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Fiber, Layer, Logger, Schema, Stream } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import * as fsModule from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as BrowserJj from "../src/browser/BrowserJj.ts"
import { Errno as E, make as makeWasi } from "../src/browser/WasiPreview1.ts"
import { Jj, jjErrorCause } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import * as resolveJjBinary from "../src/node/resolveJjBinary.ts"
import * as Repository from "../src/Repository.ts"
import { fakeFlowsJjWasm } from "./FakeFlowsJjWasm.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])
const encoder = new TextEncoder()

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = fsModule.mkdtempSync(join(tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    fsModule.rmSync(dir, { recursive: true, force: true })
  }
}

const makeScriptedSpawner = (
  respond: (args: ReadonlyArray<string>) => { readonly code?: number; readonly stdout?: string; readonly stderr?: string }
) =>
  ChildProcessSpawner.make((cmd: any) => {
    const args: ReadonlyArray<string> = cmd.args ?? []
    const res = respond(args)
    const out = encoder.encode(res.stdout ?? "")
    const err = encoder.encode(res.stderr ?? "")
    return Effect.succeed({
      pid: 123 as any,
      exitCode: Effect.succeed((res.code ?? 0) as any),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: undefined as any,
      stdout: out.length > 0 ? Stream.make(out) : Stream.empty,
      stderr: err.length > 0 ? Stream.make(err) : Stream.empty,
      all: out.length > 0 ? Stream.make(out) : Stream.empty,
      getInputFd: () => undefined as any,
      getOutputFd: () => undefined as any
    } as any)
  })

describe("@smthrs/jj Wave10 Deep Fuzzing", () => {
  it("fuzzes Repository validation errors, Repository.make, jjErrorCause unrenderable failure, and resolveJjBinary empty PATH", async () => {
    const unrenderable = {
      get message() {
        throw new Error("no msg")
      },
      toString() {
        throw new Error("no str")
      }
    }
    expect(jjErrorCause(unrenderable).message).toBe("[unrenderable failure]")

    const emptyPathRes = resolveJjBinary.resolveJjBinary({ environment: { PATH: "" } })
    expect(emptyPathRes.path).toBeDefined()

    const arb = Arbitrary.schema(
      Schema.Struct({
        badCase: Schema.Literals([
          "tree_not_array",
          "tree_bad_entry",
          "tree_missing_oid",
          "commit_null",
          "commit_bad_parents",
          "commit_bad_person",
          "commit_missing_obj",
          "read_commit_not_found",
          "refs_bad_op",
          "refs_not_array",
          "refs_bad_val",
          "refs_missing_after"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ badCase }) =>
          Effect.gen(function*() {
            const repo = yield* Repository.Repository
            const fakeOid = "a".repeat(40)
            const person = { name: "A", email: "a@b.c", seconds: 0, offsetMinutes: 0 }
            const validBlob = yield* repo.writeBlob("hi")
            const validTree = yield* repo.writeTree([{ name: "f.txt", mode: "100644", oid: validBlob }])
            const validCommit = yield* repo.writeCommit({
              tree: validTree,
              parents: [],
              author: person,
              committer: person,
              message: "init\n"
            })
            expect(validCommit.length).toBe(40)

            let exit: Exit.Exit<unknown, unknown>
            switch (badCase) {
              case "tree_not_array":
                exit = yield* Effect.exit(repo.writeTree("not-arr" as any))
                break
              case "tree_bad_entry":
                exit = yield* Effect.exit(repo.writeTree([{ name: "a/b", mode: "100644", oid: validBlob }]))
                break
              case "tree_missing_oid":
                exit = yield* Effect.exit(repo.writeTree([{ name: "f", mode: "100644", oid: fakeOid }]))
                break
              case "commit_null":
                exit = yield* Effect.exit(repo.writeCommit(null as any))
                break
              case "commit_bad_parents":
                exit = yield* Effect.exit(
                  repo.writeCommit({
                    tree: validTree,
                    parents: ["bad-oid"],
                    author: person,
                    committer: person,
                    message: "m"
                  })
                )
                break
              case "commit_bad_person":
                exit = yield* Effect.exit(
                  repo.writeCommit({
                    tree: validTree,
                    parents: [],
                    author: null as any,
                    committer: person,
                    message: "m"
                  })
                )
                break
              case "commit_missing_obj":
                exit = yield* Effect.exit(
                  repo.writeCommit({
                    tree: fakeOid,
                    parents: [fakeOid],
                    author: person,
                    committer: person,
                    message: "m"
                  })
                )
                break
              case "read_commit_not_found":
                exit = yield* Effect.exit(repo.readCommit(fakeOid))
                break
              case "refs_bad_op":
                exit = yield* Effect.exit(repo.updateRefs({ operation: "bad op!", updates: [] }))
                break
              case "refs_not_array":
                exit = yield* Effect.exit(repo.updateRefs({ operation: "op", updates: "no" as any }))
                break
              case "refs_bad_val":
                exit = yield* Effect.exit(
                  repo.updateRefs({
                    operation: "op",
                    updates: [{ ref: "refs/heads/main", before: "bad", after: null }]
                  })
                )
                break
              case "refs_missing_after":
                exit = yield* Effect.exit(
                  repo.updateRefs({
                    operation: "op",
                    updates: [{ ref: "refs/heads/main", before: null, after: fakeOid }]
                  })
                )
                break
            }
            expect(Exit.isFailure(exit)).toBe(true)
            expect(Repository.make(repo)).toBe(repo)
            return true
          }).pipe(Effect.provide(Repository.layerMemory())),
        { executions: Math.min(executions, 40), seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes WasiPreview1 uncovered syscalls, error paths, symlinks, renumber, poll_oneoff, sockets, and OOB fault", async () => {
    await withTempDir("wave10b-wasi-", async (dir) => {
      const uninit = makeWasi({ fs: fsModule, root: dir })
      expect(() => (uninit.imports as any).fd_filestat_get(0, 0)).toThrow()

      const wasi = makeWasi({ fs: fsModule, root: dir })
      const memory = new WebAssembly.Memory({ initial: 2 })
      wasi.initialize(memory)
      const u8 = new Uint8Array(memory.buffer)
      const dv = new DataView(memory.buffer)

      const writeStr = (ptr: number, text: string) => {
        const b = encoder.encode(text)
        u8.set(b, ptr)
        return b.length
      }

      const imp = wasi.imports as any
      const R = 1n << 1n
      const W = 1n << 6n
      const RW = R | W
      const OFLAG = { creat: 1, directory: 2, excl: 4, trunc: 8 } as const
      const FDFLAGS_APPEND = 1

      fsModule.writeFileSync(join(dir, "seed.txt"), "hello world")
      fsModule.mkdirSync(join(dir, "sub"))
      fsModule.writeFileSync(join(dir, "sub", "a.txt"), "a")
      fsModule.writeFileSync(join(dir, "sub", "b.txt"), "b")
      fsModule.symlinkSync("loop_b", join(dir, "loop_a"))
      fsModule.symlinkSync("loop_a", join(dir, "loop_b"))
      fsModule.symlinkSync("seed.txt", join(dir, "link_seed"))
      fsModule.symlinkSync("/seed.txt", join(dir, "abs_link"))

      const seedLen = writeStr(0x100, "seed.txt")
      expect(imp.path_open(3, 1, 0x100, seedLen, 0, RW, RW, 0, 0x340)).toBe(E.success)
      const fileFd = dv.getUint32(0x340, true)

      const subLen = writeStr(0x100, "sub")
      expect(imp.path_open(3, 1, 0x100, subLen, OFLAG.directory, R, R, 0, 0x340)).toBe(E.success)
      const dirFd = dv.getUint32(0x340, true)

      expect(imp.fd_allocate(fileFd, 0n, 16n)).toBe(E.notsup)
      expect(imp.fd_allocate(0, 0n, 16n)).toBe(E.spipe)
      expect(imp.fd_allocate(dirFd, 0n, 16n)).toBe(E.badf)
      expect(imp.path_filestat_get(fileFd, 0, 0x100, subLen, 0x600)).toBe(E.notdir)
      expect(imp.fd_filestat_get(0, 0x600)).toBe(E.success)

      expect(imp.fd_filestat_set_times(0, 0n, 0n, 0)).toBe(E.badf)
      expect(imp.fd_filestat_set_times(dirFd, 0n, 0n, 2 | 8)).toBe(E.success)
      expect(imp.fd_filestat_set_times(fileFd, 0n, 0n, 1 | 2)).toBe(E.inval)
      expect(imp.fd_filestat_set_times(fileFd, 0n, 0n, 4 | 8)).toBe(E.inval)

      dv.setUint32(0x300, 0x1000, true)
      dv.setUint32(0x304, 0, true)
      expect(imp.fd_pread(fileFd, 0x300, 1, 0n, 0x340)).toBe(E.success)
      dv.setUint32(0x304, 4, true)
      expect(imp.fd_pread(fileFd, 0x300, 1, BigInt(Number.MAX_SAFE_INTEGER) + 10n, 0x340)).toBe(E.fbig)

      expect(imp.fd_prestat_get(fileFd, 0x600)).toBe(E.badf)
      expect(imp.fd_prestat_dir_name(fileFd, 0x1000, 10)).toBe(E.badf)
      expect(imp.fd_prestat_dir_name(3, 0x1000, 0)).toBe(E.nametoolong)

      expect(imp.fd_read(0, 0x300, 1, 0x340)).toBe(E.success)
      expect(dv.getUint32(0x340, true)).toBe(0)
      expect(imp.fd_read(1, 0x300, 1, 0x340)).toBe(E.badf)
      expect(imp.fd_read(dirFd, 0x300, 1, 0x340)).toBe(E.isdir)
      dv.setUint32(0x304, 0, true)
      expect(imp.fd_read(fileFd, 0x300, 1, 0x340)).toBe(E.success)

      expect(imp.fd_write(0, 0x300, 1, 0x340)).toBe(E.badf)
      expect(imp.fd_write(dirFd, 0x300, 1, 0x340)).toBe(E.badf)
      expect(imp.fd_write(fileFd, 0x300, 1, 0x340)).toBe(E.success)

      expect(imp.fd_readdir(dirFd, 0x1000, 4, 0n, 0x340)).toBe(E.success)
      expect(imp.fd_readdir(dirFd, 0x1000, 256, 99n, 0x340)).toBe(E.success)

      expect(imp.fd_seek(fileFd, -10n, 0, 0x340)).toBe(E.inval)
      expect(imp.fd_seek(fileFd, 0n, 99, 0x340)).toBe(E.inval)

      expect(imp.fd_renumber(fileFd, fileFd)).toBe(E.success)
      const sLen = writeStr(0x100, "seed.txt")
      expect(imp.path_open(3, 1, 0x100, sLen, 0, R, R, 0, 0x340)).toBe(E.success)
      const fileFd2 = dv.getUint32(0x340, true)
      expect(imp.fd_renumber(fileFd2, 50)).toBe(E.success)
      expect(imp.fd_renumber(fileFd, 50)).toBe(E.success)
      expect(imp.fd_close(50)).toBe(E.success)

      expect(imp.path_open(3, 1, 0x100, 0, 0, R, R, 0, 0x340)).toBe(E.noent)
      const loopLen = writeStr(0x100, "loop_a")
      expect(imp.path_open(3, 1, 0x100, loopLen, 0, R, R, 0, 0x340)).toBe(E.loop)
      const loopChildLen = writeStr(0x100, "loop_a/x")
      expect(imp.path_open(3, 1, 0x100, loopChildLen, 0, R, R, 0, 0x340)).toBe(E.loop)
      const nonDirParent = writeStr(0x100, "seed.txt/child")
      expect(imp.path_open(3, 1, 0x100, nonDirParent, 0, R, R, 0, 0x340)).toBe(E.notdir)
      const linkLen = writeStr(0x100, "link_seed")
      expect(imp.path_open(3, 1, 0x100, linkLen, OFLAG.creat | OFLAG.excl, RW, RW, 0, 0x340)).toBe(E.exist)
      expect(imp.path_open(3, 0, 0x100, linkLen, 0, R, R, 0, 0x340)).toBe(E.loop)
      const absLinkLen = writeStr(0x100, "abs_link")
      expect(imp.path_open(3, 1, 0x100, absLinkLen, 0, R, R, 0, 0x340)).toBe(E.success)
      imp.fd_close(dv.getUint32(0x340, true))

      const seedLen2 = writeStr(0x100, "seed.txt")
      expect(imp.path_open(3, 1, 0x100, seedLen2, OFLAG.creat | OFLAG.excl, RW, RW, 0, 0x340)).toBe(E.exist)
      const subLen2 = writeStr(0x100, "sub")
      expect(imp.path_open(3, 1, 0x100, subLen2, 0, W, W, 0, 0x340)).toBe(E.isdir)
      const seedLen3 = writeStr(0x100, "seed.txt")
      expect(imp.path_open(3, 1, 0x100, seedLen3, OFLAG.directory, R, R, 0, 0x340)).toBe(E.notdir)
      const missLen = writeStr(0x100, "missing.txt")
      expect(imp.path_open(3, 1, 0x100, missLen, OFLAG.directory, R, R, 0, 0x340)).toBe(E.noent)
      expect(imp.path_open(3, 1, 0x100, missLen, 0, R, R, 0, 0x340)).toBe(E.noent)
      const seedLen4 = writeStr(0x100, "seed.txt")
      expect(imp.path_open(3, 1, 0x100, seedLen4, OFLAG.trunc, R, R, 0, 0x340)).toBe(E.inval)

      const apLen = writeStr(0x100, "append_new.txt")
      expect(imp.path_open(3, 1, 0x100, apLen, OFLAG.creat | OFLAG.excl, RW, RW, FDFLAGS_APPEND, 0x340)).toBe(E.success)
      imp.fd_close(dv.getUint32(0x340, true))
      expect(imp.path_open(3, 1, 0x100, apLen, OFLAG.trunc, RW, RW, FDFLAGS_APPEND, 0x340)).toBe(E.success)
      imp.fd_close(dv.getUint32(0x340, true))
      expect(imp.path_open(3, 1, 0x100, apLen, 0, RW, RW, 0, 0x340)).toBe(E.success)
      imp.fd_close(dv.getUint32(0x340, true))

      const dstLen = writeStr(0x200, "sym_dst")
      expect(imp.path_symlink(0x100, 0, 3, 0x200, dstLen)).toBe(E.noent)

      expect(imp.poll_oneoff(0x1000, 0x1100, 0, 0x340)).toBe(E.inval)
      dv.setBigUint64(0x1000, 12345n, true)
      u8[0x1008] = 0
      expect(imp.poll_oneoff(0x1000, 0x1100, 1, 0x340)).toBe(E.success)
      expect(dv.getUint32(0x340, true)).toBe(1)

      expect(imp.proc_raise(9)).toBe(E.notsup)
      expect(imp.sock_accept(3, 0, 0x340)).toBe(E.notsup)
      expect(imp.sock_recv(3, 0x300, 1, 0, 0x340, 0x344)).toBe(E.notsup)
      expect(imp.sock_send(3, 0x300, 1, 0, 0x340)).toBe(E.notsup)
      expect(imp.sock_shutdown(3, 0)).toBe(E.notsup)

      expect(imp.fd_filestat_get(0, 0x999999)).toBe(E.fault)

      wasi.dispose()
    })
  }, 60_000)

  it("fuzzes BrowserJj layerScoped, root/normalize/contains, revert, workspaceAdd rollback, symlinks, disposal, and layerUnsupported", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const jj = yield* Jj
        expect(Exit.isFailure(yield* Effect.exit(jj.workspaceForget("w")))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(jj.root!("/")))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(jj.revert!("@")))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(jj.opRestore!("op")))).toBe(true)
      }).pipe(Effect.provide(BrowserJj.layerUnsupported))
    )

    await withTempDir("wave10b-bjj-", async (dir) => {
      const okBytes = fakeFlowsJjWasm({ response: JSON.stringify({ ok: { commitId: "abcd1234" } }) })
      const okModule = await WebAssembly.compile(okBytes as BufferSource)
      let leakedJj!: typeof Jj.Service
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const jj = yield* Jj
            leakedJj = jj
            expect(yield* jj.root!(dir)).toBe(dir)
            expect(yield* jj.root!(`${dir}/sub/../a/./b`)).toBe(dir)
            expect(Exit.isFailure(yield* Effect.exit(jj.root!("relative/path")))).toBe(true)
            expect(Exit.isFailure(yield* Effect.exit(jj.root!("/elsewhere/outside")))).toBe(true)
            expect(Exit.isFailure(yield* Effect.exit(jj.revert!("@")))).toBe(true)
          }).pipe(
            Effect.provide(
              BrowserJj.layerScoped({
                fs: fsModule,
                root: dir,
                wasm: okModule
              })
            )
          )
        )
      )
      const disposedExit = await Effect.runPromiseExit(leakedJj.root!(dir))
      expect(Exit.isFailure(disposedExit)).toBe(true)

      const symDir = join(dir, "sym-ws")
      fsModule.mkdirSync(symDir)
      fsModule.writeFileSync(join(symDir, "a.txt"), "hi")
      fsModule.symlinkSync("a.txt", join(symDir, "link.txt"))
      const symJj = BrowserJj.make({ fs: fsModule, root: symDir, wasm: okModule })
      expect(Exit.isFailure(await Effect.runPromiseExit(symJj.snapshot()))).toBe(true)

      const dotJjSymDir = join(dir, "dotjj-sym")
      fsModule.mkdirSync(dotJjSymDir)
      fsModule.symlinkSync("/tmp", join(dotJjSymDir, ".jj"))
      const dotJjSymJj = BrowserJj.make({ fs: fsModule, root: dotJjSymDir, wasm: okModule })
      expect(Exit.isFailure(await Effect.runPromiseExit(dotJjSymJj.snapshot()))).toBe(true)

      const failWasmJj = BrowserJj.make({
        fs: fsModule,
        root: dir,
        wasm: () => Promise.reject(new Error("wasm download failed"))
      })
      expect(Exit.isFailure(await Effect.runPromiseExit(failWasmJj.status()))).toBe(true)
      expect(Exit.isFailure(await Effect.runPromiseExit(failWasmJj.status()))).toBe(true)

      const zeroAllocWasm = await WebAssembly.compile(
        fakeFlowsJjWasm({ response: "{}", packedResult: { ptr: 0, len: 0 } }) as BufferSource
      )
      const zeroJj = BrowserJj.make({ fs: fsModule, root: dir, wasm: zeroAllocWasm })
      expect(Exit.isFailure(await Effect.runPromiseExit(zeroJj.status()))).toBe(true)

      const errBytes = fakeFlowsJjWasm({
        response: JSON.stringify({ error: { code: "unknown", message: "pin fail" } })
      })
      const errModule = await WebAssembly.compile(errBytes as BufferSource)
      const wsDir = join(dir, "ws-add")
      fsModule.mkdirSync(wsDir)
      const wsJj = BrowserJj.make({ fs: fsModule, root: wsDir, wasm: errModule })
      expect(Exit.isFailure(await Effect.runPromiseExit(wsJj.workspaceAdd("lane1", join(dir, "lane1"), "@")))).toBe(
        true
      )
    })
  }, 60_000)

  it("exercises NodeJj real-repo mutations, dead-lock reclamation, startup checks, spawner workspaceAdd/opRestore/revert, and interruption", async () => {
    expect(() => NodeJj.layerAt("relative/root")).toThrow(TypeError)
    expect(() => NodeJj.layerSpawnerAt("relative/root")).toThrow(TypeError)

    const badTimeoutExit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const jj = yield* Jj
        return yield* jj.status()
      }).pipe(
        Effect.provide(NodeJj.layer),
        Effect.provideService(NodeJj.StartupTimeoutMs, 0),
        Effect.provide(silentLogger)
      )
    )
    expect(Exit.isFailure(badTimeoutExit)).toBe(true)

    const prevBin = process.env.SMITHERS_JJ_BIN
    process.env.SMITHERS_JJ_BIN = "/nonexistent/path/to/jj-bin-wave10"
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          yield* Jj
        }).pipe(Effect.provide(NodeJj.layer), Effect.provide(silentLogger))
      )
    } finally {
      if (prevBin === undefined) delete process.env.SMITHERS_JJ_BIN
      else process.env.SMITHERS_JJ_BIN = prevBin
    }

    await withTempDir("wave10b-nodejj-", async (dir) => {
      const repoDir = join(dir, "repo")
      fsModule.mkdirSync(repoDir)
      execFileSync("jj", ["git", "init"], { cwd: repoDir, stdio: "ignore" })
      fsModule.writeFileSync(join(repoDir, "hello.txt"), "v1\n")

      const layer = NodeJj.layerAt(repoDir)

      await Effect.runPromise(
        Effect.gen(function*() {
          const jj = yield* Jj
          const snap = yield* jj.snapshot()
          expect(snap.commitId.length).toBeGreaterThan(0)

          // Plant a stale dead lock directory & candidate directory in .jj/repo/store so next mutation reclaims it!
          const storeDir = join(repoDir, ".jj", "repo", "store")
          const lockDir = join(storeDir, ".smithers-jj-lock")
          const candDir = join(storeDir, ".smithers-jj-lock-candidate-dead")
          fsModule.mkdirSync(lockDir, { recursive: true })
          fsModule.writeFileSync(join(lockDir, `${hostname()}-99999999`), "")
          fsModule.mkdirSync(candDir, { recursive: true })
          fsModule.writeFileSync(join(candDir, `${hostname()}-99999999`), "")

          yield* jj.snapshot("reclaimed dead lock")

          // Secondary workspace pointer `.jj/repo` file (NodeJj line 675 + NodeJjHost.readFileSync)
          const secDir = join(dir, "sec-ws")
          fsModule.mkdirSync(join(secDir, ".jj"), { recursive: true })
          fsModule.writeFileSync(join(secDir, ".jj", "repo"), join(repoDir, ".jj", "repo"))
          yield* Effect.exit(
            Jj.pipe(
              Effect.flatMap((j) => j.status()),
              Effect.provide(NodeJj.layerAt(secDir))
            )
          )

          // Plant workspace-config.toml without workspace-config-id (NodeJj line 671)
          const cfgPath = join(repoDir, ".jj", "workspace-config.toml")
          fsModule.writeFileSync(cfgPath, '[user]\nname = "x"\n')
          expect(Exit.isFailure(yield* Effect.exit(jj.status()))).toBe(true)
          fsModule.rmSync(cfgPath, { force: true })

          // Non-directory cwd (NodeJj line 286)
          const notDir = join(dir, "not-a-dir")
          fsModule.writeFileSync(notDir, "file")
          expect(Exit.isFailure(yield* Effect.exit(jj.root!(notDir)))).toBe(true)

          // Interrupt a forked jj command (exercises child kill finalizer)
          const f = yield* Effect.forkChild(jj.status())
          yield* Fiber.interrupt(f)
        }).pipe(Effect.provide(layer), Effect.provide(silentLogger))
      )

      // Exercise NodeJj.layerSpawner & layerSpawnerAt for workspaceAdd (with/without revision, bad commit id),
      // opRestore workspace-changed conflict (added & removed), and revert bad JSON path!
      let wsListCall = 0
      const scripted = makeScriptedSpawner((args) => {
        if (args.includes("--version")) return { stdout: "jj 0.39.0\n" }
        if (args.includes("op") && args.includes("log")) return { stdout: "0".repeat(32) + "\n" }
        if (args.includes("workspace") && args.includes("list")) {
          wsListCall += 1
          return {
            stdout: wsListCall % 2 === 1 ? "default aaaa\nextra bbbb\n" : "default aaaa\nold cccc\n"
          }
        }
        if (args.includes("log") && args.includes("commit_id")) {
          return { stdout: args.some((a) => a.includes("badrev")) ? "not-hex!\n" : "a".repeat(40) + "\n" }
        }
        if (args.includes("diff")) {
          return { stdout: "123\n" }
        }
        return { stdout: "" }
      })

      await Effect.runPromise(
        Effect.gen(function*() {
          const jj = yield* Jj
          const lane1 = join(dir, "sp-lanes", "l1")
          const lane2 = join(dir, "sp-lanes", "l2")
          yield* jj.workspaceAdd("l1", lane1)
          yield* jj.workspaceAdd("l2", lane2, "@")
          // Non-hex commit id in resolveCommit
          expect(Exit.isFailure(yield* Effect.exit(jj.workspaceAdd("l3", join(dir, "l3"), "badrev")))).toBe(true)
          // opRestore with changed workspaces -> conflict listing added & removed
          expect(Exit.isFailure(yield* Effect.exit(jj.opRestore!("0".repeat(32))))).toBe(true)
          // revert with non-string JSON path -> unknown error
          expect(Exit.isFailure(yield* Effect.exit(jj.revert!("@")))).toBe(true)
        }).pipe(
          Effect.provide(
            NodeJj.layerSpawnerAt(repoDir).pipe(
              Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(scripted))
            )
          ),
          Effect.provide(silentLogger)
        )
      )

      // NodeJj.layerSpawner root smoke
      await Effect.runPromise(
        Effect.scoped(
          Layer.build(NodeJj.layerSpawner).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scripted),
            Effect.provide(silentLogger)
          )
        )
      )
    })
  }, 60_000)
})
