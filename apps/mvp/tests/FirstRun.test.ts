// `/app`'s first run as the page draws it (decision 0121, docs/features/first-run.md): the steps, the composer's place
// and the header's sign-in, rendered by the real views over the app's own layer against ChatApi's real handler. Each
// state is the session row sign-in keeps, set as its load would, and the first run's follower works out the rest.
import { createRootRoute, createRouter, createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import { Effect } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, expect, test, vi } from "vitest"
import { Auth } from "../src/features/auth/auth"
import { AuthProvider } from "../src/features/auth/components/AuthContext"
import type { Session } from "../src/features/auth/schema"
import { AuthStore, SESSION } from "../src/features/auth/store"
import { Chat } from "../src/features/chat/chat"
import { FirstRunAccount } from "../src/features/first-run/components/FirstRunAccount"
import { FirstRunProvider } from "../src/features/first-run/components/FirstRunContext"
import { FirstRunGate } from "../src/features/first-run/components/FirstRunGate"
import { FirstRunSteps } from "../src/features/first-run/components/FirstRunSteps"
import { FirstRun } from "../src/features/first-run/firstRun"
import { PersonalModel } from "../src/features/personal-model/personalModel"
import { FIRST_RUN } from "../src/features/first-run/schema"
import { FirstRunStore } from "../src/features/first-run/store"
import { openTestApp } from "../src/test/chatApi"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 40_000, interval: 20 })

test("the steps, the composer's place and the header's sign-in, for each state of a first run", { timeout: 120_000 }, async () => {
  const app = openTestApp({ answers: false })
  runtimes.push(app)
  const auth = await app.runPromise(Effect.service(Auth))
  const store = await app.runPromise(Effect.service(AuthStore))
  const firstRun = await app.runPromise(Effect.service(FirstRun))
  const chat = await app.runPromise(Effect.service(Chat))
  const personalModel = await app.runPromise(Effect.service(PersonalModel))
  for (const query of [auth.queries.session, auth.queries.confirmed, firstRun.queries.state, personalModel.queries.saved]) {
    query.startSyncImmediate()
  }
  const page = () => createElement("div", null,
    createElement(FirstRunAccount),
    createElement(FirstRunSteps),
    createElement(FirstRunGate, null, createElement("span", { "data-gate": "" }, "gate")))
  const root = createRootRoute({ component: page })
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/app"] }) })
  await router.load()
  const html = () =>
    renderToStaticMarkup(
      createElement(AuthProvider, { value: auth },
        createElement(FirstRunProvider, { value: firstRun }, createElement(RouterProvider, { router }))),
    )
  /** The first run's list alone, from the page's markup. */
  const list = (out: string) => out.slice(out.indexOf("<section"), out.indexOf("</section>"))
  const session = (fields: Partial<Session>) =>
    app.runPromise(store.session.update(SESSION, (row) => void Object.assign(row, fields)))
  await until(() => expect(firstRun.queries.state.toArray[0]?.show).toBe("steps"))

  // A visitor where sign-in works: the Sign in step is current and has the one sign-in link; the header has none.
  await session({ status: "signed_out", login: null, role: null, available: true, hostedModel: false })
  await until(() => {
    const out = html()
    expect(out).toContain('aria-label="Get started"')
    expect(out).toMatch(/<li class="first-run-step" data-step="sign_in" data-state="next" aria-current="step">/)
    expect(out.match(/Sign in with GitHub/g)).toHaveLength(1)
    expect(out).toContain('href="/api/auth/sign-in?return=%2Fapp"')
    expect(out).toContain("Add your model")
    expect(out).toContain("Ask Smithers")
    expect(out).not.toContain("data-gate")
  })

  // A Member without a model while the deployment's is off: Sign in done, Open settings on Add your model.
  await session({ status: "signed_in", login: "member", role: "member", hostedModel: false })
  await until(() => {
    const out = html()
    expect(out).toContain('aria-label="Done"')
    expect(out).toMatch(/data-step="model" data-state="next" aria-current="step" data-add-model="">/)
    expect(out).toMatch(/<button[^>]*>Open settings<\/button>/)
    expect(out).not.toContain("Sign in with GitHub")
    expect(out).not.toContain("data-gate")
  })

  // With the deployment's model on, Ask Smithers is current, and the composer's place shows under the list.
  await session({ hostedModel: true })
  await until(() => {
    const out = html()
    expect(out).toMatch(/data-step="ask" data-state="next" aria-current="step"/)
    expect(out).not.toContain('data-step="model"')
    expect(out).toContain("data-gate")
  })

  // Opening the composer leaves only the composer's place.
  chat.actions.openComposer("button")
  await until(() => {
    const out = html()
    expect(out).not.toContain("Get started")
    expect(out).toContain("data-gate")
  })
  chat.actions.closeComposer()

  // A Guest of the deployment's repository, whom its model doesn't answer: Sign in done, Add your model current, and
  // Open your repository to come; never Members can ask Smithers. (ruling AUTH-8).
  await session({ role: "guest", hostedModel: false, install: "https://github.com/apps/smithers/installations/new" })
  await until(() => {
    const out = html()
    expect(out).toMatch(/data-step="model" data-state="next" aria-current="step" data-add-model="">/)
    expect(out).toMatch(/data-step="repository" data-state="later">/)
    expect(out).not.toContain("Members can ask Smithers.")
    expect(out).not.toContain("data-gate")
  })

  // Their model saved, as the follower works out (src/features/first-run/firstRun.test.ts): Open your repository is
  // current, with its field, Open and Install, and no composer.
  const steps = await app.runPromise(Effect.service(FirstRunStore))
  const atRepository = () =>
    app.runPromise(steps.row.update(FIRST_RUN, (draft) => void Object.assign(draft, {
      show: "steps",
      at: "repository",
      steps: [{ id: "sign_in", state: "done" }, { id: "model", state: "done" }, { id: "repository", state: "next" }],
    })))
  await atRepository()
  await until(() => {
    const out = html()
    expect(out).toMatch(/data-step="repository" data-state="next" aria-current="step">/)
    const field = /<input[^>]*>/.exec(list(out))?.[0] ?? ""
    for (const attribute of ['name="repository"', 'aria-label="Repository"', 'placeholder="owner/name"', 'required=""']) {
      expect(field).toContain(attribute)
    }
    // The browser's own check takes what Open opens: owner/name, or its GitHub URL with a trailing slash.
    const pattern = new RegExp(`^(?:${/pattern="([^"]*)"/.exec(field)![1]!.replaceAll("&amp;", "&")})$`, "v")
    for (const text of ["acme/widgets", "https://github.com/acme/widgets/", " acme/widgets.git "]) expect(text).toMatch(pattern)
    for (const text of ["acme", "acme/widgets/tree/main"]) expect(text).not.toMatch(pattern)
    expect(list(out)).toMatch(/<button[^>]*type="submit"[^>]*>Open<\/button>/)
    expect(list(out)).toContain('href="https://github.com/apps/smithers/installations/new"')
    expect(out).not.toContain("data-gate")
  })

  // Without an App to install (local development), the field and Open, and no Install.
  await session({ install: undefined })
  await atRepository()
  await until(() => {
    const out = list(html())
    expect(out).toContain('name="repository"')
    expect(out).not.toContain("installations/new")
  })
})
