/**
 * The exact capability value.
 *
 * The class is named `Capability`, and `Capability.ts` is the module barrel
 * that re-exports it, so the definition lives here to keep the barrel free of
 * a runtime cycle with the constructors and parsers that instantiate it.
 *
 * @since 0.1.0
 */
import { type Brand, Schema } from "effect";
declare const Capability_base: Schema.Class<Capability, Schema.Struct<{
    readonly action: Schema.Literals<readonly ["fs:read", "fs:write", "net:get", "net:post", "net:private", "model:call", "memory:read", "memory:write", "proc:spawn", "jj:status", "jj:diff", "jj:snapshot", "jj:restore", "jj:workspace-add", "jj:workspace-forget", "jj:root", "jj:revert", "jj:op-restore"]>;
    readonly resource: Schema.String;
}>, Brand.Brand<"@smthrs/capability/Capability">>;
/**
 * An exact adapter request subject to authorization.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export declare class Capability extends Capability_base {
}
export {};
