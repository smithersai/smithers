import type { Collection, Outbox } from "@smthrs/effect-tanstack-db";
import { Context, Effect } from "effect";
declare const OutboxWrites_base: Context.ServiceClass<OutboxWrites, "@smthrs/mvp/OutboxWrites", {
    readonly collections: Readonly<Record<string, Collection.Collection<any, any, any>>>;
    readonly mutations: Readonly<Record<string, Outbox.Mutation<never>>>;
    /**
     * What shows a parked write of each mutation, one an older build stored that this build can't send as it meant
     * (decision 0021 §4): the feature's own Not sent row. `true` when it took the write.
     */
    readonly parked?: Readonly<Record<string, (write: Outbox.Parked) => Effect.Effect<boolean>>>;
}>;
/** The writes features send through the device's outbox besides chat's own questions. */
export declare class OutboxWrites extends OutboxWrites_base {
    /**
     * `writes` added to the writes a layer below handed over, if any: how a second feature hands its writes to the same
     * outbox. Its names must be new: the earlier feature's stay as they were.
     */
    static readonly adding: (writes: OutboxWrites["Service"]) => Effect.Effect<{
        readonly collections: Readonly<Record<string, Collection.Collection<any, any, any>>>;
        readonly mutations: Readonly<Record<string, Outbox.Mutation<never>>>;
        /**
         * What shows a parked write of each mutation, one an older build stored that this build can't send as it meant
         * (decision 0021 §4): the feature's own Not sent row. `true` when it took the write.
         */
        readonly parked?: Readonly<Record<string, (write: Outbox.Parked) => Effect.Effect<boolean>>>;
    }, never, never>;
}
export {};
