import { ElectricCollection } from "@smthrs/effect-electric";
import { Collection, LiveQuery } from "@smthrs/effect-tanstack-db";
import { Context, Effect, FiberHandle, Layer, Scope } from "effect";
import { Dialog, ShareRow } from "../../../../../src/features/sharing/schema";
/** Where the lists sync from: ChatApi's origin, the site's own. */
export interface SharingConfig {
    readonly origin: string;
}
/** The dialog this tab shows. */
export declare const dialogQuery: (dialog: Collection.Collection<Dialog, string>) => Effect.Effect<LiveQuery.LiveQuery<import("@tanstack/db").QueryBuilder<import("@tanstack/db").ContextFromSource<{
    dialog: import("@tanstack/db").Collection<{
        readonly id: "dialog";
        readonly open: boolean;
        readonly branchId: string | null;
        readonly error: "failed" | "forbidden" | "no_person" | "too_many" | null;
        readonly pending: readonly string[];
    }, string, import("@tanstack/db").UtilsRecord, import(".pnpm/@standard-schema+spec@1.1.0/node_modules/@standard-schema/spec").StandardSchemaV1<unknown, unknown>, {
        readonly id: "dialog";
        readonly open: boolean;
        readonly branchId: string | null;
        readonly error: "failed" | "forbidden" | "no_person" | "too_many" | null;
        readonly pending: readonly string[];
    }>;
}> & import("@tanstack/db").SingleResult>>, Collection.LoadFailed, Scope.Scope>;
/** The open branch's permission list, oldest grant first. */
export declare const sharesQuery: (list: Collection.Collection<ShareRow, string>) => Effect.Effect<LiveQuery.LiveQuery<import("@tanstack/db").QueryBuilder<import("@tanstack/db").ContextFromSource<{
    share: import("@tanstack/db").Collection<{
        readonly branchId: string;
        readonly grantee: string;
        readonly login: string | null;
        readonly access: "edit" | "view";
        readonly sharedBy: string | null;
        readonly createdAt: string;
        readonly updatedAt: string;
    }, string, import("@tanstack/db").UtilsRecord, import(".pnpm/@standard-schema+spec@1.1.0/node_modules/@standard-schema/spec").StandardSchemaV1<unknown, unknown>, {
        readonly branchId: string;
        readonly grantee: string;
        readonly login: string | null;
        readonly access: "edit" | "view";
        readonly sharedBy: string | null;
        readonly createdAt: string;
        readonly updatedAt: string;
    }>;
}>>>, Collection.LoadFailed, Scope.Scope>;
declare const SharingStore_base: Context.ServiceClass<SharingStore, "@smthrs/mvp/sharing/SharingStore", {
    readonly origin: string;
    readonly dialog: Collection.Collection<Dialog, string>;
    readonly dialogState: Effect.Success<ReturnType<typeof dialogQuery>>;
    /** The open branch's permission list, as the dialog renders it. */
    readonly list: Collection.Collection<ShareRow, string>;
    readonly listState: Effect.Success<ReturnType<typeof sharesQuery>>;
    /** A branch's permission list, synced while this tab has opened it, for as long as the store lives. */
    readonly shares: (branchId: string) => Effect.Effect<ElectricCollection.ElectricCollection<ShareRow>>;
    /** What keeps `list` equal to the open branch's: only the latest dialog's runs. */
    readonly follower: FiberHandle.FiberHandle<void, never>;
    readonly scope: Scope.Scope;
}>;
/** Sharing's state for one tab. */
export declare class SharingStore extends SharingStore_base {
    /** The store; its collections cleaned up and its shapes closed when the scope closes. */
    static readonly layer: (config: SharingConfig) => Layer.Layer<SharingStore, Collection.LoadFailed, never>;
}
export {};
