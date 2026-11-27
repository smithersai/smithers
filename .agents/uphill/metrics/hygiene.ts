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
    if (entry === "node_modules" || entry === "dist" || entry === ".uphill" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, exts, files)
    else if (exts.some((ext) => entry.endsWith(ext)) && !entry.includes(".test.") && !entry.includes(".spec.")) {
      files.push(full)
    }
  }
  return files
}

const tsExts = [".ts", ".tsx", ".vibe"]
const coreDirs = [
  "apps/mvp/src",
  "apps/mvp/plugins",
  "apps/mvp/worker",
  "packages/rpc/src",
  "packages/smithers/ui/src",
]

const anyRe = /\b(?::\s*any\b|\bas\s+any\b)/g
const suppressRe = /@ts-(?:ignore|expect-error|nocheck)\b/g
const reactLeakRe = /\b(?:useState|useEffect)\s*\(/g
const modelStreamRe = /\bModel\.stream\s*\(/g

let anyTotal = 0
let suppressTotal = 0
let reactLeakTotal = 0
let modelStreamTotal = 0

for (const dir of coreDirs) {
  const files = walk(join(root, dir), tsExts)
  let dirAny = 0
  let dirSuppress = 0
  for (const file of files) {
    const content = readFileSync(file, "utf8")
    const rel = relative(root, file)
    const anyMatches = content.match(anyRe)?.length ?? 0
    const supMatches = content.match(suppressRe)?.length ?? 0
    dirAny += anyMatches
    dirSuppress += supMatches
    if (file.endsWith(".tsx") && (dir === "apps/mvp/src" || dir === "apps/mvp/plugins")) {
      const leaks = content.match(reactLeakRe)?.length ?? 0
      if (leaks > 0) {
        reactLeakTotal += leaks
        lines.push(`react-state-leaks ${rel} fail note "${leaks} useState/useEffect call(s)"`)
      }
    }
    if (dir === "apps/mvp/src" || dir === "apps/mvp/worker") {
      const streams = content.match(modelStreamRe)?.length ?? 0
      if (streams > 0) {
        modelStreamTotal += streams
        lines.push(`direct-model-stream ${rel} fail note "${streams} direct Model.stream() call(s)"`)
      }
    }
  }
  anyTotal += dirAny
  suppressTotal += dirSuppress
  lines.push(`explicit-any ${dir} ${dirAny}`)
  lines.push(`ts-suppressions ${dir} ${dirSuppress}`)
}

if (reactLeakTotal === 0) lines.push(`react-state-leaks apps/mvp pass`)
if (modelStreamTotal === 0) lines.push(`direct-model-stream apps/mvp pass`)

appendFileSync(out, lines.join("\n") + "\n")
