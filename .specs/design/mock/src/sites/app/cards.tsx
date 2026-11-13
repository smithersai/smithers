/* The cards that live in a repo's transcript. */
import { useContext, useEffect, useMemo, useState } from "react"
import { EXTERNAL, signInRoute } from "../core/catalog"
import { still, useMock, useRead } from "../core/mock"
import { Link, navigate, resolveRoute, useLocation } from "../core/router"
import type { Repo as FixtureRepo } from "../repo/fixtures/types"
import type { Answer, Issue, Pull, RepoData, Run } from "./data"
import { Avatar, Card, CopyButton, highlightLines, Icon, Markdown, Pill, ReadError, SkeletonRows, useElapsed, type LinkResolver } from "./lib"
import { BROKEN_EFFECT, FAILED_EFFECK, DIAGNOSTICS } from "../front/effeck-content"
import { ComposerContext } from "./frame"

export const docResolver = (repo: RepoData, currentPath = ""): LinkResolver => (href) => {
  if (/^(https?|mailto):/.test(href)) return { kind: "external", href }
  if (href.startsWith("#")) return { kind: "text" }
  if (href.startsWith("smithers.sh/") || href.startsWith("effeck.dev/")) return { kind: "route", to: href }
  const base = currentPath.split("/").slice(0, -1)
  for (const part of href.split("/")) {
    if (part === "." || part === "") continue
    else if (part === "..") base.pop()
    else base.push(part)
  }
  const resolved = base.join("/")
  if (repo.files[resolved] !== undefined) return { kind: "route", to: `smithers.sh/${repo.slug}/blob/main/${resolved}` }
  if (repo.github !== null) return { kind: "external", href: `${repo.github}/blob/main/${resolved}` }
  return { kind: "text" }
}

export const PersonPrompt = ({ who, name, text, id }: { who: "maya" | "guest" | "will"; name: string; text: string; id?: string }) => (
  <div className="app-prompt" data-rail={id}>
    <Avatar who={who} />
    <div className="app-prompt-text"><span className="app-prompt-name">{name}</span>{text}</div>
  </div>
)

export const SmithersReply = ({ answer, repo, signedOut }: { answer: Answer; repo: RepoData; signedOut: boolean }) => {
  const [open, setOpen] = useState(false)
  return (
    <div data-rail={answer.q !== "" ? `a-${answer.q.slice(0, 12)}` : undefined}>
      <div className="app-reply-head"><Avatar who="smithers" /><span className="app-reply-name">Smithers</span></div>
      <button type="button" className="app-disclosure" data-open={open} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={12} /> {signedOut ? "Answered from the docs and README" : answer.disclosure}
      </button>
      {open && (
        <div className="app-disclosure-files">
          {answer.files.map((file, i) => (
            <Link key={i} to={`smithers.sh/${repo.slug}/blob/main/${file.path}${file.label.includes(":") ? `?L=${file.label.split(":")[1]}` : ""}`}>{file.path}</Link>
          ))}
        </div>
      )}
      <div className="app-reply-body"><Markdown source={answer.md} resolve={docResolver(repo)} dense /></div>
      {signedOut && answer.openOwn === true && (
        <p className="app-reply-quiet"><Link to="smithers.sh/">Open your own repo</Link></p>
      )}
    </div>
  )
}

export const CeilingCard = () => {
  const location = useLocation()
  return (
    <Card title="That's today's tenth guest question.">
      <p className="app-pr-note" style={{ marginBottom: 12 }}>Sign in with GitHub to keep asking.</p>
      <Link to={signInRoute(location)} className="app-btn app-btn-primary">Sign in with GitHub</Link>
    </Card>
  )
}

export const SignInToAskReply = ({ what }: { what: string }) => {
  const location = useLocation()
  return (
    <div>
      <div className="app-reply-head"><Avatar who="smithers" /><span className="app-reply-name">Smithers</span></div>
      <div className="app-reply-body">
        <p style={{ margin: "0 0 12px" }}>{what === "off" ? "Guest questions are off right now. Sign in with GitHub to ask." : "Changes need an account. Sign in with GitHub to open your own repo."}</p>
        <Link to={signInRoute(location)} className="app-btn app-btn-primary">Sign in with GitHub</Link>
      </div>
    </div>
  )
}

const RECEIPT_STEPS = ["Reported", "Accepted", "Working", "In review", "Merged"] as const
export const FactoryReceipt = ({ repo, issue }: { repo: RepoData; issue: Issue }) => {
  const receipt = issue.receipt
  if (receipt === undefined) return null
  const reached = receipt.stage === "reported" ? 0 : receipt.stage === "accepted" ? 1 : receipt.stage === "working" ? 2 : receipt.stage === "review" ? 3 : 4
  const evidence = (step: number) => {
    if (receipt === undefined) return null
    switch (step) {
      case 0: return <span><Link to={`smithers.sh/${repo.slug}/issues/${issue.n}`}>{receipt.reporter}</Link> · {receipt.reported}</span>
      case 1: return receipt.acceptedBy !== undefined ? <span><Link to={`smithers.sh/${repo.slug}/issues/${issue.n}`}>{receipt.acceptedBy}</Link> · {receipt.accepted}</span> : null
      case 2: return receipt.run !== undefined ? <Link to={`smithers.sh/${repo.slug}/runs/${receipt.run}`}>{receipt.run}</Link> : null
      case 3:
        if (receipt.pull !== undefined) return <Link to={`smithers.sh/${repo.slug}/pull/${receipt.pull}`}>#{receipt.pull}</Link>
        return <Link to={`smithers.sh/${repo.slug}/issues/${issue.n}`}>reviewed on the issue</Link>
      case 4:
        if (receipt.commit === undefined) return null
        if (repo.github !== null) return <a href={`${repo.github}/commit/${receipt.commit}`} target="_blank" rel="noopener noreferrer">{receipt.commit} on main ↗</a>
        return <Link to={`smithers.sh/${repo.slug}/commit/${receipt.commit}`}>{receipt.commit} on main</Link>
      default: return null
    }
  }
  return (
    <div className="app-receipt" aria-label="Progress">
      {RECEIPT_STEPS.map((label, step) => (
        <div className="app-receipt-step" key={label} data-done={step <= reached}>
          <span className="app-receipt-dot" />
          <span className="app-receipt-label">{step === 4 && repo.site === "effeck" ? "Landed" : label}</span>
          <span className="app-receipt-evidence">{step <= reached ? evidence(step) : ""}</span>
        </div>
      ))}
    </div>
  )
}

