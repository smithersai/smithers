/* Every repo page: <RepoFrame tab="issues" title? askContext? askView?>children</RepoFrame>.
 * Descendants call useRepoFrame().openAsk(prompt?) to open/focus Ask.
 * askView is a suffix such as "issues/:n"; omitted values derive from the current route. */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { signInRoute } from "../../core/catalog"
import { flagsIn, useMock } from "../../core/mock"
import { Link, navigate, useLocation } from "../../core/router"
import { BASE, MOCK_NOW, flow, issue, KNOWN_REPOS, repo, to } from "../fixtures"
import type { TabId } from "../fixtures/types"
import { Counter, Icon, PersonChip, Tabs, Toast, toast } from "../ui"
import { registerIssueCommands } from "../views/issues/commands"
import { useRunRecords } from "../views/runs/shared"
import { AskPanel } from "./AskPanel"
import { formSubject, invokedAction } from "./subjects"
import { registerSlash } from "./slash"
import { PackageScopeControls, usePackageScope } from "./packageScope"
import { useWaitingOnYou } from "./waiting"
import { WORDMARK } from "../../core/wordmark"
import { useGitHubSync } from "./githubSync"

/* Shared fallbacks open the same confirmation as the view button. Mounted views can override either handler. */
registerSlash("issue.implement", {
  purpose: "Implement an issue",
  fields: [{ name: "issue", label: "Issue number", type: "number", min: 1 }],
  confirm: false,
  run: ({ issue: number }, { closeAsk }) => {
    if (!issue(Number(number))) throw new Error(`Issue #${number} wasn't found in this repository.`)
    closeAsk()
    navigate(to(`issues/${number}?act=implement`))
  }
})
registerSlash("box.open", {
  purpose: "Run on a sandbox",
  fields: [{ name: "branch", label: "Branch" }],
  confirm: "Open a sandbox on this branch?",
  run: ({ branch }, { flags, closeAsk }) => {
    if (flags.hosted === "paused") throw new Error("Hosted machines are paused. Try again when they resume.")
    closeAsk()
    navigate(to(`branches/${encodeURIComponent(branch)}/terminal`))
  }
})
registerSlash("flow.run", {
  purpose: "Run a flow",
  fields: [{ name: "flow", label: "Flow", required: false }],
  confirm: false,
  run: ({ flow: name }, { closeAsk }) => {
    if (name && !flow(name)) throw new Error(`Flow ${name} wasn't found in this repository.`)
    navigate(to(`flows${name ? `/${encodeURIComponent(name)}` : ""}?run=1`))
    closeAsk()
  }
})

registerSlash("files", {
  purpose: "Open files", fields: [], access: "public", confirm: false,
  run: (_, { location, closeAsk }) => {
    const ref = location.match(/\/(?:tree|blob|blame|commits)\/([^/?]+)/)?.[1]
    closeAsk()
    const query = location.split("?")[1]
    navigate(`${ref ? to(`tree/${ref}`) : to()}${query ? `?${query}` : ""}`)
  }
})
registerSlash("repo.clone", {
  purpose: "Clone repository", fields: [], access: "public", confirm: false,
  run: (_, { closeAsk }) => { closeAsk(); navigate(`${to()}?menu=code`) }
})
export const requestRepoImport = (slug: string) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error("Enter a repository as owner/name.")
  toast("Import requested. Check GitHub App access to continue.")
}
registerSlash("repo.import", {
  purpose: "Import repository", access: "signed-in", confirm: false,
  fields: [{ name: "repository", label: "Repository", placeholder: "owner/name" }],
  run: ({ repository }, { closeAsk }) => {
    requestRepoImport(repository)
    closeAsk()
    navigate(`smithers.sh/${repository}?import=requested`)
  }
})

