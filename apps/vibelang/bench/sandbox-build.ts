// Stays .ts: Alchemy's deferred rolldown plugin protocol. Only the vl-test probe uses this build.
// The Worker evaluates its own props, so the build-time compiler must be imported only when rolldown awaits it.
import type { deferred } from "vibelang-unplugin/deferred"
const specifier = new URL("./sandbox-coverage-plugin.ts", import.meta.url).href
let loaded: Promise<ReturnType<typeof import("./sandbox-coverage-plugin.ts").default>> | undefined
const load = () => loaded ??= import(/* @vite-ignore */ specifier).then((module) => module.default() as ReturnType<typeof import("./sandbox-coverage-plugin.ts").default>)
const plugin: ReturnType<typeof deferred> = {
  then: (accept, reject) => load().then(accept, reject),
  catch: (reject) => load().catch(reject),
  finally: (settle) => load().finally(settle),
  [Symbol.toStringTag]: "Promise",
}
export const sandboxBenchmarkBuild = {
  input: { plugins: [Object.assign(plugin, { "~alchemy/DeferredPlugin": specifier })] },
  output: { minify: false },
}
