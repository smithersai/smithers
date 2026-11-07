/**
 * A WASI preview 1 host shim over a {@link WasiFs.SyncFsLike} slice.
 *
 * This is the syscall layer under the wasm build of jj: the `flows_jj.wasm`
 * reactor imports `wasi_snapshot_preview1`, and this module answers those
 * imports from a synchronous filesystem slice — ZenFS's sync surface in a
 * browser page, `node:fs` in tests. It is written by hand in this repository
 * (the codebase pattern is structural slices passed as arguments, not an npm
 * runtime dependency); `@bjorn3/browser_wasi_shim` is prior art it mirrors in
 * shape, not a dependency.
 *
 * The shim is deliberately testable without any wasm module: {@link make}
 * returns plain functions over `(memory, fs, fd table)` state, so a test can
 * construct a `WebAssembly.Memory`, call the syscalls directly, and assert
 * errno values and memory layouts.
 *
 * One preopen is exposed: fd 3 names `"/"`, mapped to `root` in the slice —
 * exactly what wasi-libc's preopen scan expects, so every absolute path the
 * module opens resolves inside the slice, subject to the namespace ownership
 * requirement below.
 *
 * This shim is not a security sandbox for a concurrently mutated native
 * filesystem. `SyncFsLike` has only path-based calls: no retained directory
 * handles, atomic confined resolution, or no-follow open flags. Checks and
 * subsequent reads or mutations are separate backend calls. The host must
 * prevent other writers (including backend callbacks) from replacing path
 * components during a syscall, including `root` and its host ancestors, or
 * supply a backend that independently confines every operation. Synchronous
 * guest execution alone does not exclude native processes or other workers.
 *
 * The namespace is POSIX: `/` is the only separator, in guest paths and in
 * symlink targets alike, and `root` is expected to be a path the slice joins
 * the same way. A backend that also treats `\` as a separator would read a
 * segment this shim considers an ordinary filename as a traversal, so the
 * confinement below assumes it does not. rc.0 supports no such host: Windows is
 * not a supported runtime, and the slices this ships against are ZenFS and
 * `node:fs` under a POSIX root.
 *
 * **Honest divergences** from a kernel WASI host, in the `BrowserFileSystem`
 * tradition of documenting rather than hiding them:
 *
 * - `fd_sync`/`fd_datasync` only validate the descriptor and report success.
 *   The slice has no flush operation and provides no durability barrier.
 *   The host must await its mount's `sync` for changes that must survive reload.
 * - `poll_oneoff` reports every subscription complete immediately: clock waits
 *   (jj's lock backoff sleeps) become yields, and a synchronous filesystem is
 *   always ready. Nothing can be genuinely waited on in a single thread.
 * - `path_link` is `notsup`: the slice has no `linkSync`, and the jj code paths
 *   this package exercises never hard-link (the contract suite proves it).
 * - `path_filestat_set_times` always follows symlinks: the slice has no
 *   `lutimesSync`.
 * - `fd_readdir` lists the directory once per enumeration: a call at cookie
 *   zero takes a snapshot on the fd, later pages index it by cookie, and it is
 *   released when a page past the end yields nothing or the fd closes. Entries
 *   added or removed during an enumeration appear on the next cookie-zero
 *   enumeration; a cookie that arrives with no snapshot held lists afresh and
 *   indexes that listing, so a shorter directory ends the iteration early
 *   rather than failing.
 * - A directory fd names a PATH, not an inode. The slice has no `openat` and no
 *   directory handle to hold, so every use of an open directory fd re-resolves
 *   its namespace path. Rename the directory an fd was opened on and the fd
 *   follows the name, where POSIX would keep naming the moved directory. The
 *   alternative — remembering the host path at open time — is worse than a
 *   divergence: it is an escape, because a symlink left at the old name is then
 *   followed by the backend out of the preopen.
 * - `sock_*` and `proc_raise` are `notsup`; there are no sockets or signals in
 *   a tab.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema";
import type { SyncFsLike } from "../../../../src/browser/WasiFs.ts";
/**
 * WASI preview 1 errno values, by their spec names. Exported so tests assert
 * numbers against names rather than magic literals.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const Errno: {
    readonly success: 0;
    readonly acces: 2;
    readonly again: 6;
    readonly badf: 8;
    readonly busy: 10;
    readonly exist: 20;
    readonly fault: 21;
    readonly fbig: 22;
    readonly inval: 28;
    readonly io: 29;
    readonly isdir: 31;
    readonly loop: 32;
    readonly mfile: 33;
    readonly nametoolong: 37;
    readonly nfile: 41;
    readonly noent: 44;
    readonly nolck: 46;
    readonly nospc: 51;
    readonly nosys: 52;
    readonly notdir: 54;
    readonly notempty: 55;
    readonly notsup: 58;
    readonly perm: 63;
    readonly pipe: 64;
    readonly range: 68;
    readonly rofs: 69;
    readonly spipe: 70;
    readonly xdev: 75;
};
declare const WasiExitError_base: Schema.Class<WasiExitError, Schema.TaggedStruct<"@smthrs/jj/WasiExitError", {
    /** The unsigned exit code the module passed to `proc_exit`. */
    readonly exitCode: Schema.Number;
}>, import("effect/Cause").YieldableError>;
/**
 * The wasm module called `proc_exit`. A reactor module must not exit, so the
 * shim turns the call into a thrown error that traps the calling export;
 * `BrowserJj` reports it as a failed operation.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class WasiExitError extends WasiExitError_base {
    get message(): string;
}
/**
 * What the shim serves the module: a synchronous filesystem, the slice of it
 * preopened as the WASI root, and where the module's stdout and stderr go.
 *
 * The filesystem must be *synchronous* because WASI preview 1 syscalls return
 * a value rather than a promise — there is nowhere to await inside an import.
 *
 * @category models
 * @since 0.1.0
 */
