import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Project flows must use the compiled host's Effect instance. In particular,
 * Schema's private missing-value symbol cannot cross two copies of Effect:
 * encoding a foreign String schema otherwise silently drops its return value.
 * Generate from the installed package's public exports, including subpaths,
 * so the bridge follows the pinned dependency without a second API inventory.
 */
export const compiledEffectRuntime = (require) => {
  const root = dirname(require.resolve("effect/package.json"))
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const modules = []
  for (const file of readdirSync(join(root, "dist"), { recursive: true }).sort()) {
    if (!file.endsWith(".js")) continue
    const key = file === "index.js" ? "effect"
      : file.endsWith("/index.js") ? `effect/${file.slice(0, -9)}`
      : `effect/${file.slice(0, -3)}`
    try {
      modules.push({ path: require.resolve(key), key: file.slice(0, -3) })
    } catch {
      // The package export map excludes private implementation files.
    }
  }
  return `import { readFileSync } from "node:fs"
${modules.map((module, index) => `import * as m${index} from ${JSON.stringify(module.path)}`).join("\n")}
const modules = new Map([${modules.map((module, index) => `[${JSON.stringify(module.key)}, m${index}]`).join(",")}])
const checked = new Set()
Bun.plugin({
  name: "smithers-shared-effect",
  setup(build) {
    // Bun's transpiler cache can bypass bare-specifier resolution hooks. Load
    // the resolved module itself so cached and uncached imports share identity.
    build.onLoad({ filter: /\\/effect\\/dist\\/.*\\.js$/ }, ({ path }) => {
      const match = /^(.*\\/effect)\\/dist\\/(.*)\\.js$/.exec(path)
      if (match === null) return
      const root = match[1]
      if (!checked.has(root)) {
        const actual = JSON.parse(readFileSync(root + "/package.json", "utf8")).version
        if (actual !== ${JSON.stringify(version)}) {
          throw new Error("This Smithers TUI requires effect@${version}; the project resolves effect@" + actual)
        }
        checked.add(root)
      }
      const exports = modules.get(match[2])
      if (exports === undefined) throw new Error("Unsupported private Effect import: " + match[2])
      return { loader: "object", exports }
    })
  }
})
`
}
