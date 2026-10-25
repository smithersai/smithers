import { watchUpdates } from "./pwa"
import { SmithersUiStyles } from "@smthrs/ui"
import { BrowserCollectionCoordinator, createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { SharedSqlite, StoragePersistence, WebLock } from "@smthrs/platform-browser"
import { IndexedDBAdapter, startOfflineExecutor, WebOnlineDetector } from "@tanstack/offline-transactions"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { registerSW } from "virtual:pwa-register"
import { ChatProvider } from "./AppContext"
import { type BootOptions, type Host, realServices, start } from "./boot"
import { AttentionProvider } from "./features/attention/components/AttentionContext"
import { AuthProvider } from "./features/auth/components/AuthContext"
import { BranchProvider } from "./features/branch/components/BranchContext"
import { CodeIntelProvider } from "./features/code-intel/components/CodeIntelContext"
import { CommandsProvider } from "./features/commands/components/CommandsContext"
import { IssuesProvider } from "./features/issues/components/IssuesContext"
import { PullsProvider } from "./features/pulls/components/PullsContext"
import { FilesProvider } from "./features/files/components/FilesContext"
import { SecretsProvider } from "./features/secrets/components/SecretsContext"
import { RepoProvider } from "./features/repo/components/RepoContext"
import { RunsProvider } from "./features/runs/components/RunsContext"
import { FlowsUiProvider } from "./features/flows-ui/components/FlowsUiContext"
import { DocsProvider } from "./features/docs/components/DocsContext"
import { HomeProvider } from "./features/home/components/HomeContext"
import { THEME_ATTRIBUTE, THEME_MIRROR_KEY } from "./features/theme/contract"
import { ENGINE_NAME } from "./flows/contract"
import { ThemeProvider } from "./features/theme/components/ThemeButton"
import { StatusProvider } from "./features/status/components/StatusContext"
import { SpendProvider } from "./features/spend/components/SpendContext"
import { PluginsProvider } from "./plugins/components/PluginsContext"
import { DomainsProvider } from "./features/domains/components/DomainsContext"
import { PersonalModelProvider } from "./features/personal-model/components/PersonalModelContext"
import { TerminalProvider } from "./features/terminal/components/TerminalContext"
import { TodosProvider } from "./features/todos/components/TodosContext"
import { ViewsProvider } from "./features/views/components/ViewsContext"
import { WebProvider } from "./features/web/components/WebContext"
import { router } from "./router"
import { activationGate, type Adoption, boundFetch, outboxPrincipal, DeviceIdentityRefused, IDENTITY_MESSAGE, readReceipt, type Receipt, VISITOR } from "./device/identity"
import { DEVICE_ADOPTED_EVENT, NO_DEVICE_DATA, type SessionState } from "./features/auth/contract"
import { failedWorker, memoryStorage, pageWipe, unwiped } from "./wipe"
import { claimEditorTabId } from "./device/editorTab"
import { awaitEditorWrites, hasFailedEditorWrite, hasPendingEditorWrites } from "./features/flows-ui/editorWrites"
import "./styles/fonts.css"

// The page: `start` runs the app's one program, and React renders the chat, sign-in, theme, repository and slash-command
// layers it hands over.
// This is the browser's host: everything platform-specific the app's layers take as arguments
// (docs/decisions/0002-local-first.md §6).
const inputStillUnsaved = () =>
  document.querySelector('[data-draft="unsaved"]') !== null ||
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).some((input) => input.value !== "")

/** Passwords stay only in their field; chat marks its composer unsaved until SQLite or the shared prompt confirms it. */
const awaitSafeInputs = (): Promise<void> => {
  if (!inputStillUnsaved()) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      if (inputStillUnsaved()) return
      observer.disconnect()
      document.removeEventListener("input", done, true)
      document.removeEventListener("reset", afterReset, true)
      resolve()
    }
    const afterReset = () => queueMicrotask(done)
    const observer = new MutationObserver(done)
    observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true, attributeFilter: ["data-draft"] })
    document.addEventListener("input", done, true)
    document.addEventListener("reset", afterReset, true)
    done()
  })
}

