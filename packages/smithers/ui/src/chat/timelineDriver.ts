import {
  TIMELINE_PITCH, timelineBlockWindow, timelineRowWindow, timelineSearch, timelineToChat, timelineToRow,
  type TimelineBlock, type TimelineBox, type TimelineWindow,
} from "./timelineZoom";

// What moves with the chat. Scrolling must not re-render a rail of hundreds of rows, so React draws the rows and blocks
// and this driver moves the windows, thumb, lens and funnel lines directly: the mock's `update`, as one function.

/** The rail as drawn: entries and the blocks of each outer level, in order. */
export interface TimelineModel {
  readonly ids: readonly string[];
  readonly asks: readonly boolean[];
  readonly levels: number;
  readonly spans: readonly TimelineBlock[];
  readonly arcs: readonly TimelineBlock[];
  readonly higher?: readonly (readonly TimelineBlock[])[];
  /** Widen the transcript history window; mounting is observed before restoring the requested position. */
  readonly onRequestHistory?: (id: string) => void;
}

export interface TimelineDriver {
  /** Reads the transcript again and lays out for `model`: after every render that changes it. */
  readonly sync: (model: TimelineModel) => void;
  readonly dispose: () => void;
}

const px = (value: number) => `${value}px`;
const CORNER = 6;

/** The transcript viewport beside `rail`: the one `[data-slot="message-scroller-viewport"]` of its transcript. */
const viewportOf = (rail: HTMLElement): HTMLElement | null =>
  rail.closest<HTMLElement>(".sui-chat-transcript")?.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]') ?? null;

/** How much room the rail has beside the transcript: to the page's left edge, or the panel `data-rail-bound` marks. */
const roomOf = (rail: HTMLElement) => {
  const transcript = rail.closest<HTMLElement>(".sui-chat-transcript");
  if (transcript === null) return undefined;
  const bound = rail.closest<HTMLElement>("[data-rail-bound]")?.getBoundingClientRect().left ?? 0;
  return Math.max(0, transcript.getBoundingClientRect().left - bound - 18);
};

