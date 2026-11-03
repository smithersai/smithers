/**
 * Private flow construction shared by declarations and action registration.
 *
 * @since 1.0.0
 * @private
 */
import * as Node from "@smthrs/plan/Node";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import type * as RetryPolicy from "../RetryPolicy.vibe";
import type { Any, AnyStructSchema, BodySuccess, DeclarationMetadata, Flow } from "./Flow.vibe";
/**
 * Builds the private prototype from normalized declaration data.
 *
 * @since 1.0.0
 * @private
 */
export declare const makeProto: <const Tag extends string, Payload extends AnyStructSchema, Success extends Schema.Top, Error extends Schema.Top, Requires>(options: DeclarationMetadata & {
    readonly _tag: Tag;
    readonly description?: string | undefined;
    readonly payloadSchema: Payload;
    readonly successSchema: Success;
    readonly errorSchema: Error;
    readonly annotations: Context.Context<never>;
    readonly body: (payload: Payload["Type"]) => Node.Node<BodySuccess<Success["Type"]>, Error["Type"], Requires>;
    readonly prompt?: ((payload: Payload["Type"]) => string) | undefined;
    readonly action?: Any["action"] | undefined;
    readonly idempotencyKey?: ((payload: Payload["Type"]) => string) | undefined;
    readonly suspendedRetryPolicy?: RetryPolicy.RetryPolicy | undefined;
    readonly maxRounds?: number | undefined;
    readonly deadline?: Duration.Duration | undefined;
}) => Flow<Tag, Payload, Success, Error, Requires>;
