import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { SHARED_BACKEND_CLIENT_ROUTES } from "../src/AgentApiRoutes"

describe("shared backend client route contract", () => {
  test("every client-called route is mounted by the Go composition root", () => {
    const router = readFileSync(join(import.meta.dirname, "../../backend/internal/compose/router.go"), "utf8")
    for (const route of SHARED_BACKEND_CLIENT_ROUTES) {
      const path = route.path.replace(/^\/api\//, "")
      const mounted = router.includes(`r.${route.method === "GET" ? "Get" : "Post"}(\"${route.path}\"`) ||
        router.includes(`${route.method === "GET" ? "Get" : "Post"}(\"/${path}\"`)
      expect(mounted, `${route.method} ${route.path} is not mounted in packages/backend/internal/compose/router.go`).toBe(true)
    }
  })
})
