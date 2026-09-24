/**
 * The Worker entry. workerd runs only WebAssembly its toolchain compiled, so
 * the QuickJS module is imported here as a module and handed to the sandbox.
 * The routes live in `handle.ts`.
 */
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import wasmModule from "@jitl/quickjs-wasmfile-release-sync/wasm"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import { newVariant, type QuickJSSyncVariant } from "quickjs-emscripten-core"
import { type Env, handle } from "./handle.ts"

// The package's one `types` entry names its CommonJS declaration; workerd
// resolves the ESM glue and hands over the variant itself.
const sandboxVariant = QuickJSSandbox.layerVariant(
  newVariant(wasmfile as unknown as QuickJSSyncVariant, { wasmModule })
)

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handle(request, env, sandboxVariant)
}
