/** @jsxImportSource react */
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { cn } from "@smthrs/ui-css";
import { isPlainNavigationClick } from "./internal/navigationClick";
import { useInjectUiCss } from "./styles";

/** What a {@link DirectoryListing} row names: a file or a directory, by its full `/`-delimited path. */
export type DirectoryEntry = {
  /** The entry's name within its directory. */
  name: string;
  /** Full path from the root; the identity a host navigates by. */
  path: string;
  kind: "file" | "directory";
};

/** Where a row leads: an entry, or the parent directory (`..`). */
export type DirectoryTarget = { readonly path: string; readonly kind: "file" | "directory" };

export type DirectoryListingProps = Omit<ComponentProps<"div">, "children"> & {
  /** The directory's entries, in the order to show them. */
  entries: ReadonlyArray<DirectoryEntry>;
  /** The parent directory's path; given, a `..` row leads to it. `""` is the root. */
  parent?: string | undefined;
  /** The URL each row links to, so every row is a real link. */
  href: (target: DirectoryTarget) => string;
  /**
   * In-app navigation for a plain click on a row. The browser's default is
   * prevented first; a modified click keeps the browser's behavior.
   */
  onOpen?: (target: DirectoryTarget) => void;
  /** Accessible name of the list. Defaults to "Files". */
  label?: string;
  /** Shown instead of rows when there are no entries and no `..` row. */
  empty?: ReactNode;
};

const FolderIcon = () => (
  <svg className="sui-dir-icon" data-kind="directory" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.75 3.5h4l1.5 1.5h7v7.75H1.75z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
  </svg>
);

const FileIcon = () => (
  <svg className="sui-dir-icon" data-kind="file" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.25 1.75h6l3.5 3.5v9H3.25z M9.25 1.75v3.5h3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
  </svg>
);

/**
 * One directory's contents as a list of links, folders and files each with
 * their icon, headed by a `..` row when the directory has a parent. Each row
 * is a real `<a href>`, so a row opens in a new tab like any link.
 */
export function DirectoryListing(
  { entries, parent, href, onOpen, label, empty, className, ...props }: DirectoryListingProps,
) {
  useInjectUiCss();
  const open = (target: DirectoryTarget) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (onOpen === undefined || !isPlainNavigationClick(event)) return;
    event.preventDefault();
    onOpen(target);
  };
  if (entries.length === 0 && parent === undefined && empty !== undefined) {
    return <div data-slot="directory-listing" className={cn("sui-dir", "sui-dir-empty", className)} {...props}>{empty}</div>;
  }
  const up: DirectoryTarget | undefined = parent === undefined ? undefined : { path: parent, kind: "directory" };
  return (
    <div data-slot="directory-listing" className={cn("sui-dir", className)} {...props}>
      <ul className="sui-dir-list" aria-label={label ?? "Files"}>
        {up === undefined ? null : (
          <li className="sui-dir-row">
            <a className="sui-dir-link" href={href(up)} onClick={open(up)} aria-label="Parent directory">..</a>
          </li>
        )}
        {entries.map((entry) => {
          const target: DirectoryTarget = { path: entry.path, kind: entry.kind };
          return (
            <li key={entry.path} className="sui-dir-row" data-kind={entry.kind}>
              <a className="sui-dir-link" href={href(target)} onClick={open(target)}>
                {entry.kind === "directory" ? <FolderIcon /> : <FileIcon />}
                <span className="sui-dir-name">{entry.name}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
