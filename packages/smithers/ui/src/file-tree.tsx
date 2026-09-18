/** @jsxImportSource react */
import { type ComponentProps, type ReactNode, useState } from "react";
import { cn } from "./cn";
import type { DataAttributes } from "./data-attributes";
import { useInjectUiCss } from "./styles";

/** One entry in the flat list a {@link FileTree} groups into a nested tree. */
export type FileTreeNode = {
  /** Full `/`-delimited path; determines nesting and identity. */
  path: string;
  /** Leaf label; defaults to the last path segment. */
  label?: ReactNode;
};

/** A node accepted by {@link FileTree}: a full `FileTreeNode` or a bare path string. */
export type FileTreeItem = FileTreeNode | string;

export type { DataAttributes };
/** Pass-through attributes for a leaf row button; the structural attributes stay the component's. */
export type FileTreeNodeProps = Omit<ComponentProps<"button">, "type" | "data-slot"> & DataAttributes;
/** Pass-through attributes for a directory toggle; its type, slot, and expanded state stay the component's. */
export type FileTreeDirectoryProps = Omit<ComponentProps<"button">, "type" | "data-slot" | "aria-expanded"> & DataAttributes;

export type FileTreeProps = Omit<ComponentProps<"div">, "onSelect" | "onToggle"> & {
  /** Flat list of paths (or nodes) grouped into a nested tree by `/`. */
  nodes: ReadonlyArray<FileTreeItem>;
  /**
   * Directory paths to render even when no node sits under them (a directory
   * whose children the host has not loaded yet). Each renders with its caret;
   * expanded with nothing under it, it renders one `renderDirectoryEmpty` row.
   */
  directories?: ReadonlyArray<string>;
  /** Controlled selected path; the matching leaf gets the active treatment. */
  selected?: string | null;
  /** Fired with the node path when a leaf is activated. */
  onSelect?: (path: string) => void;
  /**
   * Controlled collapse state: the set of collapsed directory paths. When
   * passed, the component never owns collapse state — a toggle only reports
   * through `onToggle`, and the host decides what the next render shows.
   */
  collapsed?: ReadonlySet<string>;
  /** Fired when a directory toggle is pressed, with the state the press asks for (`true` = expand). */
  onToggle?: (path: string, expanded: boolean) => void;
  /**
   * The one row an expanded directory with no loaded children shows (the
   * host's `loading…`, `empty`, or its error text). Called with `""` for an
   * empty root. Absent: nothing renders under such a directory.
   */
  renderDirectoryEmpty?: (path: string) => ReactNode;
  /** A trailing row after a directory's children (a truncation note); `null` renders nothing. */
  renderDirectoryFooter?: (path: string) => ReactNode;
  /** Optional trailing affordance rendered beside each leaf (dirty dot, menu, badge). */
  renderAffordance?: (node: FileTreeNode) => ReactNode;
  /*
   * Pass-through attributes for the leaf row buttons this component renders on
   * the host's behalf.
   *
   * A host whose affordances must name the act behind them — a `data-flow`
   * binding, an analytics id, a test hook — otherwise has to reach into this
   * component's rendered DOM from outside, which is the exact coupling a
   * pass-through prop exists to prevent.
   */
  nodeProps?: (node: FileTreeNode) => FileTreeNodeProps;
  /** The same pass-through for the directory toggles, keyed by directory path. */
  directoryProps?: (path: string) => FileTreeDirectoryProps;
  /** Start with every directory collapsed (default: expanded). Ignored under `collapsed`. */
  defaultCollapsed?: boolean;
};

type TreeDir = { name: string; path: string; dirs: TreeDir[]; files: FileTreeNode[]; };

function toNode(item: FileTreeItem): FileTreeNode {
  return typeof item === "string" ? { path: item } : item;
}

/** The directory at `parts` under `root`, created along the way in first-seen order. */
function ensureDir(root: TreeDir, parts: ReadonlyArray<string>): TreeDir {
  let dir = root;
  for (const name of parts) {
    let next = dir.dirs.find((child) => child.name === name);
    if (!next) {
      next = { name, path: dir.path ? `${dir.path}/${name}` : name, dirs: [], files: [] };
      dir.dirs.push(next);
    }
    dir = next;
  }
  return dir;
}

/**
 * Group flat `/`-delimited paths into a nested directory tree. Explicit
 * directories come first so their order (the host's listing order) is the
 * order they render in; a node's ancestors are created as they are met.
 */
function buildTree(nodes: ReadonlyArray<FileTreeNode>, directories: ReadonlyArray<string>): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: [], files: [] };
  for (const directory of directories) {
    const parts = directory.split("/").filter(Boolean);
    if (parts.length > 0) ensureDir(root, parts);
  }
  for (const node of nodes) {
    const parts = node.path.split("/").filter(Boolean);
    ensureDir(root, parts.slice(0, -1)).files.push(node);
  }
  return root;
}

/** Every directory path in the tree, for seeding the default-collapsed state. */
function directoryPaths(dir: TreeDir, out: string[] = []): string[] {
  for (const child of dir.dirs) {
    out.push(child.path);
    directoryPaths(child, out);
  }
  return out;
}

function leafLabel(node: FileTreeNode): ReactNode {
  if (node.label !== undefined) return node.label;
  return node.path.split("/").filter(Boolean).at(-1) ?? node.path;
}

