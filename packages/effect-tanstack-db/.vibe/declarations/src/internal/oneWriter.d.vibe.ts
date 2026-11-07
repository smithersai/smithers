/**
 * One writer for a persisted synced collection among the programs that share
 * its database.
 *
 * The programs sharing one database through TanStack DB's coordinator, a
 * browser's tabs, each run the collection's sync source, and the persisted
 * core stores what every source commits, in the order the commits reach the
 * coordinator. A source that starts afresh commits a snapshot that empties
 * the collection first. One that reached the coordinator after another program
 * had stored newer rows erased them from the device, and the reload that
 * followed erased them from every program.
 *
 * Here only the program that holds the collection's lock writes: its source
 * runs as it would alone. Every other program runs its source watching: what
 * it writes, empties or commits is dropped, and it gets no sync metadata, so
 * it neither reads nor stores resume state. Its rows come from the device
 * alone, through the coordinator, while its source still tells it how the
 * network is and when it is ready. The lock is waited for, never stolen, so a
 * writer's late commit never lands after the next writer's. A watcher that
 * comes to hold the lock ends its watching session and starts its source
 * again, writing, from what the device stored.
 *
 * @since 0.2.0
 */
import * as Effect from "effect/Effect";
import type { Lock } from "../../../../src/Outbox.ts";
/**
 * What a program's source does for the collection: writes what it syncs, or
 * watches.
 *
 * @category models
 * @since 0.2.0
 */
export type Role = "writer" | "watcher";
/**
 * `config`, with its source writing only in the program that holds `lock`
 * `name`, and watching in every other. `fork` runs the program's turn at the
 * lock in the background and answers how to stop it; `became` hears each role
 * the program takes, and `failed` the failure that ends its turn, before the
 * collection is marked failed. A writer's transactions reach the persisted
 * core whole (`wholeTransactions`).
 *
 * @category internal
 * @since 0.2.0
 */
export declare const oneWriter: <C extends {
    readonly sync: (params: never) => unknown;
}>(config: C, options: {
    readonly lock: Lock;
    readonly name: string;
    readonly fork: (turn: Effect.Effect<void>) => () => void;
    readonly became: (role: Role) => void;
    readonly failed: (error: unknown) => Effect.Effect<void>;
}) => C;
