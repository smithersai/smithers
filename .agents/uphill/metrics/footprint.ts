import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const out = process.env.UPHILL_METRICS
if (!out) {
  console.error("UPHILL_METRICS not set")
  process.exit(1)
}
const lines: string[] = []
const root = process.cwd()

function dirBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) total += dirBytes(full)
    else if (!entry.includes(".test.") && !entry.includes(".spec.")) total += st.size
  }
  return total
}

const surfaces = [
  ["apps/mvp/src", "apps/mvp/src"],
  ["apps/mvp/plugins", "apps/mvp/plugins"],
  ["apps/mvp/worker", "apps/mvp/worker"],
  ["packages/rpc/src", "packages/rpc/src"],
  ["packages/smithers/ui/src", "packages/smithers/ui/src"],
] as const

for (const [label, rel] of surfaces) {
  lines.push(`source-surface ${label} ${dirBytes(join(root, rel))}B`)
}

appendFileSync(out, lines.join("\n") + "\n")
