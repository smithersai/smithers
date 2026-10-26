import { expect, test as setup } from "@playwright/test"
import { DEFAULT_SANDBOX_LIMITS, SANDBOX_LIMITS_ROUTE, SANDBOX_LIMIT_BOUNDS } from "../../src/features/spend/contract"

// The local project's setup (playwright.config.ts): every local spec is local development's Admin, `local-developer`
// (worker/DevChatApi.ts), and the specs run in parallel, so branch terminals, sandbox tools and shared branches wake
// more machines for that one person at once than the per-person limit admits (decision 0103,
// `DEFAULT_SANDBOX_LIMITS.perPerson`). A machine past it waits ("Waiting for a sandbox") until another's lease ends,
// minutes later, past the test's timeout. The Admin raises the limit the way a person does, through
// `POST /api/sandbox-limits`, on the dev server's own database; the deployment's limits are never touched.

setup("the local developer may wake a machine for every parallel spec", async ({ request }) => {
  const limits = { ...DEFAULT_SANDBOX_LIMITS, perPerson: SANDBOX_LIMIT_BOUNDS.perPerson[1], awake: SANDBOX_LIMIT_BOUNDS.awake[1] }
  const response = await request.post(SANDBOX_LIMITS_ROUTE, { data: limits })
  expect(response.status(), await response.text()).toBe(200)
})