export const timelineDriver = (rail: HTMLElement, box: HTMLElement): TimelineDriver => {
  let model: TimelineModel = { ids: [], asks: [], levels: 0, spans: [], arcs: [] };
  let boxes: readonly TimelineBox[] = [];
  let tops: readonly number[] = [];
  let rowWindow: TimelineWindow | undefined;
  let blockWindows: (TimelineWindow | undefined)[] = [];
  const columns = () => [model.spans, model.arcs, ...(model.higher ?? [])];
  let drag: { readonly level: number; readonly grab: number } | undefined;
  let pendingRead: { readonly fraction: number; readonly center: boolean; readonly id: string; readonly scroll: number; readonly contentHeight: number } | undefined;
  let readAnchor: { readonly fraction: number; readonly center: boolean; readonly id: string; readonly scroll: number } | undefined;
  let frame = 0;
  let layoutWidth = -1, layoutHeight = -1;
  let viewport: HTMLElement | null = null;
  const inView = new Set<number>();
  const q = <E extends Element>(selector: string) => box.querySelector<E>(selector);
  const level = (n: number) => q<HTMLElement>(`.sui-tl-lv[data-level="${n}"]`);
  const clip = (n: number) => level(n)?.querySelector<HTMLElement>(".sui-tl-clip") ?? null;
  const inner = (n: number) => level(n)?.querySelector<HTMLElement>(".sui-tl-inner") ?? null;

  /** Each entry mounted in the transcript, as content coordinates; the host's window may hold fewer than the rail. */
  const measure = () => {
    if (viewport === null) { boxes = []; tops = []; return; }
    const origin = viewport.getBoundingClientRect().top - viewport.scrollTop;
    boxes = model.ids.flatMap((id, row) => {
      const element = document.getElementById(id);
      if (element === null) return [];
      const rect = element.getBoundingClientRect();
      return [{ row, top: rect.top - origin, bottom: rect.bottom - origin }];
    });
    tops = boxes.map(item => item.top);
  };

  const moveRows = (next: TimelineWindow, animate: boolean) => {
    const content = inner(0), frameEl = clip(0);
    if (content === null || frameEl === null) return;
    if (!animate) { content.style.transition = "none"; frameEl.style.transition = "none"; } else { content.style.transition = ""; frameEl.style.transition = ""; }
    content.style.transform = `translateY(${px(-next.start * TIMELINE_PITCH)})`;
    frameEl.style.height = px((next.end - next.start) * TIMELINE_PITCH);
    box.querySelectorAll<HTMLElement>(".sui-tl-row").forEach(row => { row.tabIndex = -1; });
    q<HTMLElement>(`.sui-tl-row[data-row="${next.start}"]`)?.setAttribute("tabindex", "0");
  };

  const moveBlocks = (lvl: number, next: TimelineWindow, animate: boolean): boolean => {
    const content = inner(lvl), frameEl = clip(lvl);
    if (content === null || frameEl === null) return false;
    const first = content.querySelector<HTMLElement>(`[data-block="${next.start}"]`);
    const last = content.querySelector<HTMLElement>(`[data-block="${next.end - 1}"]`);
    if (first === null || last === null) return false;
    if (!animate) { content.style.transition = "none"; frameEl.style.transition = "none"; } else { content.style.transition = ""; frameEl.style.transition = ""; }
    content.style.transform = `translateY(${px(-first.offsetTop)})`;
    frameEl.style.height = px(last.offsetTop + last.offsetHeight - first.offsetTop);
    return true;
  };

  const blockOf = (blocks: readonly TimelineBlock[], row: number) => {
    const found = timelineSearch(blocks.map(block => block.start), row);
    return Math.max(0, found);
  };

  /** The y range, in `content` coordinates, of the strip marks whose entries lie in `[first, last]`. */
  const lensRange = (content: HTMLElement, first: number, last: number, top: number, bottom: number) => {
    let low = Infinity, high = -Infinity;
    content.querySelectorAll<HTMLElement>(".sui-tl-sm").forEach(mark => {
      const start = Number(mark.dataset.start), end = Number(mark.dataset.end);
      const hit = end > first && start <= last;
      if (hit) mark.setAttribute("data-in", ""); else mark.removeAttribute("data-in");
      if (!hit) return;
      const parent = mark.closest<HTMLElement>("[data-block]");
      const y = (parent?.offsetTop ?? 0) + mark.offsetTop;
      low = Math.min(low, y); high = Math.max(high, y + mark.offsetHeight);
    });
    return Number.isFinite(low) ? { top: Math.max(top, low - 4), bottom: Math.min(bottom, high + 4) } : { top, bottom: top };
  };

  const markBlocks = (lvl: number, blocks: readonly TimelineBlock[], first: number, last: number) => {
    level(lvl)?.querySelectorAll<HTMLElement>(".sui-tl-blk").forEach((button, index) => {
      const block = blocks[index];
      const hit = block !== undefined && block.end > first && block.start <= last;
      if (hit) button.setAttribute("data-in", ""); else button.removeAttribute("data-in");
    });
  };

  const drawFunnels = () => {
    const origin = box.getBoundingClientRect();
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - origin.left, right: r.right - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top };
    };
    const track = (n: number, d: string) => q<SVGPathElement>(`.sui-tl-trk[data-t="${n}"]`)?.setAttribute("d", d);
    const funnel = (n: number, lens: HTMLElement | null, x: number, y0: number, y1: number) => {
      const group = q<SVGGElement>(`g[data-f="${n}"]`);
      if (group === null || lens === null) return;
      const [beam, upper, lower] = [...group.children] as SVGPathElement[];
      const l = rect(lens), right = l.right, k = (x - CORNER - right) * .62;
      const T = `M${right} ${l.top + .5} C${right + k} ${l.top + .5} ${x - CORNER - k} ${y0} ${x - CORNER} ${y0} Q${x} ${y0} ${x} ${y0 + CORNER}`;
      const B = `M${right} ${l.bottom - .5} C${right + k} ${l.bottom - .5} ${x - CORNER - k} ${y1} ${x - CORNER} ${y1} Q${x} ${y1} ${x} ${y1 - CORNER}`;
      upper!.setAttribute("d", T); lower!.setAttribute("d", B);
      beam!.setAttribute("d", `${T} L${x} ${y1 - CORNER} Q${x} ${y1} ${x - CORNER} ${y1} C${x - CORNER - k} ${y1} ${right + k} ${l.bottom - .5} ${right} ${l.bottom - .5} Z`);
    };
    for (let lvl = 0; lvl < model.levels; lvl++) {
      const column = level(lvl), frame = clip(lvl);
      if (column === null || frame === null) continue;
      const bounds = rect(frame), x = rect(column).left + 3.5;
      const corner = lvl < model.levels - 1 ? CORNER : 0;
      track(lvl, `M${x} ${bounds.top + corner} L${x} ${Math.max(bounds.top + corner, bounds.bottom - corner)}`);
      if (lvl > 0) {
        const lower = level(lvl - 1), lowerClip = clip(lvl - 1);
        if (lower !== null && lowerClip !== null) {
          const bounds = rect(lowerClip);
          funnel(lvl, q(`[data-lens='${lvl}']`), rect(lower).left + 3.5, bounds.top, bounds.bottom);
        }
      }
    }
    box.querySelectorAll<SVGPathElement>(".sui-tl-trk").forEach(path => {
      if (Number(path.dataset.t) >= model.levels) path.setAttribute("d", "");
    });
  };

  const update = (force = false) => {
    const count = model.ids.length;
    if (count === 0) return;
    const height = box.clientHeight;
    if (height !== layoutHeight || box.clientWidth !== layoutWidth) {
      layoutHeight = height; layoutWidth = box.clientWidth;
      rowWindow = undefined; blockWindows = [];
      force = true;
    }
    const top = viewport?.scrollTop ?? 0, bottom = top + (viewport?.clientHeight ?? 0);
    const firstRow = timelineToRow(boxes, top), lastRow = timelineToRow(boxes, bottom), reading = timelineToRow(boxes, (top + bottom) / 2);
    const firstIndex = boxes.length === 0 ? -1 : timelineSearch(tops, top);
    const lastIndex = boxes.length === 0 ? -1 : timelineSearch(tops, bottom);
    const visible = boxes.length === 0 ? [] : boxes.slice(boxes[firstIndex]!.bottom < top && firstIndex < boxes.length - 1 ? firstIndex + 1 : firstIndex, lastIndex + 1).map(item => item.row);
    const vf = visible[0] ?? 0, vl = visible.at(-1) ?? vf;
    const nextRows = drag?.level === 0 && rowWindow !== undefined ? rowWindow : timelineRowWindow({
      count, levels: model.levels, height, first: vf, last: vl, reading, force: force || (drag !== undefined), ask: row => model.asks[row] === true,
      blockStart: row => model.spans[blockOf(model.spans, row)]?.start ?? row,
      ...(rowWindow === undefined ? {} : { current: rowWindow }),
    });
    if (force || nextRows.start !== rowWindow?.start || nextRows.end !== rowWindow?.end) { const animate = rowWindow !== undefined && !force; rowWindow = nextRows; moveRows(nextRows, animate); }
    let firstEntry = rowWindow.start, lastEntry = rowWindow.end - 1;
    const blocksByLevel = columns();
    for (let lvl = 1; lvl < model.levels; lvl++) {
      const blocks = blocksByLevel[lvl - 1] ?? [];
      if (blocks.length === 0) continue;
      const current = blockWindows[lvl - 1];
      const next = timelineBlockWindow({
        count: blocks.length, height,
        first: blockOf(blocks, firstEntry), last: blockOf(blocks, lastEntry),
        force: force || drag?.level === lvl + 1, ...(current === undefined ? {} : { current }),
      });
      if (force || next.start !== current?.start || next.end !== current?.end) {
        if (moveBlocks(lvl, next, current !== undefined && !force)) blockWindows[lvl - 1] = next;
      }
      const content = inner(lvl), lens = q<HTMLElement>(`[data-lens='${lvl}']`);
      markBlocks(lvl, blocks, firstEntry, lastEntry);
      if (content !== null && lens !== null) {
        const first = content.querySelector<HTMLElement>(`[data-block="${next.start}"]`);
        const last = content.querySelector<HTMLElement>(`[data-block="${next.end - 1}"]`);
        const low = first?.offsetTop ?? 0, high = (last?.offsetTop ?? 0) + (last?.offsetHeight ?? 0);
        const range = lensRange(content, firstEntry, lastEntry, low, high);
        lens.style.top = px(range.top); lens.style.height = px(Math.max(0, range.bottom - range.top));
      }
      firstEntry = blocks[next.start]?.start ?? firstEntry;
      lastEntry = (blocks[next.end - 1]?.end ?? lastEntry + 1) - 1;
    }
    const thumb = q<HTMLElement>(".sui-tl-thumb"), dot = q<HTMLElement>(".sui-tl-dot"), cursor = q<HTMLElement>(".sui-tl-cur");
    if (thumb !== null && dot !== null && cursor !== null) {
      thumb.style.top = px(firstRow * TIMELINE_PITCH);
      thumb.style.height = px(Math.max(6, (lastRow - firstRow) * TIMELINE_PITCH));
      dot.style.top = cursor.style.top = px(reading * TIMELINE_PITCH);
    }
    for (const row of inView) if (!visible.includes(row)) {
      const element = q<HTMLElement>(`.sui-tl-row[data-row="${row}"]`);
      element?.removeAttribute("data-in"); element?.removeAttribute("aria-current");
      inView.delete(row);
    }
    for (const row of visible) if (!inView.has(row)) {
      const element = q<HTMLElement>(`.sui-tl-row[data-row="${row}"]`);
      element?.setAttribute("data-in", ""); element?.setAttribute("aria-current", "location");
      inView.add(row);
    }
    drawFunnels();
  };

  const positionRead = (target: { readonly id: string; readonly fraction: number; readonly center: boolean }) => {
    if (viewport === null) return false;
    const row = model.ids.indexOf(target.id);
    if (row < 0 || !boxes.some(item => item.row === row)) return false;
    rail.dataset.readingRow = String(row + target.fraction);
    const targetY = timelineToChat(boxes, row + target.fraction);
    const desired = targetY - (target.center ? viewport.clientHeight / 2 : 0);
    viewport.scrollTop = desired;
    rail.dataset.readingY = String(targetY);
    rail.dataset.readingScroll = String(viewport.scrollTop);
    // Clamping at either end is a live-edge read; let the transcript keep following there.
    readAnchor = Math.abs(viewport.scrollTop - desired) <= 1 ? { ...target, scroll: viewport.scrollTop } : undefined;
    return true;
  };
  const restoreRead = () => {
    if (pendingRead !== undefined && positionRead(pendingRead)) {
      pendingRead = undefined;
      rail.removeAttribute("data-navigation");
    }
  };
  const releaseRead = () => { readAnchor = undefined; pendingRead = undefined; rail.removeAttribute("data-navigation"); };
  const schedule = () => { if (frame === 0) frame = requestAnimationFrame(() => {
    frame = 0;
    if (pendingRead !== undefined) { measure(); restoreRead(); }
    else if (readAnchor !== undefined) { measure(); positionRead(readAnchor); }
    update();
  }); };
  const scrolled = () => {
    // Programmatic navigation elsewhere also releases the rail's reading anchor.
    if (pendingRead !== undefined && viewport !== null && viewport.scrollHeight === pendingRead.contentHeight && Math.abs(viewport.scrollTop - pendingRead.scroll) > 1) releaseRead();
    else if (readAnchor !== undefined && viewport !== null && Math.abs(viewport.scrollTop - readAnchor.scroll) > 1) readAnchor = undefined;
    schedule();
  };
  const mounted = new MutationObserver(() => { measure(); schedule(); });
  /** Keeps funnel lines on the columns while they slide. */
  let following = 0;
  const follow = (until: number) => {
    following = Math.max(following, until);
    const step = () => { drawFunnels(); if (performance.now() < following) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };

  const bind = () => {
    const next = viewportOf(rail);
    if (next === viewport) return;
    viewport?.removeEventListener("scroll", scrolled);
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) viewport?.removeEventListener(event, releaseRead);
    mounted.disconnect();
    viewport = next;
    if (viewport !== null) mounted.observe(viewport, { childList: true, subtree: true });
    viewport?.addEventListener("scroll", scrolled, { passive: true });
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) viewport?.addEventListener(event, releaseRead, { passive: true });
    if (viewport !== null) observer?.observe(viewport);
    const content = viewport?.firstElementChild;
    if (content) observer?.observe(content);
  };
  const remeasure = () => {
    const room = roomOf(rail);
    const host = rail.closest<HTMLElement>(".sui-timeline-disclosure");
    if (room !== undefined && host !== null) host.style.setProperty("--sui-timeline-room", px(room));
    measure();
    schedule();
    // Columns ease to a new width: the lines follow them there.
    follow(performance.now() + 320);
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(remeasure);
  observer?.observe(rail);
  observer?.observe(box);
  const transcript = rail.closest(".sui-chat-transcript");
  if (transcript) observer?.observe(transcript);
  const transcriptActivity = (event: Event) => {
    if (event.target instanceof Node && box.contains(event.target)) return;
    releaseRead();
  };
  for (const event of ["pointerdown", "click", "keydown", "wheel", "touchstart"]) transcript?.addEventListener(event, transcriptActivity, { capture: true, passive: true });
  window.addEventListener("resize", remeasure);

  const readRow = (requested: number, center: boolean) => {
    if (viewport === null || model.ids.length === 0) return;
    const row = Math.max(0, Math.min(model.ids.length, requested));
    const index = Math.min(model.ids.length - 1, Math.floor(row));
    const id = model.ids[index]!;
    const previous = pendingRead;
    pendingRead = { fraction: Math.min(1, row - index), center, id, scroll: viewport.scrollTop, contentHeight: viewport.scrollHeight };
    rail.dataset.readingRow = String(index + pendingRead.fraction);
    measure();
    if (boxes.some(item => item.row === index)) { restoreRead(); return; }
    rail.setAttribute("data-navigation", "pending");
    if (previous?.id !== id) model.onRequestHistory?.(id);
    schedule();
  };
  /** A y on an outer strip to the transcript: the mark under it, and how far down that mark. */
  const stripToRow = (content: HTMLElement, y: number) => {
    let best: { start: number; end: number; distance: number; fraction: number } | undefined;
    content.querySelectorAll<HTMLElement>(".sui-tl-sm").forEach(mark => {
      const top = (mark.closest<HTMLElement>("[data-block]")?.offsetTop ?? 0) + mark.offsetTop, bottom = top + mark.offsetHeight;
      const distance = y < top ? top - y : y > bottom ? y - bottom : 0;
      if (best !== undefined && distance >= best.distance) return;
      best = { start: Number(mark.dataset.start), end: Number(mark.dataset.end), distance, fraction: Math.max(0, Math.min(1, (y - top) / Math.max(1, bottom - top))) };
    });
    return best === undefined ? undefined : best.start + best.fraction * (best.end - best.start);
  };
  const down = (event: PointerEvent) => {
    releaseRead();
    const target = event.target as HTMLElement;
    const lens = target.dataset?.lens;
    if (target.classList?.contains("sui-tl-thumb") || target.classList?.contains("sui-tl-dot")) {
      const content = inner(0);
      if (content === null || viewport === null) return;
      drag = { level: 0, grab: event.clientY - content.getBoundingClientRect().top - timelineToRow(boxes, viewport.scrollTop) * TIMELINE_PITCH };
    } else if (lens !== undefined) {
      const rect = target.getBoundingClientRect();
      drag = { level: Number(lens), grab: event.clientY - (rect.top + rect.height / 2) };
    } else return;
    event.preventDefault();
    box.setPointerCapture?.(event.pointerId);
    rail.setAttribute("data-dragging", "");
  };
  const move = (event: PointerEvent) => {
    if (drag === undefined || viewport === null) return;
    if (drag.level === 0) {
      const content = inner(0);
      if (content === null || rowWindow === undefined) return;
      const y = event.clientY - content.getBoundingClientRect().top - drag.grab;
      const row = Math.max(rowWindow.start, Math.min(rowWindow.end, y / TIMELINE_PITCH));
      readRow(row, false);
      return;
    }
    const content = inner(drag.level);
    if (content === null) return;
    const row = stripToRow(content, event.clientY - content.getBoundingClientRect().top - drag.grab);
    if (row !== undefined) readRow(row, true);
  };
  const up = () => {
    if (drag === undefined) return;
    drag = undefined;
    rail.removeAttribute("data-dragging");
    update();
  };
  box.addEventListener("keydown", releaseRead, { capture: true });
  box.addEventListener("pointerdown", down);
  box.addEventListener("pointermove", move);
  box.addEventListener("pointerup", up);
  box.addEventListener("pointercancel", up);

  return {
    sync: next => {
      const grew = next.levels !== model.levels;
      model = next;
      if (pendingRead !== undefined && !next.ids.includes(pendingRead.id)) { pendingRead = undefined; rail.removeAttribute("data-navigation"); }
      if (readAnchor !== undefined && !next.ids.includes(readAnchor.id)) readAnchor = undefined;
      bind();
      remeasure();
      const rowsGone = rowWindow !== undefined && rowWindow.end > next.ids.length;
      if (rowsGone) rowWindow = undefined;
      blockWindows = blockWindows.map((window, index) => window !== undefined && window.end <= (columns()[index]?.length ?? 0) ? window : undefined);
      // Rows may have changed under their indices: nothing stays marked from before.
      box.querySelectorAll(".sui-tl-row[data-in]").forEach(row => { row.removeAttribute("data-in"); row.removeAttribute("aria-current"); });
      inView.clear();
      update(grew || rowWindow === undefined);
      if (grew) follow(performance.now() + 760);
    },
    dispose: () => {
      observer?.disconnect();
      mounted.disconnect();
      pendingRead = undefined; readAnchor = undefined;
      if (frame !== 0) cancelAnimationFrame(frame);
      viewport?.removeEventListener("scroll", scrolled);
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) viewport?.removeEventListener(event, releaseRead);
      window.removeEventListener("resize", remeasure);
      for (const event of ["pointerdown", "click", "keydown", "wheel", "touchstart"]) transcript?.removeEventListener(event, transcriptActivity, { capture: true });
      box.removeEventListener("keydown", releaseRead, { capture: true });
      box.removeEventListener("pointerdown", down);
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", up);
      box.removeEventListener("pointercancel", up);
    },
  };
};
