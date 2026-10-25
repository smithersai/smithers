/** @jsxImportSource react */
import {
  type BreadcrumbItem,
  Breadcrumbs,
  cn,
  DirectoryListing,
  type DirectoryTarget,
  FileTree,
  isPlainNavigationClick,
  Skeleton
} from "@smthrs/ui";
import { type ComponentProps, type ReactNode, useMemo, useState } from "react";
import { CodeFileView, type CodeFileViewProps, type CodeViewMode } from "./CodeFileView";
import { HtmlPreview } from "./HtmlPreview";
import { MarkdownEditor, type MarkdownEditorProps } from "./MarkdownEditor";
import {
  ancestorsOf,
  directoriesOf,
  directoryEntries,
  formatBytes,
  isHtml,
  isMarkdown,
  lineCount,
  parentOf,
  resolveLink,
  treeOrder
} from "./paths";
import { useInjectRepoViewCss } from "./styles";

/**
 * What the view shows: a directory (`tree`) or a file (`blob`), by its full
 * path at the revision. `""` is the root directory. `line` anchors a file at
 * a 1-based line, and `lineEnd` widens the mark to a range.
 */
export type RepoViewLocation = {
  readonly kind: "tree" | "blob";
  readonly path: string;
  readonly line?: number | undefined;
  readonly lineEnd?: number | undefined;
};

/** The repository's file list at the revision, as the host has loaded it. */
export type RepoViewTree =
  | { readonly state: "loading" }
  | {
    readonly state: "ready";
    /** Every file's full path. Directories are implied by the paths under them. */
    readonly paths: ReadonlyArray<string>;
    /**
     * Directories known without their files, such as a repository's top
     * level as GitHub lists it before a clone: listed, and opened as a
     * directory, though the view has nothing under them.
     */
    readonly directories?: ReadonlyArray<string> | undefined;
    /** The host stopped listing before the end: the view says so under the tree. */
    readonly truncated?: boolean | undefined;
  }
  | { readonly state: "failed"; readonly message: ReactNode };

/** One file's contents, as the host has loaded them. Sizes are in bytes. */
export type RepoViewFile =
  | { readonly state: "loading" }
  | { readonly state: "text"; readonly contents: string; readonly size: number }
  | { readonly state: "binary"; readonly size: number }
  | { readonly state: "too-large"; readonly size: number }
  | { readonly state: "failed"; readonly message: ReactNode };

/** How a Markdown file shows: rendered as a document, or as its source. */
export type RepoViewMarkdownMode = "preview" | "source";

/**
 * How an HTML file shows, as CodePen does: its source (`code`), the page
 * rendered live in a sandboxed frame (`preview`), or both side by side
 * (`split`).
 */
export type RepoViewHtmlMode = "code" | "preview" | "split";

/**
 * `full` is the page: the file tree beside the content. `inline` fits in a
 * conversation: no tree, and the content scrolls inside a bounded height.
 */
export type RepoViewSize = "inline" | "full";

