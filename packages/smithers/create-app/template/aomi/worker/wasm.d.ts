/**
 * What the Cloudflare toolchain hands a worker for the QuickJS `.wasm` import:
 * the compiled `WebAssembly.Module`, as the default export. `wrangler.jsonc`
 * has the rule that makes it do so.
 */
declare module "@jitl/quickjs-wasmfile-release-sync/wasm" {
  const wasmModule: WebAssembly.Module
  export default wasmModule
}
