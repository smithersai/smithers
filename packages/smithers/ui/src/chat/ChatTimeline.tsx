/** @jsxImportSource react */
import { type CSSProperties, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { timelineLevels, type TimelineBlock } from "./timelineZoom";
export { timelineCapacity, timelineLevelCount, timelineLevels, type TimelineBlock, type TimelineLevel } from "./timelineZoom";
import { useInjectUiCss } from "../styles";

export interface ChatTimelineEntry {
  readonly id: string;
  readonly summary?: string;
  /** Concrete recorded object and outcome while a generated summary is unavailable. */
  readonly label?: string;
  readonly actor?: string;
  readonly time?: string;
  readonly duration?: string;
  readonly tokens?: number;
  readonly cost?: string;
  readonly state: "done" | "working" | "waiting" | "failed" | "queued";
  readonly kind: "ask" | "answer" | "tool" | "flow";
}
export interface ChatTimelineProps {
  readonly entries: readonly ChatTimelineEntry[];
  /** The host owns navigation. Without it, jump to the entry's transcript anchor. */
  readonly onJump?: (id: string) => void;
  /** Explicit activation of a single entry; keyboard traversal and grouped entries only jump. */
  readonly onActivate?: (id: string) => void;
  readonly groupSummaries?: Readonly<Record<string, string>>;
  /** Only groups in currently existing, visible levels are requested. */
  readonly onGroupsChange?: (groups: readonly TimelineBlock[]) => void;
}
export const timelineLabel = (entry: ChatTimelineEntry): string => entry.summary || entry.label || ({
  done: { ask: "Question sent", answer: "Reply completed", tool: "Tool completed", flow: "Run completed" }[entry.kind],
  working: "Working", waiting: "Needs you",
  failed: { ask: "Not sent", answer: "Reply failed", tool: "Tool failed", flow: "Run failed" }[entry.kind],
  queued: { ask: "Waiting to send", answer: "Waiting for reply", tool: "Waiting", flow: "Waiting" }[entry.kind],
}[entry.state]);
export const timelineKey = (key: string, index: number, length: number): number | undefined => {
  if (length === 0) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown" || key === "j") return Math.min(length - 1, index + 1);
  if (key === "ArrowUp" || key === "k") return Math.max(0, index - 1);
  return undefined;
};

/** Viewport and label measurements keep every octave inside the available rail. */
export function ChatTimeline({ entries, onJump, onActivate, groupSummaries = {}, onGroupsChange }: ChatTimelineProps) {
  useInjectUiCss();
  const rail = useRef<HTMLElement>(null);
  const onGroupsChangeRef = useRef(onGroupsChange);
  useLayoutEffect(() => { onGroupsChangeRef.current = onGroupsChange; }, [onGroupsChange]);
  const hasGroupsChange = onGroupsChange !== undefined;
  const ids = entries.map(entry => entry.id).join("\0");
  const geometry = useMemo(() => {
    let snapshot = "408||32";
    let rowHeight = 32;
    return {
      read: () => snapshot,
      subscribe: (notify: () => void) => {
        let groupKey = "";
        const update = () => {
          const list = ids ? ids.split("\0") : [];
          const visible = list.filter(id => {
            const el = document.getElementById(id);
            if (!el) return false;
            const box = el.getBoundingClientRect();
            const viewport = el.closest('[data-slot="message-scroller-viewport"]');
            const bounds = viewport?.getBoundingClientRect();
            return box.bottom > (bounds?.top ?? 0) && box.top < (bounds?.bottom ?? window.innerHeight);
          });
          const height = rail.current?.querySelector("ol")?.clientHeight || rail.current?.clientHeight || Math.min(560, window.innerHeight * .7);
          // Retain the largest measured label while this entry set is mounted.
          // Shrinking to a different window must not oscillate the octave count.
          for (const label of rail.current?.querySelectorAll<HTMLElement>("button > span") ?? []) rowHeight = Math.max(rowHeight, label.scrollHeight);
          const next = `${height}|${visible.join("\0")}|${rowHeight}`;
          if (next !== snapshot) { snapshot = next; notify(); }
          const first = Math.max(0, list.indexOf(visible[0] ?? ""));
          const last = Math.max(first, list.indexOf(visible.at(-1) ?? ""));
          const groups = timelineLevels(list, height, first, last, rowHeight).filter(level => level.level > 0).flatMap(level => level.blocks);
          const key = JSON.stringify(groups);
          if (key !== groupKey) { groupKey = key; onGroupsChangeRef.current?.(groups); }
        };
        document.addEventListener("scroll", update, true);
        window.addEventListener("resize", update);
        const observer = new ResizeObserver(update);
        if (rail.current) observer.observe(rail.current);
        ids.split("\0").forEach(id => { const el = document.getElementById(id); if (el) observer.observe(el); });
        const labels = new MutationObserver(update);
        if (rail.current) labels.observe(rail.current, { childList: true, characterData: true, subtree: true });
        update();
        return () => { labels.disconnect(); observer.disconnect(); document.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
      },
    };
  }, [ids, hasGroupsChange]);
  const snapshot = useSyncExternalStore(geometry.subscribe, geometry.read, () => "408||32");
  const [height, visible = "", rowHeight] = snapshot.split("|");
  const band = visible.split("\0");
  const first = Math.max(0, entries.findIndex(entry => entry.id === band[0]));
  const last = Math.max(first, entries.findIndex(entry => entry.id === band.at(-1)));
  const levels = timelineLevels(entries.map(entry => entry.id), Number(height), first, last, Number(rowHeight));
  const jump = (id: string) => {
    if (onJump) { onJump(id); return; }
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "instant" });
  };
  return <nav ref={rail} className="sui-chat-timeline" aria-label="Conversation timeline">
    {[...levels].reverse().map((level, column) => <ol key={level.level} data-level={level.level} aria-label={`Zoom level ${level.level}`} style={{ "--sui-timeline-column": column, "--sui-timeline-columns": levels.length } as CSSProperties}>
      <i className="sui-timeline-band" aria-hidden="true" style={{ top: `${level.band.top * 100}%`, height: `${level.band.height * 100}%` }} />
      {level.blocks.map((block, index) => {
        const members = entries.slice(block.start, block.end);
        const entry = members[0]!;
        const grouped = level.level > 0;
        const state = (["failed", "waiting", "working", "queued", "done"] as const).find(state => members.some(member => member.state === state))!;
        const label = grouped ? groupSummaries[block.id] || `${members.length} entries` : timelineLabel(entry);
        const previewId = `timeline-preview-${level.level}-${entry.id}`;
        return <li key={block.id} data-state={state} data-in-view={members.some(member => band.includes(member.id)) || undefined} style={{ flexGrow: members.length, flexBasis: `${rowHeight}px` }}>
          <button type="button" aria-controls={entry.id} aria-current={members.some(member => band.includes(member.id)) ? "location" : undefined}
            aria-label={!grouped && entry.label && entry.label !== label ? `${label} · ${entry.label}` : undefined}
            data-summary={(grouped ? groupSummaries[block.id] : entry.summary) ? "ready" : "pending"} aria-describedby={previewId}
            onClick={() => !grouped && onActivate ? onActivate(entry.id) : jump(entry.id)}
            onKeyDown={event => {
              if (event.key === "Escape") {
                const target = document.getElementById(entry.id);
                if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
                return;
              }
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                const adjacent = levels[level.level + (event.key === "ArrowLeft" ? 1 : -1)];
                if (!adjacent) return;
                event.preventDefault();
                const nearest = adjacent.blocks.reduce((best, candidate) => Math.abs(candidate.start - block.start) < Math.abs(best.start - block.start) ? candidate : best);
                const containing = adjacent.blocks.find(candidate => candidate.start <= block.start && candidate.end > block.start) ?? nearest;
                rail.current?.querySelector<HTMLButtonElement>(`ol[data-level="${adjacent.level}"] button[aria-controls="${CSS.escape(entries[containing.start]!.id)}"]`)?.focus({ preventScroll: true });
                return;
              }
              const next = timelineKey(event.key, index, level.blocks.length);
              if (next === undefined) return;
              event.preventDefault();
              const buttons = event.currentTarget.closest("ol")!.querySelectorAll<HTMLButtonElement>("button");
              buttons[next]!.focus({ preventScroll: true });
              jump(entries[level.blocks[next]!.start]!.id);
            }}><span>{label}</span></button>
          <div className="sui-timeline-preview" id={previewId} role="tooltip">
            <strong>{label}</strong>
            {grouped ? <span>{members.length} entries{entry.time && members.at(-1)!.time ? ` · ${entry.time} – ${members.at(-1)!.time}` : ""}</span> : <>
              <span>{entry.actor ?? ({ ask: "Person", answer: "Agent", tool: "Tool", flow: "Flow" }[entry.kind])}</span>
              {(entry.time || entry.duration) && <span>{[entry.time, entry.duration].filter(Boolean).join(" · ")}</span>}
              {(entry.tokens !== undefined || entry.cost) && <span>{[entry.tokens !== undefined ? `${entry.tokens.toLocaleString()} tokens` : undefined, entry.cost].filter(Boolean).join(" · ")}</span>}
            </>}
            <span>{({ done: "Completed", working: "Working", waiting: "Needs you", failed: "Failed", queued: "Waiting" })[state]}</span>
            <small>Enter to jump</small>
          </div>
        </li>;
      })}
    </ol>)}
  </nav>;
}
