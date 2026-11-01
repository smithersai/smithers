/** @jsxImportSource react */
import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { timelineDriver, type TimelineDriver } from "./timelineDriver";
import { useOptionalMessageScroller } from "./MessageScroller";
import {
  timelineBlocks, timelineExchanges, timelineLevelCount, timelineIntersections, timelineWidths, type TimelineBlock, type TimelineMarker,
} from "./timelineZoom";
export {
  timelineBlocks, timelineCapacity, timelineExchanges, timelineLevelCount, timelineWidths,
  type TimelineBlock, type TimelineMarker,
} from "./timelineZoom";
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
  /** The message's length in characters: its size on the rail until the transcript has measured it. */
  readonly length?: number;
  readonly state: "done" | "working" | "waiting" | "failed" | "queued";
  readonly kind: "ask" | "answer" | "tool" | "flow";
}
export interface ChatTimelineProps {
  readonly entries: readonly ChatTimelineEntry[];
  /** The conversation's logical phases, in order: level 1. Sizes follow what happened, never a fixed stride (FE-19). */
  readonly phases?: readonly TimelineMarker[];
  /** Larger arcs of phases: level 2, when level 1 no longer fits. */
  readonly arcs?: readonly TimelineMarker[];
  /** Further model-summarized semantic levels, innermost first. Missing coverage stays pending. */
  readonly higherLevels?: readonly (readonly TimelineMarker[])[];
  /** Why entries without a summary won't get one now; the rail marks them, and an outer block untitled for it. */
  readonly unavailable?: string;
  /** The host owns navigation. Without it, jump to the entry's transcript anchor. */
  readonly onJump?: (id: string) => void;
  /** Mount history only, without scrolling. The driver owns fractional drag positioning after mount. */
  readonly onRequestHistory?: (id: string) => void;
  /** Explicit activation of a single entry; keyboard traversal and grouped entries only jump. */
  readonly onActivate?: (id: string) => void;
}
/** Default state words when a message has neither a summary nor a host label. */
const stateWords = (entry: ChatTimelineEntry): string | undefined => {
  if (entry.state === "done" || (entry.kind !== "ask" && entry.kind !== "answer")) return undefined;
  if (entry.kind === "ask") return { working: undefined, waiting: undefined, failed: "Not sent", queued: "Queued" }[entry.state];
  return { working: "Working", waiting: "Needs you", failed: "Couldn't answer", queued: "Waiting" }[entry.state];
};
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

type State = ChatTimelineEntry["state"];
/** A block takes its most urgent member's state. */
const worst = (members: readonly ChatTimelineEntry[]): State =>
  (["failed", "waiting", "working", "queued", "done"] as const).find(state => members.some(member => member.state === state))!;
const blockPending = (block: TimelineBlock, entries: readonly ChatTimelineEntry[]) => block.title ?? timelineLabel(entries[block.start]!);
const detailOf = (block: TimelineBlock, entries: readonly ChatTimelineEntry[]) => {
  const first = entries[block.start]!, last = entries[block.end - 1]!;
  const messages = block.end - block.start;
  return [`${messages} ${messages === 1 ? "message" : "messages"}`, first.time && last.time ? first.time === last.time ? first.time : `${first.time} – ${last.time}` : undefined].filter(Boolean).join(" · ");
};
const entryDetail = (entry: ChatTimelineEntry) => [
  entry.actor ?? ({ ask: "Person", answer: "Smithers", tool: "Tool", flow: "Flow" }[entry.kind]), entry.time, entry.duration,
  entry.tokens === undefined ? undefined : `${entry.tokens.toLocaleString("en-US")} tokens`, entry.cost,
].filter(Boolean).join(" · ");

