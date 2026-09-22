import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { expect, realApi } from "./support/test"
import { runSlash } from "./issues/local"
import { withOwnedRepository } from "./portable/owned-repository"

authenticatedTest.setTimeout(240_000)

authenticatedTest("an owned repository runs a declared Flow and exposes its durable result", scenario("flows.product-run", {
  capabilities: ["identity", "cloud"],
  coverage: ["action:flow.list", "action:flow.run", "host:local", "host:production", "path:success", "door:slash", "surface:flow-api", "evidence:accepted-run-and-terminal-projection"]
}), async ({ page, request }) => {
  await withOwnedRepository(page, request, async (repo) => {
    await page.goto(`/${repo.fullName}`, { waitUntil: "domcontentloaded" })
    const list = await realApi(page, request, "POST", "/api/workflow/rpc", {
      repo: repo.fullName, procedure: "List", payload: { _tag: "flows" }
    })
    expect(list.status()).toBe(200)
    const catalog = await list.json() as { readonly ok?: boolean; readonly payload?: { readonly items?: ReadonlyArray<{ readonly flowId?: string }> } }
    expect(catalog.ok).toBe(true)
    const flow = catalog.payload?.items?.find(({ flowId }) => flowId?.toLowerCase().includes("librarian"))
    expect(flow?.flowId, "the packaged librarian Flow must be in the product catalog").toEqual(expect.any(String))

    const accepted = page.waitForResponse((response) => {
      if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/workflow/rpc") return false
      const body = response.request().postDataJSON() as { readonly procedure?: string; readonly repo?: string }
      return body.procedure === "Run" && body.repo === repo.fullName
    })
    await runSlash(page, `/flow.run ${flow!.flowId} ${repo.fullName} ${JSON.stringify({ repo: repo.fullName })}`)
    const response = await accepted
    expect(response.status()).toBe(200)
    const run = await response.json() as { readonly ok?: boolean; readonly payload?: { readonly runId?: string } }
    expect(run.ok).toBe(true)
    expect(run.payload?.runId).toEqual(expect.any(String))
    await expect.poll(async () => {
      const projection = await realApi(page, request, "POST", "/api/workflow/rpc", {
        repo: repo.fullName, procedure: "Projection.Snapshot", payload: { selector: { _tag: "run-summary", runId: run.payload!.runId } }
      })
      expect(projection.status()).toBe(200)
      const body = await projection.json() as { readonly ok?: boolean; readonly payload?: { readonly rows?: ReadonlyArray<{ readonly status?: string }> } }
      expect(body.ok).toBe(true)
      return body.payload?.rows?.[0]?.status
    }, { timeout: 180_000, intervals: [500, 1_000, 2_000] }).toBe("completed")
  })
})
