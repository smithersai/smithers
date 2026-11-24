/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { Badge } from "./badge";
import { Button } from "./button";
import { Card } from "./card";
import { EmptyState } from "./empty-state";
import { Input } from "./input";
import { safeHref } from "./internal/safeHref";
import { LoadingBar } from "./loading";
import { Markdown } from "./primitives/markdown";
import { formatCount, languageColor } from "./repo-about";
import { Skeleton } from "./skeleton";
import { useInjectUiCss } from "./styles";
import { RelativeTime } from "./time/RelativeTime";

/** Active tab on an owner's profile page. */
export type OwnerProfileTab = "overview" | "repositories";

/** Sort order on the Repositories tab. */
export type OwnerProfileSort = "updated" | "stars" | "name";

/** Repository type filter on the Repositories tab. */
export type OwnerProfileRepoFilter = "all" | "sources" | "forks" | "cloned";

/** An organization the person belongs to. */
export interface OwnerProfileOrganization {
  readonly login: string;
  readonly name?: string | null | undefined;
  readonly avatarUrl?: string | null | undefined;
  readonly href: string;
}

/** One repository shown on a profile's pinned grid or repositories list. */
export interface OwnerProfileRepository {
  readonly owner: string;
  readonly name: string;
  readonly href: string;
  readonly description?: string | null | undefined;
  readonly language?: string | null | undefined;
  readonly languageColor?: string | null | undefined;
  readonly stars: number;
  readonly forks: number;
  readonly fork?: boolean | undefined;
  readonly archived?: boolean | undefined;
  readonly cloned?: boolean | undefined;
  readonly license?: string | null | undefined;
  readonly topics?: ReadonlyArray<string> | undefined;
  /** Epoch milliseconds of the last push, or null. */
  readonly pushedAt?: number | null | undefined;
}

/** One day cell of a GitHub-style contribution heatmap. */
export interface OwnerProfileContributionDay {
  readonly date: string;
  readonly count: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
}

/** A user's contribution activity over the last year. */
export interface OwnerProfileContributions {
  readonly total: number;
  readonly commits?: number | undefined;
  readonly pullRequests?: number | undefined;
  readonly issues?: number | undefined;
  readonly reviews?: number | undefined;
  readonly weeks: ReadonlyArray<ReadonlyArray<OwnerProfileContributionDay>>;
}

/** Link props passed to an optional host router link renderer. */
export interface OwnerProfileLinkProps {
  readonly href: string;
  readonly className?: string | undefined;
  readonly title?: string | undefined;
  readonly "aria-label"?: string | undefined;
  readonly "aria-current"?: "page" | undefined;
  readonly children: ReactNode;
}

