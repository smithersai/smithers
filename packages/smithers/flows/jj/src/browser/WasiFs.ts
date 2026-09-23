/**
 * The synchronous filesystem slice the WASI preview 1 shim runs over.
 *
 * WASI preview 1 is a synchronous syscall ABI: when the wasm module calls
 * `fd_read`, the answer has to be on the stack when the call returns. So the
 * backend the shim adapts must itself be synchronous — a promises API cannot be
 * awaited from inside a syscall. In the browser that backend is **ZenFS**'s
 * sync surface (mounted over an async mirror to OPFS or IndexedDB by the page);
 * in tests it is Node's own `node:fs`, which satisfies the same slice
 * structurally — the same duality `BrowserFileSystem` establishes with
 * `ZenFsPromisesLike`.
 *
 * The slice is an argument, never an import: this module names the shape and
 * depends on nothing, so the browser bundle decides which backend is mounted
 * and this package's dependency list stays at `effect` alone.
 *
 * Paths are POSIX-shaped (`/`-separated), which is what ZenFS speaks natively
 * and what `node:fs` accepts on every platform the test suite runs on.
 *
 * @since 0.1.0
 */

/**
 * The `Stats` subset the shim reads. Satisfied by Node's `fs.Stats` and by
 * ZenFS's `Stats`.
 *
 * Times are millisecond floats because that is what both backends report;
 * {@link SyncFsLike} has no bigint-stats mode, so the shim widens `mtimeMs` to
 * the nanosecond `filestat` fields WASI wants. Sub-millisecond precision
 * survives (both backends carry microseconds in the fraction); nothing finer
 * exists to lose.
 *
 * @category models
 * @since 0.1.0
 */
export interface SyncStatsLike {
  readonly size: number
  readonly atimeMs: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  /** Inode number when the backend has one; the shim reports 0 otherwise. */
  readonly ino?: number
  readonly isFile: () => boolean
  readonly isDirectory: () => boolean
  readonly isSymbolicLink: () => boolean
}

/**
 * The `Dirent` subset `fd_readdir` needs: a name and enough type information
 * to fill the WASI dirent `d_type` byte. Satisfied by Node's `fs.Dirent` and
 * by ZenFS's `Dirent`.
 *
 * @category models
 * @since 0.1.0
 */
export interface SyncDirentLike {
  readonly name: string
  readonly isFile: () => boolean
  readonly isDirectory: () => boolean
  readonly isSymbolicLink: () => boolean
}

/**
 * The synchronous filesystem surface the WASI shim depends on.
 *
 * Satisfied structurally by **`node:fs`** (what the test suite hands it) and by
 * **ZenFS**'s sync API (what a browser page hands it) — the module never
 * imports either. Two deliberate consequences of the shape:
 *
 * - `openSync` takes Node **string** flags (`"r"`, `"r+"`, `"w"`, `"wx"`, …)
 *   rather than numeric `O_*` constants, because the numeric constants are
 *   platform-specific and live on the module object this slice refuses to
 *   import. The shim composes WASI's `oflags`/`fdflags` onto string flags.
 * - Errors must be thrown with a Node-style string `code` property
 *   (`"ENOENT"`, `"EEXIST"`, `"ENOTDIR"`, …); the shim maps those codes onto
 *   WASI errno values. Both backends already throw exactly that shape.
 *
 * The slice has no flush operation such as `fsyncSync`. `fd_sync` and
 * `fd_datasync` only validate the descriptor and provide no durability barrier;
 * synchronous completion does not establish persistence. The host must await
 * its mount's `sync` after operations that must survive a reload. See the
 * [host mount contract](../../docs/guides/run-jj-in-a-browser.md#durability-is-the-mounts-job).
 *
 * `ftruncateSync` is the sole truncation member. It and `futimesSync` are
 * required: the fd-addressed `fd_filestat_set_size` and
 * `fd_filestat_set_times` must follow the open file even after a
 * `path_rename` (jj's tempfile-persist shape is open → rename → mutate), so
 * serving them through a path captured at `path_open` time would mutate
 * whatever file occupies the old name. Both backends carry the fd flavours.
 *
 * @category models
 * @since 0.1.0
 */
export interface SyncFsLike {
  readonly openSync: (path: string, flags: string, mode?: number) => number
  readonly closeSync: (fd: number) => void
  readonly readSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => number
  readonly writeSync: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ) => number
  readonly fstatSync: (fd: number) => SyncStatsLike
  readonly ftruncateSync: (fd: number, length: number) => void
  readonly futimesSync: (fd: number, atime: number, mtime: number) => void
  readonly statSync: (path: string) => SyncStatsLike
  readonly lstatSync: (path: string) => SyncStatsLike
  readonly mkdirSync: (path: string) => unknown
  readonly readdirSync: (
    path: string,
    options: { readonly withFileTypes: true }
  ) => Array<SyncDirentLike>
  readonly renameSync: (from: string, to: string) => void
  readonly unlinkSync: (path: string) => void
  readonly rmdirSync: (path: string) => void
  readonly readlinkSync: (path: string) => string
  readonly symlinkSync: (target: string, path: string) => void
  readonly utimesSync: (path: string, atime: number, mtime: number) => void
}
