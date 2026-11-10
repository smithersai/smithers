// Stays .ts: Vite and Vitest load their config through Vite's config loader, which bundles JS/TS files only.
/** workerd's bundler hands the agent's QuickJS a compiled module for this specifier; Node compiles the same file. */
export const quickjsModule = {
  name: "vibelang-quickjs-module",
  enforce: "pre" as const,
  resolveId: (id: string) => id === "#quickjs.wasm" ? "\0vibelang-quickjs-module" : undefined,
  load: (id: string) => id !== "\0vibelang-quickjs-module" ? undefined : `
    import { readFile } from "node:fs/promises"
    import { createRequire } from "node:module"
    const path = createRequire(${JSON.stringify(new URL("../../packages/smithers/agent/harness/package.json", import.meta.url).pathname)}).resolve("@jitl/quickjs-wasmfile-release-sync/wasm")
    export default await WebAssembly.compile(await readFile(path))
  `,
}