const GitHubSyncChip = () => {
  const { flags } = useMock()
  const { state, lastSync, failure } = useGitHubSync()
  const elapsed = Math.max(0, Math.floor((Date.parse(MOCK_NOW) - Date.parse(lastSync)) / 60_000))
  const age = elapsed < 1 ? "just now" : elapsed < 60 ? `${elapsed} min ago` : elapsed < 1440 ? `${Math.floor(elapsed / 60)} h ago` : `${Math.floor(elapsed / 1440)} d ago`
  const member = flags.as === "in" && flags.role === "member"
  const content = <>
    <span className="repo-frame-sync-separator" aria-hidden="true">·</span>
    {state === "error" && <Icon name="x" size={16} />}
    {state === "error" ? failure : state === "stale" ? `Synced ${age}` : "Synced with GitHub"}
    {state === "error" && <><span aria-hidden="true">·</span><span className="repo-frame-last-sync">Last success {age}</span></>}
  </>
  const className = `repo-frame-github${state === "error" ? " repo-frame-sync-error" : ""}`
  return member
    ? <Link className={className} to={to("settings/sync")}>{content}</Link>
    : <span className={className}>{content}</span>
}

const FrameContext = createContext<{
  openAsk: (prompt?: string, options?: { send?: boolean }) => void
  closeAsk: () => void
  askOpen: boolean
  actionOpen: boolean
}>({ openAsk: () => {}, closeAsk: () => {}, askOpen: false, actionOpen: false })
export const useRepoFrame = () => useContext(FrameContext)
export const useAsk = useRepoFrame

const initialOpen = (location: string) => {
  if (new URLSearchParams(location.split("?")[1]).has("ask")) return true
  if (formSubject(location) || invokedAction(location)) return matchMedia("(min-width: 1440px)").matches
  try {
    const saved = sessionStorage.getItem("repo-ask-open")
    if (saved !== null) return saved === "true"
  } catch { /* session-only without storage */ }
  return matchMedia("(min-width: 1440px)").matches
}

