import { WriteControl } from "../../frame/WriteControl"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import { useMock } from "../../../core/mock"
import { Link, useLocation } from "../../../core/router"
import { MOCK_NOW, people, repo, to, wiki, wikiPage } from "../../fixtures"
import type { DiffFile, DiffLine, WikiPage as WikiRecord } from "../../fixtures/types"
import { Denied, Empty, Failed, Loading, registerSlash, SignInWall, useView } from "../../frame"
import { ViewFrame as RepoFrame } from "../checklist/ViewFrame"
import { AgentMark, Box, DiffView, Icon, Markdown, PageHeader, PersonChip, RelTime, toast } from "../../ui"

type Proposal = NonNullable<WikiRecord["proposals"]>[number]
const viewer = () => people.find(person => person.role === "owner")?.login ?? repo.owner
const pageRoute = (page: WikiRecord) => `wiki/${encodeURIComponent(page.slug)}`

export const proposalDiff = (page: WikiRecord, proposal: Proposal): DiffFile[] => {
  let old = 1
  let next = 1
  const lines: DiffLine[] = proposal.diff.split("\n").map(text => {
    if (text.startsWith("@@")) {
      const match = text.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/)
      if (match) { old = Number(match[1]); next = Number(match[2]) }
      return { kind: "hunk", text }
    }
    if (text.startsWith("+")) return { kind: "add", new: next++, text: text.slice(1) }
    if (text.startsWith("-")) return { kind: "del", old: old++, text: text.slice(1) }
    return { kind: "ctx", old: old++, new: next++, text: text.replace(/^ /, "") }
  })
  return [{
    path: `${page.slug}.md`,
    status: "modified",
    additions: lines.filter(line => line.kind === "add").length,
    deletions: lines.filter(line => line.kind === "del").length,
    lines
  }]
}

