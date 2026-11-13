import { pluralize } from "../../ui/pluralize"
import { fixedByAgents, useIssues } from "../issues/model"
/* Code-home states are exported for review. Every fixture read happens during render. */
import { useEffect, useId, useRef, useState } from "react"
import { signInRoute } from "../../../core/catalog"
import { useMock } from "../../../core/mock"
import { Link, navigate, useLocation } from "../../../core/router"
import {
  branches, children, commit, file, history, KNOWN_REPOS,
  lastCommitFor, releases, repo, shortSha, tags, to, tree
} from "../../fixtures"
import type { HomeBlock, Issue } from "../../fixtures/types"
import { Denied, Failed, Loading, registerSlash, SignInWall, useRepoFrame, useView, usePackageScope } from "../../frame"
import {
  AgentMark, Box, BranchPicker, CopyButton, Icon, Markdown, PersonChip,
  RelTime, Sidebar, SidebarSection
} from "../../ui"
import { ViewFrame as RepoFrame } from "../checklist/ViewFrame"
import { FactoryReceipt as ReceiptStepper } from "../issues/shared"
import { requestRepoImport } from "../../frame/RepoFrame"

const cloneHTTPS = () => `${repo.github ?? `https://smithers.sh/${repo.slug}`}.git`
const cloneSSH = () => repo.github ? `git@github.com:${repo.slug}.git` : `ssh://smithers.sh/${repo.slug}.git`

const SetupCommand = ({ command }: { command: string }) => (
  <div className="repo-code-home-command">
    <code>{command}</code>
    <CopyButton text={command} small />
  </div>
)

export const CodeHomeLoading = () => (
  <div className="repo-code-home-layout">
    <Loading variant="file" rows={9} />
    <Loading variant="detail" rows={4} />
  </div>
)
export const CodeHomeError = () => (
  <Failed primary what="repository files" reason="The repository host didn't respond. Your files haven't loaded." />
)
export const CodeHomeDenied = () => <Denied act="run a sandbox" />
export const CodeHomeSignedOut = () => <SignInWall act="run a sandbox" />
export const CodeHomeEmpty = () => {
  const { openAsk, askOpen } = useRepoFrame()
  return (
    <Box header="Quick setup">
      <div className="repo-code-home-setup">
        <h2>{repo.name} is empty.</h2>
        <SetupCommand command={`git clone ${cloneHTTPS()}`} />
        <SetupCommand command={`smthrs open ${repo.slug}`} />
        <button
          className={`repo-ui-btn${askOpen ? "" : " repo-ui-btn-primary"}`}
          title="/ask Scaffold a small TypeScript HTTP router"
          onClick={() => openAsk("Scaffold a small TypeScript HTTP router")}
        >
          Ask Smithers to scaffold
        </button>
      </div>
    </Box>
  )
}

export const CodeHomeNotImported = ({ owner, name }: { owner: string; name: string }) => {
  const { flags } = useMock()
  const location = useLocation()
  const [requested, setRequested] = useState(new URLSearchParams(location.split("?")[1]).get("import") === "requested")
  const importRepo = (slug: string) => {
    requestRepoImport(slug)
    if (slug === `${owner}/${name}`) setRequested(true)
    else navigate(`smithers.sh/${slug}?import=requested`)
  }
  useEffect(() => registerSlash("repo.import", {
    purpose: "Import repository", access: "signed-in", confirm: false,
    fields: [{ name: "repository", label: "Repository", placeholder: "owner/name" }],
    run: ({ repository }) => importRepo(repository)
  }), [owner, name])
  return (
    <section className="repo-frame-state repo-code-home-import">
      <h2>{owner}/{name} isn't on Smithers yet.</h2>
      {flags.as === "out" ? (
        <Link className="repo-ui-btn repo-ui-btn-primary" title="/signin" to={signInRoute(location)}>
          Sign in to import it
        </Link>
      ) : (
        <button
          className="repo-ui-btn repo-ui-btn-primary"
          title={`/repo.import ${owner}/${name}`}
          onClick={() => importRepo(`${owner}/${name}`)}
        >
          {requested ? "Import requested" : "Import"}
        </button>
      )}
      <a href={`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`} target="_blank" rel="noopener noreferrer">
        View on GitHub
        <Icon name="external" size={13} />
      </a>
    </section>
  )
}