export type OwnerProfileProps = Omit<ComponentProps<"section">, "children"> & {
  readonly kind: "User" | "Organization";
  readonly login: string;
  readonly name?: string | null | undefined;
  readonly avatarUrl?: string | null | undefined;
  readonly bio?: string | null | undefined;
  readonly company?: string | null | undefined;
  readonly location?: string | null | undefined;
  readonly website?: string | null | undefined;
  readonly twitter?: string | null | undefined;
  readonly pronouns?: string | null | undefined;
  readonly status?: { readonly emoji?: string | null | undefined; readonly message?: string | null | undefined } | null | undefined;
  readonly followers?: number | null | undefined;
  readonly following?: number | null | undefined;
  readonly publicRepos?: number | null | undefined;
  /** Epoch milliseconds of when the account joined. */
  readonly createdAt?: number | null | undefined;
  readonly githubUrl?: string | undefined;
  readonly organizations?: ReadonlyArray<OwnerProfileOrganization> | undefined;
  readonly readme?: { readonly path: string; readonly href?: string | undefined; readonly text: string } | null | undefined;
  /** Pinned or popular repositories for the Overview tab. */
  readonly featured?: ReadonlyArray<OwnerProfileRepository> | undefined;
  /** Whether `featured` are pinned repositories (else popular repositories). */
  readonly pinned?: boolean | undefined;
  readonly contributions?: OwnerProfileContributions | null | undefined;
  /** Filtered and sorted repositories for the Repositories tab. */
  readonly repositories?: ReadonlyArray<OwnerProfileRepository> | undefined;
  /** Total public repositories owned (for the Repositories tab count badge). */
  readonly totalRepositories?: number | undefined;
  readonly hasClonedRepositories?: boolean | undefined;
  readonly tab: OwnerProfileTab;
  readonly overviewHref: string;
  readonly repositoriesHref: string;
  readonly search?: string | undefined;
  readonly sort?: OwnerProfileSort | undefined;
  readonly filter?: OwnerProfileRepoFilter | undefined;
  readonly onSearchChange?: ((value: string) => void) | undefined;
  readonly onSortChange?: ((sort: OwnerProfileSort) => void) | undefined;
  readonly onFilterChange?: ((filter: OwnerProfileRepoFilter) => void) | undefined;
  readonly onClearFilters?: (() => void) | undefined;
  readonly loading?: boolean | undefined;
  /** Renders internal app links (e.g. TanStack Router Link); defaults to `<a>`. */
  readonly renderLink?: ((props: OwnerProfileLinkProps) => ReactNode) | undefined;
};

const OTHER_LANG_COLOR = "var(--text-faint, #6c655a)";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const defaultLink = ({ href, children, ...rest }: OwnerProfileLinkProps) => (
  <a href={href} {...rest}>{children}</a>
);

