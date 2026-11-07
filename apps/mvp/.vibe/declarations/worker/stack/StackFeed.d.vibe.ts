import { Effect } from "effect";
import { SqlClient } from "effect/sql";
/**
 * Fold a committed TODO into its person's notification in the transaction that commits it (decision 0124): Commit's
 * result, which opens the TODO. Only the stack's one writer (`Stack.apply`) calls it, once per op id; a replay of the
 * same op answers its first receipt and folds nothing again.
 */
export declare const foldCommit: (commit: {
    readonly opId: string;
    readonly repoId: string;
    readonly actorId: string;
    readonly number: number;
}) => Effect.Effect<number, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
