/**
 * Engine-private Jujutsu authority.
 *
 * Action bodies resolve the public `Jj` tag from their guarded host context.
 * Snapshot, restore, and diff bookkeeping resolve this distinct tag instead,
 * so an engine operation never grants the same authority to user code.
 *
 * @since 1.0.0
 */
import { Jj } from "@smthrs/kernel";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
declare const EngineJj_base: Context.ServiceClass<EngineJj, "@smthrs/engine-store/internal/EngineJj", Jj.Jj>;
/**
 * Engine-owned repository operations, absent from public action context.
 *
 * @since 1.0.0
 * @category services
 */
export declare class EngineJj extends EngineJj_base {
}
/**
 * Captures the current public Jj implementation under the private engine tag.
 *
 * @since 1.0.0
 * @category layers
 */
export declare const layerFromJj: Layer.Layer<EngineJj, never, Jj.Jj>;
export {};