let updateReloading = false
const editorUpdateParked = () => {
  console.warn("pwa.update", { outcome: "editor_unpersisted" })
  window.alert("Couldn't save your edit on this device. Copy it before reloading.")
}
registerSW({
  immediate: true,
  onRegistered: (registration) => {
    if (!registration) return
    watchUpdates(registration, {
      visible: () => document.visibilityState === "visible",
      listen: (trigger, check) => {
        if (trigger === "navigation") return router.subscribe("onResolved", check)
        const target = trigger === "visible" ? document : window
        const event = trigger === "visible" ? "visibilitychange" : "focus"
        target.addEventListener(event, check)
        return () => target.removeEventListener(event, check)
      },
      record: (trigger, outcome) => console.info("pwa.update.check", { trigger, outcome }),
    })
  },
  onNeedReload: () => {
    if (updateReloading) return
    updateReloading = true
    console.info("pwa.update", { outcome: "activated" })
    void (async () => {
      for (;;) {
        await awaitEditorWrites()
        if (hasFailedEditorWrite()) {
          editorUpdateParked()
          return
        }
        await awaitSafeInputs()
        if (hasFailedEditorWrite()) {
          editorUpdateParked()
          return
        }
        if (hasPendingEditorWrites() || inputStillUnsaved()) continue
        window.location.reload()
        return
      }
    })()
  },
  onRegisterError: () => console.warn("pwa.register", { outcome: "failed" }),
})
const root = createRoot(document.getElementById("root")!)

// Sign-out's wipe (src/wipe.ts, decision 0008 §4.6): this page hears wipes from the start and holds the device's data
// while it runs. A boot a sign-out marked deletes the engine's OPFS directory (the engine's store and the device store)
// and the outbox's IndexedDB database once no other page and no engine worker has them open. The theme's mirror stays.
const OUTBOX_DATABASE = "smithers-outbox"
const wipe = pageWipe(
  {
    locks: navigator.locks,
    // Read when used: a browser that blocks storage throws on reaching `localStorage`.
    marks: {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    },
    directory: () => navigator.storage.getDirectory(),
    indexedDB,
    channel: (name) => new BroadcastChannel(name),
    reload: () => window.location.reload(),
  },
  { engine: ENGINE_NAME, outbox: OUTBOX_DATABASE },
)

// Whose data the device holds (src/device/identity.ts, decision 0021 "Device ownership"). The leading engine worker
// checks before its engine starts and sends a receipt, checked against the browser's session now for a tab that
// follows it. This page opens the device store and the outbox only on a receipt that names an owner (`retained`);
// until one comes, both wait, as they wait for a leader anyway. Otherwise it runs on memory stores, and the device's
// data stays sealed and whole.
let deviceOwner: string | undefined
// Whether the owner held the device's data before this activation (`Receipt.continuous`): only then are the outbox's
// writes stored before writes named who queued them theirs.
let deviceContinuous = false
// Sealed only because no one was signed in, or ChatApi couldn't say who: the owner signing in reopens this page.
let sealedUntilSignIn = false
let engineWorker: Worker | undefined
const sealed = () => new DeviceIdentityRefused({ reason: "sealed" })
const activation = activationGate(() => {
  // This page's worker never serves it, nor leads with its view: its engine is unavailable, and says why.
  engineWorker?.terminate()
  engineWorker?.dispatchEvent(new ErrorEvent("error", { error: sealed() }))
})
// Reopening loads every page again so a new activation checks the session the browser has now. Once a minute at most
// from this tab: a second mismatch so soon settles on memory instead of reloading again.
const REOPENED = "smithers-identity-reopened"
const reopen = () => {
  let last = 0
  try {
    last = Number(sessionStorage.getItem(REOPENED) ?? 0)
    sessionStorage.setItem(REOPENED, String(Date.now()))
  } catch {}
  if (Date.now() - last < 60_000) return
  console.info("auth.device_identity", { outcome: "reopened" })
  wipe.reopen()
}
// Adopting in place (decision 0023, "Adopting in place"): a page that opened the visitor's data asks its leader to
// claim it for the person signed in now, instead of reopening every page, and waits for the receipt.
let adoption: { readonly personId: string | undefined; readonly settle: (outcome: Adoption) => void } | undefined
const adopted = (receipt: Receipt) => {
  // Every page on the visitor's data takes the person who adopted it, whichever page asked.
  if (receipt.outcome === "verified" && receipt.owner !== undefined && receipt.owner !== VISITOR && deviceOwner === VISITOR) {
    deviceOwner = receipt.owner
    // The person came to the visitor's data only now: the outbox's writes stored before writes named who queued them
    // stay sealed, never theirs (`Receipt.continuous`, false for an adoption).
    deviceContinuous = receipt.continuous === true
    console.info("auth.device_identity", { outcome: "adopted" })
    // What this page syncs and sends goes again now, as theirs.
    window.dispatchEvent(new Event(DEVICE_ADOPTED_EVENT))
  }
  if (adoption === undefined || receipt.owner === undefined) return
  adoption.settle(
    receipt.owner === adoption.personId && deviceOwner === receipt.owner
      ? "adopted"
      : receipt.owner === VISITOR
      ? "unavailable"
      : "refused",
  )
}
const adopt = (session: SessionState, signal: AbortSignal) =>
  activation.state() !== "retained" || deviceOwner !== VISITOR
    ? Promise.resolve<Adoption>("refused")
    : new Promise<Adoption>((resolve) => {
      // The request's Effect timeout aborts this wait too: an older leader that never answers reopens the page.
      const aborted = () => adoption?.settle("refused")
      adoption = {
        personId: session.signedIn ? session.personId : undefined,
        settle: (outcome) => {
          signal.removeEventListener("abort", aborted)
          adoption = undefined
          resolve(outcome)
        },
      }
      signal.addEventListener("abort", aborted, { once: true })
      if (signal.aborted) aborted()
      else identity.postMessage({ request: "adopt" })
    })