export interface WasiPreview1Options {
    /**
     * The synchronous filesystem the module's WASI namespace is served from.
     * The host must exclude concurrent namespace mutation during each syscall,
     * or the backend must independently confine every path operation. `root`
     * alone does not sandbox `node:fs` against a concurrent native writer.
     */
    readonly fs: SyncFsLike;
    /**
     * The slice path preopened as the WASI namespace root `"/"`. Defaults to
     * `"/"` — the namespace *is* the slice — which is what a ZenFS mount wants;
     * tests over `node:fs` pass a temp directory here instead.
     */
    readonly root?: string;
    /** Receives text the module writes to fd 1. Unset means the text is dropped. */
    readonly onStdout?: (text: string) => void;
    /** Receives text the module writes to fd 2 — Rust panic messages arrive here. */
    readonly onStderr?: (text: string) => void;
}
/**
 * A WASI preview 1 host: the `imports` object to instantiate a module with,
 * and the {@link WasiPreview1.initialize} call that binds its memory.
 *
 * The two are separate because the shim cannot read the module's memory until
 * the module exists, and the module cannot be instantiated without the
 * imports — so the binding necessarily happens after instantiation.
 *
 * @category models
 * @since 0.1.0
 */
export interface WasiPreview1 {
    /**
     * The `wasi_snapshot_preview1` import namespace: instantiate the module with
     * `{ wasi_snapshot_preview1: shim.imports }`. Every function returns a WASI
     * errno; backend errors are mapped by their Node-style `code`, and anything
     * without one (a genuine bug) is rethrown into the calling export rather
     * than laundered into an errno.
     */
    readonly imports: {
        readonly [name: string]: (...args: Array<any>) => number;
    };
    /**
     * Binds the instantiated module's exported memory. Must be called after
     * instantiation and before the module's `_initialize` runs, because
     * `_initialize` may already issue syscalls (environ probing).
     */
    readonly initialize: (memory: WebAssembly.Memory) => void;
    /**
     * Releases every host descriptor the guest still holds and empties the fd
     * table, so a guest that trapped (a Rust panic, `proc_exit`, a thrown host
     * callback) before its own `fd_close` calls leaks nothing into the backend.
     * Idempotent: a second call finds nothing to close. After it, every
     * descriptor answers `badf`, and the preopen is gone too, so the host must
     * not reuse the instance.
     *
     * A backend that refuses to close a descriptor does not stop the sweep: the
     * remaining descriptors are still closed, the table is still emptied, and
     * the first failure is rethrown afterwards.
     */
    readonly dispose: () => void;
}
/**
 * Creates a WASI preview 1 host over a synchronous filesystem slice.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (options: WasiPreview1Options) => WasiPreview1;
export {};