const ReceiptDate = ({ date }: { date: string }) => (
  <time dateTime={date} title={new Date(date).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}>
    {new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
    {" · "}
    {new Date(date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}
  </time>
)

const EvidenceStrip = ({ item, compact = false }: { item: Issue; compact?: boolean }) => {
  const receipt = item.receipt
  if (compact && receipt?.landed) return <article className="repo-code-home-evidence repo-code-home-fix">
    <ReceiptDate date={receipt.landed.date} />
    <div className="repo-code-home-fix-links"><Link to={to(`issues/${item.n}`)}>#{item.n}</Link><Link to={to(`commit/${receipt.landed.sha}`)}><code>{shortSha(receipt.landed.sha)}</code></Link></div>
    <Link className="repo-code-home-fix-title" to={to(`issues/${item.n}`)}>{item.title}</Link>
    <AgentMark run={receipt.working?.run} />
    {receipt.review && <Link to={to(`pull/${receipt.review.pull}`)}>#{receipt.review.pull}</Link>}
  </article>
  return (
    <article className="repo-code-home-evidence">
      <div className="repo-code-home-evidence-heading"><Link className="repo-code-home-evidence-title" to={to(`issues/${item.n}`)}>
        <span className="repo-ui-muted">#{item.n}</span>
        {item.title}
      </Link><AgentMark run={receipt?.working?.run} /></div>
      <ReceiptStepper issue={item} compact />
    </article>
  )
}

type AppBlock = Extract<HomeBlock, { type: "app" }>
const HomeApps = ({ blocks }: { blocks: AppBlock[] }) => {
  const { openAsk } = useRepoFrame()
  return (
    <div className="repo-code-home-apps" aria-label="Repository apps">
      {blocks.map((block, i) => {
        const command = `/${block.flow.replace(/^\//, "")}`
        const icon = block.picture === "issue" ? "issue" : block.picture === "review" ? "change"
          : block.picture === "schedule" ? "clock" : "file"
        return (
          <button
            key={`${block.flow}:${i}`}
            className="repo-code-home-app"
            title={command}
            onClick={() => openAsk(command, { send: true })}
          >
            <Icon name={icon} size={18} />
            <span>{block.title}</span>
          </button>
        )
      })}
    </div>
  )
}

const HomePrompt = ({ block }: { block: Extract<HomeBlock, { type: "prompt" }> }) => {
  const { openAsk, askOpen } = useRepoFrame()
  const { flags } = useMock()
  const blocked = flags.as === "out" && flags.guest === "off"
  const id = useId()
  const { scope } = usePackageScope()
  const label = (text: string) => text.replaceAll("{package}", scope?.name ?? "the workspace")
  const [input, setInput] = useState("")
  const primary = !repo.config.home?.some(item => item.type === "prompt") || repo.config.home.find(item => item.type === "prompt") === block
  if (askOpen) return null
  return (
    <Box header={label(block.title)}>
      {blocked ? <div className="repo-code-home-block"><button className="repo-ui-btn" title="/ask" onClick={() => openAsk(input)}>{`Sign in to ${label(block.title).replace(/^Ask\b/, "ask")}`}</button></div> : (
      <form
        className="repo-code-home-block"
        onSubmit={event => {
          event.preventDefault()
          if (input.trim()) openAsk(scope ? `${scope.name}: ${input.trim()}` : input.trim(), { send: true })
        }}
      >
        <label className="repo-ui-sr" htmlFor={id}>{label(block.title)}</label>
        <input
          className="repo-ui-input"
          id={id}
          placeholder={label(block.placeholder)}
          value={input}
          onChange={event => setInput(event.target.value)}
          required
        />
        <div className="repo-ui-actions">
          {block.chips?.map(chip => (
            <button key={chip} type="button" className="repo-ui-btn" title={`/ask ${chip}`} onClick={() => openAsk(chip)}>
              {chip}
            </button>
          ))}
          <button className={`repo-ui-btn${primary ? " repo-ui-btn-primary" : ""}`} title="/ask" disabled={!input.trim()}>Send</button>
        </div>
      </form>
      )}
    </Box>
  )
}

const HomeConfigBlock = ({ block }: { block: HomeBlock }) => {
  const issues = useIssues()
  if (block.type === "text") {
    return (
      <div className="repo-code-home-block repo-code-home-intro">
        <Markdown source={block.text} />
      </div>
    )
  }
  if (block.type === "markdown") {
    return (
      <Box header={block.title}>
        <div className="repo-code-home-block">
          <Markdown source={file(block.path)?.content ?? ""} />
        </div>
      </Box>
    )
  }
  if (block.type === "links") {
    return (
      <nav className="repo-code-home-links" aria-label="Repository links">
        {block.links.map(link => {
          const internal = link.url.replace(/^https?:\/\/(?=smithers\.sh(?:\/|$))/, "")
          return /^https?:/.test(internal) ? (
            <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">
              {link.label}
              <Icon name="external" size={13} />
            </a>
          ) : (
            <Link key={link.url} to={internal === "/" ? "smithers.sh/" : internal.startsWith("smithers.sh/") ? internal : to(internal)}>
              {link.label}
              <Icon name="chevron" size={13} />
            </Link>
          )
        })}
      </nav>
    )
  }
  if (block.type === "fixed-by-agents") {
    const fixed = block.issues.map(n => issues.find(item => item.n === n)).filter((item): item is Issue => Boolean(item && fixedByAgents(item)))
    if (!fixed.length) return null
    return (
      <Box header="Fixed by agents">
        {fixed.map(item => <EvidenceStrip key={item.n} item={item} compact={block.compact} />)}
      </Box>
    )
  }
  if (block.type === "app") return <HomeApps blocks={[block]} />
  return <HomePrompt block={block} />
}

const HomeConfig = () => {
  const { flags } = useMock()
  const blocks = repo.config.home ?? []
  const apps = blocks.filter((block): block is AppBlock => block.type === "app")
  const ordered = [
    ...blocks.filter(block => block.type === "text"),
    ...blocks.filter(block => block.type === "prompt"),
    ...blocks.filter(block => block.type === "links"),
    ...blocks.filter(block => block.type === "fixed-by-agents"),
    ...(apps.length && flags.as === "in" && flags.role === "member" ? [apps] : [])
  ]
  return (
    <>
      {ordered.map((block, i) => Array.isArray(block)
        ? <HomeApps key={i} blocks={block} />
        : <HomeConfigBlock key={i} block={block} />)}
    </>
  )
}

const CodeHomeToolbar = ({ finderOpen, onFind, onSandbox }: {
  finderOpen: boolean
  onFind: () => void
  onSandbox: (trigger: HTMLElement) => void
}) => {
  const location = useLocation()
  const { flags } = useMock()
  const query = new URLSearchParams(location.split("?")[1])
  const cloneMenu = useRef<HTMLDetailsElement>(null)
  useEffect(() => registerSlash("repo.clone", {
    purpose: "Clone repository", fields: [], access: "public", confirm: false,
    run: (_, { closeAsk }) => {
      closeAsk()
      if (cloneMenu.current) { cloneMenu.current.open = true; cloneMenu.current.querySelector("button")?.focus() }
    }
  }), [])
  return (
    <div className="repo-code-home-toolbar">
      <BranchPicker />
      <Link className="repo-code-home-ref-count" to={to("branches")}>
        <Icon name="change" size={15} />
        <strong>{branches.length}</strong> {pluralize(branches.length, "branch", "branches")}
      </Link>
      <Link className="repo-code-home-ref-count" to={to("tags")}>
        <strong>{tags.length}</strong> {pluralize(tags.length, "tag")}
      </Link>
      <span className="repo-code-home-toolbar-spacer" />
      <button className="repo-ui-btn" title="/file.find" aria-expanded={finderOpen} onClick={onFind}>Go to file</button>
      <details ref={cloneMenu} className="repo-ui-dropdown repo-code-home-code-menu" open={query.get("menu") === "code" || undefined}>
        <summary className="repo-ui-btn" title="/repo.clone">
          Code
          <Icon name="chevron-down" size={13} />
        </summary>
        <div className="repo-ui-menu">
          <h3>Clone</h3>
          <span className="repo-ui-muted">HTTPS</span>
          <SetupCommand command={cloneHTTPS()} />
          <span className="repo-ui-muted">SSH</span>
          <SetupCommand command={cloneSSH()} />
          <h3>Open locally</h3>
          <SetupCommand command={`smthrs open ${repo.slug}`} />
          {flags.as === "in" && (
            <button className="repo-ui-menu-item" title={`/box.open ${repo.defaultBranch}`} onClick={event => onSandbox(event.currentTarget)}>
              Run on a sandbox
              <Icon name="chevron" size={13} />
            </button>
          )}
        </div>
      </details>
    </div>
  )
}

const CodeHomeFinder = ({ onClose }: { onClose: () => void }) => {
  const [filter, setFilter] = useState("")
  const finder = useRef<HTMLInputElement>(null)
  const matches = tree.filter(item => item.kind === "file" && item.path.toLowerCase().includes(filter.toLowerCase()))
  useEffect(() => finder.current?.focus(), [])
  return (
    <Box>
      <div className="repo-code-home-finder">
        <label htmlFor="repo-file-finder">Go to file</label>
        <input
          ref={finder}
          className="repo-ui-input"
          id="repo-file-finder"
          value={filter}
          onChange={event => setFilter(event.target.value)}
          onKeyDown={event => { if (event.key === "Escape") onClose() }}
          placeholder="Search files…"
        />
        {matches.map(item => (
          <Link key={item.path} to={to(`blob/${repo.defaultBranch}/${item.path}`)}>
            <Icon name="file" size={14} />
            {item.path}
          </Link>
        ))}
        {!matches.length && <p className="repo-ui-muted">No files found.</p>}
      </div>
    </Box>
  )
}

const CodeHomeFiles = () => {
  const latest = history(repo.defaultBranch)[0]
  return (
    <Box
      className="repo-code-home-files"
      header={latest && (
        <div className="repo-code-home-latest">
          <PersonChip login={latest.author} compact />
          <Link className="repo-code-home-latest-title" to={to(`commit/${latest.sha}`)}>{latest.title}</Link>
          {latest.agent && <AgentMark agent={latest.agent} />}
          <Link className="repo-code-home-sha" to={to(`commit/${latest.sha}`)}>{shortSha(latest.sha)}</Link>
          <RelTime date={latest.date} />
          <Link className="repo-code-home-commit-count" to={to(`commits/${repo.defaultBranch}`)}>
            <Icon name="clock" size={14} />
            {history(repo.defaultBranch).length} {pluralize(history(repo.defaultBranch).length, "commit")}
          </Link>
        </div>
      )}
    >
      <div className="repo-code-home-file-table" role="table" aria-label="Repository files">
        <div className="repo-ui-sr" role="row">
          <span role="columnheader">Name</span>
          <span role="columnheader">Last commit</span>
          <span role="columnheader">Updated</span>
        </div>
        {children("").map(entry => {
          const last = commit(entry.sha) ?? lastCommitFor(entry.path)
          return (
            <div className="repo-code-home-file-row" role="row" key={entry.path}>
              <span role="cell">
                <Link to={to(`${entry.kind === "dir" ? "tree" : "blob"}/${repo.defaultBranch}/${entry.path}`)}>
                  <Icon name={entry.kind === "dir" ? "folder" : "file"} size={17} />
                  {entry.path}
                </Link>
              </span>
              <span className="repo-code-home-file-message" role="cell">
                {last && (
                  <>
                    <Link to={to(`commit/${last.sha}`)}>{last.title}</Link>
                    {last.agent && <AgentMark agent={last.agent} />}
                  </>
                )}
              </span>
              <span role="cell">{last && <RelTime date={last.date} />}</span>
            </div>
          )
        })}
      </div>
    </Box>
  )
}

const CodeHomeReadme = () => {
  const readme = file("README.md")
  return (
    <>
    {!repo.config.home?.some(block => block.type === "prompt") && <HomePrompt block={{ type: "prompt", title: "Ask about this repo", placeholder: "Ask about this repo…" }} />}
    <Box header={(
      <div className="repo-code-home-readme-header">
        <Link to={to(`blob/${repo.defaultBranch}/README.md`)}>
          <Icon name="file" size={15} />
          README.md
        </Link>

      </div>
    )}>
      <article className="repo-code-home-readme">
        {readme ? <Markdown source={readme.content} /> : <p className="repo-ui-muted">No README yet.</p>}
      </article>
    </Box>
    </>
  )
}

const CodeHomeSidebar = () => {
  const latestRelease = releases.find(item => item.latest) ?? releases[0]
  return (
    <Sidebar>
      <SidebarSection title="Releases">
        {latestRelease && (
          <Link className="repo-code-home-release" to={to(`releases/tag/${latestRelease.tag}`)}>
            <span>{latestRelease.tag}</span>
            <RelTime date={latestRelease.date} />
          </Link>
        )}
        <Link className="repo-code-home-side-link" to={to("releases")}>
          {releases.length} {pluralize(releases.length, "release")}
          <Icon name="chevron" size={13} />
        </Link>
      </SidebarSection>
    </Sidebar>
  )
}

const SandboxDialog = ({ onClose }: { onClose: () => void }) => {
  const { flags } = useMock()
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => registerSlash("cancel", {
    purpose: "Close sandbox confirmation", fields: [], access: "public", confirm: false,
    run: () => close.current()
  }), [])
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("button, a[href]")?.focus()
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose() }
    window.addEventListener("keydown", close)
    return () => window.removeEventListener("keydown", close)
  }, [])
  return (
    <div className="repo-code-home-dialog-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
      <div
        className="repo-code-home-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Run on a sandbox"
        ref={dialog}
        onKeyDown={event => {
          if (event.key !== "Tab") return
          const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),a[href]')]
          if (event.shiftKey && document.activeElement === elements[0]) {
            event.preventDefault()
            elements.at(-1)?.focus()
          } else if (!event.shiftKey && document.activeElement === elements.at(-1)) {
            event.preventDefault()
            elements[0]?.focus()
          }
        }}
      >
        <button className="repo-ui-icon-btn repo-code-home-dialog-close" title="/cancel" aria-label="Close sandbox confirmation" onClick={onClose}>
          <Icon name="x" />
        </button>
        {flags.as === "out" ? <CodeHomeSignedOut /> : flags.role !== "member" ? <CodeHomeDenied /> : flags.hosted === "paused" ? (
          <>
            <h2>Hosted machines are paused.</h2>
            <p>Try again when they resume.</p>
            <button className="repo-ui-btn" title="/cancel" onClick={onClose}>Close</button>
          </>
        ) : (
          <>
            <h2>Run on a sandbox</h2>
            <p>{repo.slug} <span className="repo-ui-muted">/</span> {repo.defaultBranch}</p>
            <div className="repo-ui-actions">
              <button
                className="repo-ui-btn repo-ui-btn-primary"
                title={`/box.open ${repo.defaultBranch}`}
                onClick={() => {
                  onClose()
                  navigate(to(`branches/${encodeURIComponent(repo.defaultBranch)}/terminal`))
                }}
              >
                Open sandbox
              </button>
              <button className="repo-ui-btn repo-ui-btn-quiet" title="/cancel" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export const CodeHomeReady = () => {
  const location = useLocation()
  const query = new URLSearchParams(location.split("?")[1])
  const [sandbox, setSandbox] = useState(query.get("dialog") === "sandbox")
  const [finderOpen, setFinderOpen] = useState(false)
  const findFile = (path = "") => {
    if (path) {
      if (!file(path)) throw new Error(`File ${path} wasn't found in this repository.`)
      navigate(to(`blob/${repo.defaultBranch}/${path}`))
    } else setFinderOpen(current => !current)
  }
  useEffect(() => registerSlash("file.find", {
    purpose: "Go to file",
    fields: [{ name: "path", label: "File path", required: false }],
    access: "public",
    confirm: false,
    run: ({ path }, { closeAsk }) => { findFile(path); closeAsk() }
  }), [repo.slug])
  const sandboxTrigger = useRef<HTMLElement | null>(null)
  const closeSandbox = () => {
    setSandbox(false)
    sandboxTrigger.current?.focus()
  }
  return (
    <>
      <div className="repo-code-home-layout">
        <div className="repo-code-home-main">
          <CodeHomeToolbar
            finderOpen={finderOpen}
            onFind={() => findFile()}
            onSandbox={trigger => {
              sandboxTrigger.current = trigger
              setSandbox(true)
            }}
          />
          <HomeConfig />
          {finderOpen && <CodeHomeFinder onClose={() => setFinderOpen(false)} />}
          {repo.config.home?.length ? <h2 className="repo-code-home-files-heading">Files</h2> : null}
          <CodeHomeFiles />
          <CodeHomeReadme />
        </div>
        <CodeHomeSidebar />
      </div>
      {sandbox && <SandboxDialog onClose={closeSandbox} />}
    </>
  )
}

export const CodeHome = ({ owner, name }: { owner: string; name: string }) => {
  const state = useView(`code-home:${owner}/${name}`)
  return (
    <RepoFrame tab="code" askView="" askContext={`${repo.slug} at ${repo.defaultBranch}`} title={`${owner}/${name} · Smithers`}>
      {!KNOWN_REPOS.includes(`${owner}/${name}`) ? <CodeHomeNotImported key={`${owner}/${name}`} owner={owner} name={name} />
        : state === "loading" ? <CodeHomeLoading />
        : state === "error" ? <CodeHomeError />
        : state === "empty" ? <CodeHomeEmpty />
        : <CodeHomeReady key={repo.slug} />}
    </RepoFrame>
  )
}
