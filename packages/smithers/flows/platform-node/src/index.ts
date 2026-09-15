/**
 * `@smthrs/platform-node`, the Node.js Host bundle.
 *
 * `@effect/platform-node` already ships `FileSystem`, `Path`,
 * `ChildProcessSpawner`, and an Undici-backed `HttpClient` for Node, and
 * `NodeHost.layer` composes the complete closed five-tag Host surface out of
 * them plus the Node `Jj` adapter, which lives in `@smthrs/jj`.
 *
 * The host adapters add guarantees beyond Effect's base services.
 * `AtomicFileSystem` performs every filesystem operation relative to
 * a pinned directory descriptor, so a symlink swapped in after authorization
 * cannot redirect it; `ProcessReaper` kills the process groups a crashed
 * incarnation of this host abandoned; `HostLiveness` answers whether a recorded
 * run owner is still running here. `ScopedProcess` runs transient commands with
 * supervised process cleanup and owns their input and output pipes.
 *
 * `AtomicFileSystem` is `NodeHost`'s filesystem slot, and it executes its
 * syscalls through a CPython 3 helper, so a POSIX host with `python3` at
 * `/usr/bin/python3` is a prerequisite by default. Smithers' Node and Bun control
 * hosts accept `SMITHERS_PYTHON3` as an absolute CPython 3 path at startup; unset
 * or empty keeps the default, and relative paths fail startup. They never search
 * `PATH`. Custom library compositions use `AtomicFileSystem.layerWith({ executable })`.
 * The layer BUILDS without an installed interpreter and then
 * fails every guarded filesystem call closed with `PermissionDenied`. Windows is
 * unsupported.
 *
 * @since 0.1.0
 */

/** The complete closed Host bundle for Node. */
export * as NodeHost from "./NodeHost.ts"

/** Whether a recorded run owner is still alive on this host. */
export * as HostLiveness from "./HostLiveness.ts"

/** Reaping the process groups a dead incarnation of this host abandoned. */
export * as ProcessReaper from "./ProcessReaper.ts"

/** Transient pipe-based commands with supervised process cleanup. */
export * as ScopedProcess from "./ScopedProcess.ts"
