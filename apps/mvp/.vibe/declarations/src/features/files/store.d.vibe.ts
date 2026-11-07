import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db";
import { Context, Effect, Layer } from "effect";
import { FileTabRow, type Here } from "../../../../../src/features/files/schema";
/** Every open file on this device, in the order they opened: what frontends read. */
export declare const tabsQuery: (tabs: Collection.Collection<FileTabRow, string>) => Effect.Effect<LiveQuery.LiveQuery<import("@tanstack/db").QueryBuilder<import("@tanstack/db").ContextFromSource<{
    tab: import("@tanstack/db").Collection<{
        readonly key: string;
        readonly owner: string;
        readonly name: string;
        readonly revision: string;
        readonly path: string;
        readonly lines: string | null;
        readonly position: number;
    }, string, import("@tanstack/db").UtilsRecord, import(".pnpm/@standard-schema+spec@1.1.0/node_modules/@standard-schema/spec").StandardSchemaV1<unknown, unknown>, {
        readonly key: string;
        readonly owner: string;
        readonly name: string;
        readonly revision: string;
        readonly path: string;
        readonly lines: string | null;
        readonly position: number;
    }>;
}>>>, Collection.LoadFailed, import("effect/Scope").Scope>;
declare const FilesStore_base: Context.ServiceClass<FilesStore, "@smthrs/mvp/files/FilesStore", {
    tabs: Collection.Collection<{
        readonly key: string;
        readonly owner: string;
        readonly name: string;
        readonly revision: string;
        readonly path: string;
        readonly lines: string | null;
        readonly position: number;
    }, string, import("@tanstack/db").UtilsRecord>;
    all: LiveQuery.LiveQuery<import("@tanstack/db").QueryBuilder<import("@tanstack/db").ContextFromSource<{
        tab: import("@tanstack/db").Collection<{
            readonly key: string;
            readonly owner: string;
            readonly name: string;
            readonly revision: string;
            readonly path: string;
            readonly lines: string | null;
            readonly position: number;
        }, string, import("@tanstack/db").UtilsRecord, import(".pnpm/@standard-schema+spec@1.1.0/node_modules/@standard-schema/spec").StandardSchemaV1<unknown, unknown>, {
            readonly key: string;
            readonly owner: string;
            readonly name: string;
            readonly revision: string;
            readonly path: string;
            readonly lines: string | null;
            readonly position: number;
        }>;
    }>>>;
    keep: (here: Pick<Here, "owner" | "name" | "revision">, path: string, lines: string | null) => Effect.Effect<void, Collection.TransactionFailed, never>;
    drop: (here: Pick<Here, "owner" | "name" | "revision">, path: string) => Effect.Effect<boolean, never, never>;
}>;
/**
 * File tabs' state for one tab:
 * - `tabs`: this device's open files, kept on the device.
 * - `all`: the live query of every one, in the order they opened.
 * - `keep` and `drop`: a tab kept with its lines, and a tab closed, one write at a time.
 */
export declare class FilesStore extends FilesStore_base {
    /** The store, with its follower of the repository view running until the scope closes. */
    static readonly layer: Layer.Layer<FilesStore, Collection.LoadFailed, import("../../../../../node_modules/@smthrs/effect-tanstack-db/src/Persistence").Persistence>;
}
export {};
