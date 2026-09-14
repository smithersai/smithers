import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { json, jsonError, readJson, type Router } from "../routes"
import type { RepositoryAuthority } from "../RepositoryAuthority"

/** mkdir is the collision lock: never inspect and then overwrite an existing directory. */
export async function createTutorialRepository(name: string, home = homedir()) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error("Use a repository name with letters, numbers, hyphens or underscores.")
  const parent = join(home, "Smithers", "repositories")
  await mkdir(parent, { recursive: true })
  for (let suffix = 0; suffix < 10_000; suffix++) {
    const actualName = suffix === 0 ? name : `${name}-${suffix}`
    const path = join(parent, actualName)
    try { await mkdir(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
      throw error
    }
    const child = Bun.spawn(["git", "init", "--initial-branch=main", path], { stdout: "pipe", stderr: "pipe" })
    const stderr = await new Response(child.stderr).text()
    if (await child.exited !== 0) throw new Error(`Could not initialize ${path}: ${stderr}`)
    return { name: actualName, path }
  }
  throw new Error("No unused repository name is available.")
}

/** Mount only on the authenticated local host, behind its normal CSRF gate. */
export function registerTutorialRepositoryRoutes(router: Router, authority: RepositoryAuthority, home?: string) {
  router.add("POST", "/api/repo/create", async ({ request }) => {
    const parsed = await readJson(request, 4096)
    if ("error" in parsed) return parsed.error
    const input = z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/) }).strict().safeParse(parsed.body)
    if (!input.success) return jsonError("invalid_name", "Choose a repository name with letters, numbers, hyphens or underscores.")
    try {
      const created = await createTutorialRepository(input.data.name, home)
      const grant = await authority.authorize(created.path, "read-write")
      if (grant.status !== "connected") return jsonError("repository_authorization_failed", `Created ${created.name} at ${created.path}, but could not open it.`)
      return json(grant)
    } catch (error) {
      return jsonError("repository_creation_failed", error instanceof Error ? error.message : "Could not create the repository.")
    }
  })
}
