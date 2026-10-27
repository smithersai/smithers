/** @jsxImportSource react */
import type { Home } from "@smthrs/views";
import { type ComponentProps, type MouseEvent, type ReactNode, useEffect, useRef } from "react";
import { Button } from "../button";
import { cn } from "../cn";
import { isPlainNavigationClick } from "../internal/navigationClick";
import { safeHref } from "../internal/safeHref";
import { useCopyFeedback } from "../internal/useCopyFeedback";
import { Markdown } from "../primitives/markdown";
import { Skeleton } from "../skeleton";
import { StatusPill } from "../status-pill";
import { useInjectUiCss } from "../styles";
import { RelativeTime } from "../time";
import { highlight } from "./highlight";
import {
  isNotice,
  type RepositoryHomeEntry,
  type RepositoryHomeIssues,
  type RepositoryHomeList,
  type RepositoryHomeLive,
} from "./live";

/** A markdown block's file as the host has read it so far. */
export type RepositoryHomeFile =
  | { readonly state: "loading" }
  | { readonly state: "text"; readonly text: string }
  | { readonly state: "failed" };

export type RepositoryHomeProps = Omit<ComponentProps<"section">, "children"> & {
  /**
   * The sections to draw, in order, as `Home.read` from `@smthrs/views` answered them. Pass only the ones this viewer
   * may see (`Home.visible`): the component draws every section it is given.
   */
  sections: ReadonlyArray<Home.Section>;
  /** Each markdown block's file, by its repository path; a path absent here shows as loading. */
  files?: Readonly<Record<string, RepositoryHomeFile>>;
  /**
   * Where a prompt, app or flow button goes: a real link. Supply a resolver to keep the selected flow in the URL
   * for native navigation, including modified clicks and opening in another tab. Without it, those blocks aren't drawn.
   */
  askHref?: string | ((flow: string | undefined) => string);
  /**
   * A plain click on a prompt, app or flow button: the block's `flow`, if any. The click's default is prevented, so
   * the host navigates to the resolved `askHref` itself. A modified click (⌘, Ctrl, Shift, Alt, middle) keeps the browser's own
   * behavior and doesn't call it. Without it, the buttons are plain links.
   */
  onAsk?: (flow: string | undefined) => void;
  /** Whether this page has an app block's flow. An app block whose flow it hasn't is not drawn. Default: none. */
  offered?: (flow: string) => boolean;
  /** The live blocks' rows, read by the host under its own access checks. A live block without them isn't drawn. */
  live?: RepositoryHomeLive;
  /** A plain click on a link inside the app (a live block's row or count): the host navigates. Without it, plain links. */
  onNavigate?: (href: string) => void;
  /** Copies an install command or a code block, the host's way. Without it, the browser's clipboard. */
  onCopy?: (text: string) => void | Promise<void>;
  /**
   * Runs an `action` block's flow: a press of its button, or of its key while the person isn't typing. Without it, or
   * when `offered` hasn't the flow, action blocks aren't drawn.
   */
  onRun?: (flow: string) => void;
  /** The action blocks' flows running now: their buttons are disabled until they finish. */
  running?: ReadonlyArray<string>;
};

/** How an audience's section is labelled for the people who may see it; everyone's isn't. */
const AUDIENCE_LABEL: Readonly<Record<Home.Audience, string | undefined>> = {
  everyone: undefined,
  contributor: "Contributors",
  maintainer: "Maintainers",
};

/** Whether a key press happened while the person was typing, where a letter is text, never a shortcut. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  (target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']") !== null ||
    (target instanceof HTMLElement && target.isContentEditable));

/**
 * Blocks drawn side by side when adjacent: app buttons in one row, stack and runs panels in one grid, and a hero with
 * the code block right after it in two columns.
 */
type Group = "apps" | "panels" | "lead" | "actions";
type Drawn = { readonly key: number; readonly kind: Home.Block["type"]; readonly group?: Group; readonly node: ReactNode };

const GROUP_CLASS: Readonly<Record<Group, string>> = {
  apps: "sui-repository-home-apps",
  panels: "sui-rh-panels",
  lead: "sui-rh-lead",
  actions: "sui-rh-actions",
};

