/**
 * Action selectors a capability pattern may name: every exact action plus the
 * namespace and whole-authority wildcards.
 *
 * @since 0.1.0
 */
import { Schema } from "effect";
/**
 * Schema for action selectors accepted in capability patterns.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export declare const PatternAction: Schema.Literals<readonly ["fs:read", "fs:write", "net:get", "net:post", "net:private", "model:call", "memory:read", "memory:write", "proc:spawn", "jj:status", "jj:diff", "jj:snapshot", "jj:restore", "jj:workspace-add", "jj:workspace-forget", "jj:root", "jj:revert", "jj:op-restore", "fs:*", "net:*", "model:*", "memory:*", "proc:*", "jj:*", "*"]>;
/**
 * An action selector accepted in a capability pattern.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type PatternAction = typeof PatternAction.Type;
