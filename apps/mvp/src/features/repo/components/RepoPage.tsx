import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  LoadingBar,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RefPicker,
  RelativeTime,
  Skeleton,
  Snippet,
} from "@smthrs/ui"
import { LiveMarkdownEditor, RepoView, type RepoViewLocation } from "@smthrs/repo-view"
import { Fragment, type ReactNode } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import {
  CLONING,
  cloneUrl,
  CODE,
  COPY_CLONE_URL,
  COPY_CONTENTS,
  COPY_PATH,
  COPY_PERMALINK,
  DOWNLOAD,
  NOT_FOUND,
  NOT_SYNCED,
  RAW,
  TRY_AGAIN,
} from "../contract"
import { hrefFor, parseLineHash, viewHrefFor } from "../paths"
import {
  aboutOf,
  atRoot,
  type Commit,
  countLabel,
  type Counts,
  countsOf,
  fileLinksOf,
  fileProps,
  headCommitOf,
  pageOf,
  missingFileOf,
  previewCommitOf,
  previewReadmeOf,
  previewTreeOf,
  refsProps,
  revisionLabel,
  treeProps,
} from "../view"
import { useBranch } from "../../branch/components/BranchContext"
import { codeIntelParts, useCodeIntelRow } from "../../code-intel/components/CodeIntelView"
import { markdownInPlace, saveLabelOf } from "../../coedit/view"
import { GeneratedFileChip, GeneratedFileWarning } from "./FileMarks"
import { RepoAside } from "./RepoAside"
import { useRepo } from "./RepoContext"

/** The commit row: its first line, its author, its short SHA, when, and how many commits there are. */
function CommitRow({ commit, commits }: { readonly commit: Commit | undefined; readonly commits: number | undefined }) {
  if (commit === undefined) return null
  return (
    <span className="repo-commit" aria-label="Head commit">
      <span>{commit.message}</span>
      <span>{commit.author}</span>
      <code>{commit.shortSha}</code>
      <RelativeTime ts={commit.at} />
      {commits === undefined ? null : <span className="repo-commit-count">{countLabel(commits, "Commit", "Commits")}</span>}
    </span>
  )
}

/** Beside the picker: how many branches and tags there are, as GitHub's repository page says. */
function RefCounts({ counts, owner, name }: { readonly counts: Counts; readonly owner: string; readonly name: string }) {
  if (counts.branches === undefined && counts.tags === undefined) return null
  return (
    <span className="repo-counts">
      {counts.branches === undefined ? null : <Link to="/$owner/$repo/branches" params={{ owner, repo: name }}>{countLabel(counts.branches, "Branch", "Branches")}</Link>}
      {counts.tags === undefined ? null : <span>{countLabel(counts.tags, "Tag", "Tags")}</span>}
    </span>
  )
}

/** Code: the menu with the URL `git clone` takes, whose Copy runs `repo/copy`. */
function CodeMenu({ owner, name, onCopy }: {
  readonly owner: string
  readonly name: string
  readonly onCopy: () => Promise<void>
}): ReactNode {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">{CODE}</Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <Snippet code={cloneUrl(owner, name)} copyLabel={COPY_CLONE_URL} onCopyCode={onCopy} />
      </PopoverContent>
    </Popover>
  )
}

