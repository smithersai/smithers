/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { safeHref } from "./internal/safeHref";
import { LoadingBar } from "./loading";
import { useInjectUiCss } from "./styles";
import { RelativeTime } from "./time/RelativeTime";

/** A repository's latest release, as the about panel names it. */
export interface RepoAboutRelease {
  readonly tag: string;
  readonly name?: string | null | undefined;
  /** When it was published: epoch milliseconds. */
  readonly publishedAt?: number | null | undefined;
  /** Where the release opens. */
  readonly href?: string | undefined;
}

/** One contributor: their login and avatar image. */
export interface RepoAboutContributor {
  readonly login: string;
  readonly avatarUrl: string;
  /** Where their profile opens. */
  readonly href?: string | undefined;
}

/** One language and how many bytes of the repository are in it. */
export interface RepoAboutLanguage {
  readonly name: string;
  readonly bytes: number;
}

export type RepoAboutProps = Omit<ComponentProps<"section">, "children"> & {
  readonly description?: string | null | undefined;
  /** An `http(s)` homepage; anything else isn't drawn. */
  readonly homepage?: string | null | undefined;
  readonly topics?: ReadonlyArray<string> | undefined;
  readonly stars?: number | null | undefined;
  readonly watchers?: number | null | undefined;
  readonly forks?: number | null | undefined;
  /** Such as `MIT`. */
  readonly license?: string | null | undefined;
  readonly release?: RepoAboutRelease | null | undefined;
  /** How many releases there are; the latest is `release`. */
  readonly releases?: number | null | undefined;
  /** The first few contributors; `contributorCount` counts them all. */
  readonly contributors?: ReadonlyArray<RepoAboutContributor> | undefined;
  readonly contributorCount?: number | null | undefined;
  /** Bytes per language, largest first: the bar and its legend. */
  readonly languages?: ReadonlyArray<RepoAboutLanguage> | undefined;
  /** While the host reads what it shows: the shared loading bar, after its delay. */
  readonly loading?: boolean | undefined;
  /** Under the panel's sections, such as a note about the repository's copy. */
  readonly footer?: ReactNode;
};

/** GitHub's colors for the languages most repositories have; any other gets a neutral one. */
const LANGUAGE_COLORS: Readonly<Record<string, string>> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  HTML: "#e34c26",
  CSS: "#563d7c",
  SCSS: "#c6538c",
  Python: "#3572a5",
  Go: "#00add8",
  Rust: "#dea584",
  Java: "#b07219",
  Kotlin: "#a97bff",
  Swift: "#f05138",
  Ruby: "#701516",
  PHP: "#4f5d95",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  Shell: "#89e051",
  Nix: "#7e7eff",
  Zig: "#ec915c",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  MDX: "#fcb32c",
  Markdown: "#083fa1",
  Dockerfile: "#384d54",
  Makefile: "#427819",
  Lua: "#000080",
  Elixir: "#6e4a7e",
  Haskell: "#5e5086",
  OCaml: "#ef7a08",
  Dart: "#00b4ab",
};

const OTHER_COLOR = "var(--text-faint, #6c655a)";

/** A count as GitHub shows it: `908`, `14.1k`, `1.2m`. */
export const formatCount = (count: number): string =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(count).toLowerCase();

/** Each language's share in percent, one decimal; ones under 0.1% fold into `Other`. */
export const languageShares = (
  languages: ReadonlyArray<RepoAboutLanguage>,
): ReadonlyArray<{ readonly name: string; readonly percent: number; readonly color: string }> => {
  const total = languages.reduce((sum, language) => sum + Math.max(0, language.bytes), 0);
  if (total === 0) return [];
  const shares = languages
    .filter((language) => language.bytes > 0)
    .map((language) => ({ name: language.name, percent: (language.bytes / total) * 100 }));
  const shown = shares.filter((share) => share.percent >= 0.1);
  const other = shares.filter((share) => share.percent < 0.1).reduce((sum, share) => sum + share.percent, 0);
  return [
    ...shown.map((share) => ({
      name: share.name,
      percent: Math.round(share.percent * 10) / 10,
      color: LANGUAGE_COLORS[share.name] ?? OTHER_COLOR,
    })),
    ...(other > 0 ? [{ name: "Other", percent: Math.round(other * 10) / 10, color: OTHER_COLOR }] : []),
  ];
};

const Heading = ({ children, count }: { readonly children: ReactNode; readonly count?: number | null | undefined }) => (
  <h3 className="sui-repo-about-heading">
    {children}
    {count === undefined || count === null ? null : <span className="sui-repo-about-count">{formatCount(count)}</span>}
  </h3>
);