const accept = (message: unknown) => {
  const receipt = readReceipt(message)
  if (receipt === undefined) return
  if (activation.state() === "retained") return adopted(receipt)
  if (activation.state() !== "pending") return
  if (receipt.owner !== undefined) {
    deviceOwner = receipt.owner
    deviceContinuous = receipt.continuous === true
    activation.allow()
    return
  }
  // Reopening or not, this page never opens the data it was told of: it runs on memory until it loads again.
  sealedUntilSignIn = receipt.outcome === "signed_out" || receipt.outcome === "unverified"
  if (receipt.reopen === true) reopen()
  activation.refuse()
}
const identity = new BroadcastChannel(IDENTITY_MESSAGE)
identity.onmessage = (event: MessageEvent) => accept(event.data)
const memoryOutbox = memoryStorage()
let retainedOutbox: IndexedDBAdapter | undefined
const outboxStorage = async () => {
  await activation.ready
  return activation.state() === "retained" ? (retainedOutbox ??= new IndexedDBAdapter(OUTBOX_DATABASE, "transactions")) : memoryOutbox
}

// The device store: the app's shared SQLite database in the engine worker's OPFS pool (@smthrs/platform-browser's
// `SharedSqlite`), one per origin, reached by every tab through the leading tab's worker. The outbox: IndexedDB,
// sending when the browser says it can, led by one tab through @smthrs/platform-browser's Web Lock service.
const host: Omit<Host, "editorTabId" | "editorTabPersistent"> = {
  persistence: {
    open: async () => {
      await activation.ready
      if (activation.state() !== "retained") throw sealed()
      return SharedSqlite.open({ name: ENGINE_NAME })
    },
    make: (database, coordinator) => createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
    coordinator: () => new BrowserCollectionCoordinator({ dbName: "smithers" }),
  },
  outbox: {
    start: startOfflineExecutor,
    // The device's IndexedDB outbox once this page may open the device's data; memory otherwise.
    storage: {
      get: async (key) => (await outboxStorage()).get(key),
      set: async (key, value) => (await outboxStorage()).set(key, value),
      delete: async (key) => (await outboxStorage()).delete(key),
      keys: async () => (await outboxStorage()).keys(),
      clear: async () => (await outboxStorage()).clear(),
    },
    online: new WebOnlineDetector(),
    // A queued write is sent only as who queued it: the device's owner when this page opened its data. Another
    // owner's writes, such as an earlier owner's left in IndexedDB after the browser evicted the device store, stay
    // sealed in the outbox (`Outbox.Principal`).
    principal: outboxPrincipal(
      () => (activation.state() === "retained" ? deviceOwner : undefined),
      () => deviceContinuous,
    ),
  },
  lock: WebLock.make(navigator.locks),
  isOnline: () => navigator.onLine,
  storage: StoragePersistence.make(navigator.storage),
  // The theme paints `<html data-theme>`, which @smthrs/ui's palette reads, and mirrors the mode into localStorage,
  // which index.html paints from before the store opens. Without a preference the page follows the system.
  theme: {
    paint: (mode) => {
      if (mode === undefined) document.documentElement.removeAttribute(THEME_ATTRIBUTE)
      else document.documentElement.setAttribute(THEME_ATTRIBUTE, mode)
    },
    mirror: (mode) => {
      try {
        if (mode === undefined) localStorage.removeItem(THEME_MIRROR_KEY)
        else localStorage.setItem(THEME_MIRROR_KEY, mode)
      } catch {
        // Storage blocked: the store still has the mode, and the next load paints it once the store opens.
      }
    },
    systemChanges: matchMedia("(prefers-color-scheme: dark)"),
    system: () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    painted: () => {
      const mode = document.documentElement.getAttribute(THEME_ATTRIBUTE)
      return mode === "dark" || mode === "light" ? mode : undefined
    },
  },
  // Copy permalink writes here; the browser refuses without the page's focus or permission.
  clipboard: (text) => navigator.clipboard.writeText(text),
  // Navigation answers only after the router completes.
  navigate: (path) => router.navigate({ href: path }),
  reopenRoute: () => void router.invalidate(),
  pathname: () => router.state.location.pathname,
  // `app/web/open` (src/features/web/url.ts): `http:` pages on this machine open in a new tab only under the dev
  // server. A person's own `/web … tab` opens its tab here, inside their keypress, when the browser still allows it:
  // `window.open` takes the click's activation when it opens a tab, so an activation still there after it means the
  // browser refused, and the flow adds a card instead. A browser that can't say opens nothing here.
  web: {
    policy: { localHttp: import.meta.env.DEV, appOrigin: window.location.origin },
    openTab: (href) => {
      const activation = navigator.userActivation
      if (activation === undefined || !activation.isActive) return false
      window.open(href, "_blank", "noopener,noreferrer")
      return !activation.isActive
    },
  },
  // The repository view's language server: TypeScript in a worker of its own, started when a TypeScript or JavaScript
  // file first shows, so its bundle loads only then (docs/features/code-intelligence.md).
  codeIntelWorker: () => new Worker(new URL("./features/code-intel/language.worker.ts", import.meta.url), { type: "module" }),
  // This tab's engine worker: it runs every client flow, the agent among them, once its tab leads (decision 0011). Under
  // the dev server, the end-to-end tests' parameters reach it in its name, `dev:<parameters>`: `?agent=<script>` names a
  // scripted model (src/test/scriptedAgent.ts), and `?faults=session-503` opens its session read refused
  // (src/test/authFaults.ts). A production build drops the branch.
  engineName: ENGINE_NAME,
  engineWorker: () => {
    // A page already on memory never starts a worker that could lead over the device's data.
    if (activation.state() === "memory") return failedWorker(sealed)()
    const search = new URLSearchParams(window.location.search)
    const dev = new URLSearchParams([...search].filter(([key]) => key === "agent" || key === "faults"))
    // Vite reads the worker's `type` statically, so it comes after the spread.
    const worker = new Worker(new URL("./flows/engine.worker.ts", import.meta.url), {
      ...(import.meta.env.DEV && dev.toString() !== "" ? { name: `dev:${dev}` } : {}),
      type: "module",
    })
    engineWorker = worker
    // Its own receipt when it leads; a stopped engine or a failed worker sends none, and this page runs on memory.
    worker.addEventListener("message", (event) => {
      if (event.data?._tag === "@smthrs/platform-browser/EngineStopped") activation.refuse()
      else accept(event.data)
    })
    worker.addEventListener("error", () => activation.refuse())
    // A leader in another tab answers with its receipt, checked against the browser's session now.
    identity.postMessage({ request: true })
    return worker
  },
  // The tab's title, which counts the agent's open questions (decision 0015).
  title: { read: () => document.title, write: (title) => void (document.title = title) },
  // Sign-out's wipe: mark it and tell every page, this one included; each stops and loads again (src/wipe.ts).
  wipe: wipe.wipe,
}

