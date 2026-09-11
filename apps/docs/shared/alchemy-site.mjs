// @ts-check
/** Alchemy 2 stack factory shared by every package documentation site. */
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * List Alchemy 1 state files under `<dir>/.alchemy` that embed a process
 * environment. Alchemy 1's `os::Exec` build resource copied the deploying
 * shell's whole environment into `props.env` and `output.env`. Reports file
 * paths and variable counts only, never names or values.
 *
 * @param {string} dir
 * @returns {Array<{ readonly file: string, readonly variables: number }>}
 */
export function findLegacyEnvState(dir) {
  const root = join(dir, ".alchemy")
  /** @type {Array<{ file: string, variables: number }>} */
  const found = []
  /** @param {string} at */
  const walk = (at) => {
    let entries
    try {
      entries = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        let state
        try {
          state = JSON.parse(readFileSync(path, "utf8"))
        } catch {
          continue
        }
        const names = new Set()
        for (const env of [state?.props?.env, state?.output?.env]) {
          if (env && typeof env === "object") for (const name of Object.keys(env)) names.add(name)
        }
        if (names.size > 0) found.push({ file: relative(dir, path), variables: names.size })
      }
    }
  }
  walk(root)
  return found
}

/**
 * Declare a static site without running its stack or contacting Cloudflare.
 *
 * Physical names from Alchemy 1 cannot be derived from Alchemy 2's naming
 * scheme. Requiring the existing Worker name preserves deployed resources.
 * For a new site, choose a unique name explicitly. Alchemy refuses a custom
 * hostname belonging to another Worker; hostname transfers are not automatic.
 *
 * Refuses to declare the stack while `<dir>/.alchemy` still holds Alchemy 1
 * state that embeds a shell environment; see apps/docs/README.md.
 *
 * @param {{ readonly slug: string, readonly dir?: string }} options
 */
export function makeDocsSiteStack({ slug, dir = process.cwd() }) {
  const legacy = findLegacyEnvState(dir)
  if (legacy.length > 0) {
    const files = legacy.map(({ file, variables }) => `${file} (${variables} variables)`).join(", ")
    throw new Error(`Alchemy 1 state embeds the deploying shell environment: ${files}. Delete it or strip props.env and output.env, then rotate those credentials; see apps/docs/README.md`)
  }
  const prefix = slug.toUpperCase().replace(/-/g, "_")
  const domain = process.env[`${prefix}_SITE_DOMAIN`]?.trim() || `${slug}.smithers.sh`
  const name = process.env[`${prefix}_WORKER_NAME`]?.trim()
  if (!name) {
    throw new Error(`Set ${prefix}_WORKER_NAME to the existing Worker name (or a unique name for a new site); see apps/docs/README.md`)
  }
  const zoneId = process.env.CLOUDFLARE_SMITHERS_ZONE_ID?.trim() || undefined

  return Alchemy.Stack(
    `smithers-docs-${slug}`,
    { providers: Cloudflare.providers(), state: Alchemy.localState() },
    Cloudflare.Website.StaticSite(`smithers-docs-${slug}`, {
      name,
      command: "pnpm run build",
      outdir: "dist",
      assets: { notFoundHandling: "404-page" },
      workersDev: false,
      domain: { name: domain, ...(zoneId ? { zoneId } : {}) }
    })
  )
}
