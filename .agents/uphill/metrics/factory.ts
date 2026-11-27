import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const out = process.env.UPHILL_METRICS
if (!out) {
  console.error("UPHILL_METRICS not set")
  process.exit(1)
}

const root = process.cwd()
const lines: string[] = []

const checkFile = (metric: string, name: string, rel: string) => {
  if (existsSync(join(root, rel))) lines.push(`${metric} ${name} pass`)
  else lines.push(`${metric} ${name} fail note "missing ${rel}"`)
}

// 1. Shared Smithers Cloud object store & trust boundaries
checkFile("cloud-trust-surface", "execution-trust", "apps/mvp/worker/trust/ExecutionTrust.vibe")
checkFile("cloud-trust-surface", "cloud-object-store", "apps/mvp/worker/object-store/CloudObjectStore.vibe")
checkFile("cloud-trust-surface", "one-time-auth", "apps/mvp/worker/mcp/OneTimeAuth.vibe")
checkFile("cloud-trust-surface", "cloud-factory-mcp", "apps/mvp/worker/mcp/CloudFactoryTools.vibe")
checkFile("cloud-trust-surface", "post-merge-planner", "apps/mvp/worker/ci/PostMerge.vibe")

// 2. Post-merge automation workflows
for (const wf of ["backpressure-audit", "docs-publish", "release", "wiki-refresh", "mythical-fold"]) {
  const hasTs = existsSync(join(root, `.smithers/workflows/${wf}.ts`))
  const hasVibe = existsSync(join(root, `.smithers/workflows/${wf}.vibe`))
  if (hasTs || hasVibe) lines.push(`post-merge-workflows ${wf} pass`)
  else lines.push(`post-merge-workflows ${wf} fail note "missing .smithers/workflows/${wf}.{ts,vibe}"`)
}

// 3. Personalized 3-audience home (maintainer, contributor, everyone/viewer)
const homePath = join(root, ".smithers/home.json")
if (existsSync(homePath)) {
  try {
    const parsed = JSON.parse(readFileSync(homePath, "utf8"))
    const audiences = new Set((parsed.sections ?? []).map((s: { audience?: string }) => s.audience))
    for (const audience of ["maintainer", "contributor", "everyone"]) {
      if (audiences.has(audience)) lines.push(`personalized-audiences ${audience} pass`)
      else lines.push(`personalized-audiences ${audience} fail note "missing ${audience} section in .smithers/home.json"`)
    }
  } catch {
    lines.push(`personalized-audiences home-json fail note "invalid JSON in .smithers/home.json"`)
  }
} else {
  lines.push(`personalized-audiences home-json fail note "missing .smithers/home.json"`)
}

// 4. Project wiki and mythical history plugin
const wikiDir = join(root, ".smithers/wiki/pages")
const wikiCount = existsSync(wikiDir) ? readdirSync(wikiDir).filter((f) => f.endsWith(".md")).length : 0
if (wikiCount >= 5) lines.push(`knowledge-surfaces wiki-pages pass`)
else lines.push(`knowledge-surfaces wiki-pages fail note "only ${wikiCount} wiki pages"`)
checkFile("knowledge-surfaces", "mythical-plugin", "apps/mvp/plugins/mythical/plugin.json")

appendFileSync(out, lines.join("\n") + "\n")