const receiptChip = (issue: Issue) => {
  if (issue.receipt === undefined || issue.receipt.stage === "reported") return null
  const stage = issue.receipt.stage
  if (stage === "accepted") return <Pill tone="neutral">Accepted</Pill>
  if (stage === "working") return <Pill tone="brand">Working</Pill>
  if (stage === "review") return <Pill tone="warning">In review</Pill>
  return <Pill tone="neutral">Merged</Pill>
}

export const IssueRow = ({ repo, issue, receipt = false }: { repo: RepoData; issue: Issue; receipt?: boolean }) => (
  <Link to={`smithers.sh/${repo.slug}/issues/${issue.n}`} className="app-issue-row">
    <span className={`app-issue-icon ${issue.state === "open" ? "app-issue-icon-open" : "app-issue-icon-closed"}`}><Icon name={issue.state === "open" ? "issue" : "issue-closed"} /></span>
    <span className="app-issue-main">
      <span className="app-issue-title">{issue.title}
        {issue.labels.length > 0 && <span className="app-issue-labels">{issue.labels.map(label => <span key={label} className={`app-label${label === "bug" ? " app-label-bug" : label === "accepted" ? " app-label-accepted" : ""}`}>{label}</span>)}</span>}
      </span>
      <span className="app-issue-meta">#{issue.n} · opened {issue.opened} by {issue.author}</span>
      {receipt && issue.receipt !== undefined && <span style={{ display: "block", marginTop: 8 }}><FactoryReceipt repo={repo} issue={issue} /></span>}
    </span>
    <span className="app-issue-side">{receiptChip(issue)}</span>
  </Link>
)

export const IssuesCard = ({ repo, view }: { repo: RepoData; view: string }) => {
  const { flags } = useMock()
  const read = useRead(`issues:${repo.slug}:${view}`)
  const open = repo.issues.filter(issue => issue.state === "open")
  const closed = repo.issues.filter(issue => issue.state === "closed")
  const factory = repo.issues.filter(issue => issue.receipt !== undefined && issue.receipt.stage !== "reported")
  const rows = flags.data === "empty" ? [] : view === "closed" ? closed : view === "factory" ? factory : open
  return (
    <Card title="Issues" pill={undefined}>
      {repo.slug === "smithers-canary/smithers" && <p className="app-sync-note">Synced from GitHub · 2 minutes ago</p>}
      <div className="app-list-head">
        <div className="app-tabs" style={{ flex: 1, marginBottom: 0 }}>
          <Link to={`smithers.sh/${repo.slug}/issues`} className="app-tab" data-active={view !== "closed" && view !== "factory"}>Open {open.length}</Link>
          <Link to={`smithers.sh/${repo.slug}/issues?view=closed`} className="app-tab" data-active={view === "closed"}>Closed {closed.length}</Link>
          <Link to={`smithers.sh/${repo.slug}/issues?view=factory`} className="app-tab" data-active={view === "factory"}>Fixed by agents</Link>
        </div>
        <Link to={`smithers.sh/${repo.slug}?card=bug`} className="app-btn app-btn-primary app-btn-sm">Report a bug</Link>
      </div>
      {read.state === "loading" && <SkeletonRows rows={6} />}
      {read.state === "error" && <ReadError what={repo.github !== null ? "the issues from GitHub" : "the issues"} onRetry={read.retry} />}
      {read.state === "ready" && (
        rows.length === 0
          ? <p className="app-empty">{view === "closed" ? "No closed issues." : view === "factory" ? "Nothing fixed by agents yet." : "No open issues."}</p>
          : <div>{rows.map(issue => <IssueRow key={issue.n} repo={repo} issue={issue} receipt={view === "factory"} />)}</div>
      )}
    </Card>
  )
}