/**
 * A repository's about panel, as GitHub's sidebar: its description, homepage,
 * topics, stars, watchers and forks, license, latest release, contributors and
 * languages. Every part is optional and a missing one isn't drawn; it fetches
 * nothing.
 */
export function RepoAbout({
  description,
  homepage,
  topics = [],
  stars,
  watchers,
  forks,
  license,
  release,
  releases,
  contributors = [],
  contributorCount,
  languages = [],
  loading = false,
  footer,
  className,
  ...props
}: RepoAboutProps) {
  useInjectUiCss();
  const home = homepage === null || homepage === undefined ? undefined : safeHref(homepage);
  const shares = languageShares(languages);
  const stats = [
    stars === null || stars === undefined ? null : { key: "stars", text: `${formatCount(stars)} stars` },
    watchers === null || watchers === undefined ? null : { key: "watchers", text: `${formatCount(watchers)} watching` },
    forks === null || forks === undefined ? null : { key: "forks", text: `${formatCount(forks)} forks` },
    license === null || license === undefined ? null : { key: "license", text: license },
  ].filter((stat) => stat !== null);
  const releaseHref = release?.href === undefined ? undefined : safeHref(release.href);
  return (
    <section data-slot="repo-about" className={cn("sui-repo-about", className)} aria-label="About" {...props}>
      {/* Decorative: the panel's own parts say what is there; the bar only shows the read is on its way. */}
      <LoadingBar loading={loading} placement="inline" />
      <div className="sui-repo-about-section">
        <Heading>About</Heading>
        {description ? <p className="sui-repo-about-description">{description}</p> : null}
        {home === undefined ? null : (
          <a className="sui-repo-about-homepage" href={home} target="_blank" rel="noopener noreferrer">
            {home.replace(/^https?:\/\//i, "").replace(/\/$/, "")}
          </a>
        )}
        {topics.length === 0 ? null : (
          <ul className="sui-repo-about-topics" aria-label="Topics">
            {topics.map((topic) => <li key={topic} className="sui-repo-about-topic">{topic}</li>)}
          </ul>
        )}
        {stats.length === 0 ? null : (
          <ul className="sui-repo-about-stats">
            {stats.map((stat) => <li key={stat.key}>{stat.text}</li>)}
          </ul>
        )}
      </div>
      {release === null || release === undefined ? null : (
        <div className="sui-repo-about-section">
          <Heading count={releases}>Releases</Heading>
          <div className="sui-repo-about-release">
            {releaseHref === undefined ?
              <span className="sui-repo-about-release-name">{release.name || release.tag}</span> :
              (
                <a className="sui-repo-about-release-name" href={releaseHref} target="_blank" rel="noopener noreferrer">
                  {release.name || release.tag}
                </a>
              )}
            <span className="sui-repo-about-latest">Latest</span>
            {release.publishedAt === null || release.publishedAt === undefined ?
              null :
              <RelativeTime className="sui-repo-about-muted" ts={release.publishedAt} />}
          </div>
        </div>
      )}
      {contributors.length === 0 ? null : (
        <div className="sui-repo-about-section">
          <Heading count={contributorCount ?? contributors.length}>Contributors</Heading>
          <ul className="sui-repo-about-people" aria-label="Contributors">
            {contributors.map((person) => {
              const href = person.href === undefined ? undefined : safeHref(person.href);
              const image = (
                <img
                  className="sui-repo-about-avatar"
                  src={person.avatarUrl}
                  alt={person.login}
                  title={person.login}
                  width={28}
                  height={28}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              );
              return (
                <li key={person.login}>
                  {href === undefined ? image : <a href={href} target="_blank" rel="noopener noreferrer">{image}</a>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {shares.length === 0 ? null : (
        <div className="sui-repo-about-section">
          <Heading>Languages</Heading>
          <div className="sui-repo-about-bar" aria-hidden="true">
            {shares.map((share) => (
              <span key={share.name} style={{ width: `${share.percent}%`, background: share.color }} />
            ))}
          </div>
          <ul className="sui-repo-about-languages" aria-label="Languages">
            {shares.map((share) => (
              <li key={share.name}>
                <span className="sui-repo-about-dot" style={{ background: share.color }} aria-hidden="true" />
                <span className="sui-repo-about-language">{share.name}</span>
                <span className="sui-repo-about-muted">{share.percent}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {footer === undefined || footer === null ? null : <div className="sui-repo-about-footer">{footer}</div>}
    </section>
  );
}