/** The rail's size, measured: the mock's columns are laid out for it, so it is the one thing rendering reads. */
const useBox = (box: RefObject<HTMLDivElement | null>) => {
  const [size, setSize] = useState({ width: 342, height: 804 });
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const read = () => {
      const width = element.clientWidth, height = element.clientHeight;
      if (width > 0 && height > 0) setSize(now => now.width === width && now.height === height ? now : { width, height });
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
  return size;
};

/** The vertical scrubber of ruling FE-16: a detailed level beside the chat, and coarser ones as the chat outgrows them. */
export function ChatTimeline({ entries, phases = [], arcs = [], higherLevels = [], unavailable, onJump, onRequestHistory, onActivate }: ChatTimelineProps) {
  useInjectUiCss();
  const rail = useRef<HTMLElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const driver = useRef<TimelineDriver | null>(null);
  const size = useBox(box);
  const ids = useMemo(() => entries.map(entry => entry.id), [entries]);
  const spans = useMemo(() => timelineBlocks(ids, phases, 1), [ids, phases]);
  const larger = useMemo(() => timelineBlocks(ids, arcs, 2), [ids, arcs]);
  const exchanges = useMemo(() => timelineExchanges(entries.map(entry => entry.kind === "ask")), [entries]);
  const supplied = useMemo(() => [spans, larger, ...higherLevels.map((markers, index) => timelineBlocks(ids, markers, index + 3))], [spans, larger, higherLevels, ids]);
  const levels = timelineLevelCount(entries.length, spans.length, size.height, supplied.slice(1).map(blocks => blocks.length));
  const columns = useMemo(() => [...supplied, timelineBlocks(ids, [], supplied.length + 1)], [supplied, ids]);
  // A level on its way out stays drawn until its exit has played; one on its way in is marked for its entrance.
  const [shown, setShown] = useState(levels);
  const [entering, setEntering] = useState(Infinity);
  const previous = useRef(levels);
  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = levels;
    if (levels <= from) return;
    setEntering(from);
    setShown(levels);
    const timer = setTimeout(() => setEntering(Infinity), 520);
    return () => clearTimeout(timer);
  }, [levels]);
  useEffect(() => {
    if (levels >= shown) return;
    const timer = setTimeout(() => setShown(levels), 400);
    return () => clearTimeout(timer);
  }, [levels, shown]);
  const drawn = Math.max(levels, shown);
  const { widths, gap } = timelineWidths(Math.max(1, drawn), size.width);
  const lefts: number[] = [];
  widths.forEach((width, index) => { lefts.push(index === 0 ? size.width - width : lefts[index - 1]! - gap - width); });
  const scrollByReader = useOptionalMessageScroller()?.scrollByReader;
  useLayoutEffect(() => {
    if (rail.current === null || box.current === null) return;
    const made = timelineDriver(rail.current, box.current, scrollByReader);
    driver.current = made;
    return () => { made.dispose(); driver.current = null; };
  }, [scrollByReader]);
  useLayoutEffect(() => {
    driver.current?.sync({ ids, asks: entries.map(entry => entry.kind === "ask"), lengths: entries.map(entry => entry.length ?? timelineLabel(entry).length), levels, spans, arcs: larger, higher: columns.slice(2), ...(onRequestHistory === undefined ? {} : { onRequestHistory }) });
  }, [ids, entries, levels, spans, larger, columns, size, onRequestHistory]);
  const [preview, setPreview] = useState<{ readonly title: string; readonly summary?: string; readonly detail: string; readonly left: number; readonly top: number } | undefined>();
  const show = (element: HTMLElement, title: string, detail: string, summary?: string) => {
    const box = element.getBoundingClientRect();
    setPreview({ title, detail, left: Math.min(window.innerWidth - 250, box.left + 20), top: box.bottom + 4, ...(summary === undefined ? {} : { summary }) });
  };
  const hide = () => setPreview(undefined);
  const jump = (id: string) => {
    if (onJump) { onJump(id); return; }
    document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "instant" });
  };
  const keys = (element: HTMLElement, event: KeyboardEvent, lvl: number, list: readonly { readonly start: number }[], index: number, entry: ChatTimelineEntry) => {
    if (event.key === "Escape") {
      const target = document.getElementById(entry.id);
      if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const to = lvl + (event.key === "ArrowLeft" ? 1 : -1);
      if (to < 0 || to >= levels) return;
      event.preventDefault();
      const row = entries.indexOf(entry);
      const blocks = columns[to - 1] ?? [];
      const target = to === 0 ? element.closest(".sui-timeline-box")!.querySelector<HTMLElement>(`[data-row="${row}"]`)
        : element.closest(".sui-timeline-box")!.querySelector<HTMLElement>(`ol[data-level="${to}"] li:nth-child(${Math.max(1, blocks.findIndex(block => block.start <= row && block.end > row) + 1)}) button`);
      target?.focus({ preventScroll: true });
      return;
    }
    const next = timelineKey(event.key, index, list.length);
    if (next === undefined) return;
    event.preventDefault();
    const items = element.closest("ol")!.querySelectorAll<HTMLElement>("button");
    items[next]!.focus({ preventScroll: true });
    jump(entries[list[next]!.start]!.id);
  };
  const blockColumn = (lvl: number, blocks: readonly TimelineBlock[], parts: readonly { readonly start: number; readonly end: number }[], leaving: boolean) => {
    const width = widths[lvl] ?? widths.at(-1)!;
    const left = lefts[lvl] ?? lefts.at(-1)!;
    return <div key={lvl} className="sui-tl-lv" data-level={lvl} data-strip={width < 30 || undefined} data-entering={lvl >= entering || undefined} data-leaving={leaving || undefined} style={{ left, width, height: size.height }}>
      <div className="sui-tl-clip">
        <div className="sui-tl-inner">
          <ol data-level={lvl} aria-label={lvl === 1 ? "Phases" : lvl === 2 ? "Arcs" : `Summary level ${lvl}`}>
            {blocks.map((block, index) => {
              const members = entries.slice(block.start, block.end);
              const first = members[0]!;
              const state = worst(members);
              const title = blockPending(block, entries);
              const pending = block.title === undefined;
              return <li key={block.id} className="sui-tl-blk-li" data-block={index} data-state={state}>
                <button type="button" className="sui-tl-blk" tabIndex={-1} aria-controls={first.id} data-summary={pending ? unavailable ? "unavailable" : "pending" : "ready"}
                  aria-label={`${title}, ${detailOf(block, entries)}`}
                  onPointerEnter={event => show(event.currentTarget, title, detailOf(block, entries), block.summary ?? (pending ? unavailable : undefined))}
                  onPointerLeave={hide} onBlur={hide}
                  onFocus={event => show(event.currentTarget, title, detailOf(block, entries), block.summary ?? (pending ? unavailable : undefined))}
                  onClick={() => jump(first.id)}
                  onKeyDown={event => keys(event.currentTarget, event, lvl, blocks, index, first)}>
                  <span className="sui-tl-sms" aria-hidden="true">{timelineIntersections(parts, block).map(mark => <i key={mark.start} className="sui-tl-sm" data-state={worst(entries.slice(mark.start, mark.end))} data-start={mark.start} data-end={mark.end} />)}</span>
                  <span className="sui-tl-tx">{title}</span>
                </button>
              </li>;
            })}
          </ol>
          <div className="sui-tl-lens" data-lens={lvl} />
        </div>
      </div>
    </div>;
  };
  const leaving = (lvl: number) => lvl >= levels && lvl < drawn;
  return <nav ref={rail} className="sui-chat-timeline" aria-label="Conversation timeline" data-levels={levels}>
    <div ref={box} className="sui-timeline-box" onPointerLeave={hide}>
      <svg className="sui-tl-fun" aria-hidden="true">
        {Array.from({ length: drawn }, (_, level) => level).map(t => <path key={t} className="sui-tl-trk" data-t={t} />)}
        {Array.from({ length: Math.max(0, drawn - 1) }, (_, index) => index + 1).map(f => <g key={f} data-f={f} data-entering={f >= entering || undefined} data-leaving={leaving(f) || undefined}><path className="sui-tl-beam" /><path className="sui-tl-ln" pathLength={1} /><path className="sui-tl-ln" pathLength={1} /></g>)}
      </svg>
      {entries.length === 0 ? null : <div className="sui-tl-lv" data-level={0} style={{ left: lefts[0], width: widths[0] }}>
        <div className="sui-tl-clip">
          <div className="sui-tl-inner">
            <ol data-level={0} aria-label="Messages">
              {entries.map((entry, row) => {
                const label = entry.summary || entry.label || stateWords(entry) || timelineLabel(entry);
                const name = entry.label && entry.label !== label ? `${label} · ${entry.label}` : undefined;
                const pending = !entry.summary && entry.state === "done";
                const why = pending ? unavailable : undefined;
                return <li key={entry.id} data-state={entry.state} style={{ display: "contents" }}>
                  <button type="button" className="sui-tl-row" data-row={row} data-kind={entry.kind === "ask" ? "ask" : "answer"} data-state={entry.state} tabIndex={row === 0 ? 0 : -1} aria-controls={entry.id}
                    aria-label={name} data-summary={entry.summary ? "ready" : why ? "unavailable" : "pending"}
                    onPointerEnter={event => show(event.currentTarget, label, entryDetail(entry), why)}
                    onPointerLeave={hide} onBlur={hide}
                    onFocus={event => show(event.currentTarget, label, entryDetail(entry), why)}
                    onClick={() => onActivate ? onActivate(entry.id) : jump(entry.id)}
                    onKeyDown={event => keys(event.currentTarget, event, 0, entries.map((_, start) => ({ start })), row, entry)}>
                    <i className="sui-tl-mk" />
                    <i className="sui-tl-lead" />
                    <span className="sui-tl-tx">{label}</span>
                  </button>
                </li>;
              })}
            </ol>
            <div className="sui-tl-thumb" /><i className="sui-tl-cur" /><div className="sui-tl-dot" />
          </div>
        </div>
      </div>}
      {Array.from({ length: Math.max(0, drawn - 1) }, (_, index) => {
        const lvl = index + 1;
        const blocks = columns[index] ?? timelineBlocks(ids, [], lvl);
        return blockColumn(lvl, blocks, lvl === 1 ? exchanges : columns[index - 1] ?? [], leaving(lvl));
      })}
    </div>
    <div className="sui-timeline-preview" role="tooltip" hidden={preview === undefined} style={preview ? { left: preview.left, top: preview.top } : undefined}>
      {preview ? <><strong>{preview.title}</strong>{preview.summary ? <span>{preview.summary}</span> : null}<span>{preview.detail}</span></> : null}
    </div>
  </nav>;
}
