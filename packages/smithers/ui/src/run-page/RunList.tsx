/** @jsxImportSource react */
import { Fragment, type ComponentProps, type ReactNode } from "react";
import { Badge } from "../badge";
import { cn } from "../cn";
import { EmptyState } from "../empty-state";
import { safeHref } from "../internal/safeHref";
import { useInjectUiCss } from "../styles";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../table";
import { formatRelativeTime } from "../time/formatRelativeTime";
import { clockDuration, type RunState } from "./runPage";
import { RunStatusPill } from "./RunStatusPill";

/** One run in a list. */
export interface RunRow {
  readonly id: string;
  /** The flow's name: the row's link text. */
  readonly flow: string;
  readonly state: RunState;
  readonly cancelRequested?: boolean;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  /** The run page. */
  readonly href: string;
  /** What started it, such as `push`, `commit` or `button`. The column shows once any row has it. */
  readonly trigger?: string;
  /** The branch it ran for; `null` reads as none. The column shows once any row has the field. */
  readonly branch?: string | null;
  /** Who started it, such as a login; `null` reads as none. The column shows once any row has the field. */
  readonly actor?: string | null;
  /** Where it ran when a list mixes hosts, such as `Cloud`: a tag beside the flow. */
  readonly where?: string;
  /**
   * Where the row's details toggle goes, such as the list's address with this run opened or closed: the toggle shows
   * when given, and `expanded` says which way it points.
   */
  readonly toggleHref?: string;
  readonly expanded?: boolean;
}

export type RunListProps = Omit<ComponentProps<"div">, "children"> & {
  runs: ReadonlyArray<RunRow>;
  now: number;
  /** Renders the flow's link, such as the router's `Link`; a plain `<a>` otherwise. */
  renderLink?: (href: string, children: ReactNode) => ReactNode;
  /** Shown when there are no runs. Default: `EmptyState` titled `No runs`. */
  empty?: ReactNode;
  /** An expanded run's details, such as its jobs and steps, in a full-width row under it. */
  renderDetails?: (run: RunRow) => ReactNode;
};

/** None, as a cell reads it. */
const NONE = "–";

/**
 * Runs as a table, like a CI system's runs: the flow (a link to its run page), its state, what started it, its branch,
 * who started it, when it started and how long it ran. A row with a toggle expands to its details in place.
 */
export function RunList({ runs, now, renderLink, empty, renderDetails, className, ...props }: RunListProps) {
  useInjectUiCss();
  if (runs.length === 0) {
    return (
      <div data-slot="run-list" data-empty="true" className={cn("sui-run-list", className)} {...props}>
        {empty ?? <EmptyState title="No runs" />}
      </div>
    );
  }
  // The plain link takes only a navigable href; one that isn't shows its content alone.
  const link = renderLink ?? ((href: string, children: ReactNode) => {
    const safe = safeHref(href);
    return safe === undefined ? children : <a href={safe}>{children}</a>;
  });
  const shows = {
    trigger: runs.some((run) => run.trigger !== undefined),
    branch: runs.some((run) => run.branch !== undefined),
    actor: runs.some((run) => run.actor !== undefined),
    toggle: runs.some((run) => run.toggleHref !== undefined),
  };
  const columns = 4 + Number(shows.trigger) + Number(shows.branch) + Number(shows.actor) + Number(shows.toggle);
  return (
    <div data-slot="run-list" className={cn("sui-run-list", className)} {...props}>
      <Table aria-label="Runs">
        <TableHeader>
          <TableRow>
            {shows.toggle ? <TableHead className="sui-run-list-toggle"><span className="sui-sr-only">Details</span></TableHead> : null}
            <TableHead>Flow</TableHead>
            <TableHead>Status</TableHead>
            {shows.trigger ? <TableHead>Trigger</TableHead> : null}
            {shows.branch ? <TableHead>Branch</TableHead> : null}
            {shows.actor ? <TableHead>Actor</TableHead> : null}
            <TableHead>Started</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <Fragment key={run.id}>
              <TableRow data-run={run.id} data-expanded={run.expanded === true ? "true" : undefined}>
                {shows.toggle ? (
                  <TableCell className="sui-run-list-toggle">
                    {run.toggleHref === undefined ? null : link(
                      run.toggleHref,
                      <span
                        className="sui-run-list-chevron"
                        data-slot="run-details-toggle"
                        aria-label={run.expanded === true ? `Hide ${run.flow}` : `Show ${run.flow}`}
                        role="img"
                      >
                        {run.expanded === true ? "▾" : "▸"}
                      </span>,
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="sui-run-list-flow">
                  {link(run.href, run.flow)}
                  {run.where === undefined ? null : (
                    <Badge variant="outline" data-slot="run-where" className="sui-run-list-where">{run.where}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <RunStatusPill state={run.state} cancelRequested={run.cancelRequested ?? false} />
                </TableCell>
                {shows.trigger ? <TableCell className="sui-run-list-meta" data-slot="run-trigger">{run.trigger ?? NONE}</TableCell> : null}
                {shows.branch ? <TableCell className="sui-run-list-meta sui-run-list-branch" data-slot="run-branch">{run.branch ?? NONE}</TableCell> : null}
                {shows.actor ? <TableCell className="sui-run-list-meta" data-slot="run-actor">{run.actor ?? NONE}</TableCell> : null}
                <TableCell className="sui-run-list-time">{formatRelativeTime(run.startedAtMs, now)}</TableCell>
                <TableCell className="sui-run-list-time">{clockDuration((run.finishedAtMs ?? now) - run.startedAtMs)}</TableCell>
              </TableRow>
              {run.expanded === true && renderDetails !== undefined ? (
                <TableRow data-run-details={run.id} className="sui-run-list-details">
                  <TableCell colSpan={columns}>{renderDetails(run)}</TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