const Icon = ({ children }: { readonly children: ReactNode }) => (
  <svg
    className="sui-profile-detail-icon"
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const SmallIcon = ({ children }: { readonly children: ReactNode }) => (
  <svg
    width={14}
    height={14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const languageColorOf = (name: string, color?: string | null): string =>
  color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : languageColor(name) ?? OTHER_LANG_COLOR;

const joinedLabel = (ts: number | null | undefined): string | null => {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return null;
  const date = new Date(ts);
  return `Joined ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

/** Month labels aligned to the first week in which a new month starts. */
export const contributionMonthLabels = (
  weeks: ReadonlyArray<ReadonlyArray<OwnerProfileContributionDay>>,
): ReadonlyArray<{ readonly column: number; readonly label: string }> => {
  const labels: Array<{ readonly column: number; readonly label: string }> = [];
  let previousMonth = -1;
  for (let index = 0; index < weeks.length; index++) {
    const first = weeks[index]?.[0];
    if (first === undefined) continue;
    const month = Number(first.date.slice(5, 7)) - 1;
    if (!Number.isInteger(month) || month < 0 || month > 11) continue;
    if (month !== previousMonth) {
      // Avoid crowding two labels in adjacent columns at the left edge.
      if (labels.length === 0 || index - labels[labels.length - 1]!.column >= 3) {
        labels.push({ column: index, label: MONTHS[month]! });
      }
      previousMonth = month;
    }
  }
  return labels;
};

const dayTitle = (day: OwnerProfileContributionDay): string => {
  const noun = day.count === 1 ? "contribution" : "contributions";
  return day.count === 0 ? `No contributions on ${day.date}` : `${day.count.toLocaleString("en-US")} ${noun} on ${day.date}`;
};

function RepoMeta({ repo }: { readonly repo: OwnerProfileRepository }) {
  return (
    <div className="sui-profile-repo-meta">
      {repo.language ? (
        <span className="sui-profile-meta-item">
          <span
            className="sui-profile-lang-dot"
            style={{ background: languageColorOf(repo.language, repo.languageColor) }}
            aria-hidden="true"
          />
          <span>{repo.language}</span>
        </span>
      ) : null}
      {repo.stars > 0 ? (
        <span className="sui-profile-meta-item" aria-label={`${repo.stars} stars`}>
          <SmallIcon>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </SmallIcon>
          <span>{formatCount(repo.stars)}</span>
        </span>
      ) : null}
      {repo.forks > 0 ? (
        <span className="sui-profile-meta-item" aria-label={`${repo.forks} forks`}>
          <SmallIcon>
            <circle cx="12" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
            <path d="M12 12v3" />
          </SmallIcon>
          <span>{formatCount(repo.forks)}</span>
        </span>
      ) : null}
      {repo.license ? <span>{repo.license}</span> : null}
      {repo.pushedAt !== null && repo.pushedAt !== undefined ? (
        <span className="sui-profile-meta-item">
          Updated <RelativeTime ts={repo.pushedAt} />
        </span>
      ) : null}
    </div>
  );
}

function RepoBadges({ repo }: { readonly repo: OwnerProfileRepository }) {
  return (
    <>
      {repo.cloned ? <Badge variant="default">Cloned</Badge> : null}
      {repo.fork ? <Badge variant="secondary">Fork</Badge> : null}
      {repo.archived ? <Badge variant="warning">Archived</Badge> : null}
    </>
  );
}

function ContributionGraph({ contributions }: { readonly contributions: OwnerProfileContributions }) {
  const months = contributionMonthLabels(contributions.weeks);
  const breakdown = [
    contributions.commits ? `${formatCount(contributions.commits)} commits` : null,
    contributions.pullRequests ? `${formatCount(contributions.pullRequests)} pull requests` : null,
    contributions.issues ? `${formatCount(contributions.issues)} issues` : null,
    contributions.reviews ? `${formatCount(contributions.reviews)} reviews` : null,
  ].filter((part): part is string => part !== null);
  return (
    <section className="sui-profile-block" aria-label="Contributions">
      <div className="sui-profile-block-head">
        <h2 className="sui-profile-block-title">
          {contributions.total.toLocaleString("en-US")} {contributions.total === 1 ? "contribution" : "contributions"} in the last year
        </h2>
      </div>
      <Card className="sui-profile-contrib-card">
        <div className="sui-profile-contrib-scroll">
          <div className="sui-profile-contrib-grid" role="img" aria-label={`${contributions.total} contributions in the last year`}>
            <div className="sui-profile-contrib-months" aria-hidden="true">
              {months.map((month) => (
                <span
                  key={`${month.column}-${month.label}`}
                  className="sui-profile-contrib-month"
                  style={{ gridColumnStart: month.column + 1 }}
                >
                  {month.label}
                </span>
              ))}
            </div>
            <div className="sui-profile-contrib-days" aria-hidden="true">
              <span />
              <span>Mon</span>
              <span />
              <span>Wed</span>
              <span />
              <span>Fri</span>
              <span />
            </div>
            <div className="sui-profile-contrib-weeks">
              {contributions.weeks.map((week, weekIndex) => (
                <div key={week[0]?.date ?? weekIndex} className="sui-profile-contrib-week">
                  {week.map((day) => (
                    <span
                      key={day.date}
                      className="sui-profile-contrib-cell"
                      data-level={day.level}
                      title={dayTitle(day)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="sui-profile-contrib-foot">
          <div className="sui-profile-contrib-breakdown">
            {breakdown.map((item) => <span key={item}>{item}</span>)}
          </div>
          <div className="sui-profile-contrib-legend" aria-hidden="true">
            <span>Less</span>
            {([0, 1, 2, 3, 4] as const).map((level) => (
              <span key={level} className="sui-profile-contrib-cell" data-level={level} />
            ))}
            <span>More</span>
          </div>
        </div>
      </Card>
    </section>
  );
}

/** Structural loading skeleton matching the two-column profile layout. */
export function OwnerProfileSkeleton({ className }: { readonly className?: string | undefined }) {
  useInjectUiCss();
  return (
    <section data-slot="owner-profile" className={cn("sui-profile", className)} aria-label="Profile" aria-busy="true">
      <div className="sui-profile-sidebar">
        <div className="sui-profile-identity">
          <Skeleton className="sui-profile-skeleton-avatar" />
          <div className="sui-profile-names">
            <Skeleton className="sui-profile-skeleton-line" />
            <Skeleton className="sui-profile-skeleton-short" />
          </div>
        </div>
      </div>
      <div className="sui-profile-main">
        <div className="sui-profile-pinned">
          {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="sui-profile-skeleton-card" />)}
        </div>
      </div>
    </section>
  );
}

/**
 * A GitHub-style user or organization profile page: avatar, identity, bio,
 * metadata and organizations on the left; Overview (profile README, pinned or
 * popular repositories, contribution calendar) and Repositories (searchable,
 * filterable, sortable list) on the right. Pure view: fetches nothing and holds
 * no React state.
 */
export function OwnerProfile({
  kind,
  login,
  name,
  avatarUrl,
  bio,
  company,
  location,
  website,
  twitter,
  pronouns,
  status,
  followers,
  following,
  publicRepos,
  createdAt,
  githubUrl,
  organizations = [],
  readme,
  featured = [],
  pinned = false,
  contributions,
  repositories = [],
  totalRepositories,
  hasClonedRepositories = false,
  tab,
  overviewHref,
  repositoriesHref,
  search = "",
  sort = "updated",
  filter = "all",
  onSearchChange,
  onSortChange,
  onFilterChange,
  onClearFilters,
  loading = false,
  renderLink = defaultLink,
  className,
  ...props
}: OwnerProfileProps) {
  useInjectUiCss();
  const safeAvatar = avatarUrl && /^https?:\/\//i.test(avatarUrl.trim()) ? safeHref(avatarUrl) : undefined;
  const safeWebsite = website && /^https?:\/\//i.test(website.trim()) ? safeHref(website) : undefined;
  const safeGithub = githubUrl && /^https?:\/\//i.test(githubUrl.trim()) ? safeHref(githubUrl) : undefined;
  const cleanTwitter = twitter?.trim().replace(/^@/, "") || undefined;
  const joined = joinedLabel(createdAt);
  const repoCount = totalRepositories ?? publicRepos ?? repositories.length;
  const statusText = [status?.emoji?.trim(), status?.message?.trim()].filter(Boolean).join(" ");
  const hasFilters = search.trim() !== "" || filter !== "all";

  return (
    <section data-slot="owner-profile" className={cn("sui-profile", className)} aria-label={`${login} profile`} {...props}>
      <LoadingBar loading={loading} placement="inline" />
      <aside className="sui-profile-sidebar" aria-label="Profile details">
        <div className="sui-profile-identity">
          <div className="sui-profile-avatar-wrap" data-kind={kind}>
            {safeAvatar ? (
              <img
                className="sui-profile-avatar"
                src={safeAvatar}
                alt={name?.trim() || login}
                width={260}
                height={260}
                referrerPolicy="no-referrer"
              />
            ) : (
              <span aria-hidden="true">{login.slice(0, 2).toUpperCase()}</span>
            )}
          </div>
          <div className="sui-profile-names">
            <h1 className="sui-profile-name">{name?.trim() || login}</h1>
            <div className="sui-profile-login-row">
              <span className="sui-profile-login">{login}</span>
              {kind === "Organization" ? <Badge variant="secondary">Organization</Badge> : null}
              {pronouns ? <span className="sui-profile-pronouns">· {pronouns}</span> : null}
            </div>
          </div>
        </div>

        {statusText ? <div className="sui-profile-status">{statusText}</div> : null}
        {bio ? <p className="sui-profile-bio">{bio}</p> : null}

        {safeGithub ? (
          <Button asChild variant="outline">
            <a href={safeGithub} target="_blank" rel="noopener noreferrer">View on GitHub</a>
          </Button>
        ) : null}

        {kind === "User" && (followers !== null && followers !== undefined || following !== null && following !== undefined) ? (
          <div className="sui-profile-follows">
            {followers !== null && followers !== undefined ? (
              <span><strong>{formatCount(followers)}</strong> {followers === 1 ? "follower" : "followers"}</span>
            ) : null}
            {followers !== null && followers !== undefined && following !== null && following !== undefined ? (
              <span aria-hidden="true">·</span>
            ) : null}
            {following !== null && following !== undefined ? (
              <span><strong>{formatCount(following)}</strong> following</span>
            ) : null}
          </div>
        ) : null}

        {company || location || safeWebsite || cleanTwitter || joined ? (
          <ul className="sui-profile-details">
            {company ? (
              <li>
                <Icon>
                  <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
                  <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
                  <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
                  <path d="M10 6h4M10 10h4M10 14h4M10 18h4" />
                </Icon>
                <span className="sui-profile-detail-text">{company}</span>
              </li>
            ) : null}
            {location ? (
              <li>
                <Icon>
                  <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                  <circle cx="12" cy="10" r="3" />
                </Icon>
                <span className="sui-profile-detail-text">{location}</span>
              </li>
            ) : null}
            {safeWebsite ? (
              <li>
                <Icon>
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </Icon>
                <a className="sui-profile-detail-link" href={safeWebsite} target="_blank" rel="noopener noreferrer">
                  {safeWebsite.replace(/^https?:\/\//i, "").replace(/\/$/, "")}
                </a>
              </li>
            ) : null}
            {cleanTwitter ? (
              <li>
                <Icon>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
                </Icon>
                <a
                  className="sui-profile-detail-link"
                  href={`https://x.com/${encodeURIComponent(cleanTwitter)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  @{cleanTwitter}
                </a>
              </li>
            ) : null}
            {joined ? (
              <li>
                <Icon>
                  <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
                  <line x1="16" x2="16" y1="2" y2="6" />
                  <line x1="8" x2="8" y1="2" y2="6" />
                  <line x1="3" x2="21" y1="10" y2="10" />
                </Icon>
                <span className="sui-profile-detail-text">{joined}</span>
              </li>
            ) : null}
          </ul>
        ) : null}

        {organizations.length > 0 ? (
          <div className="sui-profile-section">
            <h2 className="sui-profile-section-title">Organizations</h2>
            <ul className="sui-profile-orgs" aria-label="Organizations">
              {organizations.map((org) => {
                const orgAvatar = org.avatarUrl && /^https?:\/\//i.test(org.avatarUrl.trim()) ? safeHref(org.avatarUrl) : undefined;
                return (
                  <li key={org.login}>
                    {renderLink({
                      href: org.href,
                      className: "sui-profile-org-link",
                      title: org.name?.trim() || org.login,
                      "aria-label": org.login,
                      children: orgAvatar ? (
                        <img
                          className="sui-profile-org-avatar"
                          src={orgAvatar}
                          alt={org.login}
                          width={32}
                          height={32}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <span>{org.login.slice(0, 2).toUpperCase()}</span>
                      ),
                    })}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </aside>

      <div className="sui-profile-main">
        <nav className="sui-profile-tabs" aria-label="Profile sections">
          {renderLink({
            href: overviewHref,
            className: "sui-profile-tab",
            "aria-current": tab === "overview" ? "page" : undefined,
            children: "Overview",
          })}
          {renderLink({
            href: repositoriesHref,
            className: "sui-profile-tab",
            "aria-current": tab === "repositories" ? "page" : undefined,
            children: (
              <>
                <span>Repositories</span>
                <span className="sui-profile-tab-count">{formatCount(repoCount)}</span>
              </>
            ),
          })}
        </nav>

        {tab === "overview" ? (
          <>
            {readme ? (
              <Card className="sui-profile-readme">
                <div className="sui-profile-readme-bar">
                  {readme.href
                    ? renderLink({ href: readme.href, children: readme.path })
                    : <span>{readme.path}</span>}
                </div>
                <div className="sui-profile-readme-body">
                  <Markdown content={readme.text} variant="document" />
                </div>
              </Card>
            ) : null}

            {featured.length > 0 ? (
              <section className="sui-profile-block" aria-label={pinned ? "Pinned repositories" : "Popular repositories"}>
                <div className="sui-profile-block-head">
                  <h2 className="sui-profile-block-title">{pinned ? "Pinned" : "Popular repositories"}</h2>
                </div>
                <ul className="sui-profile-pinned">
                  {featured.map((repo) => (
                    <li key={`${repo.owner}/${repo.name}`}>
                      <Card className="sui-profile-pinned-card">
                        <div className="sui-profile-repo-head">
                          {renderLink({
                            href: repo.href,
                            className: "sui-profile-repo-name",
                            children: repo.owner.toLowerCase() === login.toLowerCase() ? repo.name : `${repo.owner}/${repo.name}`,
                          })}
                          <RepoBadges repo={repo} />
                        </div>
                        {repo.description ? <p className="sui-profile-repo-desc">{repo.description}</p> : <div />}
                        <RepoMeta repo={repo} />
                      </Card>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {contributions ? <ContributionGraph contributions={contributions} /> : null}

            {!readme && featured.length === 0 && !contributions ? (
              <EmptyState title="No public repositories" />
            ) : null}
          </>
        ) : (
          <section className="sui-profile-block" aria-label="Repositories">
            <div className="sui-profile-toolbar">
              <Input
                className="sui-profile-search"
                type="search"
                value={search}
                placeholder="Find a repository…"
                aria-label="Find a repository"
                onChange={(event) => onSearchChange?.(event.currentTarget.value)}
              />
              <div className="sui-profile-filters" role="group" aria-label="Filter repositories">
                {(
                  [
                    ["all", "All"],
                    ["sources", "Sources"],
                    ["forks", "Forks"],
                    ...(hasClonedRepositories ? ([["cloned", "Cloned"]] as const) : []),
                  ] as ReadonlyArray<readonly [OwnerProfileRepoFilter, string]>
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={filter === value ? "default" : "outline"}
                    aria-pressed={filter === value}
                    onClick={() => onFilterChange?.(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <div className="sui-profile-filters" role="group" aria-label="Sort repositories">
                {(
                  [
                    ["updated", "Updated"],
                    ["stars", "Stars"],
                    ["name", "Name"],
                  ] as ReadonlyArray<readonly [OwnerProfileSort, string]>
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={sort === value ? "default" : "ghost"}
                    aria-pressed={sort === value}
                    onClick={() => onSortChange?.(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>

            {repositories.length === 0 ? (
              <EmptyState
                title={hasFilters ? "No matching repositories" : "No public repositories"}
                action={hasFilters && onClearFilters ? (
                  <Button variant="outline" size="sm" onClick={onClearFilters}>Clear filter</Button>
                ) : null}
              />
            ) : (
              <ul className="sui-profile-repo-list">
                {repositories.map((repo) => (
                  <li key={`${repo.owner}/${repo.name}`} className="sui-profile-repo-row">
                    <div className="sui-profile-repo-head">
                      {renderLink({
                        href: repo.href,
                        className: "sui-profile-repo-name",
                        children: repo.name,
                      })}
                      <RepoBadges repo={repo} />
                    </div>
                    {repo.description ? <p className="sui-profile-repo-desc">{repo.description}</p> : null}
                    {repo.topics && repo.topics.length > 0 ? (
                      <ul className="sui-profile-topics" aria-label="Topics">
                        {repo.topics.map((topic) => (
                          <li key={topic} className="sui-profile-topic">{topic}</li>
                        ))}
                      </ul>
                    ) : null}
                    <RepoMeta repo={repo} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
