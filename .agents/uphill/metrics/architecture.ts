import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const out = process.env.UPHILL_METRICS
if (!out) {
  console.error("UPHILL_METRICS not set")
  process.exit(1)
}
const lines: string[] = []
const root = process.cwd()

function walk(dir: string, exts: string[], files: string[] = []): string[] {
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, exts, files)
    else if (exts.some((ext) => entry.endsWith(ext)) && !entry.includes(".test.") && !entry.includes(".spec.")) {
      files.push(full)
    }
  }
  return files
}

const dirs = ["apps/mvp/src", "apps/mvp/plugins", "apps/mvp/worker", "packages/rpc/src"]
const todoRe = /\b(?:TODO|FIXME|HACK)\b/g

for (const dir of dirs) {
  const files = walk(join(root, dir), [".ts", ".tsx", ".vibe"])
  let oversized = 0
  let todos = 0
  for (const file of files) {
    const content = readFileSync(file, "utf8")
    const lineCount = content.split("\n").length
    if (lineCount > 600) oversized++
    todos += content.match(todoRe)?.length ?? 0
  }
  lines.push(`oversized-files ${dir} ${oversized}`)
  lines.push(`todo-markers ${dir} ${todos}`)
}

// Plugin manifest registry integrity check
const pluginsDir = join(root, "apps/mvp/plugins")
const manifestsSrc = existsSync(join(root, "apps/mvp/src/plugins/manifests.ts"))
  ? readFileSync(join(root, "apps/mvp/src/plugins/manifests.ts"), "utf8")
  : ""

if (existsSync(pluginsDir)) {
  for (const entry of readdirSync(pluginsDir).sort()) {
    const manifestPath = join(pluginsDir, entry, "plugin.json")
    if (!existsSync(manifestPath)) continue
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"))
      const validApi = parsed.apiVersion === 1 && typeof parsed.id === "string"
      const isUi = entry !== "branches"
      const registered = !isUi || manifestsSrc.includes(`plugins/${entry}/plugin.json`)
      if (validApi && registered) {
        lines.push(`plugin-boundary ${entry} pass`)
      } else {
        lines.push(`plugin-boundary ${entry} fail note "invalid apiVersion or missing from manifests.ts"`)
      }
    } catch {
      lines.push(`plugin-boundary ${entry} fail note "invalid JSON"`)
    }
  }
}

appendFileSync(out, lines.join("\n") + "\n")
