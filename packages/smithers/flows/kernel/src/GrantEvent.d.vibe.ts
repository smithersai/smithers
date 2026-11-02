/**
 * Durable grant decision events.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Journal Queue.md`.
 *
 * @since 1.0.0-rc.0
 */
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability";
import * as Schema from "effect/Schema";
/**
 * The tier at which a capability decision was made.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const GrantTier: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
/**
 * The scope selected for a permission grant.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const GrantScope: Schema.Literals<readonly ["once", "run", "remembered"]>;
declare const OnceGrant_base: Schema.Class<OnceGrant, Schema.TaggedStruct<"@smthrs/kernel/GrantEvent/OnceGrant", {
    readonly eventType: Schema.Literal<"flows.kernel.grant.once.v1">;
    readonly requestId: Schema.String;
    readonly runId: Schema.String;
    readonly planDigest: Schema.optional<Schema.String>;
    readonly capability: typeof Capability;
    readonly pattern: typeof CapabilityPattern;
    readonly scope: Schema.Literal<"once">;
    readonly tier: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
}>, {}>;
/**
 * A one-call grant.
 *
 * It is durable audit evidence but is deliberately never replayed as active
 * authority.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare class OnceGrant extends OnceGrant_base {
}
declare const RememberedGrant_base: Schema.Class<RememberedGrant, Schema.TaggedStruct<"@smthrs/kernel/GrantEvent/RememberedGrant", {
    readonly eventType: Schema.Literal<"flows.kernel.grant.remembered.v1">;
    readonly requestId: Schema.String;
    readonly runId: Schema.String;
    readonly planDigest: Schema.optional<Schema.String>;
    readonly capability: typeof Capability;
    readonly pattern: typeof CapabilityPattern;
    readonly scope: Schema.Literal<"remembered">;
    readonly tier: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
}>, {}>;
/**
 * A grant remembered across runs.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare class RememberedGrant extends RememberedGrant_base {
}
declare const RunGrant_base: Schema.Class<RunGrant, Schema.TaggedStruct<"@smthrs/kernel/GrantEvent/RunGrant", {
    readonly eventType: Schema.Literal<"flows.kernel.grant.run.v2">;
    readonly requestId: Schema.String;
    readonly runId: Schema.String;
    readonly planDigest: Schema.String;
    readonly capability: typeof Capability;
    readonly pattern: typeof CapabilityPattern;
    readonly ceiling: Schema.$Array<Schema.$Array<typeof CapabilityPattern>>;
    readonly scope: Schema.Literal<"run">;
    readonly tier: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
}>, {}>;
/**
 * A grant scoped to the current run.
 *
 * Version 2 captures the requesting fiber's normalized conjunction of any-of
 * capability-pattern groups. Replay intersects it with the constructor ceiling.
 * Version 1 omitted this boundary and cannot safely activate authority.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare class RunGrant extends RunGrant_base {
}
declare const DeniedGrant_base: Schema.Class<DeniedGrant, Schema.TaggedStruct<"@smthrs/kernel/GrantEvent/DeniedGrant", {
    readonly eventType: Schema.Literal<"flows.kernel.grant.denied.v1">;
    readonly requestId: Schema.String;
    readonly runId: Schema.String;
    readonly planDigest: Schema.optional<Schema.String>;
    readonly capability: typeof Capability;
    readonly pattern: typeof CapabilityPattern;
    readonly scope: Schema.Literal<"once">;
    readonly tier: Schema.Literals<readonly ["sealed", "compensable", "irreversible"]>;
}>, {}>;
/**
 * A denied permission request.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare class DeniedGrant extends DeniedGrant_base {
}
declare const EnvelopeGrant_base: Schema.Class<EnvelopeGrant, Schema.TaggedStruct<"@smthrs/kernel/GrantEvent/EnvelopeGrant", {
    readonly eventType: Schema.Literal<"flows.kernel.grant.envelope.v1">;
    readonly runId: Schema.String;
    readonly planDigest: Schema.String;
    readonly patterns: Schema.$Array<typeof CapabilityPattern>;
    readonly scope: Schema.Literals<readonly ["run", "remembered"]>;
}>, {}>;
/**
 * A capability envelope grant.
 *
 * Envelope grants are not attached to an individual request. `planDigest`
 * binds the decision to exactly the plan shown to the approver. A `run`
 * envelope is replayed only for that run and digest; a `remembered` envelope
 * becomes remembered predicate grants for future plans while retaining its
 * origin digest as audit evidence.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare class EnvelopeGrant extends EnvelopeGrant_base {
}
/**
 * All durable grant events understood by the kernel.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export declare const GrantEventSchema: Schema.Union<readonly [typeof OnceGrant, typeof RememberedGrant, typeof DeniedGrant, typeof EnvelopeGrant, typeof RunGrant]>;
/**
 * All durable grant events understood by the kernel.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type GrantEvent = typeof GrantEventSchema.Type;
/**
 * Decodes one JSON-compatible journal payload into a grant event.
 *
 * Excess payload keys are rejected rather than stripped. Grant payloads are
 * replayed as active permission authority, so a payload that mixes fields
 * from two grant variants — for example an envelope carrying request-only
 * fields — is treated as corrupt instead of silently narrowed to whichever
 * variant its declared keys happen to satisfy.
 *
 * @category decoding
 * @since 1.0.0-rc.0
 */
