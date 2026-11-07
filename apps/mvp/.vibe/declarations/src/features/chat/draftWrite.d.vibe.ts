import type { Collection } from "@smthrs/effect-tanstack-db";
import { Effect } from "effect";
export declare const persistDraft: (write: Collection.Transaction, key: string) => Effect.Effect<void, Collection.TransactionFailed, never>;