export type RepoViewProps = Omit<ComponentProps<"section">, "children"> & {
  /** The repository's name: the first step of the path trail. */
  name: string;
  tree: RepoViewTree;
  location: RepoViewLocation;
  /** The file at `location` when it is a `blob`. */
  file?: RepoViewFile | undefined;
  /** A directory's README, rendered under its listing. */
  readme?: { readonly path: string; readonly file: RepoViewFile } | undefined;
  /** Defaults to `full`. */
  size?: RepoViewSize | undefined;
  /** The URL of a location, so every link in the view is a real link. */
  href: (location: RepoViewLocation) => string;
  /** In-app navigation: a plain click on a link in the view, or a relative link in a README. */
  onNavigate: (location: RepoViewLocation) => void;
  /**
   * The tree's open directories, controlled. Absent, the view keeps its own,
   * starting with the location's ancestors and opening a location's
   * ancestors as it navigates. A host that controls it does the same.
   */
  expanded?: ReadonlySet<string> | undefined;
  /** A tree directory was opened or closed. */
  onToggle?: ((path: string, expanded: boolean) => void) | undefined;
  /** Controlled Markdown mode. Absent, the view keeps its own, starting at `preview`. */
  markdownMode?: RepoViewMarkdownMode | undefined;
  onMarkdownModeChange?: ((mode: RepoViewMarkdownMode) => void) | undefined;
  /** Controlled HTML mode. Absent, the view keeps its own, starting at `code`. */
  htmlMode?: RepoViewHtmlMode | undefined;
  onHtmlModeChange?: ((mode: RepoViewHtmlMode) => void) | undefined;
  /**
   * Beside the content, on the right of a `full` view: a directory's about
   * panel, as GitHub's repository page has. It moves under the content when
   * the view is narrow.
   */
  aside?: ReactNode;
  /** Whether a `full` view shows the file tree on its left. Defaults to `true`. */
  fileTree?: boolean | undefined;
  /** Leading the header, before the path trail: the revision, such as a branch name. */
  revision?: ReactNode;
  /** Trailing the header: the view's actions, such as Copy permalink or Open. */
  actions?: ReactNode;
  /** A row between the header and the content, such as the latest commit. */
  summary?: ReactNode;
  /** Trailing a file's toolbar, such as a Raw link. */
  fileActions?: ReactNode;
  /** After a file's stats in its toolbar: marks on the file, such as a Generated chip. */
  fileBadges?: ReactNode;
  /** Code theme mode; defaults to the page's. */
  codeMode?: CodeViewMode | undefined;
  /**
   * A language server's help on the shown file's code: hover cards, marks,
   * the keyboard cursor and the token gestures (`CodeFileView`'s props).
   */
  code?: RepoViewCode | undefined;
  /**
   * The Markdown editor's seams, for a host that bundles its own Milkdown
   * build or for a test: `fallback` forces the textarea (`true`) or the
   * WYSIWYG editor (`false`), and `loadEditor` supplies the editor modules.
   */
  markdownEditor?: Pick<MarkdownEditorProps, "fallback" | "loadEditor"> | undefined;
  /**
   * A Markdown file's preview, in place of the read-only document: a host's
   * live editor for a person who may change the file. It shows only for a
   * file whose text loaded, in preview mode; Code still shows the source.
   * Absent, the read-only document shows. A directory's README is always the
   * read-only document.
   */
  markdownPreview?: ReactNode;
};

/** What `RepoView` passes through to the shown file's `CodeFileView`. */
export type RepoViewCode = Pick<
  CodeFileViewProps,
  | "annotations"
  | "cursor"
  | "hover"
  | "marks"
  | "onCursorMove"
  | "onKeyDown"
  | "onTokenActivate"
  | "onTokenRest"
  | "onTokenSelect"
>;

/** The path trail: the repository, then each directory, then the file. Every step but the last is a directory. */
function trail(name: string, location: RepoViewLocation, href: RepoViewProps["href"]): ReadonlyArray<BreadcrumbItem> {
  const parts = location.path.split("/").filter(Boolean);
  const steps = parts.map((part, index): BreadcrumbItem => {
    const path = parts.slice(0, index + 1).join("/");
    return { key: path, label: part, href: href({ kind: "tree", path }) };
  });
  return [{ key: "", label: name, href: href({ kind: "tree", path: "" }) }, ...steps];
}

