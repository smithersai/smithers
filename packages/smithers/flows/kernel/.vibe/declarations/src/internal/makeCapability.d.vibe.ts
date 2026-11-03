/**
 * Typed capability construction for host decorators.
 *
 * @since 1.0.0-rc.0
 */
import * as Capability from "@smthrs/capability/Capability";
import { GrantStoreError } from "@smthrs/capability/Permission";
import { Effect } from "effect";
/**
 * Constructs decorator requests without leaking schema failures as defects.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const makeCapability: (action: Capability.Action, resource: string) => Effect.Effect<Capability.Capability, GrantStoreError, never>;
