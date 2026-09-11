import { expect, test, type Page } from "@playwright/test"
import { AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"
import { CloudSessionSchema, ReposResponseSchema } from "@smthrs/rpc/LocalApp"
import { installCloudFixture } from "./cloudFixture.ts"

const read = (page: Page, path: string) => page.evaluate(async (path) => {
  const response = await fetch(path)
  return { status: response.status, body: await response.json() }
}, path)

// Exercise Playwright's actual URL matching without booting application state.
test.beforeEach(async ({ page }) => {
  await page.route("**/fixture", (route) => route.fulfill({ contentType: "text/html", body: "<title>Fixture contract</title>" }))
  await page.goto("/fixture")
})

test("cloud fixture uses the shared local contracts and current cloud list envelopes", async ({ page }) => {
  await installCloudFixture(page)
  expect(AppBootstrapSchema.safeParse((await read(page, "/api/bootstrap")).body).success).toBe(true)
  expect(ReposResponseSchema.parse((await read(page, "/api/repos")).body)).toEqual({ repos: [] })
  expect(CloudSessionSchema.parse((await read(page, "/api/cloud-auth/session")).body).state).toBe("signed-in")
  expect((await read(page, "/api/auth/session")).body).toMatchObject({ login: "codeplanesmithers", admin: false })
  for (const query of ["", "?limit=100&cursor=next"]) {
    expect((await read(page, `/api/cloud/api/user/repos${query}`)).body).toEqual([
      expect.objectContaining({ full_name: "smithersai/smithers", owner_type: "Organization" })
    ])
    expect((await read(page, `/api/cloud/api/user/orgs${query}`)).body).toEqual([{ name: "smithersai" }])
    expect((await read(page, `/api/cloud/api/user/workspaces${query}`)).body).toEqual([])
    expect((await read(page, `/api/cloud/api/repos/smithersai/smithers/bookmarks${query}`)).body).toEqual({
      items: [{ name: "main", target_change_id: "kxyzqrpv", target_commit_id: "c0ffee123456", is_tracking_remote: false }],
      next_cursor: ""
    })
  }
})

test("cloud fixture overrides stay isolated and match repository pathnames literally", async ({ page, context }) => {
  const workspace = {
    workspace_id: "ws-9", repository_id: 9, repository_owner: "visitor", repository_name: "demo.v2",
    workspace_title: "review", state: "running", last_accessed_at: null,
    last_activity_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", sort_timestamp: "2026-09-01T00:00:00Z"
  }
  const localRepo = {
    id: "demo", path: "/tmp/demo", name: "demo", git: null, warnings: [],
    smithers: { detected: false, workspaceFile: null, declarationFiles: [], reason: "fixture", workspaces: [] }
  }
  await installCloudFixture(page, {
    localRepos: [localRepo], capabilities: ["cloud"], degraded: true, orgs: [], workspaces: [workspace],
    repos: [{ owner: "visitor", name: "demo.v2", full_name: "visitor/demo.v2", default_bookmark: "review", owner_type: "User" }],
    bookmarks: { "visitor/demo.v2": [{ name: "review", target_change_id: "change-9", target_commit_id: "commit-9", is_tracking_remote: true }] }
  })
  expect((await read(page, "/api/repos")).body).toEqual({ repos: [localRepo] })
  expect((await read(page, "/api/bootstrap")).body.capabilities).toEqual(["cloud"])
  expect((await read(page, "/api/cloud-auth/session")).body.scopes).toBe("degraded")
  expect((await read(page, "/api/cloud/api/user/orgs")).body).toEqual([])
  expect((await read(page, "/api/cloud/api/user/workspaces?limit=100")).body).toEqual([workspace])
  const path = "/api/cloud/api/repos/visitor/demo.v2/bookmarks"
  expect((await read(page, `${path}?limit=1`)).body.items).toEqual([
    { name: "review", target_change_id: "change-9", target_commit_id: "commit-9", is_tracking_remote: true }
  ])
  expect((await read(page, path.replace("demo.v2", "demoXv2"))).status).toBe(404)
  await page.route((url) => url.pathname === path, (route) => route.fulfill({ json: { items: [], next_cursor: "" } }))
  expect((await read(page, path)).body).toEqual({ items: [], next_cursor: "" })

  const other = await context.newPage()
  await installCloudFixture(other)
  await other.route("**/fixture", (route) => route.fulfill({ contentType: "text/html", body: "<title>Other fixture</title>" }))
  await other.goto("/fixture")
  expect((await read(other, "/api/cloud-auth/session")).body.scopes).toBeUndefined()
  expect((await read(other, "/api/cloud/api/user/workspaces")).body).toEqual([])
  expect((await read(other, "/api/cloud/api/user/repos")).body[0].full_name).toBe("smithersai/smithers")
})
