/**
 * The QuickJS build a host names, and its compiled WebAssembly module.
 *
 * Every QuickJS realm in Smithers compiles one build: the cell sandbox
 * (`QuickJSSandbox`) and the generated-view presentation realm
 * (`@smthrs/views`). A host provides the build once, through {@link Variant},
 * and both compile it at most once.
 *
 * Node and a browser provide the single-file build, which compiles from the
 * bytes it carries (`QuickJSSandbox.layerVariantLive`, or
 * {@link layerVariant} over `@jitl/quickjs-singlefile-browser-release-sync`).
 * Cloudflare's workerd refuses to compile WebAssembly from bytes, so a Worker
 * provides {@link layerVariant} over `newVariant(base, { wasmModule })` with a
 * module its toolchain compiled.
 *
 * This module carries no build itself, so importing it costs nothing.
 *
 * @since 1.0.0-rc.16
 */
import { Context, Effect, Layer } from "effect";
import type { QuickJSSyncVariant, QuickJSWASMModule } from "quickjs-emscripten-core";
import * as Sandbox from "./Sandbox.js";
/**
 * Caches only a successful asynchronous load; a rejection may be retried.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const cacheSuccessful: <A>(load: () => Promise<A>) => () => Promise<A>;
/**
 * The QuickJS build a realm compiles.
 *
 * @category models
 * @since 0.1.0
 */
export interface VariantService {
    readonly variant: QuickJSSyncVariant;
}
declare const Variant_base: Context.ServiceClass<Variant, "@smthrs/harness/QuickJSSandbox/Variant", VariantService>;
/**
 * The QuickJS build a realm compiles.
 *
 * @category services
 * @since 0.1.0
 */
export declare class Variant extends Variant_base {
}
/**
 * Provides a build the host names.
 *
 * A workerd host builds one with `newVariant(baseVariant, { wasmModule })` from
 * a `.wasm` module import, because that runtime instantiates a module the
 * toolchain compiled and refuses to compile one from bytes.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerVariant: (variant: QuickJSSyncVariant) => Layer.Layer<Variant>;
/**
 * Loads a QuickJS module through the sandbox's typed failure boundary.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const loadModule: (loader: () => Promise<QuickJSWASMModule>) => Effect.Effect<QuickJSWASMModule, Sandbox.SandboxError>;
/**
 * The module for the build the host names, compiled on first use and shared
 * by every realm over the same variant. A failed compile is retried on the
 * next use.
 *
 * @category constructors
 * @since 1.0.0-rc.16
 */
export declare const compiledModule: Effect.Effect<QuickJSWASMModule, Sandbox.SandboxError, Variant>;
export {};
