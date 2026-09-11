import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTutorialRepository } from "./tutorialRepository"
test("Skip initializes main, no remote, collision suffix, and never overwrites", async () => {
  const home = await mkdtemp(join(tmpdir(), "tutorial2-repository-"))
  try {
    const a = await createTutorialRepository("smithers-playground", home)
    const config = await readFile(join(a.path, ".git/config"), "utf8")
    const b = await createTutorialRepository("smithers-playground", home)
    expect(a.path).toBe(join(home, "Smithers/repositories/smithers-playground"))
    expect(b.name).toBe("smithers-playground-1")
    expect(await readFile(join(a.path, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n")
    expect(config).not.toContain("remote")
    expect(await readFile(join(a.path, ".git/config"), "utf8")).toBe(config)
    await expect(createTutorialRepository("../escape", home)).rejects.toThrow()
  } finally { await rm(home, { recursive: true, force: true }) }
})

test("the route returns a one-use adoption grant for an empty Git repository", async () => {
  const { Router } = await import("../routes")
  const { createRepositoryAuthority } = await import("../RepositoryAuthority")
  const { registerTutorialRepositoryRoutes } = await import("./tutorialRepository")
  const home = await mkdtemp(join(tmpdir(), "tutorial2-repository-route-"))
  try {
    const router = new Router(), authority = createRepositoryAuthority()
    registerTutorialRepositoryRoutes(router, authority, home)
    const request = new Request("http://localhost/api/repo/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "smithers-playground" }) })
    const route = router.match("POST", "/api/repo/create")!
    const response = await route.handler({ request, url: new URL(request.url), params: route.params })
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.repository.head).toBeNull()
    expect(result.repository.remoteUrl).toBeNull()
    expect(authority.claim(result.repository.authorizationId)).toEqual({ path: result.repository.root, access: "read-write" })
    expect(authority.claim(result.repository.authorizationId)).toBeUndefined()
  } finally { await rm(home, { recursive: true, force: true }) }
})