/** Apply complete hunks at their preview coordinates, allowing shortened context on that line. */
export const applyProposal = (body: string, diff: string) => {
  const source = body === "" ? [] : body.split("\n")
  let fence = ""
  const prose = source.map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1]
    const code = Boolean(fence) || /^( {4}|\t)/.test(line) || Boolean(marker)
    if (marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""
    }
    return !code
  })
  const result: string[] = []
  let cursor = 0
  let hunk: { old: number; next: number } | undefined
  const conflict = () => { throw new Error("Proposal conflicts with this page.") }
  const finishHunk = () => {
    if (hunk && (hunk.old !== 0 || hunk.next !== 0)) conflict()
  }
  const contextMatches = (actual: string, context: string) => {
    if (actual === context) return true
    // Only complete prose sentences may be shortened. Code context must match exactly.
    if (!prose[cursor] || !/^[A-Z].*\.$/.test(context) || /[`=<>\[\]{}+*/|&]/.test(context)) return false
    // Shortened prose keeps a contiguous phrase; only articles and sentence periods may differ.
    const words = (text: string) => text.split(/\s+/)
      .map(word => word.replace(/\.$/, ""))
      .filter(word => word && !/^(a|an|the)$/i.test(word))
    const short = words(context)
    return short.length > 0 && `\0${words(actual).join("\0")}\0`.includes(`\0${short.join("\0")}\0`)
  }
  const lines = diff.split("\n")
  if (lines.at(-1) === "") lines.pop()
  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/)
    if (header) {
      finishHunk()
      const old = Number(header[2] ?? 1), next = Number(header[4] ?? 1)
      const at = Number(header[1]) - (old === 0 ? 0 : 1)
      const target = Number(header[3]) - (next === 0 ? 0 : 1)
      if (at < cursor || at > source.length || target !== result.length + at - cursor) conflict()
      result.push(...source.slice(cursor, at))
      cursor = at
      hunk = { old, next }
    } else {
      if (!hunk) return conflict()
      const text = line.slice(1)
      if (line.startsWith("+")) {
        result.push(text)
        hunk.next--
      } else if (line.startsWith("-") || line.startsWith(" ")) {
        if (cursor >= source.length || (line.startsWith("-") ? source[cursor] !== text : !contextMatches(source[cursor], text))) conflict()
        if (line.startsWith(" ")) { result.push(source[cursor]); hunk.next-- }
        cursor++
        hunk.old--
      } else conflict()
      if (hunk.old < 0 || hunk.next < 0) conflict()
    }
  }
  if (!hunk) return conflict()
  finishHunk()
  return [...result, ...source.slice(cursor)].join("\n")
}

const WikiSidebar = ({ page, localPages }: { page?: WikiRecord; localPages: WikiRecord[] }) => (
  <aside className="repo-wiki-sidebar">
    <h2>Pages <span className="repo-ui-muted">{localPages.length}</span></h2>
    <nav aria-label="Wiki pages">
      {localPages.map(item => (
        <Link key={item.slug} className="repo-wiki-page-link" aria-current={page?.slug === item.slug ? "page" : undefined} to={to(pageRoute(item))}>
          <span>{item.title}</span>
          <RelTime date={item.updated} />
        </Link>
      ))}
    </nav>
  </aside>
)

export const WikiHistory = ({ page, onClose }: { page: WikiRecord; onClose: () => void }) => {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  useEffect(() => registerSlash("wiki.history.close", {
    purpose: "Close page history", fields: [], confirm: false, access: "public", run: () => onClose()
  }), [onClose])
  const revisions = page.revisions ?? [{ n: page.revision, date: page.updated, author: page.author, summary: "Page updated" }]
  return (
    <aside className="repo-wiki-history" aria-label="Page history" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose() } }}>
      <div className="repo-wiki-history-heading">
        <h2 tabIndex={-1} ref={heading}>History</h2>
        <button className="repo-ui-icon-btn" title="/wiki.history.close" aria-label="Close history" onClick={onClose}>Close</button>
      </div>
      {revisions.map(revision => (
        <div className="repo-wiki-revision" key={revision.n}>
          <strong>Revision {revision.n}{revision.n === page.revision && <span className="repo-ui-muted"> · current</span>}</strong>
          <p>{revision.summary}</p>
          <div className="repo-wiki-revision-author">
            <PersonChip login={revision.author} compact />
            {revision.agent && <AgentMark agent={revision.agent} />}
          </div>
          <RelTime date={revision.date} />

        </div>
      ))}
    </aside>
  )
}

const WikiProvenance = ({ page }: { page: WikiRecord }) => (
  <div className="repo-wiki-provenance">
    <Icon name={page.provenance.source === "run" ? "agent" : "file"} size={14} />
    {page.provenance.source === "person" ? <span>Written by a person</span> : (
      <span>Inferred by <Link to={to(`runs/${page.provenance.run}`)}>{page.provenance.run}</Link> · {page.provenance.confidence ?? "unknown"} confidence</span>
    )}
  </div>
)

export const WikiProposal = ({ page, proposal, onAccept, onDismiss, onConfirmChange }: {
  page: WikiRecord
  proposal: Proposal
  onAccept: () => void
  onDismiss: () => void
  onConfirmChange?: (value: boolean) => void
}) => {
  const { flags } = useMock()
  const query = new URLSearchParams(useLocation().split("?")[1])
  const [confirm, setConfirm] = useState(query.get("accept") === proposal.run)
  useEffect(() => { onConfirmChange?.(confirm); return () => onConfirmChange?.(false) }, [confirm, onConfirmChange])
  const canEdit = flags.as === "in" && flags.role === "member"
  const reason = flags.as === "out" ? "Sign in to accept or dismiss proposals." : "Only members can accept or dismiss proposals."
  useEffect(() => registerSlash("wiki.proposal.cancel", {
    purpose: "Cancel proposal acceptance", fields: [], confirm: false, access: "public", run: () => setConfirm(false)
  }), [])
  return (
    <Box className="repo-wiki-proposal" header={(
      <div className="repo-wiki-proposal-heading">
        <Icon name="agent" />
        <strong>Learning proposal</strong>
        <Link to={to(`runs/${proposal.run}`)}>{proposal.run}</Link>
      </div>
    )}>
      <div className="repo-wiki-proposal-content">
        <p>{proposal.summary}</p>
        <DiffView files={proposalDiff(page, proposal)} />
        {confirm ? (
          <div className="repo-wiki-confirm" role="group" aria-label="Confirm proposal acceptance">
            <strong>Accept this proposal?</strong>
            <p>Update {page.title} to revision {page.revision + 1}.</p>
            <div className="repo-ui-actions">
              <WriteControl><button className="repo-ui-btn repo-ui-btn-primary" title={`/wiki.accept ${proposal.run}`} disabled={!canEdit} onClick={onAccept}>Confirm accept</button></WriteControl>
              <button className="repo-ui-btn repo-ui-btn-quiet" title="/wiki.proposal.cancel" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="repo-ui-actions">
            <WriteControl><button className="repo-ui-btn" title={`/wiki.accept ${proposal.run}`} disabled={!canEdit} aria-describedby={!canEdit ? `proposal-permission-${proposal.run}` : undefined} onClick={() => setConfirm(true)}>Accept</button></WriteControl>
            <WriteControl><button className="repo-ui-btn repo-ui-btn-quiet" title={`/wiki.dismiss ${proposal.run}`} disabled={!canEdit} onClick={onDismiss}>Dismiss</button></WriteControl>
          </div>
        )}
        {!canEdit && <p id={`proposal-permission-${proposal.run}`} className="repo-ui-muted">{reason}</p>}
      </div>
    </Box>
  )
}

export const WikiEditor = ({ page, onSave, onCancel, isNew = false }: {
  page: WikiRecord
  onSave: (body: string, title?: string) => void
  onCancel: () => void
  isNew?: boolean
}) => {
  const id = useId()
  const { flags } = useMock()
  const [body, setBody] = useState(page.body)
  const [title, setTitle] = useState(page.title)
  const query = new URLSearchParams(useLocation().split("?")[1])
  const [preview, setPreview] = useState(query.get("preview") === "1")
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    const offWrite = registerSlash("wiki.write", { purpose: "Write markdown", fields: [], confirm: false, run: () => setPreview(false) })
    const offPreview = registerSlash("wiki.preview", { purpose: "Preview markdown", fields: [], confirm: false, run: () => setPreview(true) })
    return () => { offWrite(); offPreview() }
  }, [])
  useEffect(() => registerSlash("wiki.save", {
    purpose: "Save wiki page",
    fields: [],
    confirm: false,
    run: () => { if (body.trim() && title.trim()) onSave(body, isNew ? title : undefined) }
  }), [body, title, onSave, isNew])
  if (flags.as === "out") return <SignInWall act="edit the wiki" />
  if (flags.role !== "member") return <Denied act="edit the wiki" />
  return (
    <form className="repo-wiki-editor" onSubmit={event => {
      event.preventDefault()
      if (body.trim() && title.trim()) onSave(body, isNew ? title : undefined)
    }}>
      {isNew && (
        <label htmlFor={`${id}-title`}>Page title
          <input className="repo-ui-input" id={`${id}-title`} required value={title} onChange={event => setTitle(event.target.value)} />
        </label>
      )}
      <div className="repo-wiki-editor-toolbar">
      <div className="repo-ui-actions">
        <button className="repo-ui-btn repo-ui-btn-primary" title="/wiki.save" disabled={!body.trim() || !title.trim()}>Save</button>
        <button type="button" className="repo-ui-btn repo-ui-btn-quiet" title="/wiki.cancel" onClick={onCancel}>Cancel</button>
      </div>
      <div className="repo-wiki-editor-tabs" role="tablist" aria-label="Markdown editor">
        <button type="button" role="tab" aria-selected={!preview} aria-controls={`${id}-write`} title="/wiki.write" onClick={() => setPreview(false)}>Write</button>
        <button type="button" role="tab" aria-selected={preview} aria-controls={`${id}-preview`} title="/wiki.preview" onClick={() => setPreview(true)}>Preview</button>
      </div>
      </div>
      {preview ? (
        <div id={`${id}-preview`} className="repo-wiki-preview" role="tabpanel"><Markdown source={body} base="wiki" /></div>
      ) : (
        <div id={`${id}-write`} role="tabpanel">
          <label className="repo-ui-sr" htmlFor={`${id}-body`}>Page markdown</label>
          <textarea ref={input} className="repo-ui-input" id={`${id}-body`} required value={body} onChange={event => setBody(event.target.value)} spellCheck={false} />
        </div>
      )}

    </form>
  )
}

export const WikiLoading = () => <Loading variant="detail" rows={7} />
export const WikiError = () => <Failed what="the wiki" reason="The wiki service didn't respond. Pages haven't loaded." />
export const WikiNotFound = () => <Empty title="Wiki page not found." action={<Link to={to("wiki")}>Wiki home</Link>} />
export const WikiSignedOut = () => <p className="repo-wiki-permission">Sign in to edit pages or review proposals.</p>
export const WikiDenied = () => <p className="repo-wiki-permission">Only members can edit pages or review proposals.</p>

export const WikiEmpty = () => {
  const { flags } = useMock()
  const query = new URLSearchParams(useLocation().split("?")[1])
  const [create, setCreate] = useState(query.get("new") === "1")
  const [page, setPage] = useState<WikiRecord | null>(null)
  useEffect(() => {
    const offNew = registerSlash("wiki.new", { purpose: "Create wiki page", fields: [], confirm: false, run: () => setCreate(true) })
    const offCancel = registerSlash("wiki.cancel", { purpose: "Cancel wiki edit", fields: [], confirm: false, run: () => setCreate(false) })
    return () => { offNew(); offCancel() }
  }, [])
  const template: WikiRecord = {
    slug: "home", title: "Home", body: "", updated: MOCK_NOW,
    author: viewer(), revision: 1, provenance: { source: "person" }
  }
  if (page) return (
    <>
      <PageHeader title={page.title} />
      <WikiProvenance page={page} />
      <Markdown source={page.body} base="wiki" />
    </>
  )
  if (create) return (
    <>
      <PageHeader title="New wiki page" />
      <WikiEditor page={template} isNew onCancel={() => setCreate(false)} onSave={(body, title) => {
        setPage({ ...template, title: title ?? template.title, body })
        toast("Wiki page created.")
      }} />
    </>
  )
  return (
    <Empty title="No wiki pages yet.">
      <p>Runs propose pages as they learn; you can start one.</p>
      <WriteControl primary><button className="repo-ui-btn repo-ui-btn-primary" title="/wiki.new" onClick={() => setCreate(true)} disabled={flags.as !== "in" || flags.role !== "member"}>New page</button></WriteControl>
      {flags.as === "in" && flags.role !== "member" ? <WikiDenied /> : null}
    </Empty>
  )
}

export const WikiReady = ({ slug }: { slug?: string }) => {
  const { flags } = useMock()
  const location = useLocation()
  const query = new URLSearchParams(location.split("?")[1])
  const [changes, setChanges] = useState<Record<string, WikiRecord>>({})
  const [editing, setEditing] = useState(query.get("edit") === "1")
  const [history, setHistory] = useState(query.get("history") === "1")
  const [confirmingProposal, setConfirmingProposal] = useState(Boolean(query.get("accept")))
  const initial = slug ? wikiPage(slug) ?? wiki.find(page => page.slug.toLowerCase() === slug.toLowerCase())
    : wiki.find(page => page.slug.toLowerCase() === "home") ?? wiki[0]
  const page = initial ? changes[initial.slug] ?? initial : undefined
  const canEdit = flags.as === "in" && flags.role === "member"
  useEffect(() => {
    setEditing(query.get("edit") === "1")
    setHistory(query.get("history") === "1")
  }, [location])
  const save = useCallback((body: string) => {
    if (!page || !canEdit) return
    setChanges(current => ({ ...current, [page.slug]: {
      ...page, body, revision: page.revision + 1, updated: MOCK_NOW, author: viewer(), provenance: { source: "person" },
      revisions: [{ n: page.revision + 1, date: MOCK_NOW, author: viewer(), summary: "Edit wiki page" }, ...(page.revisions ?? [])]
    } }))
    setEditing(false)
    toast("Wiki page saved.")
  }, [page, canEdit])
  const decide = useCallback((proposal: Proposal, accept: boolean) => {
    if (!page || !canEdit) return
    const remaining = page.proposals?.filter(item => item !== proposal)
    let body = page.body
    if (accept) {
      try { body = applyProposal(page.body, proposal.diff) }
      catch { toast("Proposal conflicts with this page."); return }
    }
    setChanges(current => ({ ...current, [page.slug]: {
      ...page, body, proposals: remaining,
      ...(accept ? {
        revision: page.revision + 1, updated: MOCK_NOW, author: viewer(),
        provenance: { source: "run" as const, run: proposal.run, confidence: "medium" as const },
        revisions: [{ n: page.revision + 1, date: MOCK_NOW, author: viewer(), summary: `Accept proposal from ${proposal.run}` }, ...(page.revisions ?? [])]
      } : {})
    } }))
    toast(accept ? "Proposal accepted. Page updated." : "Proposal dismissed.")
  }, [page, canEdit])
  useEffect(() => {
    const proposals = page?.proposals ?? []
    if (!proposals.length) return
    const select = (id: string) => {
      const proposal = id ? proposals.find(item => item.run === id) : proposals[0]
      if (!proposal) throw new Error("This proposal is no longer available.")
      return proposal
    }
    const fields = [{ name: "run", label: "Run", options: proposals.map(item => item.run), required: proposals.length > 1 }]
    const offAccept = registerSlash("wiki.accept", {
      purpose: "Accept a learning proposal", fields,
      confirm: "Accept this proposal and update the page?",
      run: ({ run }) => decide(select(run), true)
    })
    const offDismiss = registerSlash("wiki.dismiss", {
      purpose: "Dismiss a learning proposal", fields, confirm: false,
      run: ({ run }) => decide(select(run), false)
    })
    return () => { offAccept(); offDismiss() }
  }, [page, decide])
  useEffect(() => {
    const offEdit = registerSlash("wiki.edit", {
      purpose: "Edit wiki page",
      fields: [], confirm: false,
      run: (_, context) => { setEditing(true); context.closeAsk() }
    })
    const offHistory = registerSlash("wiki.history", {
      purpose: "Read wiki history",
      fields: [], confirm: false, access: "public",
      run: (_, context) => { setHistory(true); context.closeAsk() }
    })
    const offCancel = registerSlash("wiki.cancel", {
      purpose: "Cancel wiki edit", fields: [], confirm: false,
      run: () => setEditing(false)
    })
    return () => { offEdit(); offHistory(); offCancel() }
  }, [])
  if (!page) return <WikiNotFound />
  return (
    <div className={`repo-wiki-layout${history ? " repo-wiki-with-history" : ""}`}>
      <main className="repo-wiki-main">
        <PageHeader title={page.title} actions={(
          <>
            <button
              className="repo-ui-btn repo-ui-btn-quiet"
              title="/wiki.history"
              aria-expanded={history}
              onClick={() => setHistory(!history)}
            >
              <Icon name="clock" />
              History
            </button>
            {!editing && (
              <WriteControl primary><button
                className={`repo-ui-btn${confirmingProposal ? "" : " repo-ui-btn-primary"}`}
                title="/wiki.edit"
                disabled={!canEdit}
                aria-describedby={!canEdit ? "repo-wiki-edit-permission" : undefined}
                onClick={() => setEditing(true)}
              >
                <Icon name="file" />
                Edit or ask
              </button></WriteControl>
            )}
          </>
        )} />
        <div className="repo-wiki-meta">
          <span>Last edited by</span>
          <PersonChip login={page.author} compact />
          {people.find(person => person.login === page.author)?.kind === "agent" && page.provenance.run && (
            <>
              <span>in run</span>
              <Link to={to(`runs/${page.provenance.run}`)}>{page.provenance.run}</Link>
              <AgentMark run={page.provenance.run} />
            </>
          )}
          <span>· revision {page.revision} ·</span>
          <RelTime date={page.updated} />
        </div>
        <WikiProvenance page={page} />
        {!canEdit && <div id="repo-wiki-edit-permission">{flags.as === "in" ? <WikiDenied /> : null}</div>}
        {editing ? <WikiEditor key={page.slug} page={page} onSave={save} onCancel={() => setEditing(false)} /> : (
          <>
            {page.proposals?.map(proposal => (
              <WikiProposal key={proposal.run} onConfirmChange={setConfirmingProposal} page={page} proposal={proposal} onAccept={() => decide(proposal, true)} onDismiss={() => decide(proposal, false)} />
            ))}
            <article className="repo-wiki-body">
              <Markdown source={page.body.replace(/^# [^\n]+\n*/, "")} base="wiki" />
            </article>
          </>
        )}
      </main>
      <WikiSidebar page={page} localPages={wiki.map(item => changes[item.slug] ?? item)} />
      {history && <WikiHistory key={`${page.slug}:${page.revision}`} page={page} onClose={() => setHistory(false)} />}
    </div>
  )
}

export const Wiki = ({ slug }: { slug?: string }) => {
  const state = useView(`wiki:${repo.slug}:${slug ?? "home"}`)
  return (
    <RepoFrame tab="wiki" title={`${repo.slug} · Wiki`} askView="wiki" askContext={`${slug ?? "Home"} · ${repo.slug} wiki`}>
      {state === "loading" ? <WikiLoading /> : state === "error" ? <WikiError />
        : state === "empty" ? <WikiEmpty /> : <WikiReady key={repo.slug} slug={slug} />}
    </RepoFrame>
  )
}
