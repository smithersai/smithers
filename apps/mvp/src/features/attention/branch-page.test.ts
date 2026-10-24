import { Files } from "../files/files"
// Render the real branch screen over the app's real Effect services and live collections, through the same providers
// as the branch page's other render tests (src/screens/branch/offline-render.tsx). No React hooks or views are
// replaced: the notice comes through Postgres/Electric, just as on a routed branch page.
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test, vi } from "vitest"
import { openTestApp, TestChatApi } from "../../test/chatApi"
import { Auth } from "../auth/auth"
import { Branch } from "../branch/branch"
import { Chat } from "../chat/chat"
import { CodeIntel } from "../code-intel/codeIntel"
import { Commands } from "../commands/commands"
import { PersonalModel } from "../personal-model/personalModel"
import { Repo } from "../repo/repo"
import { Spend } from "../spend/spend"
import { Status } from "../status/status"
import { Terminal } from "../terminal/terminal"
import { Theme } from "../theme/theme"
import { BranchScreen } from "../../screens/branch/BranchScreen"
import { branchRenderer } from "../../screens/branch/offline-render"
import { Todos } from "../todos/todos"
import { Attention } from "./attention"

test("a branch page renders its shared inline toast stack below the header", async () => {
  const runtime = openTestApp({ answers: false })
  try {
    const [api, attention, branch, repo, intel, spend, chat, auth, status, commands, theme, terminal, todos] =
      await runtime.runPromise(Effect.all([
        TestChatApi, Attention, Branch, Repo, CodeIntel, Spend, Chat, Auth, Status, Commands, Theme, Terminal, Todos,
      ]))
    repo.actions.openRoute("tree", { owner: "acme", repo: "widgets", ref: "feature" }, {})
    repo.queries.view.startSyncImmediate()
    await vi.waitFor(() => expect(repo.queries.view.toArray[0]?.view.repoId).toBe("github/acme/widgets"))
    const subject = "clone:github/acme/widgets"
    await Effect.runPromise(api.github.run(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO notifications (recipient, subject, kind, state, mine, repo_id, title, ref, href)
        VALUES ('person-member', ${subject}, 'clone', 'failed', true, 'github/acme/widgets', 'acme/widgets',
          'failed:not_found', '/acme/widgets')`)))
    for (const query of [attention.queries.stackHere, attention.queries.listHere]) query.startSyncImmediate()
    await vi.waitFor(() => expect(attention.queries.stackHere.toArray).toEqual([
      expect.objectContaining({ id: subject, action: "retry" }),
    ]), { timeout: 60_000 })
    const root = createRootRoute()
    const route = createRoute({ getParentRoute: () => root, path: "/$owner/$repo/tree/$ref/$", component: BranchScreen })
    const router = createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/acme/widgets/tree/feature"] }),
    })
    await router.load()
    expect(router.state.matches.map((match) => match.routeId)).toContain(route.id)
    const personalModel = await runtime.runPromise(Effect.service(PersonalModel))
    const html = branchRenderer({ files: await runtime.runPromise(Effect.service(Files)), chat, auth, repo, branch, intel, status, commands, theme, terminal, attention, spend, personalModel, todos })(router)
    expect(html).toContain('class="branch-screen"')
    expect(html).toContain('data-placement="inline"')
    expect(html).toContain(`data-subject="${subject}"`)
    expect(html).toContain("Try again")
    expect(html.indexOf('class="repo-header"')).toBeGreaterThan(-1)
    expect(html.indexOf('class="repo-header"')).toBeLessThan(html.indexOf('data-placement="inline"'))
    expect(html.indexOf('data-placement="inline"')).toBeLessThan(html.indexOf('class="branch-screen-view"'))
    expect(html.match(/data-slot="toast-stack"/g)).toHaveLength(1)
  } finally {
    await runtime.dispose()
  }
}, 120_000)
