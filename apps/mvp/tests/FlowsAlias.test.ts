import { expect, test } from "vitest"
import { router } from "../src/router"

test("the short flows address redirects to the personal flows page", () => {
  const route = router.routesById["/flows"]
  expect(route).toBeDefined()
  expect(() => (route.options.beforeLoad as () => unknown)()).toThrow()
  try { (route.options.beforeLoad as () => unknown)() } catch (redirect) {
    expect(redirect).toMatchObject({ options: { to: "/app/flows" } })
  }
})
