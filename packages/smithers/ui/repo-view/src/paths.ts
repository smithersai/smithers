import type { DirectoryEntry } from "@smthrs/ui";

/**
 * Pure helpers over a repository's flat file list: every file's full
 * `/`-delimited path at one revision, which is all a {@link RepoView} needs to
 * draw the tree, list a directory and resolve a README's relative links.
 */

const collator = new Intl.Collator("en");

/** Names sort case-insensitively, as GitHub lists them; the raw name breaks ties. */
export function compareNames(a: string, b: string): number {
  const lower = collator.compare(a.toLowerCase(), b.toLowerCase());
  return lower !== 0 ? lower : collator.compare(a, b);
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

/** A directory while the tree's order is built: its subdirectories and its files, each by name. */
type OrderNode = {
  readonly directories: Map<string, OrderNode>;
  readonly files: Array<{ readonly name: string; readonly path: string }>;
};

/**
 * Paths in the order the tree shows them: directories before files at every level. Each path is split once into a
 * directory trie, and each directory sorts its own names once, so a repository of 100,000 files orders in one pass
 * rather than re-splitting whole paths on every comparison.
 */
export function treeOrder(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const root: OrderNode = { directories: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.directories.get(part);
      if (next === undefined) {
        next = { directories: new Map(), files: [] };
        node.directories.set(part, next);
      }
      node = next;
    }
    node.files.push({ name: parts[parts.length - 1]!, path });
  }
  const ordered: Array<string> = [];
  const emit = (node: OrderNode): void => {
    for (const name of [...node.directories.keys()].sort(compareNames)) emit(node.directories.get(name)!);
    for (const file of node.files.sort((a, b) => compareNames(a.name, b.name))) ordered.push(file.path);
  };
  emit(root);
  return ordered;
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
 * when it starts with `/`. Links with a scheme, protocol-relative links,
 * bare `#anchor`s, paths that climb above the root and paths with an
 * undecodable segment resolve to nothing: the browser follows them itself.
 * Of the remaining paths, one naming a directory (one the files sit under,
 * one of `folders`, known without their files, or any path written with a
 * trailing `/`) opens the tree; any other opens as a file, so a missing file
 * shows "not found" in the view.
 */
export function resolveLink(
  from: string,
  href: string,
  paths: ReadonlyArray<string>,
  folders: ReadonlyArray<string> = [],
): LinkTarget | undefined {
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
  if (path === "" || bare.endsWith("/") || directoriesOf(paths, folders).has(path)) return { kind: "tree", path };
  return { kind: "blob", path };
}