export const IssueCard = ({ repo, issue }: { repo: RepoData; issue: Issue }) => {
  const { flags } = useMock()
  const location = useLocation()
  const [comment, setComment] = useState("")
  const [comments, setComments] = useState(issue.comments)
  const who = { maya: "maya", will: "will", cora: "cora", bot: "bot" } as const
  return (
    <Card title={<>{issue.title} <span className="app-mono" style={{ color: "var(--text-faint)" }}>#{issue.n}</span></>} pill={issue.state === "open" ? <Pill tone="brand">Open</Pill> : <Pill tone="neutral">Closed</Pill>}>
      <p className="app-pr-sub">opened {issue.opened} by {issue.author}</p>
      <div className="app-issue-layout">
        <div>
          <Markdown source={issue.body} resolve={docResolver(repo)} dense />
          <div style={{ marginTop: 8 }}>
            {comments.map((entry, i) => (
              <div className="app-comment" key={i}>
                <Avatar who={who[entry.who]} />
                <div className="app-comment-body">
                  <div className="app-comment-head"><span className="app-comment-who">{entry.who === "bot" ? "Coding agent" : entry.who}</span><span className="app-comment-when">{entry.when}</span></div>
                  <div className="app-comment-text">{entry.text}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            {flags.as === "in" ? (
              <div className="app-form">
                <div className="app-field">
                  <label htmlFor={`comment-${issue.n}`}>Comment</label>
                  <textarea id={`comment-${issue.n}`} value={comment} onChange={event => setComment(event.target.value)} />
                </div>
                <button type="button" className="app-btn app-btn-primary app-btn-sm" disabled={comment.trim() === ""} onClick={() => {
                  setComments([...comments, { who: "maya", text: comment.trim(), when: "just now" }])
                  setComment("")
                }}>Comment</button>
              </div>
            ) : (
              <Link to={signInRoute(location)} className="app-btn app-btn-secondary app-btn-sm">Sign in with GitHub to comment</Link>
            )}
          </div>
        </div>
        {issue.receipt !== undefined && issue.receipt.stage !== "reported" && (
          <div className="app-issue-receipt"><FactoryReceipt repo={repo} issue={issue} /></div>
        )}
      </div>
    </Card>
  )
}

export const TreeCard = ({ repo, dir }: { repo: RepoData; dir: string }) => {
  const read = useRead(`tree:${repo.slug}:${dir}`)
  const rows = repo.tree[dir]
  const segments = dir === "" ? [] : dir.split("/")
  return (
    <Card title="Files">
      <nav className="app-breadcrumb" aria-label="Path">
        <Link to={`smithers.sh/${repo.slug}`}>{repo.slug}</Link>
        {segments.map((segment, i) => (
          <span key={i} style={{ display: "inline-flex", gap: 4 }}>
            <span className="app-breadcrumb-sep">/</span>
            {i === segments.length - 1
              ? <span className="app-breadcrumb-current">{segment}</span>
              : <Link to={`smithers.sh/${repo.slug}/tree/main/${segments.slice(0, i + 1).join("/")}`}>{segment}</Link>}
          </span>
        ))}
      </nav>
      {read.state === "loading" && <SkeletonRows rows={6} />}
      {read.state === "error" && <ReadError what={repo.github !== null ? "the files from GitHub" : "the files"} onRetry={read.retry} />}
      {read.state === "ready" && rows === undefined && <p className="app-empty">No directory at {dir} on main.</p>}
      {read.state === "ready" && rows !== undefined && (
        <div className="app-file-rows">
          {rows.map(row => (
            <Link key={row.name} className="app-file-row" to={row.kind === "dir" ? `smithers.sh/${repo.slug}/tree/main/${dir === "" ? row.name : `${dir}/${row.name}`}` : `smithers.sh/${repo.slug}/blob/main/${dir === "" ? row.name : `${dir}/${row.name}`}`}>
              <Icon name={row.kind} />
              <span className="app-file-name">{row.name}</span>
              <span className="app-file-note">{row.note}</span>
              <span className="app-file-age">{row.age}</span>
            </Link>
          ))}
        </div>
      )}
      {read.state === "ready" && repo.dirReadmes[dir] !== undefined && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <Markdown source={repo.dirReadmes[dir]} resolve={docResolver(repo, `${dir}/README.md`)} dense />
        </div>
      )}
    </Card>
  )
}

const LANG_NAME: Record<string, string> = { ts: "TypeScript", md: "Markdown", json: "JSON", sh: "Shell", txt: "Text" }

export const BlobCard = ({ repo, path: routePath, query }: { repo: RepoData; path: string; query: URLSearchParams }) => {
  const path = routePath.replace(/\.effeck$/, ".vibe")
  const read = useRead(`blob:${repo.slug}:${path}`)
  const { flags } = useMock()
  const rawFile = repo.files[path]
  const file = rawFile && path === ".smithers/home.json" && flags.converter === "on" ? { ...rawFile, content: rawFile.content.replace("Install VibeLang", "Convert Effect code") } : rawFile
  const composer = useContext(ComposerContext)
  const [source, setSource] = useState(false)
  const lines = useMemo(() => file === undefined ? [] : file.content.replace(/\n$/, "").split("\n"), [file])
  const langName = file === undefined ? "" : path.endsWith(".vibe") ? "VibeLang" : LANG_NAME[file.lang]
  const size = file === undefined ? "" : `${(file.content.length / 1024).toFixed(1)} KB`

  const sel = query.get("L")
  const range = useMemo(() => {
    if (sel === null) return null
    const m = sel.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) return null
    return { from: Number(m[1]), to: Number(m[2] ?? m[1]) }
  }, [sel])

  useEffect(() => {
    if (range !== null && read.state === "ready") {
      const timer = setTimeout(() => document.getElementById(`app-ln-${range.from}`)?.scrollIntoView({ block: "center" }), 80)
      return () => clearTimeout(timer)
    }
  }, [range, read.state])

  const segments = path.split("/")
  return (
    <Card title={segments[segments.length - 1]}>
      <nav className="app-breadcrumb" aria-label="Path">
        <Link to={`smithers.sh/${repo.slug}`}>{repo.slug}</Link>
        {segments.map((segment, i) => (
          <span key={i} style={{ display: "inline-flex", gap: 4 }}>
            <span className="app-breadcrumb-sep">/</span>
            {i === segments.length - 1
              ? <span className="app-breadcrumb-current">{segment}</span>
              : <Link to={`smithers.sh/${repo.slug}/tree/main/${segments.slice(0, i + 1).join("/")}`}>{segment}</Link>}
          </span>
        ))}
      </nav>
      {read.state === "loading" && <SkeletonRows rows={10} />}
      {read.state === "error" && <ReadError what={repo.github !== null ? "the file from GitHub" : "the file"} onRetry={read.retry} />}
      {read.state === "ready" && file === undefined && <p className="app-empty">No file at {path} on main.</p>}
      {read.state === "ready" && file !== undefined && (
        <>
          <p className="app-file-meta">{lines.length} lines · {size} · {langName}</p>
          <div className="app-file-actions">
            <CopyButton text={file.content} small />
            <CopyButton text={`smithers.sh/${repo.slug}/blob/main/${path}${sel !== null ? `?L=${sel}` : ""}`} label="Copy permalink" small />
            {repo.github !== null && (
              <a className="app-btn app-btn-secondary app-btn-sm" href={`${repo.github}/commits/main/${path}`} target="_blank" rel="noopener noreferrer">History on GitHub ↗</a>
            )}
            <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => composer.open(`About ${path}: `)}>Ask about this file</button>
            {file.lang === "md" && (
              <span className="app-toggle" role="group" aria-label="View">
                <button type="button" data-active={!source} onClick={() => setSource(false)}>Rendered</button>
                <button type="button" data-active={source} onClick={() => setSource(true)}>Source</button>
              </span>
            )}
          </div>
          {file.lang === "md" && !source ? (
            <Markdown source={file.content} resolve={docResolver(repo, path)} />
          ) : (
            <div className="app-code"><div className="app-code-scroll">
              <div className="app-code-lines">
                {lines.map((line, i) => {
                  const n = i + 1
                  const hit = range !== null && n >= range.from && n <= range.to
                  return (
                    <div className="app-code-row" data-hit={hit || undefined} key={n}>
                      <span className="app-code-ln" id={`app-ln-${n}`}>
                        <a href={`#/smithers.sh/${repo.slug}/blob/main/${path}?L=${n}`} aria-label={`Line ${n}`} onClick={event => {
                          event.preventDefault()
                          const params = new URLSearchParams(query.toString())
                          params.set("L", String(n))
                          navigate(`smithers.sh/${repo.slug}/blob/main/${path}?${params.toString()}`, { replace: true })
                        }}>{n}</a>
                      </span>
                      <span className="app-code-lc">{highlightLines(line)}</span>
                    </div>
                  )
                })}
              </div>
            </div></div>
          )}
        </>
      )}
    </Card>
  )
}

export const SAMPLE_BUG_DRAFT = { title: "Query values disappear", body: "An empty query value was dropped.\n\nKeep the empty string." }

export const BUG_BUILD = "App 2026.10.17-rc.13"
export const BUG_CORRELATION = "Correlation id 7f3a9c12-6e84-4b25-9d70-a8c213f05e61"
export const bugContext = (from: string | null): string[] => {
  const pattern = from === "conversion" ? "effeck.dev/" : from ? resolveRoute(from)?.route.pattern : undefined
  const route = pattern?.replace(/^[^/]+/, "") || "/:owner/:repo/bug"
  return [`Route ${route}`, BUG_BUILD, BUG_CORRELATION]
}

export const BugCard = ({ repo, from, onClose, onPublish }: { repo: RepoData | FixtureRepo; from: string | null; onClose: () => void; onPublish?: (title: string, body: string) => number }) => {
  const { flags } = useMock()
  const location = useLocation()
  const standalone = location.split("?")[0].endsWith("/bug")
  const query = new URLSearchParams(location.split("?")[1])
  const inApp = query.get("bugpublish") === "app"
  const conversion = from === "conversion" && repo.slug === "effeck/effeck"
  const conversionInput = query.get("input") ?? BROKEN_EFFECT
  const conversionOutput = query.get("output") ?? FAILED_EFFECK
  const [title, setTitle] = useState(query.get("title") ?? (conversion ? "Conversion did not compile" : ""))
  const [happened, setHappened] = useState(query.get("body") ?? (conversion ? "The converted Users example did not compile." : ""))
  const [errors, setErrors] = useState<{ title?: string; happened?: string }>({})
  const contextChips = bugContext(from)
  const [chips, setChips] = useState<string[]>([...contextChips, ...(conversion
    ? ["Input · Users example", "Output · Users example", "2 diagnostics", "vibelang 0.0.1 · compiler sha256:4be1…"]
    : [])])

  const draftKey = `app-bug-draft:${repo.slug}`
  useEffect(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) ?? "null")
      if (!draft && new URLSearchParams(location.split("?")[1]).get("draft") === "restored") { setTitle(SAMPLE_BUG_DRAFT.title); setHappened(SAMPLE_BUG_DRAFT.body) }
      if (draft && !query.has("title") && !query.has("body")  ) { setTitle(draft.title); setHappened([draft.happened, draft.expected, draft.steps ? `Steps to reproduce:\n${draft.steps}` : ""].filter(Boolean).join("\n\n")); setChips([...contextChips, ...(Array.isArray(draft.chips) ? draft.chips.filter((chip: unknown): chip is string => typeof chip === "string" && !/^(?:Page |Route |App |Correlation id )/.test(chip) && !/(?:^|\s)none\s*$/i.test(chip)) : [])]) }
    } catch { /* storage unavailable */ }
  }, [draftKey])
  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify({ title, happened, chips })) } catch { /* storage unavailable */ }
  }, [title, happened, chips])
  const attachments = conversion ? [
    { label: "Input · Users example", detail: conversionInput, body: `Input\n\`\`\`ts\n${conversionInput}\n\`\`\`` },
    { label: "Output · Users example", detail: conversionOutput, body: `Output\n\`\`\`\n${conversionOutput}\n\`\`\`` },
    { label: "2 diagnostics", detail: DIAGNOSTICS.map(d => `${d.code} ${d.file}:${d.line}:${d.col} — ${d.message}`).join("\n"), body: DIAGNOSTICS.map(d => `${d.code}: ${d.message}`).join("\n") }
  ].filter(attachment => chips.includes(attachment.label)) : []
  const publicBody = [`${happened.trim()}\n\n${chips.map(chip => `- ${chip}`).join("\n")}`, ...attachments.map(attachment => attachment.body)].join("\n\n")
  const publish = () => {
    const next: { title?: string; happened?: string } = {}
    if (title.trim() === "") next.title = "Give the report a title."
    if (happened.trim() === "") next.happened = "Say what happened."
    setErrors(next)
    if (Object.keys(next).length === 0) {
      const number = onPublish?.(title, publicBody) ?? ("site" in repo && repo.site === "effeck" ? 118 : 4252)
      const issue = { n: number, title, body: publicBody, state: "open" as const, labels: ["bug", "from-app"], author: "maya" as const, opened: "just now", comments: [] }
      if ("issues" in repo) {
        repo.issues = [issue, ...repo.issues.filter(each => each.n !== number)]
        try { sessionStorage.setItem(`app-published:${repo.slug}`, JSON.stringify(issue)) } catch { /* storage unavailable */ }
      }
      const params = new URLSearchParams(location.split("?")[1] ?? "")
      params.set("card", "bug-sent")
      params.delete("from")
      navigate(standalone ? `smithers.sh/${repo.slug}/issues/${number}?${params.toString()}` : `smithers.sh/${repo.slug}?${params.toString()}`)
    }
  }

  const githubRepo = repo.github || `https://github.com/${repo.slug}`
  const githubNew = `${githubRepo}/issues/new?${new URLSearchParams({ title, body: publicBody, labels: "bug" })}`

  return (
    <Card title={`Report a bug in ${repo.slug}`} onClose={onClose}>
      <div className="app-form">
        <div className="app-field">
          <label htmlFor="bug-title">Title <span className="app-field-req">required</span></label>
          <input id="bug-title" type="text" value={title} onChange={event => setTitle(event.target.value)} />
          {errors.title !== undefined && <span className="app-field-error">{errors.title}</span>}
        </div>
        <div className="app-field">
          <label htmlFor="bug-happened">What happened <span className="app-field-req">required</span></label>
          <textarea id="bug-happened" rows={6} placeholder="What happened, what you expected, and the steps to get there" value={happened} onChange={event => setHappened(event.target.value)} />
          {errors.happened !== undefined && <span className="app-field-error">{errors.happened}</span>}
        </div>
        <div className="app-field">
          <span className="app-field-label">Attached</span>
          <div className="app-context-chips">
            {chips.map(chip => (
              <span className="app-context-chip" key={chip}>{chip}
                <button type="button" aria-label={`Remove ${chip}`} onClick={() => setChips(chips.filter(each => each !== chip))}><Icon name="x" size={10} /></button>
              </span>
            ))}
          </div>
        </div>
        {attachments.length > 0 && (
          <div className="app-field">
            {attachments.map(attachment => (
              <details className="app-collapse" key={attachment.label}>
                <summary>{attachment.label}</summary>
                <pre>{attachment.detail}</pre>
              </details>
            ))}
          </div>
        )}
        <div className="app-field">
          <details className="app-collapse"><summary>Preview what becomes public</summary>
          <div className="app-preview">
            <p className="app-preview-title">New issue on {repo.slug}</p>
            <pre className="app-bug-public-body">{publicBody}</pre>
          </div>
          </details>
        </div>
        <div className="app-form-foot">
          {!inApp ? (
            <>
              <a href={githubNew} target="_blank" rel="noopener noreferrer" className="app-btn app-btn-primary"><span>Publish on <span className="app-bug-external">GitHub ↗</span></span></a>
              <span className="app-form-note">Your draft stays on this page.</span>
            </>
          ) : flags.as === "in" ? (
            <>
              <button type="button" className="app-btn app-btn-primary" disabled={!title.trim() || !happened.trim()} title={!title.trim() || !happened.trim() ? "Enter a title and what happened" : undefined} onClick={publish}>Publish</button>
              <span className="app-form-note">Publishes as @maya on {repo.slug}.</span>
            </>
          ) : (
            <>
              <Link to={signInRoute(location.replace(/([?&])as=out/, "$1as=in"))} className="app-btn app-btn-primary">Sign in to publish</Link>
              <span className="app-form-note">Your draft stays on this page.</span>
            </>
          )}
          {inApp && (
            <a href={githubNew} target="_blank" rel="noopener noreferrer" className="app-btn app-btn-quiet app-btn-sm"><span>Publish on GitHub <span className="app-bug-external">instead ↗</span></span></a>
          )}
        </div>
      </div>
    </Card>
  )
}

