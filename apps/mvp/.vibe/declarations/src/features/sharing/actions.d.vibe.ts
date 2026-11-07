import { Effect } from "effect";
import { FlowDispatch } from "../../../../../src/flows/dispatch";
import type { ShareAccess } from "../../../../../src/features/branch/contract";
import { type Change } from "../../../../../src/features/sharing/schema";
import { SharingStore } from "./store.vibe";
/** Opens the share dialog on branch `branchId`, its list kept equal to the branch's while it shows. */
export declare const openDialog: (branchId: string) => Effect.Effect<void, never, SharingStore>;
/** Closes the share dialog. */
export declare const closeDialog: Effect.Effect<void, never, SharingStore>;
/** Applies `change` to the dialog's branch through `branch/share`; a refusal shows in the dialog. */
export declare const change: (change: Change) => Effect.Effect<import("../../../../../node_modules/@smthrs/effect-tanstack-db/src/Collection.ts").Transaction | undefined, never, FlowDispatch | SharingStore>;
/** Shares the dialog's branch with the person `login`, to `access`. */
export declare const add: (login: string, access: ShareAccess) => Effect.Effect<import("../../../../../node_modules/@smthrs/effect-tanstack-db/src/Collection.ts").Transaction | undefined, never, FlowDispatch | SharingStore>;
/** Changes what `grantee` may do, `null` to remove them. */
export declare const set: (grantee: string, access: ShareAccess | null) => Effect.Effect<import("../../../../../node_modules/@smthrs/effect-tanstack-db/src/Collection.ts").Transaction | undefined, never, FlowDispatch | SharingStore>;