export const RepoFrame = ({ tab, title, askContext, askView, children }: {
  tab: TabId | null
  title?: string
  askContext?: string
  askView?: string
  children: ReactNode
}) => {
  useLayoutEffect(() => registerIssueCommands(), [repo.slug])
  const location = useLocation()
  const { scope, withScope } = usePackageScope()
  const [routeOwner, routeName] = location.split("?")[0].split("/").slice(1, 3)
  const owner = routeOwner || repo.owner
  const name = routeName || repo.name
  const available = KNOWN_REPOS.includes(`${owner}/${name}`)
  const homeRoute = `smithers.sh/${owner}/${name}`
  const { flags, set } = useMock()
  useEffect(() => {
    if (!invokedAction(location)) return
    let first = 0
    let second = 0
    let revealed: Element | null = null
    const reveal = () => {
      const target = document.querySelector<HTMLElement>("#repo-content :is(.repo-issues-confirm, .repo-pulls-form-card, .repo-runs-confirm, .repo-flows-run-card, .repo-wiki-confirm, .repo-evals-confirm, [data-repo-action])")
      if (!target || target === revealed) return
      revealed = target
      first = window.requestAnimationFrame(() => { second = window.requestAnimationFrame(() => {
        target.scrollIntoView({ block: "start", behavior: "instant" })
        if (!target.hasAttribute("tabindex")) target.tabIndex = -1
        target.focus({ preventScroll: true })
      }) })
    }
    const observer = new window.MutationObserver(reveal)
    observer.observe(document.getElementById("repo-content") ?? document.body, { childList: true, subtree: true })
    reveal()
    return () => { observer.disconnect(); window.cancelAnimationFrame(first); window.cancelAnimationFrame(second) }
  }, [location])
  // Shell applies query flags after mount; initialization must use the route facts now.
  const routeFlags = { ...flags, ...flagsIn(new URLSearchParams(location.split("?")[1])) }
  const guestBlocked = routeFlags.as === "out" && routeFlags.guest === "off"
  const [askOpen, setAskOpen] = useState(() => !guestBlocked && initialOpen(location))
  const [actionOpen, setActionOpen] = useState(false)
  const [prompt, setPrompt] = useState({ text: "", revision: 0, send: false })
  const [mobileSearch, setMobileSearch] = useState(false)
  const [search, setSearch] = useState("")
  const [menuOpen, setMenuOpen] = useState(false)
  const avatarMenu = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const askTrigger = useRef<HTMLButtonElement>(null)
  // Signed out with guests off, Ask is the sign-in door: it returns here with Ask open. A typed draft never rides
  // in the return URL, which passes through the OAuth redirect and server logs.
  const askSignIn = () => {
    const [path, raw] = location.split("?")
    const query = new URLSearchParams(raw)
    query.delete("as")
    query.set("ask", "1")
    return signInRoute(`${path}?${query}`)
  }
  const openAsk = (text?: string, options?: { send?: boolean }) => {
    if (guestBlocked) {
      navigate(askSignIn())
      return
    }
    setAskOpen(true)
    setPrompt(current => ({ text: text ?? "", revision: current.revision + 1, send: options?.send ?? false }))
    try { sessionStorage.setItem("repo-ask-open", "true") } catch { /* optional persistence */ }
  }
  const closeAsk = () => {
    setAskOpen(false)
    try { sessionStorage.setItem("repo-ask-open", "false") } catch { /* optional persistence */ }
    askTrigger.current?.focus()
  }

  useEffect(() => {
    document.title = title ?? `${owner}/${name} · Smithers`
  }, [title, owner, name])
  useEffect(() => {
    if (guestBlocked) setAskOpen(false)
    else if (new URLSearchParams(location.split("?")[1]).has("ask")) setAskOpen(true)
    else if (formSubject(location) || invokedAction(location)) setAskOpen(matchMedia("(min-width: 1440px)").matches)
    setSearch("")
    setMobileSearch(false)
  }, [location, guestBlocked])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        if (askOpen) closeAsk()
        else openAsk()
      }
      const target = event.target as HTMLElement | null
      const editing = target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !editing) {
        event.preventDefault()
        if (matchMedia("(max-width: 767px)").matches) {
          if (askOpen) closeAsk()
          setMobileSearch(true)
        }
        searchInput.current?.focus()
      }
      if (event.key === "Escape") {
        setMenuOpen(false)
        setMobileSearch(false)
        if (askOpen) closeAsk()
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [askOpen])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!avatarMenu.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener("pointerdown", outside)
    return () => window.removeEventListener("pointerdown", outside)
  }, [])
  useEffect(() => {
    if (mobileSearch) searchInput.current?.focus()
  }, [mobileSearch])

  const { records: runRecords } = useRunRecords(undefined, false)
  const inbox = useWaitingOnYou()
  const waiting = !available || flags.data === "empty" ? 0 : inbox.total
  const labels: Record<TabId, ReactNode> = {
    code: "Code", issues: "Issues", pulls: "Pull requests", runs: "Runs",
    flows: "Flows", evals: repo.config.evals?.title ?? "Evals", wiki: "Wiki", docs: repo.config.docs?.title ?? "Docs", packages: "Packages", settings: "Settings"
  }
  const counts: Partial<Record<TabId, number>> = {
    issues: repo.counts.issuesOpen, pulls: repo.counts.pullsOpen, runs: runRecords.filter(item => ["running", "waiting", "queued"].includes(item.state)).length
  }
  const tabIds: TabId[] = ["code", "issues", "pulls", "runs", "flows", "wiki",
    ...(repo.config.docs ? ["docs" as const] : []), ...(repo.config.evals ? ["evals" as const] : []),
    ...(repo.config.packages ? ["packages" as const] : []), "settings"]
  const view = askView ?? location.split("?")[0].replace(`${BASE}/`, "").replace(BASE, "")
  const theme = (next: "light" | "dark") => {
    document.documentElement.dataset.theme = next
    try { localStorage.setItem("site-mock-theme", next) } catch { /* optional persistence */ }
    setMenuOpen(false)
  }
  const signOut = () => {
    set({ as: "out" })
    setMenuOpen(false)
    const [path, raw] = location.split("?")
    const query = new URLSearchParams(raw)
    query.set("as", "out")
    navigate(`${path}?${query}`, { replace: true })
  }
  const searchRepo = (query: string) => {
    navigate(`${homeRoute}/search?q=${encodeURIComponent(query.trim())}`)
    setMobileSearch(false)
  }
  // Stable registrations read the latest frame state, including the route query and account flags.
  const actions = useRef({ openAsk, closeAsk, theme, signOut, searchRepo })
  actions.current = { openAsk, closeAsk, theme, signOut, searchRepo }
  useEffect(() => {
    if (askOpen) return
    return registerSlash("ask", {
      purpose: "Ask", fields: [{ name: "question", label: "Question", type: "textarea", required: false }],
      access: "public", confirm: false, run: ({ question }) => actions.current.openAsk(question)
    })
  }, [askOpen, homeRoute])
  useLayoutEffect(() => {
    const navigation = ["branches", "commits", "issues", "pulls", "runs", "flows", "wiki", "releases", "tags", "approvals", "stack", "agents",
      ...(repo.config.docs ? ["docs"] : []), ...(repo.config.evals ? ["evals"] : []), "settings"]
    const off = [
      ...navigation.map(name => registerSlash(name, {
        purpose: `Open ${name}`, fields: [], access: name === "settings" ? "member" : "public", confirm: false,
        run: (_, { location, closeAsk }) => {
          const ref = location.match(/\/(?:tree|blob|blame|commits)\/([^/?]+)/)?.[1] ?? encodeURIComponent(repo.defaultBranch)
          const query = location.split("?")[1]
          const path = name === "commits" ? `commits/${ref}` : name === "evals" && repo.config.evals?.title === "Golden set" ? "evals/convert-golden" : name
          closeAsk()
          navigate(`${to(path)}${query ? `?${query}` : ""}`)
        }
      })),
      registerSlash("ask.close", {
        purpose: "Close Ask", fields: [], access: "public", confirm: false,
        userOnly: "Close Ask with this button or Escape.", run: () => actions.current.closeAsk()
      }),
      registerSlash("signin", {
        purpose: "Sign in with GitHub", fields: [], access: "public", confirm: false,
        userOnly: "Signing in needs your GitHub authorization.",
        run: (_, context) => navigate(signInRoute(context.location))
      }),
      registerSlash("signout", {
        purpose: "Sign out", fields: [], access: "signed-in", confirm: false,
        userOnly: "Only you can sign out of this browser.", run: () => actions.current.signOut()
      }),
      registerSlash("theme", {
        purpose: "Change theme", fields: [{ name: "theme", label: "Theme", options: ["light", "dark"] }],
        access: "public", confirm: false, userOnly: "Theme changes apply to your browser.",
        run: ({ theme: value }) => actions.current.theme(value as "light" | "dark")
      }),
      registerSlash("account.menu", {
        purpose: "Open account menu", fields: [], access: "signed-in", confirm: false,
        userOnly: "Account controls need your click.",
        run: (_, { closeAsk }) => { closeAsk(); setMenuOpen(current => !current) }
      }),
      registerSlash("search", {
        purpose: "Search repository", fields: [{ name: "query", label: "Search" }], access: "public", confirm: false,
        run: ({ query }, { closeAsk }) => { actions.current.searchRepo(query); closeAsk() }
      }),
      registerSlash("repo.request-access", {
        purpose: "Request access", fields: [], access: "signed-in", confirm: false,
        run: () => { toast("Access requested from maya.") }
      })
    ]
    return () => off.forEach(dispose => dispose())
  }, [homeRoute])

  return (
    <FrameContext.Provider value={{ openAsk, closeAsk, actionOpen: actionOpen && askOpen && !guestBlocked, askOpen: askOpen && !guestBlocked }}>
      <div className="repo-frame" data-page="repo" data-packages={Boolean(repo.config.packages)} data-ask-open={askOpen && !guestBlocked}>
        <Link
          className="repo-frame-skip"
          to={location}
          onClick={event => {
            event.preventDefault()
            document.getElementById("repo-content")?.focus()
          }}
        >
          Skip to content
        </Link>
        <header className="repo-frame-global">
          <Link to="smithers.sh/" className="repo-frame-mark" aria-label="Smithers home">
            <pre aria-label="Smithers">{WORDMARK.join("\n")}</pre>
          </Link>
          <div className="repo-frame-crumbs">
            <Link to="smithers.sh/">{owner}</Link>
            <span>/</span>
            <Link to={homeRoute}>{name}</Link>
          </div>
          <div className="repo-frame-global-spacer" />
          <form
            className="repo-frame-search"
            data-expanded={mobileSearch}
            role="search"
            onSubmit={event => {
              event.preventDefault()
              if (!search.trim()) return
              searchRepo(search)
            }}
          >
            <label className="repo-ui-sr" htmlFor="repo-search">Search this repository</label>
            <Icon name="search" />
            <input
              id="repo-search"
              ref={searchInput}
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search this repository…"
              autoComplete="off"
            />
            <kbd aria-hidden="true">/</kbd>
          </form>
          <button
            className="repo-ui-icon-btn repo-frame-search-toggle"
            title="/search"
            aria-label="Search repository"
            aria-expanded={mobileSearch}
            onClick={() => setMobileSearch(!mobileSearch)}
          >
            <Icon name="search" size={19} />
          </button>
          {flags.as === "out" ? (
            <Link className="repo-ui-btn repo-ui-btn-quiet" title="/signin" to={signInRoute(location)}>
              Sign in
            </Link>
          ) : (
            <>
              {available && <Link
                className="repo-frame-inbox"
                to={homeRoute + "/approvals"}
                title="Waiting on you"
                aria-label={waiting > 0 ? `${waiting} waiting on you` : "Waiting on you"}
              >
                <Icon name="clock" />
                <span className="repo-frame-inbox-label">Waiting on you</span>
                {waiting > 0 && <Counter>{waiting}</Counter>}
              </Link>}
              <div className="repo-frame-avatar-menu" ref={avatarMenu}>
                <button
                  className="repo-frame-avatar-button"
                  title="/account.menu"
                  aria-label="Open maya's account menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(!menuOpen)}
                >
                  <PersonChip login="maya" compact />
                </button>
                {menuOpen && (
                  <div className="repo-ui-menu repo-frame-account">
                    <span className="repo-frame-account-name">maya</span>
                    <Link to="smithers.sh/" onClick={() => setMenuOpen(false)}>Your repositories</Link>
                    <Link to={to("settings")} onClick={() => setMenuOpen(false)}>Settings</Link>
                    <button title="/theme light" onClick={() => theme("light")}>Light theme</button>
                    <button title="/theme dark" onClick={() => theme("dark")}>Dark theme</button>
                    <button
                      title="/signout"
                      onClick={signOut}
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </header>
        <div className="repo-frame-workspace">
          <div className="repo-frame-page">
            <header className="repo-frame-repo-header">
              <div className="repo-frame-repo-title-row">
                <div className="repo-frame-repo-title">
                  <Icon name="folder" size={20} />
                  <h1>
                    <Link to="smithers.sh/">{owner}</Link>
                    <span>/</span>
                    <Link to={homeRoute}>{name}</Link>
                  </h1>
                  {available && (
                    <span className="repo-frame-visibility">
                      {repo.visibility === "public" ? "Public" : "Private"}
                    </span>
                  )}
                  {available && <GitHubSyncChip />}
                </div>
                {guestBlocked ? (
                  <Link className="repo-ui-btn repo-frame-ask-button" title="Sign in to ask" to={askSignIn()}>
                    Ask
                    <kbd>⌘K</kbd>
                  </Link>
                ) : <button
                  ref={askTrigger}
                  className="repo-ui-btn repo-frame-ask-button"
                  title="/ask · ⌘K"
                  aria-controls="repo-ask-panel"
                  aria-expanded={askOpen && !guestBlocked}
                  aria-pressed={askOpen && !guestBlocked}
                  onClick={() => askOpen ? closeAsk() : openAsk()}
                >
                  Ask
                  <kbd>⌘K</kbd>
                </button>}
              </div>
              <Tabs
                label="Repository"
                active={tab ?? undefined}
                items={tabIds
                  .filter(id => (available || id === "code")
                    && (id !== "docs" || repo.config.docs)
                    && (id !== "packages" || repo.config.packages)
                    && (id !== "settings" || (flags.as === "in" && flags.role === "member")))
                  .map(id => ({
                    id, label: labels[id], to: withScope(id === "code" ? homeRoute : to(id === "evals" && repo.config.evals?.title === "Golden set" ? "evals/convert-golden" : id)),
                    count: counts[id] === undefined ? undefined : flags.data === "empty" ? 0 : counts[id]
                  }))}
              />
              {available && repo.config.packages && <PackageScopeControls />}
            </header>
            <main className="repo-frame-content" id="repo-content" tabIndex={-1}>
              {children}
            </main>
          </div>
          {askOpen && !guestBlocked && (
            <AskPanel
              key={`${homeRoute}:${view}`}
              view={view}
              available={available}
              context={!available ? `${owner}/${name}` : scope && !askContext?.includes(scope.name) ? `${askContext ?? `${repo.slug} at ${repo.defaultBranch}`} · ${scope.name}` : askContext}
              prompt={prompt}
              onClose={closeAsk}
              onActionChange={setActionOpen}
            />
          )}
        </div>
        <Toast />
      </div>
    </FrameContext.Provider>
  )
}