const render: BootOptions["render"] = (
  chat,
  auth,
  theme,
  repo,
  commands,
  views,
  web,
  status,
  branch,
  terminal,
  issues,
  runs,
  flows,
  home,
  spend,
  attention,
  todos,
  codeIntel,
  pulls,
  plugins,
  files,
  secrets,
  docs,
  domains,
  personalModel,
) =>
  root.render(
    <StrictMode>
      <SmithersUiStyles withTheme />
      <ChatProvider value={chat}>
        <AuthProvider value={auth}>
          <ThemeProvider value={theme}>
            <RepoProvider value={repo}>
              <FilesProvider value={files}>
              <CodeIntelProvider value={codeIntel}>
              <CommandsProvider value={commands}>
                <ViewsProvider value={views}>
                  <WebProvider value={web}>
                    <StatusProvider value={status}>
                      <SpendProvider value={spend}>
                        <DomainsProvider value={domains}>
                          <PersonalModelProvider value={personalModel}>
                          <BranchProvider value={branch}>
                            <TerminalProvider value={terminal}>
                              {/* The routes' loaders open what they show through `repo`, `views`, `branch` and `terminal`
                                  (src/router.tsx). */}
                              <IssuesProvider value={issues}>
                                <PullsProvider value={pulls}>
                                <SecretsProvider value={secrets}>
                                <TodosProvider value={todos}>
                                <RunsProvider value={runs}>
                                  <FlowsUiProvider value={flows}>
                                    <HomeProvider value={home}>
                                      <DocsProvider value={docs}>
                                      {/* The one toast stack reads the feed (decision 0009). */}
                                      <AttentionProvider value={attention}>
                                        {/* The plugin host: its slots in the shell, its views' routes (src/plugins/). */}
                                        <PluginsProvider value={plugins}>
                                          <RouterProvider
                                            router={router}
                                            context={{ repo, home, docs, views, branch, terminal, issues, pulls, todos, runs, flows, plugins, domains, secrets }}
                                          />
                                        </PluginsProvider>
                                      </AttentionProvider>
                                      </DocsProvider>
                                    </HomeProvider>
                                  </FlowsUiProvider>
                                </RunsProvider>
                                </TodosProvider>
                                </SecretsProvider>
                                </PullsProvider>
                              </IssuesProvider>
                            </TerminalProvider>
                          </BranchProvider>
                          </PersonalModelProvider>
                        </DomainsProvider>
                      </SpendProvider>
                    </StatusProvider>
                  </WebProvider>
                </ViewsProvider>
              </CommandsProvider>
              </CodeIntelProvider>
              </FilesProvider>
            </RepoProvider>
          </ThemeProvider>
        </AuthProvider>
      </ChatProvider>
    </StrictMode>,
  )

