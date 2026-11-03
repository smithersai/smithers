/**
 * Named Microsandbox disk snapshots: capture a prepared machine, ask whether
 * one exists, and prune a family down to its newest members.
 *
 * A snapshot is the machine's whole root disk. A machine booted from it with
 * the provider's `snapshot` option starts with everything the captured
 * machine had installed, so an expensive preparation runs once per snapshot
 * rather than once per machine. Capture scrubs credential files and refuses a
 * disk that still holds a registered secret, so no credential is restored.
 *
 * Every snapshot this module captures is named `<family>.<member>` by
 * {@link snapshotName}: the family is the preparation the snapshot repeats
 * (one per repository, say) and the member distinguishes its captures. The
 * member never contains the separator, so a name belongs to exactly one
 * family and pruning one family cannot reach another whose name extends it.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import { ProviderError } from "../../../../src/RemoteChildProcessSpawner/ProviderError.ts";
import type { Sdk } from "../../../../src/MicrosandboxSandbox/Sdk.ts";
/**
 * The character between a snapshot's family and its member.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const snapshotSeparator = ".";
/**
 * The name of `family`'s `member` snapshot, or `undefined` when the pair
 * cannot name exactly one family's snapshot: an empty part, or a member that
 * contains {@link snapshotSeparator} (it would read as a longer family).
 *
 * @category snapshots
 * @since 1.0.0
 */
export declare const snapshotName: (family: string, member: string) => string | undefined;
/**
 * The family a snapshot name belongs to: everything before its last
 * {@link snapshotSeparator}. `undefined` for a name this module did not
 * shape.
 *
 * @category snapshots
 * @since 1.0.0
 */
export declare const snapshotFamily: (name: string) => string | undefined;
/**
 * What {@link captureSnapshot} captures and names.
 *
 * @category models
 * @since 1.0.0
 */
export interface CaptureOptions {
    /** The injected Microsandbox SDK module. */
    readonly sdk: Sdk;
    /** The machine's Microsandbox name (a session's `remoteId`). */
    readonly machine: string;
    /** The family the snapshot joins; {@link pruneSnapshots} prunes by it. */
    readonly family: string;
    /** What tells this capture from the family's others; never contains {@link snapshotSeparator}. */
    readonly member: string;
    /**
     * Every credential value the machine was handed while it was prepared. The
     * capture is refused while any of them is still on its disk. Empty states
     * that preparation ran without credentials. Each value's longest line is
     * what is searched for and must hold at least 8 bytes.
     */
    readonly secrets: ReadonlyArray<string>;
    /** How long the machine's graceful stop may take. Default 30000. */
    readonly stopTimeoutMs?: number | undefined;
}
/**
 * Captures a prepared machine's root disk as the snapshot
 * {@link snapshotName} names, removes the machine, and returns that name.
 *
 * A snapshot is restored into every later machine, so a credential left on
 * the disk would reach all of them. Before the capture the machine is started
 * if stopped, the credential files of `/root` and every `/home/*` are removed
 * (git's store, `.netrc`, `.pypirc`, GitHub CLI, Cargo, AWS, Google Cloud,
 * and the Claude, Codex, Gemini, Copilot, and OpenCode sign-ins), and the
 * whole disk is searched for the longest line of every value in `secrets`,
 * raw, base64 or base64url at any alignment, percent-encoded, or
 * JSON-escaped; a value still found anywhere
 * refuses the capture and names the files, never the value. A secret whose
 * longest line is under 8 bytes is refused before any guest call. Hand credentials
 * to later machines at run time, after the restore.
 *
 * After the scrub the guest runs `sync`, so every file written before the
 * capture reaches the snapshot whole; stopping the machine alone does not
 * flush the guest's page cache. A `sync` that fails refuses the capture
 * before the machine is stopped or snapshotted.
 *
 * The machine is removed whether the capture succeeded, failed, or was
 * interrupted. A family and
 * member that cannot name a snapshot fail with `unavailable` before any
 * vendor call, and the machine stays.
 *
 * @category snapshots
 * @since 1.0.0
 */
export declare const captureSnapshot: (options: CaptureOptions) => Effect.Effect<string, ProviderError>;
/**
 * Whether a snapshot of that name exists.
 *
 * @category snapshots
 * @since 1.0.0
 */
export declare const hasSnapshot: (sdk: Sdk, name: string) => Effect.Effect<boolean, ProviderError>;
/**
 * Removes `family`'s snapshots (those {@link snapshotFamily} places in it,
 * exactly), except the `keep` newest and any named in `retain` (snapshots a
 * machine is about to boot from), and returns the removed names. Another
 * family whose name extends this one is never touched.
 *
 * @category snapshots
 * @since 1.0.0
 */
export declare const pruneSnapshots: (sdk: Sdk, family: string, keep: number, retain?: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string>, ProviderError>;
/**
 * Removes the named snapshot; one that is already gone is not an error.
 *
 * @category snapshots
 * @since 1.0.0
 */
export declare const removeSnapshot: (sdk: Sdk, name: string) => Effect.Effect<void, ProviderError>;
