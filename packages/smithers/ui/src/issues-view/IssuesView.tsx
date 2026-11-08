/** @jsxImportSource react */
import type { ComponentProps, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { ActionMenu, type ActionMenuItem } from "../action-menu/ActionMenu";
import { Badge } from "../badge";
import { cn } from "@smthrs/ui-css";
import { EmptyState } from "../empty-state";
import { isPlainNavigationClick } from "../internal/navigationClick";
import { safeHref } from "../internal/safeHref";
import { Skeleton } from "../skeleton";
import { useInjectUiCss } from "../styles";
import { RelativeTime } from "../time/RelativeTime";
import { ItemLink, type ItemLinkTarget } from "./ItemLink";
import { ItemStateIcon, type ItemStatus } from "./ItemStateIcon";

/** A write this device made that hasn't reached GitHub: on its way (`requested`) or refused (`not_sent`). */
export type IssuesViewPending = "requested" | "not_sent";

/** The chip each pending state shows. */
export const PENDING_WORDS: Readonly<Record<IssuesViewPending, string>> = { requested: "Requested", not_sent: "Not sent" };

/**
 * An issue's triage, read from its `smithers:` labels: neither is `proposed`,
 * one is `accepted` or `not_accepted`, and both at once is `conflict`.
 */
export type IssuesViewTriage = "proposed" | "accepted" | "not_accepted" | "conflict";

/** The chip each triage state shows. */
export const TRIAGE_WORDS: Readonly<Record<IssuesViewTriage, string>> = {
  proposed: "Proposed",
  accepted: "Accepted for discussion",
  not_accepted: "Not accepted",
  conflict: "Conflict",
};

/** The Badge variant each triage state's chip takes. */
export const TRIAGE_VARIANTS: Readonly<Record<IssuesViewTriage, "outline" | "success" | "muted" | "warning">> = {
  proposed: "outline",
  accepted: "success",
  not_accepted: "muted",
  conflict: "warning",
};

/** Which of GitHub's two lists an item is in: Open or Closed. */
export type IssuesViewState = "open" | "closed";

/** The word and icon of an issue that passes no `status`: Open or Closed. */
export const STATE_STATUS: Readonly<Record<IssuesViewState, ItemStatus>> = {
  open: { kind: "open", label: "Open" },
  closed: { kind: "closed", label: "Closed" },
};

/**
 * A link in a row's meta line, such as its branch or its pull request. An
 * `http(s)` link opens in a new tab; any other is in-app, and a plain click
 * calls the view's `onNavigate`.
 */
export type IssuesViewLink = ItemLinkTarget;

/** One issue, as the host loaded it. */
export type IssuesViewIssue = {
  /** Stable row key; defaults to the number. Pending rows have no number yet. */
  readonly id?: string;
  /** `null` while it isn't numbered yet; the row shows `#–` (the view's `numberPrefix` and a dash). */
  readonly number: number | null;
  readonly title: string;
  readonly state: IssuesViewState;
  /** The state icon and its word; default Open or Closed from `state`. */
  readonly status?: ItemStatus;
  readonly labels?: ReadonlyArray<string>;
  readonly author?: string;
  readonly comments?: number;
  /** An ISO 8601 time; the view shows it relative to now. */
  readonly updatedAt?: string;
  /** This device's write still on its way ("requested") or refused ("not_sent"); shown as a small status chip. */
  readonly pending?: IssuesViewPending;
  /** The issue's triage; shown as a small chip. Absent: no chip. */
  readonly triage?: IssuesViewTriage;
  /** Links at the end of the meta line, such as a branch and a pull request. */
  readonly links?: ReadonlyArray<IssuesViewLink>;
  /** The row's `⋯` menu (`ActionMenu`); absent or empty: none. */
  readonly menu?: ReadonlyArray<ActionMenuItem>;
};

/** GitHub's Open and Closed tabs: the list shown, and each tab's link. */
export type IssuesViewFilter = {
  readonly state: IssuesViewState;
  readonly href: (state: IssuesViewState) => string;
  /** Called on a plain left click of a tab, after `preventDefault`, so a host router navigates. */
  readonly onSelect?: (state: IssuesViewState, href: string) => void;
};

export type IssuesViewProps = Omit<ComponentProps<"section">, "children"> & {
  /** The repository the issues belong to, such as `maya/tinyhttp`. */
  repo: string;
  issues: ReadonlyArray<IssuesViewIssue>;
  /** `inline` scrolls the list inside a bounded height; `full` shows every row. */
  size?: "inline" | "full";
  /** The row's link; when set the title is an `<a href>`. */
  href?: (issue: IssuesViewIssue) => string | undefined;
  /**
   * Called on a plain left click of a row's link (no modifier keys), after
   * `preventDefault`, so a host router navigates; modified clicks keep the
   * browser's behavior.
   */
  onNavigate?: (issue: IssuesViewIssue, href: string) => void;
  /** Rows aren't known yet (first sync not complete): a loading state, never "No issues". */
  loading?: boolean;
  /**
   * Rows aren't known yet, and the host shows no loading state (a local-first
   * host whose device holds none yet): the tabs show no counts and an empty
   * list shows nothing, neither "No issues" nor placeholders, until it knows.
   */
  unknown?: boolean;
  /** Header actions, such as a "New issue" button. */
  actions?: ReactNode;
  /** Open and Closed tabs with their counts in place of the repository's name; only that state's rows show. */
  filter?: IssuesViewFilter;
  /** What a number reads after: `#` (default) for `#12`, or `T` for `T4`. */
  numberPrefix?: string;
  /** The empty list's words. Default `No issues`. */
  emptyTitle?: string;
  /** Rows in an `ol`, for a list whose order means something, such as a stack. */
  ordered?: boolean;
};

/** `#12`, or `#–` for an issue GitHub hasn't numbered yet. */
export const issueNumberText = (number: number | null, prefix = "#"): string => `${prefix}${number === null ? "–" : number}`;

/** Keys that move focus between rows' links, unmodified. */
const ROW_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** Marks a row's title link, the element row keys move focus between. */
const TARGET_ATTR = "data-issues-target";

/** An ISO time as epoch ms, or none. */
const msOf = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * The `issues` template and a repository's lists of issues and other items,
 * as GitHub draws them. Each row shows its state icon, title, labels, then a
 * meta line: the number (`#–` before it's numbered), a triage chip when the
 * host passes `triage`, a `Requested` or `Not sent` chip for this device's
 * pending write, the author, when, and its links; then the comment count and
 * its `⋯` menu.
 *
 * Without `href` it renders data only. With `href` each title is a link,
 * `onNavigate` turns a plain click into in-app navigation, and ArrowDown,
 * ArrowUp, Home and End move focus between the rows' links. `filter` shows
 * GitHub's Open and Closed tabs with counts and only that state's rows. While
 * `loading`, the list shows placeholders and a status, never "No issues";
 * while `unknown`, an empty list shows nothing at all.
 */
export function IssuesView({
  repo,
  issues,
  size = "inline",
  href,
  onNavigate,
  loading = false,
  unknown = false,
  actions,
  filter,
  numberPrefix = "#",
  emptyTitle = "No issues",
  ordered = false,
  className,
  ...props
}: IssuesViewProps) {
  useInjectUiCss();
  const open = issues.filter((issue) => issue.state === "open").length;
  const shown = filter === undefined ? issues : issues.filter((issue) => issue.state === filter.state);
  const follow = (navigate: (() => void) | undefined) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (navigate === undefined || !isPlainNavigationClick(event)) return;
    event.preventDefault();
    navigate();
  };
  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    if (!ROW_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const targets = [...event.currentTarget.querySelectorAll<HTMLElement>(`[${TARGET_ATTR}]`)];
    if (targets.length === 0) return;
    const row = (event.target as Element).closest("li");
    const current = row === null ? -1 : targets.findIndex((target) => row.contains(target));
    const last = targets.length - 1;
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? last : event.key === "ArrowDown" ? Math.min(current + 1, last) : Math.max(current - 1, 0);
    event.preventDefault();
    targets[next]!.focus();
  };
  const List = ordered ? "ol" : "ul";
  return (
    <section
      data-slot="issues-view"
      data-size={size}
      aria-label={`${repo} issues`}
      aria-busy={loading || undefined}
      className={cn("sui-issues-view", className)}
      {...props}
    >
      <header className="sui-issues-header">
        {filter === undefined ? (
          <span className="sui-issues-repo">{repo}</span>
        ) : (
          <nav className="sui-issues-filters" aria-label="Filter">
            {(["open", "closed"] as const).map((state) => {
              const link = safeHref(filter.href(state));
              const onSelect = filter.onSelect;
              return (
                <a
                  key={state}
                  className="sui-issues-filter"
                  href={link}
                  aria-current={filter.state === state ? "page" : undefined}
                  onClick={follow(onSelect === undefined || link === undefined ? undefined : () => onSelect(state, link))}
                >
                  <ItemStateIcon kind={state} label={STATE_STATUS[state].label} aria-hidden className="sui-issues-filter-icon" />
                  {unknown ? null : (
                    <span className="sui-issues-filter-count">{state === "open" ? open : issues.length - open}</span>
                  )}
                  {STATE_STATUS[state].label}
                </a>
              );
            })}
          </nav>
        )}
        {loading ? (
          <span className="sui-sr-only" role="status">Loading issues</span>
        ) : filter === undefined && !unknown ? (
          <span className="sui-issues-counts">
            {open} open · {issues.length - open} closed
          </span>
        ) : null}
        {actions === undefined || actions === null ? null : <div className="sui-issues-actions">{actions}</div>}
      </header>
      {shown.length === 0 ? (
        unknown ? null : loading ? (
          <div className="sui-issues-loading" aria-hidden>
            <Skeleton className="sui-issues-skeleton" />
            <Skeleton className="sui-issues-skeleton" />
            <Skeleton className="sui-issues-skeleton" />
          </div>
        ) : (
          <EmptyState title={emptyTitle} />
        )
      ) : (
        <List className="sui-issues-list" tabIndex={size === "inline" ? 0 : undefined} onKeyDown={href === undefined ? undefined : moveFocus}>
          {shown.map((issue, index) => {
            const raw = href?.(issue);
            const link = raw === undefined ? undefined : safeHref(raw);
            const status = issue.status ?? STATE_STATUS[issue.state];
            const number = issueNumberText(issue.number, numberPrefix);
            const updated = msOf(issue.updatedAt);
            return (
              <li
                key={issue.id ?? (issue.number === null ? `pending:${index}` : String(issue.number))}
                data-slot="issues-row"
                className="sui-issues-row"
                data-state={issue.state}
                data-status={status.kind}
                data-pending={issue.pending}
                data-live={status.live === true ? "" : undefined}
              >
                <ItemStateIcon kind={status.kind} label={status.label} live={status.live} className="sui-issues-state" />
                <div className="sui-issues-main">
                  <div className="sui-issues-title-line">
                    {link === undefined ? (
                      <span className="sui-issues-title">{issue.title}</span>
                    ) : (
                      <a
                        className="sui-issues-title sui-issues-link"
                        href={link}
                        onClick={follow(onNavigate === undefined ? undefined : () => onNavigate(issue, link))}
                        {...{ [TARGET_ATTR]: "" }}
                      >
                        {issue.title}
                      </a>
                    )}
                    {issue.labels?.map((label) => (
                      <Badge key={label} variant="outline" className="sui-issues-label">
                        {label}
                      </Badge>
                    ))}
                  </div>
                  <div className="sui-issues-meta">
                    <span className="sui-issues-number">{number}</span>
                    {issue.triage === undefined ? null : (
                      <Badge
                        variant={TRIAGE_VARIANTS[issue.triage]}
                        className="sui-issues-triage"
                        data-triage={issue.triage}
                      >
                        {TRIAGE_WORDS[issue.triage]}
                      </Badge>
                    )}
                    {issue.pending === undefined ? null : (
                      <Badge
                        variant={issue.pending === "not_sent" ? "destructive" : "muted"}
                        className="sui-issues-pending"
                      >
                        {PENDING_WORDS[issue.pending]}
                      </Badge>
                    )}
                    {issue.author === undefined ? null : <span className="sui-issues-author">{issue.author}</span>}
                    {updated === undefined ? null : <RelativeTime ts={updated} className="sui-issues-time" />}
                    {issue.links?.map((item) => (
                      <ItemLink
                        key={JSON.stringify([item.href, item.label])}
                        link={item}
                        className="sui-issues-meta-link"
                        onNavigate={onNavigate === undefined ? undefined : (target) => onNavigate(issue, target)}
                      />
                    ))}
                  </div>
                </div>
                {issue.comments === undefined || issue.comments === 0 ? null : (
                  <span className="sui-issues-comments" aria-label={`${issue.comments} comments`}>
                    {issue.comments}
                  </span>
                )}
                {issue.menu === undefined || issue.menu.length === 0 ? null : (
                  <ActionMenu label={`${number} actions`} items={issue.menu} className="sui-issues-menu" />
                )}
              </li>
            );
          })}
        </List>
      )}
    </section>
  );
}
