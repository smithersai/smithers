import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { ROUTE_PATHS } from "../src/routePaths"
import { isAppRoute } from "./appRoute"

test.each([
  "/", "/app", "/settings", "/flows", "/app/settings", "/app/flows/new", "/app/flows/code/example",
  "/app/flows/drafts/id", "/app/views/id", "/app/runs/id", "/app/conversations", "/app/bugs/report", "/app/queue",
  "/owner/repo", "/owner/repo/branches", "/owner/repo/tree/main", "/owner/repo/blob/main/src/file.ts",
  "/owner/repo/raw/main/file", "/owner/repo/docs/guide/page", "/owner/repo/issues", "/owner/repo/issues/new",
  "/owner/repo/issues/1", "/owner/repo/pulls/1", "/owner/repo/pull/1/files", "/owner/repo/stack/1",
  "/owner/repo/actions/runs/id", "/owner/repo/settings/secrets", "/owner/repo/secrets", "/owner/repo/actions",
])("a supported deep link remains successful: %s", (path) => expect(isAppRoute(path)).toBe(true))

test.each([
  "/missing", "/favicon.ico", "/sitemap.xml", "/app/conversations/id", "/app/unknown", "/app/bugs/unknown",
  "/owner/repo/flows", "/owner/repo/issues/0", "/owner/repo/issues/abc", "/owner/repo/stack/0",
  "/owner/repo/pull/1/conversation", "/owner/repo/pull/1/unknown", "/owner!/repo", "/owner/repo/%",
])("an unsupported document has no route: %s", (path) => expect(isAppRoute(path)).toBe(false))

test("the view uses the shared declarations for every core path", () => {
  const view = readFileSync(new URL("../src/router.tsx", import.meta.url), "utf8")
  for (const key of Object.keys(ROUTE_PATHS)) expect(view).toContain(`ROUTE_PATHS.${key}`)
  expect(view).not.toMatch(/path: "\//)
})
