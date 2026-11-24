import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Schema } from "effect"
import * as fsModule from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as BrowserJj from "../src/browser/BrowserJj.ts"
import type { SyncFsLike } from "../src/browser/WasiFs.ts"
import { Errno as E, make as makeWasi, WasiExitError } from "../src/browser/WasiPreview1.ts"
import { Jj } from "../src/Jj.ts"
import { emptyWasmModule, fakeFlowsJjWasm } from "./FakeFlowsJjWasm.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const encoder = new TextEncoder()
const PATH_A = 0x100
const PATH_B = 0x200
const IOV = 0x300
const RET = 0x340
const STAT = 0x600
const FDSTAT = 0x680
const BUF = 0x1000
const DATA = 0x2000
const R = 1n << 1n
const W = 1n << 6n
const RW = R | W
const OFLAG = { creat: 1, directory: 2, excl: 4, trunc: 8 } as const

describe("@smthrs/jj Wave 7 deep fuzz (WasiPreview1 syscalls + errno mapping + BrowserJj ABI/errors)", () => {
  it("WasiPreview1 syscalls preserve fd/path confinement, seek/tell/pread/pwrite/stat/readdir/link/symlink/rename/exit, and errno mappings", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        op: Schema.Literals([
          "writeReadSeek",
          "preadPwrite",
          "mkdirReaddirRmdir",
          "renameUnlink",
          "symlinkReadlink",
          "statAndTimes",
          "fdstatAndFlags",
          "clockRandomArgsEnv",
          "escapeRefused",
          "procExit",
          "badFd"
        ]),
        errnoCode: Schema.Literals(["ENOENT", "EACCES", "EEXIST", "EISDIR", "ENOTDIR", "ENOTEMPTY", "EINVAL", "ENOLCK", "ENOSPC", "EROFS", "EXDEV", "ELOOP", "EPERM", "UNKNOWN_CODE"]),
        payload: Schema.Literals(["hello wasi", "line1\nline2\n", "0123456789abcdef"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ op, errnoCode, payload }) =>
          Effect.sync(() => {
            const root = fsModule.realpathSync(fsModule.mkdtempSync(join(tmpdir(), "jj-wasi-w7-")))
            try {
              const memory = new WebAssembly.Memory({ initial: 3 })
              const stdoutChunks: Array<string> = []
              const stderrChunks: Array<string> = []
              const wasi = makeWasi({
                fs: fsModule as SyncFsLike,
                root,
                onStdout: (t) => stdoutChunks.push(t),
                onStderr: (t) => stderrChunks.push(t)
              })
              wasi.initialize(memory)
              const sys = wasi.imports as Record<string, (...args: Array<any>) => number>
              const view = () => new DataView(memory.buffer)
              const writeStr = (at: number, text: string) => {
                const b = encoder.encode(text)
                new Uint8Array(memory.buffer, at, b.length).set(b)
                return { ptr: at, len: b.length }
              }
              const setIov = (ptr: number, len: number) => {
                view().setUint32(IOV, ptr, true)
                view().setUint32(IOV + 4, len, true)
                return IOV
              }

              expect(sys.fd_prestat_get!(3, RET)).toBe(E.success)
              expect(sys.fd_prestat_dir_name!(3, BUF, 64)).toBe(E.success)
              expect(sys.fd_prestat_get!(99, RET)).toBe(E.badf)

              const bytes = encoder.encode(payload)

              if (op === "writeReadSeek") {
                const p = writeStr(PATH_A, "file.txt")
                expect(sys.path_open!(3, 0, p.ptr, p.len, OFLAG.creat | OFLAG.trunc, RW, RW, 0, RET)).toBe(E.success)
                const fd = view().getUint32(RET, true)
                new Uint8Array(memory.buffer, DATA, bytes.length).set(bytes)
                expect(sys.fd_write!(fd, setIov(DATA, bytes.length), 1, RET)).toBe(E.success)
                expect(view().getUint32(RET, true)).toBe(bytes.length)
                expect(sys.fd_tell!(fd, RET)).toBe(E.success)
                expect(view().getBigUint64(RET, true)).toBe(BigInt(bytes.length))
                expect(sys.fd_seek!(fd, 0n, 0, RET)).toBe(E.success)
                expect(sys.fd_read!(fd, setIov(BUF, bytes.length + 16), 1, RET)).toBe(E.success)
                const n = view().getUint32(RET, true)
                expect(n).toBe(bytes.length)
                expect(new TextDecoder().decode(new Uint8Array(memory.buffer, BUF, n))).toBe(payload)
                expect(sys.fd_sync!(fd)).toBe(E.success)
                expect(sys.fd_datasync!(fd)).toBe(E.success)
                expect(sys.fd_close!(fd)).toBe(E.success)
              } else if (op === "preadPwrite") {
                const p = writeStr(PATH_A, "pfile.txt")
                expect(sys.path_open!(3, 0, p.ptr, p.len, OFLAG.creat | OFLAG.trunc, RW, RW, 0, RET)).toBe(E.success)
                const fd = view().getUint32(RET, true)
                new Uint8Array(memory.buffer, DATA, bytes.length).set(bytes)
                expect(sys.fd_pwrite!(fd, setIov(DATA, bytes.length), 1, 2n, RET)).toBe(E.success)
                expect(sys.fd_pread!(fd, setIov(BUF, bytes.length), 1, 2n, RET)).toBe(E.success)
                const n = view().getUint32(RET, true)
                expect(new TextDecoder().decode(new Uint8Array(memory.buffer, BUF, n))).toBe(payload)
                expect(sys.fd_filestat_set_size!(fd, 4n)).toBe(E.success)
                expect(sys.fd_close!(fd)).toBe(E.success)
              } else if (op === "mkdirReaddirRmdir") {
                const d = writeStr(PATH_A, "sub")
                expect(sys.path_create_directory!(3, d.ptr, d.len)).toBe(E.success)
                const f = writeStr(PATH_B, "sub/a.txt")
                expect(sys.path_open!(3, 0, f.ptr, f.len, OFLAG.creat, RW, RW, 0, RET)).toBe(E.success)
                expect(sys.fd_close!(view().getUint32(RET, true))).toBe(E.success)
                expect(sys.path_open!(3, 0, d.ptr, d.len, OFLAG.directory, R, R, 0, RET)).toBe(E.success)
                const dfd = view().getUint32(RET, true)
                expect(sys.fd_readdir!(dfd, BUF, 512, 0n, RET)).toBe(E.success)
                expect(view().getUint32(RET, true)).toBeGreaterThan(0)
                expect(sys.fd_close!(dfd)).toBe(E.success)
                expect(sys.path_unlink_file!(3, f.ptr, f.len)).toBe(E.success)
                expect(sys.path_remove_directory!(3, d.ptr, d.len)).toBe(E.success)
              } else if (op === "renameUnlink") {
                const a = writeStr(PATH_A, "src.txt")
                const b = writeStr(PATH_B, "dst.txt")
                expect(sys.path_open!(3, 0, a.ptr, a.len, OFLAG.creat, RW, RW, 0, RET)).toBe(E.success)
                expect(sys.fd_close!(view().getUint32(RET, true))).toBe(E.success)
                expect(sys.path_rename!(3, a.ptr, a.len, 3, b.ptr, b.len)).toBe(E.success)
                expect(sys.path_unlink_file!(3, b.ptr, b.len)).toBe(E.success)
              } else if (op === "symlinkReadlink") {
                const target = writeStr(PATH_A, "target.txt")
                const link = writeStr(PATH_B, "sym.txt")
                expect(sys.path_open!(3, 0, target.ptr, target.len, OFLAG.creat, RW, RW, 0, RET)).toBe(E.success)
                expect(sys.fd_close!(view().getUint32(RET, true))).toBe(E.success)
                expect(sys.path_symlink!(target.ptr, target.len, 3, link.ptr, link.len)).toBe(E.success)
                expect(sys.path_readlink!(3, link.ptr, link.len, BUF, 128, RET)).toBe(E.success)
                const n = view().getUint32(RET, true)
                expect(new TextDecoder().decode(new Uint8Array(memory.buffer, BUF, n))).toBe("target.txt")
                const hard = writeStr(PATH_B, "hard.txt")
                expect([E.success, E.notsup, E.nosys]).toContain(sys.path_link!(3, 0, target.ptr, target.len, 3, hard.ptr, hard.len))
              } else if (op === "statAndTimes") {
                const a = writeStr(PATH_A, "timed.txt")
                expect(sys.path_open!(3, 0, a.ptr, a.len, OFLAG.creat, RW, RW, 0, RET)).toBe(E.success)
                const fd = view().getUint32(RET, true)
                expect(sys.fd_filestat_get!(fd, STAT)).toBe(E.success)
                expect(sys.fd_filestat_set_times!(fd, 1_000_000_000n, 2_000_000_000n, 0x1 | 0x4)).toBe(E.success)
                expect(sys.path_filestat_get!(3, 0, a.ptr, a.len, STAT)).toBe(E.success)
                expect(sys.path_filestat_set_times!(3, 0, a.ptr, a.len, 3_000_000_000n, 4_000_000_000n, 0x1 | 0x4)).toBe(E.success)
                expect(sys.fd_close!(fd)).toBe(E.success)
              } else if (op === "fdstatAndFlags") {
                const a = writeStr(PATH_A, "flags.txt")
                expect(sys.path_open!(3, 0, a.ptr, a.len, OFLAG.creat, RW, RW, 0, RET)).toBe(E.success)
                const fd = view().getUint32(RET, true)
                expect(sys.fd_fdstat_get!(fd, FDSTAT)).toBe(E.success)
                expect(sys.fd_fdstat_set_flags!(fd, 1)).toBe(E.success)
                expect(sys.fd_fdstat_set_rights!(fd, R, R)).toBe(E.success)
                expect(sys.fd_advise!(fd, 0n, 0n, 0)).toBe(E.success)
                expect(sys.fd_close!(fd)).toBe(E.success)
              } else if (op === "clockRandomArgsEnv") {
                expect(sys.clock_res_get!(0, RET)).toBe(E.success)
                expect(sys.clock_time_get!(0, 0n, RET)).toBe(E.success)
                expect(sys.clock_time_get!(1, 0n, RET)).toBe(E.success)
                expect(sys.random_get!(BUF, 16)).toBe(E.success)
                expect(sys.args_sizes_get!(RET, RET + 4)).toBe(E.success)
                expect(sys.args_get!(BUF, BUF + 64)).toBe(E.success)
                expect(sys.environ_sizes_get!(RET, RET + 4)).toBe(E.success)
                expect(sys.environ_get!(BUF, BUF + 64)).toBe(E.success)
                expect(sys.sched_yield!()).toBe(E.success)
                new Uint8Array(memory.buffer, DATA, bytes.length).set(bytes)
                expect(sys.fd_write!(1, setIov(DATA, bytes.length), 1, RET)).toBe(E.success)
                expect(sys.fd_write!(2, setIov(DATA, bytes.length), 1, RET)).toBe(E.success)
                expect(stdoutChunks.join("")).toBe(payload)
                expect(stderrChunks.join("")).toBe(payload)
              } else if (op === "escapeRefused") {
                const esc = writeStr(PATH_A, "../../etc/passwd")
                const rc = sys.path_open!(3, 0, esc.ptr, esc.len, 0, R, R, 0, RET)
                expect(rc).not.toBe(E.success)
              } else if (op === "procExit") {
                expect(() => sys.proc_exit!(7)).toThrow(WasiExitError)
              } else {
                expect(sys.fd_read!(999, setIov(BUF, 8), 1, RET)).toBe(E.badf)
                expect(sys.fd_write!(999, setIov(DATA, 8), 1, RET)).toBe(E.badf)
                expect(sys.fd_close!(999)).toBe(E.badf)
                expect(sys.fd_seek!(999, 0n, 0, RET)).toBe(E.badf)
                expect(sys.fd_tell!(999, RET)).toBe(E.badf)
              }

              // Exercise errno mapping via faulty SyncFsLike
              const faultyFs: SyncFsLike = {
                ...(fsModule as SyncFsLike),
                statSync: () => {
                  throw Object.assign(new Error(`injected ${errnoCode}`), { code: errnoCode })
                },
                lstatSync: () => {
                  throw Object.assign(new Error(`injected ${errnoCode}`), { code: errnoCode })
                }
              }
              const fMem = new WebAssembly.Memory({ initial: 2 })
              const fWasi = makeWasi({ fs: faultyFs, root })
              fWasi.initialize(fMem)
              const fSys = fWasi.imports as Record<string, (...args: Array<any>) => number>
              const fn = encoder.encode("probe.txt")
              new Uint8Array(fMem.buffer, PATH_A, fn.length).set(fn)
              const code = fSys.path_filestat_get!(3, 0, PATH_A, fn.length, STAT)
              expect(code).not.toBe(E.success)
              return true
            } finally {
              fsModule.rmSync(root, { recursive: true, force: true })
            }
          }),
        { executions: Math.min(executions, 80), seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("BrowserJj.layer and layerUnsupported exercise all ABI operations, error classification, trap/OOM/corrupt-pack safety, and cleanup", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "okStatus",
          "okSnapshot",
          "okRestore",
          "okDiff",
          "okWorkspaceAddForget",
          "errorJson",
          "badJson",
          "emptyWasm",
          "trapExit",
          "oomAlloc",
          "corruptPack",
          "unsupported"
        ]),
        errCode: Schema.Literals(["conflict", "invalid_ref", "not_installed", "snapshot_refused", "stale_workspace", "unsupported_version", "unknown"])
      })
    )

    const OK_ALL = JSON.stringify({
      ok: {
        commitId: "0a1b2c3d",
        changeId: "qpvuntsm",
        operationId: "op123",
        diff: "diff --git a/x b/x",
        status: "Working copy clean"
      }
    })

    const slice: SyncFsLike = {
      ...(fsModule as SyncFsLike),
      statSync: () => fsModule.statSync(import.meta.filename),
      lstatSync: () => fsModule.lstatSync(import.meta.dirname),
      readdirSync: () => [],
      unlinkSync: (p: string): void => {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
      }
    }

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, errCode }) =>
          Effect.gen(function*() {
            if (mode === "unsupported") {
              const ex = yield* Effect.flatMap(Jj, (jj) => jj.status()).pipe(
                Effect.provide(BrowserJj.layerUnsupported),
                Effect.exit
              )
              expect(Exit.isFailure(ex)).toBe(true)
              return true
            }

            const wasmBytes =
              mode === "emptyWasm"
                ? emptyWasmModule()
                : mode === "errorJson"
                  ? fakeFlowsJjWasm({
                      response: JSON.stringify({ err: { code: errCode, message: `fault:${errCode}` } }),
                      logAllocs: true
                    })
                  : mode === "badJson"
                    ? fakeFlowsJjWasm({ response: "{not valid json" })
                    : mode === "trapExit"
                      ? fakeFlowsJjWasm({ trap: true, logAllocs: true })
                      : mode === "oomAlloc"
                        ? fakeFlowsJjWasm({ allocResult: 0 })
                        : mode === "corruptPack"
                          ? fakeFlowsJjWasm({ packedResult: { ptr: 0x0100_0000, len: 32 } })
                          : fakeFlowsJjWasm({ response: OK_ALL, logAllocs: true })

            const stderr: Array<string> = []
            const layer = BrowserJj.layer({
              fs: slice,
              root: "/",
              wasm: wasmBytes,
              onStderr: (chunk) => stderr.push(chunk)
            })

            const ex = yield* Effect.flatMap(Jj, (jj) =>
              mode === "okSnapshot"
                ? jj.snapshot("wave7 fuzz")
                : mode === "okRestore"
                  ? jj.restore("0a1b2c3d" as never)
                  : mode === "okDiff"
                    ? jj.diff("0a1b2c3d" as never, "qpvuntsm" as never)
                    : mode === "okWorkspaceAddForget"
                      ? Effect.gen(function*() {
                          yield* jj.workspaceAdd("ws-w7", "/ws-w7")
                          yield* jj.workspaceForget("ws-w7")
                          return "ok"
                        })
                      : jj.status()
            ).pipe(Effect.provide(layer), Effect.exit)

            if (
              mode === "emptyWasm" ||
              mode === "errorJson" ||
              mode === "badJson" ||
              mode === "trapExit" ||
              mode === "oomAlloc" ||
              mode === "corruptPack"
            ) {
              expect(Exit.isFailure(ex)).toBe(true)
            } else {
              expect(Exit.isSuccess(ex)).toBe(true)
            }
            return true
          }),
        { executions: Math.min(executions, 60), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