type LevelProps = {
  dir: TreeDir;
  selected: string | null | undefined;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect?: (path: string) => void;
  renderDirectoryEmpty?: (path: string) => ReactNode;
  renderDirectoryFooter?: (path: string) => ReactNode;
  renderAffordance?: (node: FileTreeNode) => ReactNode;
  nodeProps?: (node: FileTreeNode) => FileTreeNodeProps;
  directoryProps?: (path: string) => FileTreeDirectoryProps;
};

/** An expanded directory's contents: its levels, or the host's one empty row, then the footer. */
function DirectoryContents(props: LevelProps) {
  const { dir, renderDirectoryEmpty, renderDirectoryFooter } = props;
  const empty = dir.dirs.length === 0 && dir.files.length === 0;
  const emptyRow = empty ? renderDirectoryEmpty?.(dir.path) : undefined;
  const footer = renderDirectoryFooter?.(dir.path);
  return (
    <>
      {empty ?
        (emptyRow == null || emptyRow === false ? null : (
          <div className="sui-file-tree-row sui-file-tree-note" data-slot="file-tree-empty">{emptyRow}</div>
        )) :
        <FileTreeLevel {...props} />}
      {footer == null || footer === false ? null : (
        <div className="sui-file-tree-row sui-file-tree-note" data-slot="file-tree-footer">{footer}</div>
      )}
    </>
  );
}

function FileTreeLevel(props: LevelProps) {
  const { dir, selected, collapsed, onToggle, onSelect, renderAffordance, nodeProps, directoryProps } = props;
  return (
    <>
      {dir.dirs.map((child) => {
        const isCollapsed = collapsed.has(child.path);
        const { onClick: onDirClick, className: dirClassName, ...dirButtonProps } = directoryProps?.(child.path) ?? {};
        return (
          <div className="sui-file-tree-dir" data-slot="file-tree-dir" key={`dir:${child.path}`}>
            <button
              {...dirButtonProps}
              type="button"
              className={cn("sui-file-tree-dir-toggle", dirClassName)}
              data-slot="file-tree-dir-toggle"
              aria-expanded={!isCollapsed}
              onClick={(event) => {
                onDirClick?.(event);
                if (!event.defaultPrevented) onToggle(child.path);
              }}
            >
              <span className="sui-file-tree-caret" aria-hidden="true" />
              <span className="sui-file-tree-dir-name">{child.name}</span>
            </button>
            {isCollapsed ? null : (
              <div className="sui-file-tree-children">
                <DirectoryContents {...props} dir={child} />
              </div>
            )}
          </div>
        );
      })}
      {dir.files.map((node) => {
        const active = node.path === selected;
        const affordance = renderAffordance?.(node);
        const { onClick: onNodeClick, className: nodeClassName, ...nodeButtonProps } = nodeProps?.(node) ?? {};
        return (
          <div className="sui-file-tree-row" data-slot="file-tree-row" key={`file:${node.path}`}>
            <button
              title={node.path}
              {...nodeButtonProps}
              type="button"
              className={cn("sui-file-tree-file", nodeClassName)}
              data-slot="file-tree-file"
              data-active={active ? "true" : undefined}
              onClick={(event) => {
                onNodeClick?.(event);
                if (!event.defaultPrevented) onSelect?.(node.path);
              }}
            >
              <span className="sui-file-tree-file-name">{leafLabel(node)}</span>
            </button>
            {affordance != null && affordance !== false ?
              (
                <span className="sui-file-tree-affordance" data-slot="file-tree-affordance">
                  {affordance}
                </span>
              ) :
              null}
          </div>
        );
      })}
    </>
  );
}

const NO_DIRECTORIES: ReadonlyArray<string> = [];

/**
 * Generic collapsible file/path tree. Groups a flat list of `/`-delimited paths
 * into nested directories with expand/collapse (owned here, or controlled
 * through `collapsed` + `onToggle`), controlled single selection (`selected` +
 * `onSelect`), lazily loaded directories (`directories` +
 * `renderDirectoryEmpty`), and an optional per-leaf trailing affordance slot.
 * Zero app/store/router coupling — every behavior is driven by props.
 */
export function FileTree({
  nodes,
  directories = NO_DIRECTORIES,
  selected,
  onSelect,
  collapsed: controlledCollapsed,
  onToggle: onToggleProp,
  renderDirectoryEmpty,
  renderDirectoryFooter,
  renderAffordance,
  nodeProps,
  directoryProps,
  defaultCollapsed = false,
  className,
  ...props
}: FileTreeProps) {
  useInjectUiCss();
  const resolved = nodes.map(toNode);
  const root = buildTree(resolved, directories);
  const [ownCollapsed, setOwnCollapsed] = useState<Set<string>>(() =>
    defaultCollapsed ? new Set(directoryPaths(root)) : new Set()
  );
  const collapsed = controlledCollapsed ?? ownCollapsed;
  const onToggle = (path: string) => {
    const expanded = collapsed.has(path);
    if (controlledCollapsed === undefined) {
      setOwnCollapsed((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    }
    onToggleProp?.(path, expanded);
  };
  return (
    <div data-slot="file-tree" className={cn("sui-file-tree", className)} {...props}>
      <DirectoryContents
        dir={root}
        selected={selected}
        collapsed={collapsed}
        onToggle={onToggle}
        onSelect={onSelect}
        renderDirectoryEmpty={renderDirectoryEmpty}
        renderDirectoryFooter={renderDirectoryFooter}
        renderAffordance={renderAffordance}
        nodeProps={nodeProps}
        directoryProps={directoryProps}
      />
    </div>
  );
}
