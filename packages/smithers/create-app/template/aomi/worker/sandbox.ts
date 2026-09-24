/**
 * The QuickJS build a Worker turn runs its cells on.
 *
 * workerd instantiates only WebAssembly its toolchain compiled, so the `.wasm`
 * export is imported as a module (the `CompiledWasm` rule in `wrangler.jsonc`)
 * and handed to the sandbox as a variant. This is the only file that imports
 * it; a Node test passes `QuickJSSandbox.layerVariantLive` instead.
 */
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import { newVariant, type QuickJSSyncVariant } from "quickjs-emscripten-core"

// The package's one `types` entry names its CommonJS declaration; workerd
// resolves the ESM glue and hands over the variant itself.
export const sandboxVariant = QuickJSSandbox.layerVariant(
  newVariant(wasmfile as unknown as QuickJSSyncVariant, { wasmModule })
)
