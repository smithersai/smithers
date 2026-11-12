/**
 * What a Cloudflare bundler hands a Worker for `#quickjs.wasm`: the QuickJS
 * build's `.wasm` file, uploaded as a CompiledWasm module, as its compiled
 * `WebAssembly.Module`. The package's own types can't say so: the shape
 * depends on the bundler, not the package.
 *
 * The package's `imports` field maps `#quickjs.wasm` to the build's `.wasm`
 * and its types to this file, so every program that compiles this package's
 * source, a workspace app included, sees them without declaring the module
 * itself.
 *
 * @since 0.1.0
 */

declare const wasmModule: WebAssembly.Module
export default wasmModule
