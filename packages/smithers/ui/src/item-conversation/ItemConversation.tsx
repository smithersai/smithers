/** @jsxImportSource react */
import { type ComponentProps, type KeyboardEvent, type ReactNode, useId } from "react";
import { Badge } from "../badge";
import { Button } from "../button";
import { cn } from "@smthrs/ui-css";
import { Textarea } from "../input";
import { ITEM_STATE_VARIANTS, ItemStateIcon, type ItemStateKind, type ItemStatus } from "../issues-view/ItemStateIcon";
import { issueNumberText, PENDING_WORDS, STATE_STATUS, type IssuesViewPending } from "../issues-view/IssuesView";
import { ItemLink, type ItemLinkTarget } from "../issues-view/ItemLink";
import { safeHref } from "../internal/safeHref";
import { Markdown } from "../primitives/markdown";
import { Skeleton } from "../skeleton";
import { useInjectUiCss } from "../styles";
import { RelativeTime } from "../time/RelativeTime";

/** One comment on an issue, in the order the host passes them. */
export type ItemConversationComment = {
  readonly id: string;
  readonly author?: string;
  /** ISO 8601. */
  readonly createdAt?: string;
  /** Markdown. */
  readonly body: string;
  readonly pending?: IssuesViewPending;
  /** Shown for a not_sent comment: a short closed reason such as "Not allowed" (the host decides the words). */
  readonly reason?: string;
  /** Buttons for this comment, such as Edit and Discard for a not-sent one. */
  readonly actions?: ReactNode;
};

/** Something that happened to the item, in its timeline: who, what and when, with a state icon. */
export type ItemConversationEvent = {
  readonly id: string;
  /** The icon beside it. */
  readonly kind: ItemStateKind;
  /** Who did it, bold before `text`; absent: `text` alone. */
  readonly author?: string;
  /** What happened, such as `committed` after an author, or `Dropped` alone. */
  readonly text: string;
  /** ISO 8601. */
  readonly createdAt?: string;
};

/** The comment composer. Controlled: the host owns the draft. */
export type ItemConversationComposer = {
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  readonly onSubmit: () => void;
  readonly disabled?: boolean;
  /** Accessible label of the textarea; default "Comment". */
  readonly label?: string;
};

export type ItemConversationProps = Omit<ComponentProps<"article">, "children" | "title"> & {
  title: string;
  number: number | null;
  state: "open" | "closed";
  /** The state pill's icon and word; default Open or Closed from `state`. */
  status?: ItemStatus;
  /** What the number reads after: `#` (default) for `#12`, or `T` for `T4`. */
  numberPrefix?: string;
  author?: string;
  /** ISO 8601. */
  createdAt?: string;
  /** Markdown. */
  body: string;
  pending?: IssuesViewPending;
  comments: ReadonlyArray<ItemConversationComment>;
  /** What happened to the item, in the host's order, between the body and the comments. */
  events?: ReadonlyArray<ItemConversationEvent>;
  /** A side column, as GitHub's issue page has: `ItemAsideSection`s and actions. Absent: one column. */
  aside?: ReactNode;
  /** "Open on GitHub ↗" link target, when known. */
  externalHref?: string;
  /** Rows aren't known yet: a loading state. */
  loading?: boolean;
  /** The composer; absent when this person can't comment (hidden, not disabled). Controlled. */
  composer?: ItemConversationComposer;
  /** The title's heading level. Default `h1`. */
  headingLevel?: 1 | 2 | 3;
  /** Controls at the end of the header's meta row, such as `TriageControl`. Not rendered while `loading`. */
  headerActions?: ReactNode;
};

/** ⌘Enter on macOS, Ctrl+Enter elsewhere; never while an IME composes. */
export const isSubmitChord = (event: KeyboardEvent<HTMLElement>): boolean =>
  event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing;

/** A timestamp as a ticking relative time, or nothing when it isn't a date. */
function When({ iso }: { readonly iso: string | undefined }) {
  if (iso === undefined) return null;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : <RelativeTime ts={ts} />;
}

function PendingChip({ pending }: { readonly pending: IssuesViewPending | undefined }) {
  if (pending === undefined) return null;
  return (
    <Badge variant={pending === "not_sent" ? "destructive" : "muted"} className="sui-item-conv-pending">
      {PENDING_WORDS[pending]}
    </Badge>
  );
}

export type ItemAsideSectionProps = Omit<ComponentProps<"section">, "title"> & {
  /** The section's name, shown above its content, such as `Branch`. */
  title: string;
  /** Links under the title, one per line, such as a branch or a pull request: `http(s)` in a new tab, any other in-app. */
  links?: ReadonlyArray<ItemLinkTarget>;
  /** Called on a plain left click of an in-app link, after `preventDefault`, so a host router navigates. */
  onNavigate?: (href: string) => void;
};

/** One section of an item page's side column: a small heading, its links and its content, as GitHub's sidebar shows. */
export function ItemAsideSection({ title, links, onNavigate, children, className, ...props }: ItemAsideSectionProps) {
  useInjectUiCss();
  return (
    <section {...props} aria-label={title} data-slot="item-aside-section" className={cn("sui-item-aside-section", className)}>
      <div className="sui-item-aside-title">{title}</div>
      {links?.map((link) => <ItemLink key={link.label} link={link} onNavigate={onNavigate} className="sui-item-aside-link" />)}
      {children}
    </section>
  );
}

