import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import vibelang from "vibelang-vite"
import { defineConfig } from "vitest/config"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

/**
 * Discovers workspace packages and maps their root & subpath exports directly
 * to source files so repo-wide fuzz suites can import any workspace package
 * without lockfile churn and with direct V8 coverage on `src/`.
 */
function workspaceAliases(): Array<{ readonly find: string | RegExp; readonly replacement: string }> {
  const roots = [
    "packages",
    "packages/smithers",
    "packages/smithers/agent",
    "packages/smithers/build",
    "packages/smithers/flows",
    "packages/smithers/ui"
  ]
  const exact: Array<{ readonly find: string; readonly replacement: string }> = []
  const seen = new Set<string>()

  const registerPkg = (pkgDir: string) => {
    const pkgPath = join(pkgDir, "package.json")
    if (!existsSync(pkgPath)) return
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      readonly name?: string
      readonly exports?: Record<string, unknown>
    }
    if (!pkg.name || !pkg.exports) return
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      if (target === null || subpath.includes("*")) continue
      const rel = typeof target === "string"
        ? target
        : typeof target === "object" && target !== null
        ? ((target as Record<string, unknown>).import ?? (target as Record<string, unknown>).default)
        : undefined
      if (typeof rel !== "string" || (!rel.endsWith(".ts") && !rel.endsWith(".vibe") && !rel.endsWith(".tsx"))) continue
      const key = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`
      if (seen.has(key)) continue
      seen.add(key)
      exact.push({ find: key, replacement: resolve(pkgDir, rel) })
    }
  }

  for (const parent of roots) {
    const abs = join(root, parent)
    if (!existsSync(abs)) continue
    registerPkg(abs)
    for (const entry of readdirSync(abs)) {
      const child = join(abs, entry)
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue
      if (statSync(child).isDirectory()) registerPkg(child)
    }
  }

  // Sort longest keys first so subpaths (e.g. @smthrs/testing/Vitest) win over roots (@smthrs/testing).
  exact.sort((a, b) => b.find.length - a.find.length)
  return exact.map(({ find, replacement }) => ({
    find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    replacement
  }))
}

export default defineConfig({
  plugins: [vibelang()],
  resolve: {
    alias: workspaceAliases()
  },
  test: {
    fsModuleCache: true,
    include: ["../../fuzz/**/*.fuzz.test.{ts,vibe}"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 60_000,
    maxWorkers: Number(process.env.FUZZ_WORKERS ?? 4),
    coverage: {
      provider: "v8",
      reportsDirectory: "../../coverage/repo-fuzz",
      include: [
        "packages/smithers/flows/*/src/**/*.{ts,vibe}",
        "packages/smithers/agent/*/src/**/*.{ts,vibe}",
        "packages/smithers/ui/*/src/**/*.{ts,vibe}",
        "packages/smithers/notifications/src/**/*.{ts,vibe}",
        "packages/ci/src/**/*.{ts,vibe}",
        "packages/effect-*/src/**/*.{ts,vibe}",
        "packages/errors/src/**/*.{ts,vibe}",
        "packages/rpc/src/**/*.{ts,vibe}"
      ],
      reporter: ["text", "json-summary"]
    }
  }
})
