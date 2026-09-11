import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRepositoryAuthority } from "./RepositoryAuthority"

describe("repository authority", () => {
  test("mints a one-shot expiring capability for a repository selected by the host", async () => {
    const repo = await mkdtemp(join(tmpdir(), "smithers-authority-"))
    let at = 10
    try {
      const init = Bun.spawn(["git", "init", "-q", repo])
      expect(await init.exited).toBe(0)
      const authority = createRepositoryAuthority({ now: () => at, ttlMs: 50 })
      const selected = await authority.authorize(repo, "read-write")
      expect(selected.status).toBe("connected")
      if (selected.status !== "connected") return
      expect(selected.repository.authorizationId).not.toContain(repo)
      expect(authority.claim(selected.repository.authorizationId)).toEqual({ path: await realpath(repo), access: "read-write" })
      expect(authority.claim(selected.repository.authorizationId)).toBeUndefined()

      const expired = await authority.authorize(repo, "read")
      if (expired.status !== "connected") throw new Error("repository was not authorized")
      at += 51
      expect(authority.claim(expired.repository.authorizationId)).toBeUndefined()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
