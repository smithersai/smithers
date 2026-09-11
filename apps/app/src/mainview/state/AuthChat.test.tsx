import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities } from "@smthrs/rpc/HostCapabilities"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import { backend, json, memoryStorage, settled, silentAgent, unavailableRepositories } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * One page: the chat. Auth is a conversation state, never a view — these pin
 * that a definitive signed-out or non-allowlisted answer renders THE CHAT
 * (transcript + composer) whose opening Smithers message carries the one
 * available action, that there is no second surface anywhere, and that the
 * composer's attempted send resolves to the calm one-line reply.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

const mount = (controller: AppControllerType): { host: HTMLElement; markup: () => string } => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <App />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return { host, markup: () => host.innerHTML }
}

/** What the Worker emits (docs/web-mode/PLAN.md §1): host `cloud`, built from the same table the server calls. */
const WEB: AppBootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "test",
  buildSha: "cloud",
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: false }),
  authFlow: "redirect",
  sandbox: null
}

const WEB_OPENING = "This is the Smithers web app. Sign in with GitHub to open one of your repositories and read its files here."

describe("auth is a conversation state — the chat is the only page", () => {
  test("signed-out: the chat renders open, with sign-in as the chrome's option (LOCAL-APP.md)", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, {
          scopes: [{ scope: "read:user", plain: "See your GitHub profile.", why: "Sign-in." }]
        })
      })
    })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    const html = markup()
    // The chat surface — transcript AND composer — not a landing takeover.
    expect(host.querySelector(".smithers-transcript")).not.toBeNull()
    expect(host.querySelector(".smithers-composer")).not.toBeNull()
    expect(host.querySelector(".landing-surface")).toBeNull()
    // No auth gate rides the transcript: sign-in is the chrome button, bound
    // to the registered command, and the composer invites the conversation.
    expect(html).not.toContain("sign in with GitHub to continue")
    const signIn = host.querySelector<HTMLButtonElement>("[data-testid=\"chrome-sign-in\"]")
    expect(signIn).not.toBeNull()
    expect(signIn?.dataset.flow).toBe("auth.sign-in")
    expect(controller.commands.find("auth.sign-in")).toBeDefined()
    expect(host.querySelector("textarea")?.placeholder).toBe("Ask Smithers to work on something…")
  })

  test("an adopted signed-out session (the server-rendered web boot) still names the scopes", async () => {
    /*
     * Live on canary: the Start build resolves the session on the server and
     * the client adopts it, so the scopes read the client-probe path makes
     * never ran — every signed-out web visitor read "The identity service
     * isn't configured on this deployment" on a deployment where it is.
     */
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      ...backend({
        "/api/auth/scopes": json(200, {
          scopes: [{ scope: "read:user", plain: "See your GitHub profile.", why: "Sign-in." }]
        })
      })
    })
    await controller.adoptSession({ state: "signed-out", login: null, allowlisted: false, admin: false })
    await settled()

    const { host, markup } = mount(controller)
    const html = markup()
    expect(html).not.toContain("sign in with GitHub to continue")
    expect(html).not.toContain("The identity service isn't configured")
    expect(host.querySelector("[data-testid=\"chrome-sign-in\"]")).not.toBeNull()
  })

  test("signed-out: a send reaches the agent; the chat is not gated on identity", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      features: { suggestionPills: true },
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    const { markup } = mount(controller)
    controller.send("is anyone there?")
    await settled()
    flushSync(() => {})
    expect(markup()).not.toContain("Sign in with GitHub first")
    expect(markup()).toContain("is anyone there?")
  })

  test("signed-out shows an empty transcript: no auth message, no welcome, no pills", async () => {
    /*
     * Live earlier today: under the sign-in message the chat still rendered
     * the seeded "Hey — I'm Smithers. Tell me what you're working on" — an
     * invitation to a conversation this session cannot have. §2a″ says a
     * state shows only itself.
     */
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    const html = markup()
    expect(html).not.toContain("sign in with GitHub to continue")
    expect(html).not.toContain("Tell me what you’re working on")
    expect(html).not.toContain("Tell me what you're working on")
    expect(host.querySelector(".smithers-chat-message")).toBeNull()
    const pills = [...host.querySelectorAll(".smithers-suggestion")].map((pill) => pill.textContent)
    expect(pills).toEqual([])
  })

  test("signed-out on the web (host cloud): the transcript is the one opening message whose action is sign-in", async () => {
    /*
     * docs/web-mode/PLAN.md §3: on the cloud host a signed-out visitor reads
     * what this is and the one act that is theirs. The card is the auth-state
     * shape auth.prompt renders (message + CTA bound to auth.sign-in); the
     * transcript holds nothing else — no opening read, no pills.
     */
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      bootstrap: WEB,
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    const messages = [...host.querySelectorAll<HTMLElement>(".smithers-chat-message")]
    expect(messages.map((message) => message.textContent?.includes(WEB_OPENING))).toEqual([true])
    const cta = messages[0]?.querySelector<HTMLButtonElement>(".message-cta")
    expect(cta?.dataset.flow).toBe("auth.sign-in")
    expect(cta?.textContent).toBe("Sign in with GitHub")
    expect(controller.commands.find("auth.sign-in")).toBeDefined()
    expect(markup()).not.toContain("Smithers initialized")
    expect([...host.querySelectorAll(".smithers-suggestion")]).toEqual([])
    // The chat is still the only page: transcript and composer, no takeover.
    expect(host.querySelector(".smithers-composer")).not.toBeNull()
    expect(host.querySelector(".landing-surface")).toBeNull()
  })

  /*
   * Anonymous exploring (apps/server/PUBLIC-REPOSITORIES.md): at
   * smithers.sh/smithersai/smithers the catalog row is selected before the
   * session answers signed-out. The web gate never reads: the transcript
   * belongs to the repository's welcome card (repo.welcome, rendered by the
   * open path in RepoLink.ts), whose maintain and contribute doors render
   * the sign-in step only when it is needed.
   */
  test("signed-out on the web with a catalog repository selected: no gate, no exploring line; the welcome card is the opener", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      bootstrap: WEB,
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{
        id: "smithersai/smithers",
        org: "smithersai",
        ownerKind: "user",
        name: "smithers",
        head: null,
        catalog: true,
        summary: "Smithers is a durable framework that lets agents plan, run, and review changes to a code repository through flows."
      }]
    })
    store.dispatch({ type: "repo.selected", actor: "user", id: "smithersai/smithers" })
    await controller.loadSession()
    await settled()

    expect((await controller.commands.run("repo.welcome")).status).toBe("executed")
    await settled()

    const { host, markup } = mount(controller)
    expect(markup()).not.toContain(WEB_OPENING)
    expect(markup()).not.toContain("You are exploring")
    expect(host.querySelector(".smithers-chat-message .message-cta")).toBeNull()
    const welcome = host.querySelector<HTMLElement>('[data-testid="onboarding-welcome"]')
    expect(welcome?.textContent).toBe(
      "Welcome to Smithers. smithersai/smithers is a durable framework that lets agents plan, run, and review changes to a code repository through flows."
    )
    expect([...host.querySelectorAll<HTMLElement>('.repo-onboarding [data-flow]')].map((button) => button.dataset.flow))
      .toEqual(["repo.maintain", "repo.contribute", "repo.explore"])
    // Repository reads are open to the visitor; a write still waits on sign-in.
    expect(controller.commands.state().publicRepo).toBe(true)
    expect(host.querySelector(".smithers-composer")).not.toBeNull()
  })

  test("signed-out on the web with a repository the catalog did not supply: the gate stands exactly as before", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      bootstrap: WEB,
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    store.dispatch({
      type: "repositories.loaded",
      actor: "system",
      repositories: [{ id: "acme/private", org: "acme", ownerKind: "org", name: "private", head: null }]
    })
    store.dispatch({ type: "repo.selected", actor: "user", id: "acme/private" })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    const messages = [...host.querySelectorAll<HTMLElement>(".smithers-chat-message")]
    expect(messages.map((message) => message.textContent?.includes(WEB_OPENING))).toEqual([true])
    expect(markup()).not.toContain("You are exploring")
    expect(controller.commands.state().publicRepo).toBe(false)
  })

  test("signed-out on the native host (host local) never reads the web opening message", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      bootstrap: { ...WEB, host: "local", authFlow: "native-handoff", sandbox: { platform: "darwin", mode: "enforced" } },
      ...backend({
        "/api/auth/session": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, { scopes: [] })
      })
    })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    expect(markup()).not.toContain(WEB_OPENING)
    expect(host.querySelector(".smithers-chat-message .message-cta")).toBeNull()
  })

  test("signed-in but not allowlisted: the same chat carries the request-access message", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      ...backend({
        "/api/auth/session": json(200, { login: "newcomer", allowlisted: false, admin: false })
      })
    })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    expect(host.querySelector(".smithers-transcript")).not.toBeNull()
    expect(host.querySelector(".smithers-composer")).not.toBeNull()
    expect(host.querySelector(".landing-surface")).toBeNull()
    expect(markup()).toContain("design partners only right now")
    const request = host.querySelector<HTMLButtonElement>("[data-flow=\"auth.request-access\"]")
    expect(request?.textContent).toContain("Request access")
    expect(host.querySelector("textarea")?.placeholder).toBe("Ask Smithers to work on something…")
  })

  test("a definitive $0 keeps the composer live, and a healthy composer renders NO status text (§2g)", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      ...backend({
        "/api/auth/session": json(200, { login: "will", allowlisted: true, admin: false }),
        "/api/billing/balance": json(200, {
          user: "will",
          balance: { totalUsd: "0", totalNanos: 0, lifetimeChargedUsd: "500", chargeCount: 3 },
          state: "empty",
          allowedToStartWork: false,
          credits: []
        })
      })
    })
    await controller.loadSession()
    await settled()
    await settled()

    const { host, markup } = mount(controller)
    // No balance chrome on the main page (the balance is one act away:
    // /balance); the composer is NOT paused.
    expect(host.querySelector(".corner-balance-chip")).toBeNull()
    expect(markup()).not.toContain("Balance unavailable")
    expect(markup()).not.toContain("$0")
    expect(controller.commands.find("billing.balance")).toBeDefined()
    expect(host.querySelector("textarea")?.placeholder).toBe("Ask Smithers to work on something…")
    // Calm is the budget (§2g): the persistent status line is gone — no
    // "live" chrome when healthy, no standing free-chat sentence.
    expect(markup()).not.toContain("Smithers Cloud · live")
    expect(markup()).not.toContain("chat is on us during the alpha")
    expect(markup()).not.toContain("paused at a $0 balance")
  })

  test("a slow background flow renders on the shared toast stack", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    let release: (response: Response) => void = () => {}
    const controller = createAppController(store, unavailableRepositories, silentAgent, {
      fetchImpl: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
      toastDebounceMs: 0
    })
    const { host } = mount(controller)
    const pending = controller.refreshBalance()
    await settled()
    flushSync(() => {})
    const stack = host.querySelector(".toast-stack")
    expect(stack).not.toBeNull()
    expect(stack?.textContent).toContain("Refreshing your balance…")
    release(json(503, { status: "error" }))
    await pending
    await settled()
    flushSync(() => {})
    expect(host.querySelector(".toast-stack")?.textContent).toContain(
      "Your balance couldn't be refreshed right now."
    )
  })
})
