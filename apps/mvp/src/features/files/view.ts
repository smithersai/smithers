import { encodePath } from "../repo/paths"
import type { FileTabRow, Here } from "./schema"

// What the strip shows and where a tab links, from this device's rows and where the tab is: pure functions, so a
// component only renders their result and a TUI can show the same.

/** One tab of the strip, as `@smthrs/ui`'s `FileTabs` takes it: the file's path as its key. */
export interface StripTab {
  readonly key: string
  readonly label: string
  readonly title: string
  readonly href: string
  readonly active: boolean
}

/** A tab's key: one per repository, revision and file. */
export const tabKey = (here: Pick<Here, "owner" | "name" | "revision">, path: string): string =>
  `${here.owner}/${here.name}@${here.revision}:${path}`

/** The app's URL of `path` at `here`'s revision, with `lines` in `?L=`: the file's page. */
export const fileHref = (here: Pick<Here, "owner" | "name" | "revision">, path: string, lines: string | null): string =>
  `/${encodeURIComponent(here.owner)}/${encodeURIComponent(here.name)}/blob/${encodePath(here.revision)}/${
    encodePath(path)
  }${lines === null ? "" : `?L=${lines}`}`

/** The app's URL of `here`'s repository root at its revision. */
export const rootHref = (here: Pick<Here, "owner" | "name" | "revision">): string =>
  `/${encodeURIComponent(here.owner)}/${encodeURIComponent(here.name)}/tree/${encodePath(here.revision)}`

/** The tabs of `here`'s repository and revision, in the order they opened. */
export const tabsAt = (rows: ReadonlyArray<FileTabRow>, here: Pick<Here, "owner" | "name" | "revision">) =>
  rows
    .filter((row) => row.owner === here.owner && row.name === here.name && row.revision === here.revision)
    .sort((a, b) => a.position - b.position)

/** The strip at `here`: each tab linking to its file at its lines, the file on screen active. None without a place. */
export const stripOf = (rows: ReadonlyArray<FileTabRow>, here: Here | undefined): ReadonlyArray<StripTab> =>
  here === undefined ? [] : tabsAt(rows, here).map((row) => ({
    key: row.path,
    label: row.path.split("/").at(-1)!,
    title: row.path,
    href: fileHref(here, row.path, row.lines),
    active: here.kind === "blob" && here.path === row.path,
  }))

/** Lines as `?L=` writes them, from the repository view's anchor; `null` for none. */
export const linesOf = (line: number | null, lineEnd: number | null): string | null =>
  line === null ? null : lineEnd === null || lineEnd <= line ? `${line}` : `${line}-${lineEnd}`

/** `pathname` decoded; none when it doesn't decode. */
const decoded = (pathname: string): string | undefined => {
  try {
    return decodeURIComponent(pathname)
    // expected: a path that does not decode shows no file
  } catch {
    return undefined
  }
}

/**
 * Where a tab at `pathname` is, from the repository view's row: its repository at the revision it resolved, when the
 * path is that repository's root, directory or file page. The directory or file is the URL's when it names that
 * revision, since the URL changes at once and the view's row only once the page opened; else the row's. None anywhere
 * else, or before the revision resolves.
 */
export const hereOf = (
  pathname: string,
  view: {
    readonly owner: string
    readonly name: string
    readonly revision: string | null
    readonly kind: "tree" | "blob"
    readonly path: string
  },
): Here | undefined => {
  const at = decoded(pathname)
  if (at === undefined || view.revision === null || view.owner === "") return undefined
  const [owner, name, kind] = at.split("/").filter(Boolean)
  if (owner !== view.owner || name !== view.name) return undefined
  if (kind !== undefined && kind !== "tree" && kind !== "blob") return undefined
  const here = { owner: view.owner, name: view.name, revision: view.revision }
  const base = `/${view.owner}/${view.name}/${kind}/${view.revision}`
  if (kind !== undefined && (at === base || at.startsWith(`${base}/`))) {
    return { ...here, kind, path: at.slice(base.length).replace(/^\/+|\/+$/g, "") }
  }
  return { ...here, kind: view.kind, path: view.path }
}
