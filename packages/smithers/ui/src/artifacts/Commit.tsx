/** @jsxImportSource react */
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type CommitFileStatusKind = "added" | "modified" | "deleted" | "renamed" | "copied";

export type CommitFileModel = {
  path: string;
  status: CommitFileStatusKind;
  additions?: number;
  deletions?: number;
  oldPath?: string;
};

export type CommitModel = {
  hash: string;
  /** jj change id; when present it is the preferred display identifier. */
  changeId?: string;
  message: string;
  author?: string;
  timestampMs?: number;
  files?: readonly CommitFileModel[];
};

const CommitContext = createContext<CommitModel | null>(null);

export type CommitProps = Omit<ComponentProps<"div">, "children"> & {
  commit?: CommitModel;
  children?: ReactNode;
};

/**
 * Commit / working-copy change card. Model-driven via `commit` or compound
 * via children; git hashes and jj change ids are both first-class.
 */
export function Commit({ commit, children, className, ...props }: CommitProps) {
  useInjectUiCss();
  const body = children ?? (commit ? (
    <>
      <CommitHeader>
        {commit.author !== undefined ? <CommitAuthor>{commit.author}</CommitAuthor> : null}
        <CommitInfo>
          <CommitHash hash={commit.hash} changeId={commit.changeId} />
          {commit.timestampMs !== undefined ? <CommitTimestamp timestampMs={commit.timestampMs} /> : null}
        </CommitInfo>
      </CommitHeader>
      <CommitMessage>{commit.message}</CommitMessage>
      {commit.files !== undefined && commit.files.length > 0 ? (
        <CommitFiles>
          {commit.files.map((file) => (
            <CommitFile key={`${file.oldPath ?? ""}:${file.path}`} file={file} />
          ))}
        </CommitFiles>
      ) : null}
    </>
  ) : null);
  return (
    <CommitContext.Provider value={commit ?? null}>
      <div
        data-slot="commit"
        data-vcs={commit?.changeId !== undefined ? "jj" : "git"}
        className={cn("sui-commit", className)}
        {...props}
      >
        {body}
      </div>
    </CommitContext.Provider>
  );
}

export function CommitHeader({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="commit-header" className={cn("sui-commit-header", className)} {...props} />;
}

export function CommitAuthor({ className, ...props }: ComponentProps<"span">) {
  useInjectUiCss();
  return <span data-slot="commit-author" className={cn("sui-commit-author", className)} {...props} />;
}

export function CommitInfo({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="commit-info" className={cn("sui-commit-info", className)} {...props} />;
}

export function CommitMessage({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="commit-message" className={cn("sui-commit-message", className)} {...props} />;
}

export function CommitMetadata({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="commit-metadata" className={cn("sui-commit-metadata", className)} {...props} />;
}

export type CommitHashProps = Omit<ComponentProps<"span">, "children"> & {
  hash: string;
  changeId?: string;
  /** Shorten to 7 characters (default true). */
  short?: boolean;
};

/** Identifier chip; prefers the jj change id when one is set. */
export function CommitHash({ hash, changeId, short = true, className, ...props }: CommitHashProps) {
  useInjectUiCss();
  const full = changeId ?? hash;
  const shown = short ? full.slice(0, 7) : full;
  return (
    <span
      data-slot="commit-hash"
      data-vcs={changeId !== undefined ? "jj" : "git"}
      title={full}
      className={cn("sui-commit-hash", className)}
      {...props}
    >
      <code>{shown}</code>
    </span>
  );
}

export type CommitTimestampProps = Omit<ComponentProps<"span">, "children"> & { timestampMs: number };

export function CommitTimestamp({ timestampMs, className, ...props }: CommitTimestampProps) {
  useInjectUiCss();
  const date = new Date(timestampMs);
  return (
    <span data-slot="commit-timestamp" className={cn("sui-commit-timestamp", className)} {...props}>
      <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>
    </span>
  );
}

export function CommitActions({ className, "aria-label": ariaLabel, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return (
    <div
      data-slot="commit-actions"
      role="toolbar"
      aria-label={ariaLabel ?? "Commit actions"}
      className={cn("sui-commit-actions", className)}
      {...props}
    />
  );
}

export function CommitFiles({ className, ...props }: ComponentProps<"ul">) {
  useInjectUiCss();
  return <ul data-slot="commit-files" className={cn("sui-commit-files", className)} {...props} />;
}

export type CommitFileProps = Omit<ComponentProps<"li">, "children"> & { file: CommitFileModel };

export function CommitFile({ file, className, ...props }: CommitFileProps) {
  useInjectUiCss();
  return (
    <li data-slot="commit-file" data-status={file.status} className={cn("sui-commit-file", className)} {...props}>
      <CommitFileStatus status={file.status} />
      <CommitFilePath path={file.path} oldPath={file.oldPath} />
      {file.additions !== undefined || file.deletions !== undefined ? (
        <span className="sui-commit-file-counts">
          {file.additions !== undefined ? <span className="sui-commit-add">+{file.additions}</span> : null}
          {file.additions !== undefined && file.deletions !== undefined ? " " : null}
          {file.deletions !== undefined ? <span className="sui-commit-del">−{file.deletions}</span> : null}
        </span>
      ) : null}
    </li>
  );
}

const FILE_STATUS_GLYPH: Record<CommitFileStatusKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

const FILE_STATUS_TONE: Record<CommitFileStatusKind, string> = {
  added: "ok",
  modified: "warn",
  deleted: "bad",
  renamed: "run",
  copied: "ok",
};

export type CommitFileStatusProps = Omit<ComponentProps<"span">, "children"> & { status: CommitFileStatusKind };

/** A/M/D/R/C glyph with screen-reader text for the changed-file status. */
export function CommitFileStatus({ status, className, ...props }: CommitFileStatusProps) {
  useInjectUiCss();
  return (
    <span
      data-slot="commit-file-status"
      data-status={status}
      data-tone={FILE_STATUS_TONE[status]}
      className={cn("sui-commit-file-status", className)}
      {...props}
    >
      <span aria-hidden="true">{FILE_STATUS_GLYPH[status]}</span>
      <span className="sui-sr-only">{status}</span>
    </span>
  );
}

export type CommitFilePathProps = Omit<ComponentProps<"span">, "children"> & {
  path: string;
  oldPath?: string;
};

/** File path; renames render `oldPath → path`. */
export function CommitFilePath({ path, oldPath, className, ...props }: CommitFilePathProps) {
  useInjectUiCss();
  return (
    <span data-slot="commit-file-path" className={cn("sui-commit-file-path", className)} {...props}>
      {oldPath !== undefined && oldPath !== path ? (
        <>
          {oldPath} <span aria-hidden="true">→</span> {path}
        </>
      ) : (
        path
      )}
    </span>
  );
}

/** Read the model from a surrounding <Commit commit={...}/> (for custom parts). */
export function useCommitModel(): CommitModel | null {
  return useContext(CommitContext);
}
