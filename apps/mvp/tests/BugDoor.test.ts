import { isRedirect } from "@tanstack/react-router"
import { expect, test } from "vitest"
import { router } from "../src/router"

test("client navigation through /bug redirects to the in-app form", () => {
  const route = router.routesById["/bug"]
  expect(route).toBeDefined()
  try {
    // The alias has no data dependencies; exercise the production route's hook.
    const beforeLoad = route.options.beforeLoad as () => unknown
    beforeLoad()
    throw new Error("Expected a redirect")
  } catch (error) {
    expect(isRedirect(error)).toBe(true)
    expect((error as { options: { href: string } }).options.href).toBe("/app/bugs/report")
  }
})