/**
 * One item's page, as GitHub's issue page: the title with `#number` (`#–`
 * before it's numbered), a state pill (Open or Closed, or the host's
 * `status`), the author, an optional "Open on GitHub ↗" link and the host's
 * `headerActions`; the body; its timeline `events`; the comments in order as
 * an `<ol>`; the composer when the person may comment; and the `aside` column.
 *
 * Bodies and comments render through the light `Markdown` in its `document`
 * variant, as GitHub renders them: HTML comments (issue templates) are dropped
 * and no tag the text names, a `<script>` included, ever becomes an element.
 *
 * A pending item or comment carries a `Requested` or `Not sent` chip and
 * `data-pending`; a not-sent comment shows its `reason` and `actions`. The
 * composer submits on its button, ⌘Enter or Ctrl+Enter, and only while the
 * trimmed draft is non-empty and it isn't `disabled`. While `loading` the page
 * shows placeholders and a status, and no composer or header actions.
 */
export function ItemConversation({
  title,
  number,
  state,
  status,
  numberPrefix = "#",
  author,
  createdAt,
  body,
  pending,
  comments,
  events,
  aside,
  externalHref,
  loading = false,
  composer,
  headingLevel = 1,
  headerActions,
  className,
  ...props
}: ItemConversationProps) {
  useInjectUiCss();
  const titleId = useId();
  const draftId = useId();
  const Heading = `h${headingLevel}` as const;

  if (loading) {
    return (
      <article
        {...props}
        data-slot="item-conversation"
        aria-busy="true"
        aria-label="Loading"
        className={cn("sui-item-conv", className)}
      >
        <span className="sui-sr-only" role="status">Loading</span>
        <div className="sui-item-conv-loading" aria-hidden>
          <Skeleton className="sui-item-conv-skeleton-title" />
          <Skeleton className="sui-item-conv-skeleton-body" />
          <Skeleton className="sui-item-conv-skeleton-body" />
        </div>
      </article>
    );
  }

  const external = externalHref === undefined ? undefined : safeHref(externalHref);
  const shown = status ?? STATE_STATUS[state];
  const canSubmit = composer !== undefined && composer.disabled !== true && composer.draft.trim() !== "";
  const submit = () => {
    if (canSubmit) composer?.onSubmit();
  };

  return (
    <article
      {...props}
      data-slot="item-conversation"
      data-state={state}
      data-status={shown.kind}
      data-pending={pending}
      data-aside={aside === undefined || aside === null ? undefined : ""}
      aria-labelledby={titleId}
      className={cn("sui-item-conv", className)}
    >
      <header className="sui-item-conv-header">
        <Heading id={titleId} className="sui-item-conv-title">
          {title} <span className="sui-item-conv-number">{issueNumberText(number, numberPrefix)}</span>
        </Heading>
        <div className="sui-item-conv-meta">
          <Badge variant={ITEM_STATE_VARIANTS[shown.kind]} className="sui-item-conv-state" data-status={shown.kind}>
            <ItemStateIcon kind={shown.kind} label={shown.label} live={shown.live} aria-hidden />
            {shown.label}
          </Badge>
          <PendingChip pending={pending} />
          {author === undefined ? null : <span className="sui-item-conv-author">{author}</span>}
          <When iso={createdAt} />
          {external === undefined ? null : (
            <a className="sui-item-conv-external" href={external} target="_blank" rel="noopener noreferrer">
              Open on GitHub ↗
            </a>
          )}
          {headerActions === undefined || headerActions === null ? null : (
            <div className="sui-item-conv-header-actions">{headerActions}</div>
          )}
        </div>
      </header>
      <div className="sui-item-conv-main">
        {body.trim() === "" ? null : (
          <div className="sui-item-conv-post">
            <Markdown content={body} variant="document" />
          </div>
        )}
        {events === undefined || events.length === 0 ? null : (
          <ol className="sui-item-conv-events" aria-label="Timeline">
            {events.map((event) => (
              <li key={event.id} className="sui-item-conv-event" data-kind={event.kind}>
                <span className="sui-item-conv-event-icon">
                  <ItemStateIcon kind={event.kind} label={event.text} aria-hidden />
                </span>
                <span className="sui-item-conv-event-text">
                  {event.author === undefined ? event.text : (
                    <>
                      <span className="sui-item-conv-author">{event.author}</span> {event.text}
                    </>
                  )}
                </span>
                <When iso={event.createdAt} />
              </li>
            ))}
          </ol>
        )}
        {comments.length === 0 ? null : (
          <ol className="sui-item-conv-comments" aria-label="Comments">
            {comments.map((comment) => (
              <li key={comment.id} className="sui-item-conv-comment" data-pending={comment.pending}>
                <div className="sui-item-conv-comment-meta">
                  {comment.author === undefined ? null : <span className="sui-item-conv-author">{comment.author}</span>}
                  <When iso={comment.createdAt} />
                  <PendingChip pending={comment.pending} />
                  {comment.pending === "not_sent" && comment.reason !== undefined ? (
                    <span className="sui-item-conv-reason">{comment.reason}</span>
                  ) : null}
                </div>
                <Markdown content={comment.body} variant="document" />
                {comment.actions === undefined || comment.actions === null ? null : (
                  <div className="sui-item-conv-comment-actions">{comment.actions}</div>
                )}
              </li>
            ))}
          </ol>
        )}
        {composer === undefined ? null : (
          <form
            className="sui-item-conv-composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <label htmlFor={draftId} className="sui-sr-only">
              {composer.label ?? "Comment"}
            </label>
            <Textarea
              id={draftId}
              value={composer.draft}
              onChange={(event) => composer.onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (!isSubmitChord(event)) return;
                event.preventDefault();
                submit();
              }}
            />
            <div className="sui-item-conv-composer-actions">
              <Button type="submit" disabled={!canSubmit}>
                Comment
              </Button>
            </div>
          </form>
        )}
      </div>
      {aside === undefined || aside === null ? null : <aside className="sui-item-conv-aside">{aside}</aside>}
    </article>
  );
}
