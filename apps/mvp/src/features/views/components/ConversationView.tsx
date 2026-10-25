import { DocsPageView, Button, FlowFormView, GeneratedView, WebLinkCard, type WebPagePreview, WebPageView } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import type { MouseEvent } from "react"
import { useChat } from "../../../AppContext"
import { IssuesEmbed } from "../../issues/components/IssuesEmbed"
import { issuesPath } from "../../issues/contract"
import { RepoEmbed } from "../../repo/components/RepoEmbed"
import { useShownMode } from "../../theme/components/ThemeButton"
import { useWeb } from "../../web/components/WebContext"
import { type AppTemplate, FULL_SCREEN, SUBMIT_EVENT } from "../contract"
import { formOf, generatedOf, issuesOf, pageOf, repoOf, type ViewRow } from "../rows"
import { useViews } from "./ViewsContext"

/** A click the app handles itself: the main button, no modifier, so a new tab or window keeps the browser's own. */
export const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

// One view in the conversation (docs/features/web-pages.md#in-the-conversation, docs/features/views.md), rendered from
// its own synced row: a `webpage` inline, with its origin, "Open in new tab" and a link to its full-screen size, and the
// page's preview over the frame until it loads; a `link` card with the page's icon, title, description and domain,
// whose Open in new tab button opens it in a new tab; the agent's form, whose submission is the person's next question;
// and a generated view in its sandboxed frame, whose moves go to ChatApi and whose message events are questions. Each
// but a `link` has a Full screen link to `/app/views/<id>`. A repository's view and its issues view are the app's own
// (decision 0004 §3), small here; their Full screen is the repository's own page, which records where it was opened
// from, so its Back to chat returns here (src/features/views/minimize.ts).
export function ConversationView({ id, conversationId }: { id: string; conversationId?: string }) {
  const web = useWeb()
  const views = useViews()
  const navigate = useNavigate()
  const here = useRouterState({ select: (state) => state.location.href })
  const { data: rows } = useLiveQuery(views.queries.rowsIn(conversationId))
  const view = rows.find((row) => row.id === id)
  if (view === undefined) return null
  const repo = repoOf(view)
  const issues = issuesOf(view)
  /** Opens `href` full screen from this view of `template` showing `repository`, so Back to chat comes back here. */
  const openFrom = (template: AppTemplate, repository: string) => (href: string) => {
    views.actions.opened(view.id, template, repository, here)
    void navigate({ href })
  }
  /** The app view's Full screen: a real link, which a plain click opens through `open`. */
  const fullScreenAt = (href: string, open: (href: string) => void) => (
    <Button asChild variant="ghost" size="sm">
      <a
        href={href}
        onClick={(event) => {
          if (!plainClick(event)) return
          event.preventDefault()
          open(href)
        }}
      >
        {FULL_SCREEN}
      </a>
    </Button>
  )
  if (repo !== undefined) {
    const open = openFrom("repo", repo.repo)
    return (
      <div className="conversation-view" data-view={view.id} data-template={view.template}>
        <RepoEmbed viewId={view.id} target={repo} fullScreen={(href) => fullScreenAt(href, open)} onOpen={open} />
      </div>
    )
  }
  if (issues !== undefined) {
    const open = openFrom("issues", issues.repo)
    const [owner = "", name = ""] = issues.repo.split("/")
    return (
      <div className="conversation-view" data-view={view.id} data-template={view.template}>
        <IssuesEmbed repo={issues.repo} fullScreen={fullScreenAt(issuesPath(owner, name), open)} onOpen={open} />
      </div>
    )
  }
  const fullScreen = (
    <Link
      to="/app/views/$viewId"
      params={{ viewId: view.id }}
      search={conversationId === undefined ? {} : { conversation: conversationId }}
    >
      {FULL_SCREEN}
    </Link>
  )
  return (
    <div className="conversation-view" data-view={view.id} data-template={view.template}>
      {view.template === "webpage" ? (
        <WebPageView url={pageOf(view).url} size="inline" preview={previewOf(view)} actions={fullScreen} />
      ) : view.template === "docs" ? (
        <DocsPageView url={pageOf(view).url} title={pageOf(view).title ?? ""}
          text={pageOf(view).text ?? ""} truncated={pageOf(view).truncated === true}
          size="inline" headingLevel={3} actions={fullScreen} />
      ) : view.template === "link" ? (
        <WebLinkCard
          url={pageOf(view).url}
          title={pageOf(view).title}
          description={pageOf(view).description}
          icon={pageOf(view).icon}
          onOpen={web.actions.cardOpened}
        />
      ) : (
        <>
          <AgentView view={view} size="inline" conversationId={conversationId} />
          <Button asChild variant="ghost" size="sm">{fullScreen}</Button>
        </>
      )}
    </div>
  )
}

/** What a page says about itself, read by ChatApi's check. */
export const previewOf = (view: ViewRow): WebPagePreview => {
  const { title, description, icon } = pageOf(view)
  return { title, description, icon }
}

/**
 * The agent's form or generated view at `size`: the same component, from the same row, inline and full screen. A form's
 * submission and a view's message event are asked in the view's own conversation; a move is `view/set-state`.
 */
export function AgentView({ view, size, conversationId }: { view: ViewRow; size: "inline" | "full"; conversationId?: string | undefined }) {
  const chat = useChat()
  const views = useViews()
  const mode = useShownMode()
  const form = formOf(view)
  const generated = generatedOf(view)
  const place = conversationId === undefined ? {} : { conversationId }
  if (form !== undefined) {
    return (
      <FlowFormView
        title={form.props.title}
        schema={form.props.schema}
        submitLabel={form.props.submitLabel}
        submitted={form.state.submitted}
        values={form.state.values}
        size={size}
        onSubmit={(submission) =>
          chat.actions.askFromView(submission.text, {
            source: { viewId: view.id, event: SUBMIT_EVENT },
            data: submission.data,
            ...place,
          })}
      />
    )
  }
  if (generated === undefined) return null
  return (
    <GeneratedView
      html={generated.html}
      interactions={generated.interactions}
      title={generated.title}
      theme={mode}
      size={size}
      onInteraction={(interaction) =>
        interaction._tag === "State"
          ? void views.actions.move(view.id, generated.revision, interaction.event)
          : void chat.actions.askFromView(interaction.label, {
            source: { viewId: view.id, event: interaction.event.name },
            ...(interaction.values === undefined ? {} : { data: interaction.values }),
            ...place,
          })}
    />
  )
}
