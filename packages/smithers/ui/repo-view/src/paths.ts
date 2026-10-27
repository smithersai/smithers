import type { DirectoryEntry } from "@smthrs/ui";

/**
 * Pure helpers over a repository's flat file list: every file's full
 * `/`-delimited path at one revision, which is all a {@link RepoView} needs to
 * draw the tree, list a directory and resolve a README's relative links.
 */

/** Names sort case-insensitively, as GitHub lists them; the raw name breaks ties. */
export function compareNames(a: string, b: string): number {
  const lower = a.toLowerCase().localeCompare(b.toLowerCase(), "en");
  return lower !== 0 ? lower : a.localeCompare(b, "en");
}

/** The directory holding `path`; `""` is the root. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Every directory above `path`, outermost first: `a/b/c.ts` gives `a`, `a/b`. */
export function ancestorsOf(path: string): ReadonlyArray<string> {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Every directory the files sit under, and every one `folders` names whose files aren't listed. */
export function directoriesOf(paths: ReadonlyArray<string>, folders: ReadonlyArray<string> = []): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const path of paths) for (const directory of ancestorsOf(path)) directories.add(directory);
  for (const folder of folders) {
    for (const directory of [...ancestorsOf(folder), folder]) if (directory !== "") directories.add(directory);
  }
  return directories;
}

/**
 * A directory's own entries, directories first, each group by {@link compareNames}. `folders` are directories known
 * without their files, such as a repository's top level as GitHub lists it before a clone.
 */
export function directoryEntries(
  paths: ReadonlyArray<string>,
  directory: string,
  folders: ReadonlyArray<string> = [],
): ReadonlyArray<DirectoryEntry> {
  const prefix = directory === "" ? "" : `${directory}/`;
  const entries = new Map<string, DirectoryEntry>();
  for (const path of [...paths, ...folders.filter((folder) => folder !== "").map((folder) => `${folder}/`)]) {
    if (!path.startsWith(prefix) || path.length === prefix.length) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (!entries.has(name)) entries.set(name, { name, path: `${prefix}${name}`, kind: slash < 0 ? "file" : "directory" });
  }
  return [...entries.values()].sort((a, b) =>
    a.kind === b.kind ? compareNames(a.name, b.name) : a.kind === "directory" ? -1 : 1
  );
}

/** Paths in the order the tree shows them: directories before files at every level. */
export function treeOrder(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...paths].sort((a, b) => {
    const left = a.split("/");
    const right = b.split("/");
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const leftIsDirectory = index < left.length - 1;
      const rightIsDirectory = index < right.length - 1;
      if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
      const order = compareNames(left[index]!, right[index]!);
      if (order !== 0) return order;
    }
    // Git never holds a path that is both a file and a directory, so only a duplicate gets here.
    return 0;
  });
}

/** Whether a file name is an HTML page, which the view can show live beside its source. */
export function isHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}

/** Whether a file name is Markdown, which the view renders as a document. */
export function isMarkdown(path: string): boolean {
  return /\.(?:md|mdx|markdown)$/i.test(path);
}

/** A file's line count as an editor numbers them: a final newline ends the last line, it doesn't start one. */
export function lineCount(contents: string): number {
  if (contents === "") return 0;
  const lines = contents.split("\n").length;
  return contents.endsWith("\n") ? lines - 1 : lines;
}

/** Bytes as a short label: `587 B`, `1.2 KB`, `3.4 MB` (1 KB = 1,024 B). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where a relative link in a document leads within the repository. */
export type LinkTarget = { readonly kind: "tree" | "blob"; readonly path: string };

const decode = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    return undefined;
  }
};

/**
 * Resolves a link written in the document at `from` against the repository,
 * the way GitHub does: relative to the document's directory, or to the root
 * when it starts with `/`. A link with a scheme, a protocol-relative link, a
 * bare `#anchor` and a link that climbs above the root resolve to nothing:
 * the browser follows those itself. A path naming a directory opens the tree;
 * any other path opens as a file, so a broken link shows "not found" in the
 * view rather than the browser resolving it against the app's own URL.
 */
export function resolveLink(from: string, href: string, paths: ReadonlyArray<string>): LinkTarget | undefined {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("//")) return undefined;
  const bare = href.replace(/[?#].*$/s, "");
  if (bare === "") return undefined;
  const base = bare.startsWith("/") ? [] : parentOf(from).split("/").filter(Boolean);
  const resolved = [...base];
  for (const raw of bare.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      if (resolved.length === 0) return undefined;
      resolved.pop();
      continue;
    }
    const segment = decode(raw);
    if (segment === undefined) return undefined;
    resolved.push(segment);
  }
  const path = resolved.join("/");
  if (path === "" || paths.some((file) => file.startsWith(`${path}/`))) return { kind: "tree", path };
  return { kind: "blob", path };
}