export const BugSentCard = ({ repo }: { repo: RepoData }) => {
  const n = repo.slug === "effeck/effeck" ? 118 : 4252
  return (
    <Card title={`Published #${n} on ${repo.slug}.`} pill={<Pill tone="success">Published</Pill>}>
      <p className="app-pr-note" style={{ marginBottom: 12 }}>A maintainer reviews new reports. Accepted ones go to an agent; this issue shows each step.</p>
      <Link to={`smithers.sh/${repo.slug}/issues/${n}`} className="app-btn app-btn-secondary app-btn-sm">View #{n}</Link>
    </Card>
  )
}

const INSTALL_PHASES = ["Plan", "Implement", "Verify", "Review", "Propose"]

export const RunCard = ({ repo: _repo, run, status, activeStage, failureNote, member, onRetry }: {
  repo: RepoData
  run: Run
  status: Run["status"]
  activeStage: number
  failureNote?: string
  member: boolean
  onRetry?: () => void
}) => {
  const { flags } = useMock()
  const [stopped, setStopped] = useState(false)
  const install = flags.host === "install"
  const HOSTED_TO_INSTALL = [0, 0, 1, 1, 2, 4]
  const stageToPhase = (index: number) => install ? HOSTED_TO_INSTALL[Math.min(index, HOSTED_TO_INSTALL.length - 1)] : index
  const displayActive = install ? stageToPhase(activeStage) : activeStage
  const [openStage, setOpenStage] = useState<number | null>(displayActive)
  const elapsed = useElapsed(184, status === "running" && !stopped)

  const stageState = (index: number): "done" | "active" | "waiting" | "failed" | "todo" => {
    if (stopped) return index < activeStage ? "done" : "todo"
    if (index < activeStage) return "done"
    if (index > activeStage) return "todo"
    if (status === "done") return "done"
    if (status === "needs-you") return "waiting"
    if (status === "failed") return "failed"
    return "active"
  }

  const phases = install
    ? INSTALL_PHASES.map(label => ({ label, summary: "", log: [] as string[], duration: "" }))
    : run.stages
  const displayStage = (index: number) => {
    if (!install) return run.stages[index]
    const phase = phases[index]
    const sources = run.stages.filter((_, i) => stageToPhase(i) === index)
    const last = sources[sources.length - 1]
    return { ...phase, summary: last?.summary ?? "", log: last?.log ?? [], duration: sources.map(s => s.duration).filter(d => d !== "").join(" · ") }
  }
  const displayCount = install ? INSTALL_PHASES.length : run.stages.length
  const displayState = (index: number) => {
    if (!install) return stageState(index)
    const mine = run.stages.map((_, i) => i).filter(i => stageToPhase(i) === index)
    if (mine.every(i => stageState(i) === "done")) return "done"
    const active = mine.find(i => stageState(i) !== "done" && stageState(i) !== "todo")
    if (active !== undefined) return stageState(active)
    return "todo"
  }

  const pill = stopped ? <Pill tone="neutral">Stopped</Pill>
    : status === "running" ? <Pill tone="brand" pulse>Running</Pill>
    : status === "needs-you" ? <Pill tone="warning">Needs you</Pill>
    : status === "refused" ? <Pill tone="danger">Refused</Pill>
    : status === "failed" ? <Pill tone="danger">Failed</Pill>
    : <Pill tone="neutral">Done</Pill>

  return (
    <Card title={run.title} pill={pill}>
      <p className="app-run-meta">Coding agent · {run.agent} <span className="app-repo-meta-dot">·</span> started {run.started} <span className="app-repo-meta-dot">·</span> <span className="app-mono">{elapsed}</span></p>
      <div className="app-stages">
        {Array.from({ length: displayCount }, (_, index) => {
          const stage = displayStage(index)
          const state = displayState(index)
          return (
            <div className="app-stage" data-state={state} key={index}>
              <button type="button" className="app-stage-head" aria-expanded={openStage === index} onClick={() => setOpenStage(openStage === index ? null : index)}>
                <span className="app-stage-dot" />
                <span className="app-stage-name">{stage.label}</span>
                {stage.duration !== "" && <span className="app-stage-dur">{stage.duration}</span>}
                <Icon name="chevron-down" size={12} />
              </button>
              {openStage === index && (
                <div className="app-stage-detail">
                  {stage.summary !== "" && <p className="app-stage-summary">{stage.summary}</p>}
                  {stage.log.length > 0 && <pre className="app-stage-log">{stage.log.join("\n")}</pre>}
                  {stage.summary === "" && stage.log.length === 0 && <p className="app-stage-summary">Not reached yet.</p>}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {failureNote !== undefined && status === "failed" && (
        <div className="app-run-foot">
          <p className="app-pr-note" style={{ color: "var(--danger)" }}>{failureNote}</p>
          {onRetry !== undefined && <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={onRetry}>Retry</button>}
        </div>
      )}
      <p className="app-run-note">Keeps running if you close this tab.</p>
      {member && !stopped && status === "running" && (
        <div className="app-run-foot">
          <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => setStopped(true)}>Stop</button>
        </div>
      )}
    </Card>
  )
}

const DiffView = ({ diff }: { diff: Pull["diff"] }) => (
  <>
    {diff.map(file => (
      <div className="app-diff" key={file.path}>
        <div className="app-diff-file">{file.path}</div>
        <div className="app-diff-scroll">
          <table>
            <tbody>
              {file.lines.map((line, i) => (
                <tr key={i} className={line.kind === "hunk" ? "app-diff-hunk" : line.kind === "add" ? "app-diff-add" : line.kind === "del" ? "app-diff-del" : ""}>
                  <td className="app-diff-ln">{line.old ?? ""}</td>
                  <td className="app-diff-ln">{line.new ?? ""}</td>
                  <td className="app-diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</td>
                  <td>{line.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ))}
  </>
)

const ChecksList = ({ checks }: { checks: Pull["checks"] }) => (
  <div className="app-checks">
    {checks.map(check => (
      <div className="app-check" key={check.name}>
        <span className={`app-check-icon ${check.ok ? "app-check-ok" : "app-check-bad"}`}><Icon name={check.ok ? "check" : "x"} size={14} /></span>
        <span className="app-check-name">{check.name}</span>
        <span className="app-check-detail">{check.detail}</span>
        {check.error !== undefined && <span className="app-check-error">{check.error}</span>}
      </div>
    ))}
  </div>
)

const AgentNotes = ({ pull, repo }: { pull: Pull; repo: RepoData }) => (
  <>
    {pull.findings.length > 0 && (
      <ul className="app-findings">
        {pull.findings.map((finding, i) => (
          <li key={i}><Link to={`smithers.sh/${repo.slug}/blob/main/${finding.file}?L=${finding.line}`}>{finding.file}:{finding.line}</Link> {finding.text}</li>
        ))}
      </ul>
    )}
    <p className="app-pr-note" style={{ marginTop: 10 }}>Checks passed. Your review is next.</p>
  </>
)

export const PrCard = ({ repo, pull, state, member }: { repo: RepoData; pull: Pull; state: string | null; member: boolean }) => {
  const { flags } = useMock()
  const merged = state === "merged" || pull.state === "merged"
  const checksFailed = state === "checks-failed"
  const [tab, setTab] = useState<"conversation" | "commits" | "checks" | "files">(checksFailed ? "checks" : "conversation")
  const install = flags.host === "install"
  const checks = checksFailed
    ? pull.checks.map(check => check.name === "Unit tests" ? { ...check, ok: false, detail: "failed in 1 m 58 s", error: "query.test.ts > parses pairs: expected { a: '1' } got {}" } : check)
    : pull.checks
  const github = repo.github ?? `https://github.com/${repo.slug}`
  const mergedSha = pull.mergedSha ?? pull.commit.sha

  if (install) {
    return (
      <InstallReviewCard repo={repo} pull={pull} state={state} checks={checks} member={member} />
    )
  }

  return (
    <Card title={<>{pull.title} <span className="app-mono" style={{ color: "var(--text-faint)" }}>#{pull.n}</span></>} pill={merged ? <Pill tone="neutral">Merged</Pill> : <Pill tone="brand">Open</Pill>}>
      <p className="app-pr-sub">Coding agent for {pull.forWho} proposes 1 commit for <span className="app-mono">main</span> from <span className="app-mono">{pull.branch}</span> · {pull.opened}</p>
      {pull.fixes !== undefined && <p className="app-pr-sub"><Link to={`smithers.sh/${repo.slug}/issues/${pull.fixes}`}>Fixes #{pull.fixes}</Link></p>}
      <div className="app-tabs">
        {([["conversation", "Conversation"], ["commits", "Commits 1"], ["checks", `Checks ${checks.length}`], ["files", `Files changed ${pull.diff.length === 0 ? 2 : pull.diff.length} +${pull.additions} −${pull.deletions}`]] as const).map(([key, label]) => (
          <button key={key} type="button" className="app-tab" data-active={tab === key} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "conversation" && (
        <>
          <div className="app-comment" style={{ borderTop: 0 }}>
            <Avatar who="bot" />
            <div className="app-comment-body">
              <div className="app-comment-head"><span className="app-comment-who">Coding agent</span><span className="app-comment-when">{pull.opened}</span></div>
              <div className="app-comment-text">{pull.summary}</div>
            </div>
          </div>
          <AgentNotes pull={pull} repo={repo} />
        </>
      )}
      {tab === "commits" && (
        <div className="app-file-rows">
          <span className="app-file-row">
            <Icon name="change" />
            <span className="app-file-name app-mono">{pull.commit.sha}</span>
            <span className="app-file-note">{pull.commit.subject}</span>
          </span>
        </div>
      )}
      {tab === "checks" && <ChecksList checks={checks} />}
      {tab === "files" && (pull.diff.length === 0 ? <p className="app-empty">The diff is part of the full change.</p> : <DiffView diff={pull.diff} />)}
      <div className="app-pr-foot">
        {merged ? (
          <div className="app-receipt-banner" style={{ flex: 1 }}>
            <span className="app-check-ok" style={{ flex: "none", marginTop: 2 }}><Icon name="check" size={16} /></span>
            <div>
              <p>Merged on GitHub as <span className="app-mono">{mergedSha}</span> · main · 2 minutes ago</p>
              <p className="app-sub"><a href={`${github}/commit/${mergedSha}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--brand)" }}>View commit on GitHub ↗</a></p>
            </div>
          </div>
        ) : member ? (
          <>
            <a href={`${github}/pull/${pull.n}`} target="_blank" rel="noopener noreferrer" className="app-btn app-btn-primary" {...(checksFailed ? { "aria-disabled": true, style: { opacity: 0.5, pointerEvents: "none" } } : {})}>Merge on GitHub ↗</a>
            {checksFailed && <p className="app-pr-note" style={{ color: "var(--danger)" }}>Unit tests failed on {pull.commit.sha}.</p>}
          </>
        ) : (
          <p className="app-pr-note">A maintainer merges this on GitHub.</p>
        )}
      </div>
    </Card>
  )
}

const InstallReviewCard = ({ repo, pull, state, checks, member }: { repo: RepoData; pull: Pull; state: string | null; checks: Pull["checks"]; member: boolean }) => {
  const [merged, setMerged] = useState(state === "merged" || pull.state === "merged")
  const checksFailed = state === "checks-failed"
  const sha = pull.mergedSha ?? pull.commit.sha
  return (
    <Card title={<>{pull.title} <span className="app-mono" style={{ color: "var(--text-faint)" }}>#{pull.n}</span></>} pill={merged ? <Pill tone="neutral">Merged</Pill> : <Pill tone="brand">Open</Pill>} tag="Own install">
      <p className="app-pr-sub">Coding agent for {pull.forWho} proposes 1 commit for <span className="app-mono">main</span> from <span className="app-mono">{pull.branch}</span></p>
      {pull.fixes !== undefined && <p className="app-pr-sub"><Link to={`smithers.sh/${repo.slug}/issues/${pull.fixes}`}>Fixes #{pull.fixes}</Link></p>}
      {merged ? (
        <div className="app-receipt-banner">
          <span className="app-check-ok" style={{ flex: "none", marginTop: 2 }}><Icon name="check" size={16} /></span>
          <div>
            <p>Merged on main as <span className="app-mono">{sha}</span> · just now</p>
            <p className="app-sub">The change is on {repo.slug} main.</p>
          </div>
        </div>
      ) : (
        <>
          <AgentNotes pull={pull} repo={repo} />
          <div style={{ marginBottom: 12 }}><ChecksList checks={checks} /></div>
          {pull.diff.length > 0 && <DiffView diff={pull.diff} />}
          <div className="app-pr-foot">
            {member ? <button type="button" className="app-btn app-btn-primary" disabled={checksFailed} onClick={() => setMerged(true)}>Review &amp; merge</button> : <p className="app-pr-note">A maintainer merges this.</p>}
            {checksFailed && <p className="app-pr-note" style={{ color: "var(--danger)" }}>Unit tests failed on {pull.commit.sha}.</p>}
          </div>
        </>
      )}
    </Card>
  )
}

export const ChangesCard = ({ repo }: { repo: RepoData }) => {
  const { flags } = useMock()
  const read = useRead(`pulls:${repo.slug}`)
  const rows = flags.data === "empty" ? [] : repo.pulls
  return (
    <Card title="Changes">
      {read.state === "loading" && <SkeletonRows rows={3} />}
      {read.state === "error" && <ReadError what={repo.github !== null ? "the changes from GitHub" : "the changes"} onRetry={read.retry} />}
      {read.state === "ready" && rows.length === 0 && <p className="app-empty">No changes yet.</p>}
      {read.state === "ready" && rows.length > 0 && (
        <div>
          {rows.map(pull => (
            <Link to={`smithers.sh/${repo.slug}/pull/${pull.n}`} className="app-issue-row" key={pull.n}>
              <span className={`app-issue-icon ${pull.state === "open" ? "app-issue-icon-open" : "app-issue-icon-closed"}`}><Icon name="change" /></span>
              <span className="app-issue-main">
                <span className="app-issue-title">{pull.title}</span>
                <span className="app-issue-meta">#{pull.n} · {pull.branch} · {pull.opened}</span>
              </span>
              <span className="app-issue-side">
                {pull.state === "merged" ? <Pill tone="neutral">Merged</Pill> : pull.checks.every(check => check.ok) ? <Pill tone="brand">Open</Pill> : <Pill tone="danger">Checks failed</Pill>}
              </span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  )
}

export const ConnectModelCard = ({ onConnected }: { onConnected: () => void }) => {
  const { set } = useMock()
  const [connected, setConnected] = useState<string | null>(null)
  const pick = (which: string) => {
    setConnected(which)
    set({ model: "connected" })
    if (!still) setTimeout(onConnected, 900)
  }
  return (
    <Card title="Connect a coding model to run this.">
      {connected !== null ? (
        <p className="app-run-meta"><span className="app-check-ok"><Icon name="check" size={14} /></span> Connected as maya · {connected}. Starting the run…</p>
      ) : (
        <>
          <div className="app-connect-opt">
            <div className="app-connect-opt-main">
              <div className="app-connect-opt-name">Claude Code</div>
              <div className="app-connect-opt-sub">your Claude Pro or Max subscription</div>
            </div>
            <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => pick("Claude Code")}>Connect</button>
          </div>
          <div className="app-connect-opt">
            <div className="app-connect-opt-main">
              <div className="app-connect-opt-name">Codex</div>
              <div className="app-connect-opt-sub">your ChatGPT Plus or Pro subscription</div>
            </div>
            <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => pick("Codex")}>Connect</button>
          </div>
          <p className="app-form-note">No API key. Smithers uses your subscription's sign-in.</p>
        </>
      )}
    </Card>
  )
}

export const RefusedCard = ({ onSendAgain }: { onSendAgain: () => void }) => (
  <Card title="Not started: no machine is free." pill={<Pill tone="danger">Refused</Pill>}>
    <p className="app-pr-note">Hosted machines are down for maintenance. Nothing ran and nothing was charged.</p>
    <p className="app-pr-note" style={{ marginBottom: 12 }}>Your request stays here. Send it again later, or run Smithers on your own machine.</p>
    <div className="app-run-foot">
      <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={onSendAgain}>Send again</button>
      <Link to="smithers.sh/docs/installation" className="app-btn app-btn-quiet app-btn-sm">Install Smithers locally</Link>
      <a href={EXTERNAL.status} target="_blank" rel="noopener noreferrer" className="app-btn app-btn-quiet app-btn-sm">Status ↗</a>
    </div>
  </Card>
)

export const NeedsYouCard = ({ onAnswer }: { onAnswer: (answer: string) => void }) => {
  const [text, setText] = useState("")
  return (
    <Card title="The agent asks:" pill={<Pill tone="warning">Needs you</Pill>}>
      <p className="app-ask-question">Should an empty value (<code>?a=</code>) parse to <code>""</code> or be dropped?</p>
      <div className="app-ask-answers">
        <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => onAnswer('Parse it as ""')}>Parse it as ""</button>
        <button type="button" className="app-btn app-btn-secondary app-btn-sm" onClick={() => onAnswer("Drop it")}>Drop it</button>
      </div>
      <div className="app-field" style={{ marginBottom: 0 }}>
        <label htmlFor="needs-you-answer">Or answer in your own words</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="needs-you-answer" type="text" value={text} onChange={event => setText(event.target.value)} />
          <button type="button" className="app-btn app-btn-primary app-btn-sm" disabled={text.trim() === ""} onClick={() => onAnswer(text.trim())}>Send</button>
        </div>
      </div>
    </Card>
  )
}

export const ImportCard = ({ slug }: { slug: string }) => {
  const { set } = useMock()
  const [step, setStep] = useState<number>(-1)
  const steps = ["Reading from GitHub", "Indexing 214 files", "Ready"]
  useEffect(() => {
    if (step < 0 || step >= steps.length) return
    if (step === steps.length - 1) {
      if (!still) {
        const timer = setTimeout(() => {
          set({ repos: "some" })
          navigate(`smithers.sh/${slug}?as=in`, { replace: true })
        }, 700)
        return () => clearTimeout(timer)
      }
      return
    }
    if (!still) {
      const timer = setTimeout(() => setStep(step + 1), 700)
      return () => clearTimeout(timer)
    }
  }, [step])
  return (
    <Card title={`Import ${slug}`}>
      <p className="app-pr-note">Smithers reads 214 files from GitHub. Changes you merge become commits on {slug}.</p>
      {step === -1 ? (
        <div className="app-run-foot"><button type="button" className="app-btn app-btn-primary" onClick={() => setStep(0)}>Import</button></div>
      ) : (
        <ul className="app-steps">
          {steps.map((label, i) => (
            <li className="app-step" key={label} data-state={i < step ? "done" : i === step ? "active" : "todo"}>
              <span className="app-step-icon">{i < step ? <span className="app-check-ok"><Icon name="check" size={14} /></span> : i === step ? (still && i === 1 ? <span className="app-spin" /> : <span className="app-spin" />) : null}</span>
              {label}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

const PUBLIC_REPOS = ["smithers-canary/smithers", "effeck/effeck", "smithersai/hello-smithers"]

export const SignInCard = ({ slug }: { slug: string }) => {
  const { flags } = useMock()
  return (
    <Card title={`${slug} isn't on Smithers yet.`}>
      <p className="app-pr-note" style={{ marginBottom: 12 }}>Sign in with GitHub to import it, or open a public repo:</p>
      <div className="app-file-rows" style={{ marginBottom: 16 }}>
        {PUBLIC_REPOS.map(publicSlug => (
          <Link key={publicSlug} to={`smithers.sh/${publicSlug}`} className="app-file-row">
            <Icon name="dir" />
            <span className="app-file-name">{publicSlug}</span>
          </Link>
        ))}
      </div>
      <div className="app-run-foot">
        <Link to={signInRoute(`smithers.sh/${slug}?card=import`)} className="app-btn app-btn-primary">Sign in with GitHub</Link>
        {flags.hosted === "up" && (
          <Link to="smithers.sh/smithersai/hello-smithers?card=example" className="app-btn app-btn-secondary">No repo handy? Start from our example</Link>
        )}
      </div>
    </Card>
  )
}

export const UnknownRepoCard = ({ slug }: { slug: string }) => (
  <Card title={`Smithers can't read ${slug}.`}>
    <p className="app-pr-note" style={{ marginBottom: 12 }}>Check the name, or give the Smithers GitHub App access to it.</p>
    <div className="app-run-foot">
      <a href={EXTERNAL.githubApp} target="_blank" rel="noopener noreferrer" className="app-btn app-btn-secondary">Open GitHub App settings ↗</a>
      <Link to="smithers.sh/" className="app-btn app-btn-quiet app-btn-sm">Back to smithers.sh</Link>
    </div>
  </Card>
)

export const ExampleCard = ({ repo }: { repo: RepoData }) => {
  const { flags } = useMock()
  const location = useLocation()
  const name = repo.slug.split("/")[1]
  const target = `maya/${name}`
  const prefill = repo.slug === "smithersai/hello-smithers" ? "Add Spanish greetings and test both" : "Add a typed error for a blank name and test it"
  const what = repo.slug === "smithersai/hello-smithers"
    ? "a greeting function with tests"
    : "a runnable VibeLang starter: one function and one log"
  const [step, setStep] = useState<number>(-1)
  const steps = [`Creating ${target} on GitHub`, "Importing", "Ready"]
  useEffect(() => {
    if (step < 0 || step >= steps.length) return
    if (step === steps.length - 1) {
      if (!still) {
        const timer = setTimeout(() => navigate(`smithers.sh/${target}?as=in&compose=${encodeURIComponent(prefill)}`, { replace: true }), 700)
        return () => clearTimeout(timer)
      }
      return
    }
    if (!still) {
      const timer = setTimeout(() => setStep(step + 1), 700)
      return () => clearTimeout(timer)
    }
  }, [step])

  if (flags.hosted === "paused" || flags.landing === "install") {
    return (
      <Card title="Start from our example">
        <p className="app-pr-note">Hosted examples are paused. Install locally to start.</p>
      </Card>
    )
  }
  return (
    <Card title="Start from our example">
      <p className="app-pr-note" style={{ marginBottom: 12 }}>Smithers creates {target} on your GitHub from {repo.slug}, {what}. You then ask for a change and merge it there.</p>
      {flags.as === "out" ? (
        <Link to={signInRoute(location)} className="app-btn app-btn-primary">Sign in with GitHub</Link>
      ) : step === -1 ? (
        <button type="button" className="app-btn app-btn-primary" onClick={() => setStep(0)}>Make my copy</button>
      ) : (
        <ul className="app-steps">
          {steps.map((label, i) => (
            <li className="app-step" key={label} data-state={i < step ? "done" : i === step ? "active" : "todo"}>
              <span className="app-step-icon">{i < step ? <span className="app-check-ok"><Icon name="check" size={14} /></span> : i === step ? <span className="app-spin" /> : null}</span>
              {label}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