/** A file's body for each loading state. */
function FileBody({
  path,
  file,
  markdownMode,
  htmlMode = "code",
  line,
  lineEnd,
  codeMode,
  intelligence,
  markdownEditor,
  markdownPreview,
  onLink
}: {
  path: string;
  file: RepoViewFile;
  markdownMode: RepoViewMarkdownMode;
  htmlMode?: RepoViewHtmlMode | undefined;
  line: number | undefined;
  lineEnd: number | undefined;
  codeMode: CodeViewMode | undefined;
  intelligence?: RepoViewCode | undefined;
  markdownEditor: RepoViewProps["markdownEditor"];
  markdownPreview?: ReactNode;
  onLink: (href: string) => boolean;
}) {
  switch (file.state) {
    case "loading":
      // Lines in the file's place: nothing for the first moment, then a calm skeleton (LOADING_DELAY_MS).
      return (
        <div className="sui-repo-loading" role="status" aria-label={`Loading ${path}`}>
          <Skeleton className="sui-repo-skeleton" />
          <Skeleton className="sui-repo-skeleton" />
          <Skeleton className="sui-repo-skeleton sui-repo-skeleton-short" />
        </div>
      );
    case "failed":
      return <div className="sui-repo-note" role="alert">{file.message}</div>;
    case "binary":
      return <div className="sui-repo-note">Binary file</div>;
    case "too-large":
      return <div className="sui-repo-note">Too large to show</div>;
  }
  // Text: the host's own preview of a Markdown file (its live editor, which an empty file needs too), a Markdown
  // document, code, or an HTML page in the mode asked for.
  if (isMarkdown(path) && markdownMode === "preview" && markdownPreview !== undefined && markdownPreview !== null) {
    return markdownPreview;
  }
  if (file.contents === "") return <div className="sui-repo-note">Empty file</div>;
  if (isMarkdown(path) && markdownMode === "preview") {
    return (
      <MarkdownEditor
        {...markdownEditor}
        value={file.contents}
        resetKey={path}
        readOnly
        aria-label={path}
        onLinkClick={onLink}
      />
    );
  }
  const code = (
    <CodeFileView
      {...intelligence}
      className="sui-repo-code"
      name={path}
      contents={file.contents}
      line={line}
      lineEnd={lineEnd}
      mode={codeMode}
    />
  );
  if (!isHtml(path) || htmlMode === "code") return code;
  const preview = <HtmlPreview className="sui-repo-html-preview" html={file.contents} title={`Preview of ${path}`} />;
  return htmlMode === "preview" ? preview : <div className="sui-repo-html-split">{code}{preview}</div>;
}

/** A segmented control over `modes`, each labelled by `label`, the pressed one `current`. */
function Segments<M extends string>({ modes, current, label, onChange }: {
  modes: ReadonlyArray<M>;
  current: M;
  label: (mode: M) => string;
  onChange: (mode: M) => void;
}) {
  return (
    <div className="sui-repo-segmented" role="group" aria-label="Show as">
      {modes.map((mode) => (
        <button
          key={mode}
          type="button"
          className="sui-repo-segment"
          aria-pressed={current === mode}
          onClick={() => onChange(mode)}
        >
          {label(mode)}
        </button>
      ))}
    </div>
  );
}

const MARKDOWN_MODES = ["preview", "source"] as const;
const HTML_MODES = ["code", "preview", "split"] as const;
const HTML_MODE_LABELS: Readonly<Record<RepoViewHtmlMode, string>> = { code: "Code", preview: "Preview", split: "Split" };

/** The file's stats: lines and size for text, size alone otherwise. */
function stats(file: RepoViewFile): string | undefined {
  switch (file.state) {
    case "text":
      return `${lineCount(file.contents)} lines · ${formatBytes(file.size)}`;
    case "binary":
    case "too-large":
      return formatBytes(file.size);
    default:
      return undefined;
  }
}

/**
 * A repository browser: the file tree, a directory's listing with its README,
 * and a file, highlighted as code or rendered as a Markdown document. It
 * fetches nothing: the host passes the file list and the files it loaded, and
 * owns where the view is (`location`) and how it gets there (`href`,
 * `onNavigate`), so the same view serves a routed page and a conversation.
 *
 * Code renders through {@link CodeFileView} (`@pierre/diffs`, Shiki) and
 * Markdown through {@link MarkdownEditor} (Milkdown), read-only, which is why
 * this view ships in `@smthrs/repo-view` and not in `@smthrs/ui`.
 */