const isExternal = (href: string): boolean => /^https?:\/\//i.test(href);

/** An absolute `http` or `https` URL, as `Home.Url` admits; anything else is not drawn. */
const linkHref = (url: string): string | undefined => (isExternal(url) ? safeHref(url) : undefined);

/** The file the host holds for `path`, never one an object inherits (`constructor` is a valid path). */
const fileAt = (files: RepositoryHomeProps["files"], path: string): RepositoryHomeFile | undefined =>
  files !== undefined && Object.hasOwn(files, path) ? files[path] : undefined;

/** A card grid's columns on a wide home: four for a count four divides and three doesn't, else three. */
const columnsFor = (count: number): "3" | "4" => (count % 4 === 0 && count % 3 !== 0 ? "4" : "3");

const RELEASE_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const Title = ({ title }: { readonly title: string | undefined }) =>
  title === undefined ? null : <h3 className="sui-repository-home-title">{title}</h3>;

/** A link to an `http(s)` page: a new tab, with no opener or referrer. */
const External = ({ url, className, children }: { readonly url: string; readonly className: string; readonly children: ReactNode }) => {
  const href = linkHref(url);
  return href === undefined ? null : (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
};

/** A copy button over `text`: announces success or failure without exposing the host's diagnostic. */
const Copy = ({ text, label, onCopy }: { readonly text: string; readonly label: string; readonly onCopy: RepositoryHomeProps["onCopy"] }) => {
  const { copied, copyFailed, copy } = useCopyFeedback({ value: text, onCopy });
  const feedback = copyFailed ? "Copy failed" : copied ? "Copied" : "";
  return (
    <>
      <button
        type="button"
        className="sui-rh-copy"
        aria-label={label}
        data-copied={copied ? "true" : "false"}
        data-copy-failed={copyFailed ? "true" : undefined}
        onClick={() => void copy()}
      >
        {feedback || "Copy"}
      </button>
      <span className="sui-sr-only" role="status" aria-live="polite" aria-atomic="true">{feedback}</span>
    </>
  );
};

const MarkdownFile = ({ path, file }: { readonly path: string; readonly file: RepositoryHomeFile | undefined }) => {
  if (file === undefined || file.state === "loading") {
    // Lines in the document's place, as every loading state: nothing for the first moment, then a calm skeleton.
    return (
      <div className="sui-rh-loading" role="status" aria-label={`Loading ${path}`}>
        <Skeleton className="sui-rh-skeleton" />
        <Skeleton className="sui-rh-skeleton" />
        <Skeleton className="sui-rh-skeleton sui-rh-skeleton-short" />
      </div>
    );
  }
  if (file.state === "failed") {
    return (
      <p role="status" className="sui-repository-home-notice">
        {`Couldn't read ${path}`}
      </p>
    );
  }
  return <Markdown content={file.text} variant="document" />;
};

type BlockOf<K extends Home.Block["type"]> = Extract<Home.Block, { readonly type: K }>;

const Hero = ({ block, onCopy }: { readonly block: BlockOf<"hero">; readonly onCopy: RepositoryHomeProps["onCopy"] }) => (
  <div className="sui-rh-hero">
    {block.announcement === undefined ? null : (
      <External url={block.announcement.url} className="sui-rh-announce">
        {block.announcement.label}
        <span aria-hidden="true" className="sui-rh-announce-arrow">→</span>
      </External>
    )}
    <h2 className="sui-rh-hero-title">{block.title}</h2>
    {block.tagline === undefined ? null : <p className="sui-rh-hero-tagline">{block.tagline}</p>}
    {block.text === undefined ? null : <p className="sui-rh-hero-text">{block.text}</p>}
    {block.actions === undefined ? null : (
      <div className="sui-rh-hero-actions">
        {block.actions.map((action, index) => (
          <External key={index} url={action.url} className={cn("sui-rh-action", index === 0 && "sui-rh-action-primary")}>
            {action.label}
          </External>
        ))}
      </div>
    )}
    {block.install === undefined ? null : (
      <div className="sui-rh-install">
        <span aria-hidden="true" className="sui-rh-install-prompt">$</span>
        <code tabIndex={0}>{block.install}</code>
        <Copy text={block.install} label={`Copy ${block.install}`} onCopy={onCopy} />
      </div>
    )}
  </div>
);

const Code = ({ block, onCopy }: { readonly block: BlockOf<"code">; readonly onCopy: RepositoryHomeProps["onCopy"] }) => {
  const name = block.file ?? block.language;
  return (
    <figure className="sui-rh-code" aria-label={name ?? "Code"}>
      <div className="sui-rh-code-bar">
        <span className="sui-rh-code-name">{name}</span>
        <Copy text={block.code} label="Copy code" onCopy={onCopy} />
      </div>
      <pre className="sui-rh-code-body" tabIndex={0}>
        <code data-language={block.language}>
          {highlight(block.code, block.language).map((line, lineIndex, lines) => (
            <span key={lineIndex}>
              {line.map((token, tokenIndex) =>
                token.kind === undefined
                  ? token.text
                  : <span key={tokenIndex} className={`sui-rh-tok-${token.kind}`}>{token.text}</span>
              )}
              {lineIndex < lines.length - 1 ? "\n" : null}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
};

/** A card's body: its label, its title and its line. */
const CardBody = ({ card }: { readonly card: (typeof Home.Card)["Type"] }) => (
  <>
    {card.label === undefined ? null : <span className="sui-rh-card-label">{card.label}</span>}
    <h4 className="sui-rh-card-title">{card.title}</h4>
    {card.text === undefined ? null : <p className="sui-rh-card-text">{card.text}</p>}
  </>
);

/** The link under a list to its whole, such as "All releases". */
const More = ({ more }: { readonly more: { readonly label: string; readonly url: string } | undefined }) =>
  more === undefined ? null : (
    <External url={more.url} className="sui-rh-more">
      {more.label}
      <span aria-hidden="true"> →</span>
    </External>
  );

/**
 * A repository's home: the sections its `.smithers/home.json` (or a curated home) declares, each block drawn as data.
 * Text is always text; external links open in a new tab; a markdown block is the file the host read; a prompt, app or
 * flow button is a real link to `askHref` that `onAsk` turns into in-app navigation on a plain click. The live blocks
 * (`issues`, `stack`, `runs`, `flows`) draw the rows the host hands over in `live`. Nothing runs on arrival; a button
 * acts only when pressed.
 *
 * A section for Members or Maintainers wears a label saying so. A `view` block is not drawn yet, nor a live block
 * without its rows. When nothing draws, this renders nothing.
 */
export function RepositoryHome({
  sections,
  files,
  askHref,
  onAsk,
  offered,
  live,
  onNavigate,
  onCopy,
  onRun,
  running,
  className,
  ...props
}: RepositoryHomeProps) {
  useInjectUiCss();

  // An action's key presses it while the person isn't typing. The listener reads the latest actions through a ref, so
  // it is bound once per mount.
  const shortcuts = useRef<ReadonlyMap<string, string>>(new Map());
  shortcuts.current = new Map(
    onRun === undefined || offered === undefined
      ? []
      : sections.flatMap((section) =>
        section.blocks.flatMap((block) =>
          block.type === "action" && block.key !== undefined && offered(block.flow) && !running?.includes(block.flow)
            ? [[block.key, block.flow] as const]
            : []
        )
      ),
  );
  const run = useRef(onRun);
  run.current = onRun;
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (typing(event.target)) return;
      const flow = shortcuts.current.get(event.key);
      if (flow === undefined) return;
      event.preventDefault();
      run.current?.(flow);
    };
    document.addEventListener("keydown", press);
    return () => document.removeEventListener("keydown", press);
  }, []);

  // With onAsk, a plain click is the host's to navigate; a modified click stays the browser's.
  const ask = (flow: string | undefined) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (onAsk === undefined || !isPlainNavigationClick(event)) return;
    event.preventDefault();
    onAsk(flow);
  };

  // The host owns the route format; resolve it for every link, not only an intercepted plain click.
  const hrefForAsk = (flow: string | undefined): string | undefined => typeof askHref === "function" ? askHref(flow) : askHref;

  /** A link in the app or out of it: out, a new tab; in, `onNavigate` on a plain click. */
  const link = (raw: string, className: string, children: ReactNode, label?: string) => {
    const href = safeHref(raw);
    if (href === undefined) return <span className={className}>{children}</span>;
    if (isExternal(href)) {
      return <a className={className} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>{children}</a>;
    }
    const follow = (event: MouseEvent<HTMLAnchorElement>) => {
      if (onNavigate === undefined || !isPlainNavigationClick(event)) return;
      event.preventDefault();
      onNavigate(href);
    };
    return <a className={className} href={href} onClick={follow} aria-label={label}>{children}</a>;
  };

  const askLink = (flow: string | undefined, label: string, picture?: string) => (
    <Button asChild variant="outline">
      <a href={hrefForAsk(flow)} data-picture={picture} onClick={ask(flow)}>
        {label}
      </a>
    </Button>
  );

  const entry = (row: RepositoryHomeEntry) => (
    <li key={row.key} data-slot="repository-home-entry" className="sui-rh-entry">
      {row.label === undefined ? null : <span className="sui-rh-entry-label">{row.label}</span>}
      {link(row.href, "sui-rh-entry-title", row.title)}
      {row.status === undefined ? null : <StatusPill status={row.status.status} label={row.status.label} />}
      {row.at === undefined ? null : <RelativeTime className="sui-rh-entry-at" ts={row.at} />}
    </li>
  );

  /** A list of rows under its heading and count, linking to the whole list. */
  const panel = (kind: string, title: string, list: RepositoryHomeList, heading: "h3" | "h4" = "h3", count: ReactNode = list.total) => {
    const Heading = heading;
    return (
      <div data-slot="repository-home-panel" data-panel={kind} className="sui-rh-panel">
        <div className="sui-rh-panel-head">
          <Heading className="sui-rh-panel-title">
            {list.href === undefined ? title : link(list.href, "sui-rh-panel-link", title)}
          </Heading>
          <span className="sui-rh-count">{count}</span>
        </div>
        {list.entries.length === 0
          ? <p className="sui-rh-empty">None</p>
          : <ul className="sui-rh-entries">{list.entries.map(entry)}</ul>}
      </div>
    );
  };

  /** A live block whose host says why it has no rows: its heading and that one line. */
  const notice = (kind: string, title: string, text: string) => (
    <div data-slot="repository-home-panel" data-panel={kind} className="sui-rh-panel">
      <div className="sui-rh-panel-head">
        <h3 className="sui-rh-panel-title">{title}</h3>
      </div>
      <p role="status" className="sui-rh-empty">{text}</p>
    </div>
  );

  const issues = (rows: RepositoryHomeIssues, titled: boolean) => {
    const tile = (label: string, value: number, tone?: "warning") =>
      link(
        rows.href,
        cn("sui-rh-tile", tone !== undefined && value > 0 && "sui-rh-tile-warning"),
        <>
          <span className="sui-rh-tile-value">{value}</span>
          <span className="sui-rh-tile-label">{label}</span>
        </>,
        `${value} ${label}`,
      );
    return (
      <>
        <div className="sui-rh-tiles" data-slot="repository-home-counts">
          {tile("Proposed", rows.proposed, "warning")}
          {tile("Accepted", rows.accepted)}
          {tile("Not accepted", rows.notAccepted)}
          {tile("Pull requests", rows.pulls.total)}
        </div>
        <div className="sui-rh-panels">
          {panel("triage", "Needs triage", rows.triage, titled ? "h4" : "h3")}
          {panel("pulls", "Pull requests waiting", rows.pulls, titled ? "h4" : "h3")}
        </div>
      </>
    );
  };

  const draw = (block: Home.Block, key: number): Drawn | null => {
    const shell = (children: ReactNode, title?: string, group?: Group): Drawn => ({
      key,
      kind: block.type,
      ...(group === undefined ? {} : { group }),
      node: (
        <div key={key} data-slot="repository-home-block" data-kind={block.type} className="sui-repository-home-block">
          <Title title={title} />
          {children}
        </div>
      ),
    });
    switch (block.type) {
      case "text":
        return shell(<p className="sui-repository-home-text">{block.text}</p>, block.title);
      case "links": {
        const links = block.links.flatMap((each, index) => {
          const href = linkHref(each.url);
          return href === undefined ? [] : [
            <li key={index}>
              <a className="sui-repository-home-link" href={href} target="_blank" rel="noopener noreferrer">
                {each.label}
              </a>
            </li>,
          ];
        });
        return links.length === 0 ? null : shell(<ul className="sui-repository-home-links">{links}</ul>, block.title);
      }
      case "markdown":
        return shell(<MarkdownFile path={block.path} file={fileAt(files, block.path)} />, block.title);
      case "prompt":
        return askHref === undefined ? null : shell(
          <div className="sui-rh-ask">
            {block.title === undefined ? null : <h3 className="sui-rh-ask-title">{block.title}</h3>}
            <a className="sui-rh-ask-link" href={hrefForAsk(block.flow)} onClick={ask(block.flow)}>
              {block.placeholder ?? "Ask Smithers"}
              <span aria-hidden="true" className="sui-rh-ask-key">Ask</span>
            </a>
          </div>,
        );
      case "app":
        return askHref === undefined || offered === undefined || !offered(block.flow)
          ? null
          : shell(askLink(block.flow, block.title, block.picture), undefined, "apps");
      case "hero":
        return shell(<Hero block={block} onCopy={onCopy} />);
      case "code":
        return shell(<Code block={block} onCopy={onCopy} />, block.title);
      case "cards":
        return shell(
          <>
            <ul className="sui-rh-cards" data-columns={columnsFor(block.cards.length)}>
              {block.cards.map((card, index) => (
                <li key={index}>
                  {card.url === undefined || linkHref(card.url) === undefined
                    ? <div className="sui-rh-card"><CardBody card={card} /></div>
                    : <External url={card.url} className="sui-rh-card"><CardBody card={card} /></External>}
                </li>
              ))}
            </ul>
            <More more={block.more} />
          </>,
          block.title,
        );
      case "stats":
        return shell(
          <dl className="sui-rh-stats">
            {block.stats.map((stat, index) => (
              <div key={index} className="sui-rh-stat">
                <dt>{stat.label}</dt>
                <dd>{stat.value}</dd>
              </div>
            ))}
          </dl>,
          block.title,
        );
      case "releases":
        return shell(
          <>
            <ol className="sui-rh-releases">
              {block.releases.map((release, index) => (
                <li key={index} className="sui-rh-release">
                  <External url={release.url} className="sui-rh-release-name">{release.name}</External>
                  {release.summary === undefined ? null : <p className="sui-rh-release-summary">{release.summary}</p>}
                  <time className="sui-rh-release-date" dateTime={release.date}>
                    {RELEASE_DATE.format(new Date(`${release.date}T00:00:00Z`))}
                  </time>
                </li>
              ))}
            </ol>
            <More more={block.more} />
          </>,
          block.title,
        );
      case "issues": {
        const rows = live?.issues;
        if (rows === undefined) return null;
        return isNotice(rows)
          ? shell(notice("issues", block.title ?? "Issues", rows.notice))
          : shell(issues(rows, block.title !== undefined), block.title);
      }
      case "stack": {
        const rows = live?.stack;
        if (rows === undefined) return null;
        const title = block.title ?? "Stack";
        return shell(isNotice(rows) ? notice("stack", title, rows.notice) : panel("stack", title, rows), undefined, "panels");
      }
      case "runs": {
        const rows = live?.runs;
        if (rows === undefined) return null;
        const title = block.title ?? "Runs";
        return shell(
          isNotice(rows) ? notice("runs", title, rows.notice) : panel(
            "runs",
            title,
            rows,
            "h3",
            rows.failed === 0 ? rows.total : <span className="sui-rh-count-failed">{`${rows.failed} failed`}</span>,
          ),
          undefined,
          "panels",
        );
      }
      case "flows": {
        const flows = live?.flows;
        if (askHref === undefined || flows === undefined || flows.length === 0) return null;
        return shell(
          <div className="sui-rh-flows">
            {flows.map((flow) => (
              <a key={flow.flow} className="sui-rh-flow" href={hrefForAsk(flow.flow)} onClick={ask(flow.flow)} title={flow.title}>
                <code>{flow.name}</code>
                <span className="sui-rh-flow-title">{flow.title}</span>
              </a>
            ))}
          </div>,
          block.title,
        );
      }
      case "action": {
        if (onRun === undefined || offered === undefined || !offered(block.flow)) return null;
        const busy = running?.includes(block.flow) === true;
        return shell(
          <button
            type="button"
            className="sui-rh-action-button"
            data-flow={block.flow}
            data-running={busy ? "true" : undefined}
            disabled={busy}
            aria-keyshortcuts={block.key?.toUpperCase()}
            onClick={() => onRun(block.flow)}
          >
            {block.title}
            {block.key === undefined ? null : <kbd aria-hidden="true">{block.key.toUpperCase()}</kbd>}
          </button>,
          undefined,
          "actions",
        );
      }
      // A flow's own view comes with the presentation realm (decision 0014 L3).
      case "view":
        return null;
    }
  };

  /** One section's blocks: adjacent apps in one row, adjacent panels in one grid, a hero beside the code after it. */
  const rowsOf = (blocks: ReadonlyArray<Home.Block>): Array<ReactNode> => {
    const drawn = blocks.flatMap((block, index) => {
      const one = draw(block, index);
      return one === null ? [] : [one];
    }).map((one, index, all): Drawn =>
      (one.kind === "hero" && all[index + 1]?.kind === "code") || (one.kind === "code" && all[index - 1]?.kind === "hero")
        ? { ...one, group: "lead" }
        : one
    );
    const rows: Array<ReactNode> = [];
    for (let index = 0; index < drawn.length;) {
      const first = drawn[index]!;
      if (first.group === undefined) {
        rows.push(first.node);
        index += 1;
        continue;
      }
      const run: Array<ReactNode> = [];
      while (index < drawn.length && drawn[index]!.group === first.group) run.push(drawn[index++]!.node);
      rows.push(
        <div
          key={`${first.group}-${first.key}`}
          data-slot={`repository-home-${first.group}`}
          className={GROUP_CLASS[first.group]}
        >
          {run}
        </div>,
      );
    }
    return rows;
  };

  const drawnSections = sections.flatMap((section, index) => {
    const label = AUDIENCE_LABEL[section.audience];
    // A section's leading actions sit in its heading, to the right, when it has one.
    const headed = section.title !== undefined || label !== undefined;
    const lead = headed ? section.blocks.findIndex((block) => block.type !== "action") : 0;
    const leading = headed ? section.blocks.slice(0, lead === -1 ? section.blocks.length : lead) : [];
    const actions = rowsOf(leading);
    const rows = rowsOf(section.blocks.slice(leading.length));
    if (rows.length === 0 && actions.length === 0) return [];
    return [
      <section
        key={index}
        data-slot="repository-home-section"
        data-audience={section.audience}
        aria-label={section.title}
        className="sui-rh-section"
      >
        {!headed ? null : (
          <div className="sui-rh-section-head">
            {section.title === undefined ? null : <h2 className="sui-rh-section-title">{section.title}</h2>}
            {label === undefined ? null : (
              <span data-slot="repository-home-audience" data-audience={section.audience} className="sui-rh-audience">
                {label}
              </span>
            )}
            {actions.length === 0 ? null : <div className="sui-rh-section-actions">{actions}</div>}
          </div>
        )}
        {rows}
      </section>,
    ];
  });
  if (drawnSections.length === 0) return null;

  return (
    <section data-slot="repository-home" className={cn("sui-repository-home", className)} {...props}>
      {drawnSections}
    </section>
  );
}