const page = {
  origin: window.location.origin,
  // Every request to ChatApi waits for the activation and carries the device's owner while this page has its data
  // open. Every session answer, Auth's at startup and on reconnect alike, checks the activation again: one naming
  // someone else, or a person signing in while this page is sealed until they do, reopens every page.
  fetch: boundFetch(window.fetch.bind(window), {
    origin: window.location.origin,
    principal: () => (activation.state() === "retained" && deviceOwner !== undefined ? deviceOwner : NO_DEVICE_DATA),
    ready: activation.ready,
    reauthorize: async () => void reopen(),
    reopensOnSignIn: () => activation.state() === "memory" && sealedUntilSignIn,
    adopt,
  }),
  reload: () => window.location.reload(),
  host,
  target: window,
  startedAt: performance.timeOrigin,
  // Keys' `mod` is ⌘ on a Mac, Ctrl elsewhere (src/plugins/keymap.ts).
  mac: /Mac|iPhone|iPad/.test(navigator.platform),
  render,
}

// Under the dev server, `?faults` opens the app on faulty services for the end-to-end tests of unhappy paths
// (src/test/e2e.ts). A production build drops this branch, and the test module with it. Either way, a wipe a sign-out
// marked finishes first, and a page whose wipe couldn't delete starts on stores that aren't the device's
// (src/wipe.ts `unwiped`). Leaving on a wipe drops the view, then stops the program.
void Promise.all([wipe.open(), claimEditorTabId({
  storage: { getItem: (key) => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value) },
  locks: navigator.locks, page: window, randomId: () => crypto.randomUUID(),
})]).then(([wiped, editorTab]) => {
  if (!wiped) activation.refuse()
  const tabHost: Host = { ...host, editorTabId: editorTab.id, editorTabPersistent: editorTab.persistent }
  const opened = { ...page, host: wiped ? tabHost : unwiped(tabHost) }
  const leaving = (stop: () => Promise<void>) =>
    wipe.started(() => {
      root.unmount()
      return stop()
    })
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("faults")) {
    void import("./test/e2e")
      .then((e2e) => e2e.startWithFaults(opened, window.location.search, window))
      .then(({ stop }) => leaving(stop))
  } else {
    leaving(start(opened, realServices(opened)).stop)
  }
})