export function RepoView({
  name,
  tree,
  location,
  file,
  readme,
  size = "full",
  href,
  onNavigate,
  expanded: controlledExpanded,
  onToggle,
  markdownMode: controlledMarkdownMode,
  onMarkdownModeChange,
  htmlMode: controlledHtmlMode,
  onHtmlModeChange,
  aside,
  fileTree = true,
  revision,
  actions,
  summary,
  fileActions,
  fileBadges,
  codeMode,
  code,
  markdownEditor,
  markdownPreview,
  className,
  ...props
}: RepoViewProps) {
  useInjectRepoViewCss();
  const [ownExpanded, setOwnExpanded] = useState<ReadonlySet<string>>(() =>
    new Set([...ancestorsOf(location.path), ...(location.kind === "tree" && location.path !== "" ? [location.path] : [])])
  );
  const [ownMarkdownMode, setOwnMarkdownMode] = useState<RepoViewMarkdownMode>("preview");
  const [ownHtmlMode, setOwnHtmlMode] = useState<RepoViewHtmlMode>("code");
  const expanded = controlledExpanded ?? ownExpanded;
  const markdownMode = controlledMarkdownMode ?? ownMarkdownMode;
  const htmlMode = controlledHtmlMode ?? ownHtmlMode;
  const paths = tree.state === "ready" ? tree.paths : undefined;
  const folders = tree.state === "ready" ? tree.directories : undefined;
  const ordered = useMemo(() => (paths === undefined ? [] : treeOrder(paths)), [paths]);
  const files = useMemo(() => new Set(ordered), [ordered]);
  const directories = useMemo(() => directoriesOf(ordered, folders), [ordered, folders]);
  const collapsed = useMemo(
    () => new Set([...directories].filter((directory) => !expanded.has(directory))),
    [directories, expanded]
  );

  const go = (next: RepoViewLocation) => {
    if (controlledExpanded === undefined) {
      const opened = [...ancestorsOf(next.path), ...(next.kind === "tree" && next.path !== "" ? [next.path] : [])];
      setOwnExpanded((current) => new Set([...current, ...opened]));
    }
    onNavigate(next);
  };
  const toggle = (path: string, open: boolean) => {
    if (controlledExpanded === undefined) {
      setOwnExpanded((current) => {
        const next = new Set(current);
        if (open) next.add(path);
        else next.delete(path);
        return next;
      });
    }
    onToggle?.(path, open);
  };
  const setMarkdownMode = (mode: RepoViewMarkdownMode) => {
    setOwnMarkdownMode(mode);
    onMarkdownModeChange?.(mode);
  };
  const setHtmlMode = (mode: RepoViewHtmlMode) => {
    setOwnHtmlMode(mode);
    onHtmlModeChange?.(mode);
  };

  const openTarget = (target: DirectoryTarget) => go({ kind: target.kind === "directory" ? "tree" : "blob", path: target.path });
  const linkFrom = (files: ReadonlyArray<string>, from: string) => (link: string): boolean => {
    const target = resolveLink(from, link, files);
    if (target === undefined) return false;
    go(target);
    return true;
  };

  const content = (() => {
    if (tree.state === "loading") {
      // The listing's box with rows in their place, so the files take it without a jump.
      return (
        <div className="sui-repo-box sui-repo-loading" role="status" aria-label="Loading files">
          <Skeleton className="sui-repo-skeleton" />
          <Skeleton className="sui-repo-skeleton" />
          <Skeleton className="sui-repo-skeleton" />
          <Skeleton className="sui-repo-skeleton sui-repo-skeleton-short" />
        </div>
      );
    }
    if (tree.state === "failed") return <div className="sui-repo-note" role="alert">{tree.message}</div>;
    const exists = location.kind === "blob" ?
      files.has(location.path) :
      location.path === "" || directories.has(location.path);
    if (!exists) return <div className="sui-repo-note">Not found</div>;
    if (location.kind === "tree") {
      return (
        <>
          <DirectoryListing
            className="sui-repo-box"
            entries={directoryEntries(tree.paths, location.path, tree.directories)}
            parent={location.path === "" ? undefined : parentOf(location.path)}
            href={(target) => href({ kind: target.kind === "directory" ? "tree" : "blob", path: target.path })}
            onOpen={openTarget}
            label={location.path === "" ? name : location.path}
            empty={<div className="sui-repo-note">Empty repository</div>}
          />
          {readme === undefined ? null : (
            <article className="sui-repo-box sui-repo-readme" aria-label={readme.path}>
              <header className="sui-repo-toolbar">
                <a
                  className="sui-repo-readme-name"
                  href={href({ kind: "blob", path: readme.path })}
                  onClick={(event) => {
                    if (!isPlainNavigationClick(event)) return;
                    event.preventDefault();
                    go({ kind: "blob", path: readme.path });
                  }}
                >
                  {readme.path.split("/").at(-1)}
                </a>
              </header>
              <FileBody
                path={readme.path}
                file={readme.file}
                markdownMode="preview"
                line={undefined}
                lineEnd={undefined}
                codeMode={codeMode}
                markdownEditor={markdownEditor}
                onLink={linkFrom(tree.paths, readme.path)}
              />
            </article>
          )}
        </>
      );
    }
    const shown = file ?? { state: "loading" as const };
    const label = stats(shown);
    return (
      <article className="sui-repo-box sui-repo-file" aria-label={location.path} data-html-mode={isHtml(location.path) ? htmlMode : undefined}>
        <header className="sui-repo-toolbar">
          {isMarkdown(location.path) && shown.state === "text" ?
            (
              <Segments
                modes={MARKDOWN_MODES}
                current={markdownMode}
                label={(mode) => (mode === "preview" ? "Preview" : "Code")}
                onChange={setMarkdownMode}
              />
            ) :
            null}
          {isHtml(location.path) && shown.state === "text" ?
            (
              <Segments
                modes={HTML_MODES}
                current={htmlMode}
                label={(mode) => HTML_MODE_LABELS[mode]}
                onChange={setHtmlMode}
              />
            ) :
            null}
          {label === undefined ? null : <span className="sui-repo-stats">{label}</span>}
          {fileBadges === undefined || fileBadges === null ? null : <div className="sui-repo-file-badges">{fileBadges}</div>}
          {fileActions === undefined ? null : <div className="sui-repo-file-actions">{fileActions}</div>}
        </header>
        <FileBody
          path={location.path}
          file={shown}
          markdownMode={markdownMode}
          htmlMode={htmlMode}
          line={location.line}
          lineEnd={location.lineEnd}
          codeMode={codeMode}
          intelligence={code}
          markdownEditor={markdownEditor}
          markdownPreview={markdownPreview}
          onLink={linkFrom(tree.paths, location.path)}
        />
      </article>
    );
  })();

  return (
    <section
      data-slot="repo-view"
      data-size={size}
      data-tree={size === "full" && fileTree ? "true" : "false"}
      data-aside={size === "full" && aside !== undefined && aside !== null ? "true" : "false"}
      className={cn("sui-repo", className)}
      aria-label={name}
      {...props}
    >
      <div className="sui-repo-layout">
        {size === "full" && fileTree ?
          (
            // Its column holds its place while the files load, so the content never starts in it and then jumps.
            <aside className="sui-repo-side" aria-label="Files">
              {tree.state === "ready" ?
                (
                  <FileTree
                    nodes={ordered}
                    collapsed={collapsed}
                    onToggle={toggle}
                    selected={location.kind === "blob" ? location.path : null}
                    onSelect={(path) => go({ kind: "blob", path })}
                  />
                ) :
                null}
              {tree.state === "ready" && tree.truncated === true ?
                <div className="sui-repo-note">More files not shown</div> :
                null}
            </aside>
          ) :
          null}
        <div className="sui-repo-main">
          <header className="sui-repo-head">
            {revision === undefined ? null : <div className="sui-repo-revision">{revision}</div>}
            <Breadcrumbs
              className="sui-repo-trail"
              aria-label="File path"
              items={trail(name, location, href)}
              onNavigate={(item) => go({ kind: "tree", path: item.key })}
            />
            {actions === undefined ? null : <div className="sui-repo-actions">{actions}</div>}
          </header>
          {summary === undefined ? null : <div className="sui-repo-summary">{summary}</div>}
          <div className="sui-repo-content">{content}</div>
        </div>
        {size === "full" && aside !== undefined && aside !== null ? <div className="sui-repo-aside">{aside}</div> : null}
      </div>
    </section>
  );
}