// The repository at the routed location, once it is ready: the branch and tag picker, the file tree, the directory
// with its README or the file, the head commit, Code (the clone URL), Copy permalink, and a file's Raw, Download, Copy
// path and Copy. The top level is laid out as GitHub's repository page: no tree, the about panel on the right, the
// branch and tag counts. Until the clone is ready, the top level shows what GitHub says (its folder, README and about)
// and anything deeper `Not cloned` or `Cloning`, or a skeleton while the device can't tell yet, never a blank page
// (`pageOf`). A clone is ready once its synced row says so, or once the view's load found it ready through RepoApi
// before Electric delivered that row (`shownOf`). Every link is a real link to the app's GitHub-shaped URL; a plain
// click navigates through the router, and a ref chosen in the picker runs `app/navigate`. Each Copy runs `repo/copy`.
// With `editFiles`, in a branch's workspace for someone who may edit it, a file opens in the live editor of the
// branch's working copy instead (docs/features/coedit.md#files), except a Markdown file: with `liveMarkdown`, the
// branch's conversation for someone who may write the branch, its own page edits it in place, a WYSIWYG document in the
// live editor with Save in its toolbar, once its text loaded. Anyone else, and that person while the text loads or if
// it fails, reads the document read-only (docs/features/repo.md#the-browser).
export function RepoPage({ editFiles = false, liveMarkdown }: {
  readonly editFiles?: boolean
  readonly liveMarkdown?: { readonly conversationId: string } | undefined
} = {}) {
  const { queries, actions } = useRepo()
  const { coedit } = useBranch()
  const { data: texts } = useLiveQuery(coedit.queries.texts)
  const { data: current } = useLiveQuery(queries.view)
  const { data: refs } = useLiveQuery(queries.refs)
  const { data: tree } = useLiveQuery(queries.tree)
  const { data: file } = useLiveQuery(queries.file)
  const { data: readme } = useLiveQuery(queries.readme)
  const { data: aboutRow } = useLiveQuery(queries.about)
  const codeIntel = useCodeIntelRow()
  const navigate = useNavigate()
  const anchor = parseLineHash(useLocation().hash)
  const page = pageOf(current)
  // The live query's first read, or a repository the device can't tell about yet: a skeleton in the files' place.
  if (current === undefined || page.kind === "loading") return <Skeleton className="repo-page-loading" />
  const { view, repository } = current
  const about = aboutOf(aboutRow?.about)
  const root = atRoot(view)
  if (((repository?.status === "ready" || view.refsKey !== null) && view.missing) || tree?.tree?.message === NOT_SYNCED || file?.file?.message === NOT_SYNCED) {
    return <EmptyState title={NOT_SYNCED} action={
      <Button variant="outline" onClick={() => {
        actions.refresh({ owner: view.owner, name: view.name, kind: view.kind, ref: view.ref, path: view.splat, line: view.line, lineEnd: view.lineEnd })
      }}>Refresh</Button>
    } />
  }
  if (page.kind === "missing") return <EmptyState title={NOT_FOUND} />
  if (page.kind === "failure") return <EmptyState title={page.text} />
  if (page.kind === "retry") return (
    <Card className="repo-page-empty">
      <EmptyState
        title={page.text}
        action={<Button variant="outline" onClick={() => actions.retryAbout(view.owner, view.name)}>{TRY_AGAIN}</Button>}
      />
    </Card>
  )
  if (page.kind === "preview-loading") {
    // GitHub's answer on its way: the page's own layout, with skeletons in its places, so it fills in without a jump.
    return (
      <RepoView
        className="repo-page"
        name={view.name}
        tree={{ state: "loading" }}
        location={{ kind: "tree", path: "" }}
        href={() => `/${encodeURIComponent(view.owner)}/${encodeURIComponent(view.name)}`}
        onNavigate={() => undefined}
        fileTree={false}
        aside={<RepoAside about={aboutRow?.about} repository={repository} />}
      />
    )
  }
  if (page.kind === "preview") {
    // Before the clone is ready, the top level as GitHub has it: the folder, the README and the about panel, with
    // the header's Clone. Every link is the app's own, as it will be once the repository is cloned.
    const preview = page.about
    const location = { kind: "tree" as const, path: "" }
    const at = (target: RepoViewLocation) =>
      hrefFor({ owner: view.owner, name: view.name, defaultBranch: preview.defaultBranch }, preview.defaultBranch, target)
    return (
      <RepoView
        className="repo-page"
        name={view.name}
        tree={previewTreeOf(preview)!}
        location={location}
        readme={previewReadmeOf(preview)}
        href={at}
        onNavigate={(target) => void navigate({ href: at(target) })}
        fileTree={false}
        aside={<RepoAside about={aboutRow?.about} repository={repository} />}
        revision={
          <span className="repo-revision">
            <Badge variant="outline">{preview.defaultBranch}</Badge>
            <RefCounts counts={countsOf(undefined, preview)} owner={view.owner} name={view.name} />
          </span>
        }
        actions={<CodeMenu owner={view.owner} name={view.name} onCopy={() => actions.copy("clone-url")} />}
        summary={<CommitRow commit={previewCommitOf(preview)} commits={preview.commits ?? undefined} />}
      />
    )
  }
  if (page.kind === "empty") {
    // In place of the files, until they are ready: what the header's Clone or reason is about, with a calm bar while
    // it clones.
    return (
      <Card className="repo-page-empty">
        {page.text === CLONING ? <LoadingBar loading placement="inline" /> : null}
        <EmptyState title={page.text} />
      </Card>
    )
  }
  if (missingFileOf(view.kind, file?.file)) return (
    <EmptyState title={`File not found at ${view.revision ?? view.ref ?? "this revision"}`} action={
      <Button asChild variant="outline">
        <a href={hrefFor(page.repository, view.revision ?? page.repository.defaultBranch ?? "", { kind: "tree", path: "" })}>Code</a>
      </Button>
    } />
  )
  const shown = page.repository
  const revision = view.revision ?? shown.defaultBranch ?? ""
  const href = (location: RepoViewLocation) => viewHrefFor(shown, revision, location, editFiles)
  // The Markdown file this page edits in place, for someone who may write the branch, once its text loaded.
  const editing = markdownInPlace(texts, liveMarkdown?.conversationId, view.kind, view.path)
  const at = (ref: string) => hrefFor(shown, ref, { kind: view.kind, path: view.path })
  const commit = headCommitOf(repository, view.sha, about)
  const links = fileLinksOf(view, file?.file)
  const counts = countsOf(refs?.refs, about)
  // A TypeScript or JavaScript file's language server: its marks, hover card and keys, the Symbols pane, its toolbar.
  const intel = codeIntelParts(
    codeIntel,
    view.kind === "blob" ? view.path : undefined,
    href,
    (location) => void navigate({ href: href(location) }),
  )
  return (
    <RepoView
      className="repo-page"
      name={shown.name}
      tree={treeProps(tree?.tree)}
      location={{
        kind: view.kind,
        path: view.path,
        line: anchor.line ?? view.line ?? undefined,
        lineEnd: anchor.line === null ? view.lineEnd ?? undefined : anchor.lineEnd ?? undefined,
      }}
      file={view.kind === "blob" ? fileProps(file?.file) : undefined}
      readme={view.kind === "tree" && view.readmePath !== null
        ? { path: view.readmePath, file: fileProps(readme?.readme) }
        : undefined}
      href={href}
      onNavigate={(location) => void navigate({ href: href(location) })}
      // The top level, as GitHub's repository page: no tree beside the listing, the about panel on the right.
      fileTree={!root}
      aside={root ? <RepoAside about={aboutRow?.about} repository={repository} /> : intel.aside}
      code={intel.code}
      revision={
        <span className="repo-revision">
          <RefPicker
            current={revisionLabel(revision)}
            selected={revision}
            refs={refsProps(refs?.refs)}
            defaultBranch={shown.defaultBranch ?? undefined}
            href={at}
            onSelect={(ref) => actions.navigate(at(ref))}
          />
          {root ? <RefCounts counts={counts} owner={view.owner} name={view.name} /> : null}
        </span>
      }
      actions={
        <>
          <CodeMenu owner={view.owner} name={view.name} onCopy={() => actions.copy("clone-url")} />
          <CopyButton variant="outline" size="sm" onCopy={() => actions.copy("permalink")}>{COPY_PERMALINK}</CopyButton>
        </>
      }
      markdownPreview={editing === undefined ? undefined : (
        <Fragment key={editing.id}>
          <GeneratedFileWarning path={view.path} contents={editing.text} />
          <LiveMarkdownEditor
            value={editing.text}
            aria-label={view.path}
            onChange={(markdown, { base }) => coedit.actions.type(editing.id, markdown, { base })}
          />
        </Fragment>
      )}
      fileBadges={view.kind === "blob"
        ? <GeneratedFileChip path={view.path} contents={file?.file?.state === "text" ? file.file.contents ?? undefined : undefined} />
        : undefined}
      fileActions={
        <>
          {editing === undefined ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={editing.saving || editing.saved}
              onClick={() => void coedit.actions.save(editing.id)}
            >
              {saveLabelOf(editing)}
            </Button>
          )}
          {intel.toolbar}
          {links.raw === undefined ? null : (
            <Button asChild variant="ghost" size="sm">
              <a href={links.raw} target="_blank" rel="noopener noreferrer">{RAW}</a>
            </Button>
          )}
          {links.download === undefined ? null : (
            <Button asChild variant="ghost" size="sm">
              <a href={links.download.href} download={links.download.name}>{DOWNLOAD}</a>
            </Button>
          )}
          <CopyButton variant="ghost" size="sm" onCopy={() => actions.copy("path")}>{COPY_PATH}</CopyButton>
          {links.copyContents
            ? <CopyButton variant="ghost" size="sm" onCopy={() => actions.copy("contents")}>{COPY_CONTENTS}</CopyButton>
            : null}
        </>
      }
      summary={commit === undefined
        ? undefined
        : <CommitRow commit={commit} commits={root && view.sha === about?.head?.sha ? about?.commits ?? undefined : undefined} />}
    />
  )
}