export declare const decode: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Result").Result<DeniedGrant | EnvelopeGrant | OnceGrant | RememberedGrant | RunGrant, Schema.SchemaError>;
/**
 * Encodes a grant event into its JSON-compatible journal payload.
 *
 * @category encoding
 * @since 1.0.0-rc.0
 */
export declare const encode: (input: unknown, options?: import("effect/SchemaAST").ParseOptions) => import("effect/Result").Result<{
    readonly _tag: "@smthrs/kernel/GrantEvent/EnvelopeGrant";
    readonly eventType: "flows.kernel.grant.envelope.v1";
    readonly runId: string;
    readonly planDigest: string;
    readonly patterns: readonly {
        readonly action: "*" | "fs:*" | "fs:read" | "fs:write" | "jj:*" | "jj:diff" | "jj:op-restore" | "jj:restore" | "jj:revert" | "jj:root" | "jj:snapshot" | "jj:status" | "jj:workspace-add" | "jj:workspace-forget" | "memory:*" | "memory:read" | "memory:write" | "model:*" | "model:call" | "net:*" | "net:get" | "net:post" | "net:private" | "proc:*" | "proc:spawn";
        readonly resource: string;
    }[];
    readonly scope: "remembered" | "run";
} | {
    readonly _tag: "@smthrs/kernel/GrantEvent/RunGrant";
    readonly eventType: "flows.kernel.grant.run.v2";
    readonly requestId: string;
    readonly runId: string;
    readonly planDigest: string;
    readonly capability: {
        readonly action: "fs:read" | "fs:write" | "jj:diff" | "jj:op-restore" | "jj:restore" | "jj:revert" | "jj:root" | "jj:snapshot" | "jj:status" | "jj:workspace-add" | "jj:workspace-forget" | "memory:read" | "memory:write" | "model:call" | "net:get" | "net:post" | "net:private" | "proc:spawn";
        readonly resource: string;
    };
    readonly pattern: {
        readonly action: "*" | "fs:*" | "fs:read" | "fs:write" | "jj:*" | "jj:diff" | "jj:op-restore" | "jj:restore" | "jj:revert" | "jj:root" | "jj:snapshot" | "jj:status" | "jj:workspace-add" | "jj:workspace-forget" | "memory:*" | "memory:read" | "memory:write" | "model:*" | "model:call" | "net:*" | "net:get" | "net:post" | "net:private" | "proc:*" | "proc:spawn";
        readonly resource: string;
    };
    readonly ceiling: readonly (readonly {
        readonly action: "*" | "fs:*" | "fs:read" | "fs:write" | "jj:*" | "jj:diff" | "jj:op-restore" | "jj:restore" | "jj:revert" | "jj:root" | "jj:snapshot" | "jj:status" | "jj:workspace-add" | "jj:workspace-forget" | "memory:*" | "memory:read" | "memory:write" | "model:*" | "model:call" | "net:*" | "net:get" | "net:post" | "net:private" | "proc:*" | "proc:spawn";
        readonly resource: string;
    }[])[];
    readonly scope: "run";
    readonly tier: "compensable" | "irreversible" | "sealed";
} | {
    readonly _tag: "@smthrs/kernel/GrantEvent/DeniedGrant";
    readonly eventType: "flows.kernel.grant.denied.v1";
    readonly requestId: string;
    readonly runId: string;
    readonly planDigest?: string | undefined;
    readonly capability: {
        readonly action: "fs:read" | "fs:write" | "jj:diff" | "jj:op-restore" | "jj:restore" | "jj:revert" | "jj:root" | "jj:snapshot" | "jj:status" | "jj:workspace-add" | "jj:workspace-forget" | "memory:read" | "memory:write" | "model:call" | "net:get" | "net:post" | "net:private" | "proc:spawn";
        readonly resource: string;
    };
    readonly pattern: {
        readonly action: "*" | "fs:*" | "fs:read" | "fs:write" | "jj:*" | "jj:diff" | "jj:op-restore" | "jj:restore" | "jj:revert" | "jj:root" | "jj:snapshot" | "jj:status" | "jj:workspace-add" | "jj:workspace-forget" | "memory:*" | "memory:read" | "memory:write" | "model:*" | "model:call" | "net:*" | "net:get" | "net:post" | "net:private" | "proc:*" | "proc:spawn";
        readonly resource: string;
    };
    readonly scope: "once";
    readonly tier: "compensable" | "irreversible" | "sealed";
} | {
    readonly _tag: "@smthrs/kernel/GrantEvent/OnceGrant";
    readonly eventType: "flows.kernel.grant.once.v1";
    readonly requestId: string;
    readonly runId: string;
    readonly planDigest?: string | undefined;
    readonly capability: {
        readonly action: "fs:read" | "fs:write" | "jj:diff" | "jj:op-restore" | "jj:restore" | "jj:revert" | "jj:root" | "jj:snapshot" | "jj:status" | "jj:workspace-add" | "jj:workspace-forget" | "memory:read" | "memory:write" | "model:call" | "net:get" | "net:post" | "net:private" | "proc:spawn";
        readonly resource: string;
    };
    readonly pattern: {
        readonly action: "*" | "fs:*" | "fs:read" | "fs:write" | "jj:*" | "jj:diff" | "jj:op-restore" | "jj:restore" | "jj:revert" | "jj:root" | "jj:snapshot" | "jj:status" | "jj:workspace-add" | "jj:workspace-forget" | "memory:*" | "memory:read" | "memory:write" | "model:*" | "model:call" | "net:*" | "net:get" | "net:post" | "net:private" | "proc:*" | "proc:spawn";
        readonly resource: string;
    };
    readonly scope: "once";
    readonly tier: "compensable" | "irreversible" | "sealed";
} | {
    readonly _tag: "@smthrs/kernel/GrantEvent/RememberedGrant";
    readonly eventType: "flows.kernel.grant.remembered.v1";
    readonly requestId: string;
    readonly runId: string;
    readonly planDigest?: string | undefined;
    readonly capability: {
        readonly action: "fs:read" | "fs:write" | "jj:diff" | "jj:op-restore" | "jj:restore" | "jj:revert" | "jj:root" | "jj:snapshot" | "jj:status" | "jj:workspace-add" | "jj:workspace-forget" | "memory:read" | "memory:write" | "model:call" | "net:get" | "net:post" | "net:private" | "proc:spawn";
        readonly resource: string;
    };
    readonly pattern: {
        readonly action: "*" | "fs:*" | "fs:read" | "fs:write" | "jj:*" | "jj:diff" | "jj:op-restore" | "jj:restore" | "jj:revert" | "jj:root" | "jj:snapshot" | "jj:status" | "jj:workspace-add" | "jj:workspace-forget" | "memory:*" | "memory:read" | "memory:write" | "model:*" | "model:call" | "net:*" | "net:get" | "net:post" | "net:private" | "proc:*" | "proc:spawn";
        readonly resource: string;
    };
    readonly scope: "remembered";
    readonly tier: "compensable" | "irreversible" | "sealed";
}, Schema.SchemaError>;
export {};
