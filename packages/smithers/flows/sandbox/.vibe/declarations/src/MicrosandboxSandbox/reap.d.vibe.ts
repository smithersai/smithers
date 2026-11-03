/**
 * Sweeps one owner's Microsandbox machines whose holder is gone.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import { ProviderError } from "../../../../src/RemoteChildProcessSpawner/ProviderError.ts";
import type { Sdk } from "../../../../src/MicrosandboxSandbox/Sdk.ts";
/**
 * Names whose machines to sweep and how to tell a live holder from a dead one.
 *
 * @category models
 * @since 0.1.0
 */
export interface ReapOptions {
    /** The injected Microsandbox SDK module. */
    readonly sdk: Sdk;
    /** The `smithers.owner` label value whose machines are swept; no other owner's are touched. */
    readonly owner: string;
    /**
     * Whether the process a machine's `smithers.holder` label names is still
     * running. A machine whose holder answers `false` is removed.
     */
    readonly isAlive: (holder: string) => Effect.Effect<boolean>;
    /**
     * Whether a machine whose holder is dead is still wanted, from the labels
     * its configuration records: a sticky machine a durable run will reattach
     * when it resumes. A retained machine is left alone. Default: none is.
     */
    readonly retain?: ((labels: Readonly<Record<string, string>>) => Effect.Effect<boolean>) | undefined;
    /** How long each removed machine's graceful stop may take before its removal is forced. Default 3000. */
    readonly stopTimeoutMs?: number | undefined;
}
/**
 * One machine `reap` removed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Reaped {
    /** The machine's Microsandbox name. */
    readonly name: string;
    /** The dead holder its label named. */
    readonly holder: string;
    /** The status the listing reported before removal, such as `running` or `crashed`. */
    readonly status: string;
}
/**
 * Removes this owner's machines whose holder is no longer alive.
 *
 * Microsandbox's own database is the registry: machines are listed by the
 * `smithers.provider` and `smithers.owner` labels every `MicrosandboxSandbox`
 * machine carries, page by page, and each one's `smithers.holder` label is put
 * to `isAlive`. A machine whose holder is dead is stopped and removed under a
 * bounded graceful window, with a forced removal when that fails, whatever its
 * persistence: a sticky machine outlives its holder by design, and reaping is
 * how a host decides that holder is not coming back. Machines of other owners,
 * machines without a readable holder label, and machines this package did not
 * create are never touched.
 *
 * A caller's `retain` keeps a dead holder's machine it still wants, such as a
 * sticky workspace of a run that resumes after the restart; the resumed run
 * reattaches it and relabels it to the new holder.
 *
 * Just before a removal the machine is read again, and a machine whose holder
 * label changed since the listing is skipped: acquiring an existing machine
 * relabels it to the new holder, so a machine a live holder reattached in the
 * meantime survives. A reattach that lands between that second read and the
 * removal is not caught, so a host reaps at startup, before it acquires. A
 * machine that disappears on its own in between is skipped too.
 *
 * Every candidate is attempted. When any removal fails, the effect fails with
 * `unavailable` naming those machines, after the others have been removed.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const reap: (options: ReapOptions) => Effect.Effect<ReadonlyArray<Reaped>, ProviderError>;
