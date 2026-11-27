import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const out = process.env.UPHILL_METRICS
if (!out) {
  console.error("UPHILL_METRICS not set")
  process.exit(1)
}
const lines: string[] = []
const root = process.cwd()

const requiredDocs = [
  "AGENTS.md",
  "docs/libraries.md",
  "apps/mvp/AGENTS.md",
  "apps/mvp/docs/features/plugins.md",
  "apps/mvp/docs/features/ci.md",
  "apps/mvp/docs/features/uphill.md",
]

for (const doc of requiredDocs) {
  const full = join(root, doc)
  if (existsSync(full) && readFileSync(full, "utf8").trim().length > 100) {
    lines.push(`core-docs ${doc} pass`)
  } else {
    lines.push(`core-docs ${doc} fail note "missing or empty"`)
  }
}

const featuresDir = join(root, "apps/mvp/docs/features")
const linkRe = /\[[^\]]+\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g
let broken = 0
if (existsSync(featuresDir)) {
  for (const file of readdirSync(featuresDir).filter((f) => f.endsWith(".md")).sort()) {
    const full = join(featuresDir, file)
    const content = readFileSync(full, "utf8")
    let fileBroken = 0
    for (const match of content.matchAll(linkRe)) {
      const target = match[1]!
      if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:") || target.startsWith("/")) continue
      const resolved = resolve(dirname(full), target)
      if (!existsSync(resolved)) fileBroken++
    }
    broken += fileBroken
  }
}
lines.push(`broken-doc-links ${broken}`)

appendFileSync(out, lines.join("\n") + "\n")
