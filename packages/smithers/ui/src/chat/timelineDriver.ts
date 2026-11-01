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
  /** Widen the transcript history window; mounting is observed before restoring the requested position. */
  readonly onJump?: (id: string) => void;
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
  let blockWindow: TimelineWindow | undefined;
  let drag: { readonly kind: "thumb" | "lens1" | "lens2"; readonly grab: number } | undefined;
  let pendingRead: { readonly row: number; readonly center: boolean; readonly id: string } | undefined;
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

  const moveBlocks = (next: TimelineWindow, animate: boolean): boolean => {
    const content = inner(1), frameEl = clip(1);
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
    const lv0 = level(0), c0 = clip(0);
    if (lv0 === null || c0 === null) return;
    const frame0 = rect(c0), x0 = rect(lv0).left + 3.5;
    const outer = model.levels >= 2;
    track(0, outer ? `M${x0} ${frame0.top + CORNER} L${x0} ${frame0.bottom - CORNER}` : `M${x0} ${frame0.top} L${x0} ${frame0.bottom}`);
    if (!outer) { track(1, ""); track(2, ""); return; }
    funnel(1, q("[data-lens='1']"), x0, frame0.top, frame0.bottom);
    const lv1 = level(1), c1 = clip(1);
    if (lv1 === null || c1 === null) return;
    const frame1 = rect(c1), x1 = rect(lv1).left + 3.5;
    const third = model.levels >= 3 ? level(2) : null;
    track(1, third ? `M${x1} ${frame1.top + CORNER} L${x1} ${frame1.bottom - CORNER}` : `M${x1} ${frame1.top} L${x1} ${frame1.bottom}`);
    if (third === null) { track(2, ""); return; }
    funnel(2, q("[data-lens='2']"), x1, frame1.top, frame1.bottom);
    const x2 = rect(third).left + 3.5, height = box.clientHeight;
    track(2, `M${x2} 0 L${x2} ${height}`);
  };

  const update = (force = false) => {
    const count = model.ids.length;
    if (count === 0) return;
    const height = box.clientHeight;
    if (height !== layoutHeight || box.clientWidth !== layoutWidth) {
      layoutHeight = height; layoutWidth = box.clientWidth;
      rowWindow = undefined; blockWindow = undefined;
      force = true;
    }
    const top = viewport?.scrollTop ?? 0, bottom = top + (viewport?.clientHeight ?? 0);
    const firstRow = timelineToRow(boxes, top), lastRow = timelineToRow(boxes, bottom), reading = timelineToRow(boxes, (top + bottom) / 2);
    const firstIndex = boxes.length === 0 ? -1 : timelineSearch(tops, top);
    const lastIndex = boxes.length === 0 ? -1 : timelineSearch(tops, bottom);
    const visible = boxes.length === 0 ? [] : boxes.slice(boxes[firstIndex]!.bottom < top && firstIndex < boxes.length - 1 ? firstIndex + 1 : firstIndex, lastIndex + 1).map(item => item.row);
    const vf = visible[0] ?? 0, vl = visible.at(-1) ?? vf;
    const nextRows = drag?.kind === "thumb" && rowWindow !== undefined ? rowWindow : timelineRowWindow({
      count, levels: model.levels, height, first: vf, last: vl, reading, force: force || (drag !== undefined), ask: row => model.asks[row] === true,
      blockStart: row => model.spans[blockOf(model.spans, row)]?.start ?? row,
      ...(rowWindow === undefined ? {} : { current: rowWindow }),
    });
    if (force || nextRows.start !== rowWindow?.start || nextRows.end !== rowWindow?.end) { const animate = rowWindow !== undefined && !force; rowWindow = nextRows; moveRows(nextRows, animate); }
    const firstBlock = blockOf(model.spans, rowWindow.start), lastBlock = blockOf(model.spans, rowWindow.end - 1);
    if (model.levels >= 2) {
      const nextBlocks = timelineBlockWindow({
        count: model.spans.length, levels: model.levels, height, first: firstBlock, last: lastBlock,
        force: force || drag?.kind === "lens2", ...(blockWindow === undefined ? {} : { current: blockWindow }),
      });
      if (force || nextBlocks.start !== blockWindow?.start || nextBlocks.end !== blockWindow?.end) { if (moveBlocks(nextBlocks, blockWindow !== undefined && !force)) blockWindow = nextBlocks; }
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
    if (model.levels >= 2) {
      const content = inner(1), lens = q<HTMLElement>("[data-lens='1']");
      markBlocks(1, model.spans, rowWindow.start, rowWindow.end - 1);
      if (content !== null && lens !== null && blockWindow !== undefined) {
        const firstEl = content.querySelector<HTMLElement>(`[data-block="${blockWindow.start}"]`);
        const lastEl = content.querySelector<HTMLElement>(`[data-block="${blockWindow.end - 1}"]`);
        const lo = firstEl?.offsetTop ?? 0, hi = (lastEl?.offsetTop ?? 0) + (lastEl?.offsetHeight ?? 0);
        const range = lensRange(content, rowWindow.start, rowWindow.end - 1, lo, hi);
        lens.style.top = px(range.top); lens.style.height = px(Math.max(0, range.bottom - range.top));
      }
    }
    if (model.levels >= 3 && blockWindow !== undefined) {
      const content = inner(2), lens = q<HTMLElement>("[data-lens='2']");
      const span0 = model.spans[blockWindow.start], span1 = model.spans[blockWindow.end - 1];
      if (content !== null && lens !== null && span0 !== undefined && span1 !== undefined) {
        markBlocks(2, model.arcs, span0.start, span1.end - 1);
        const range = lensRange(content, span0.start, span1.end - 1, 0, box.clientHeight);
        lens.style.top = px(range.top); lens.style.height = px(Math.max(0, range.bottom - range.top));
      }
    }
    drawFunnels();
  };

  const restoreRead = () => {
    if (pendingRead === undefined || viewport === null) return;
    const row = Math.floor(pendingRead.row);
    if (!boxes.some(item => item.row === row)) return;
    viewport.scrollTop = timelineToChat(boxes, pendingRead.row) - (pendingRead.center ? viewport.clientHeight / 2 : 0);
    pendingRead = undefined;
    rail.removeAttribute("data-navigation");
  };
  const schedule = () => { if (frame === 0) frame = requestAnimationFrame(() => {
    frame = 0;
    if (pendingRead !== undefined) { measure(); restoreRead(); }
    update();
  }); };
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
    viewport?.removeEventListener("scroll", schedule);
    mounted.disconnect();
    viewport = next;
    if (viewport !== null) mounted.observe(viewport, { childList: true, subtree: true });
    viewport?.addEventListener("scroll", schedule, { passive: true });
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
  window.addEventListener("resize", remeasure);

  const readRow = (requested: number, center: boolean) => {
    if (viewport === null || model.ids.length === 0) return;
    const row = Math.max(0, Math.min(model.ids.length - Number.EPSILON, requested));
    const index = Math.min(model.ids.length - 1, Math.floor(row));
    const id = model.ids[index]!;
    const previous = pendingRead;
    pendingRead = { row: Math.min(row, index + .999999), center, id };
    measure();
    if (boxes.some(item => item.row === index)) { restoreRead(); return; }
    rail.setAttribute("data-navigation", "pending");
    if (previous?.id !== id) model.onJump?.(id);
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
    const target = event.target as HTMLElement;
    const lens = target.dataset?.lens;
    if (target.classList?.contains("sui-tl-thumb") || target.classList?.contains("sui-tl-dot")) {
      const content = inner(0);
      if (content === null || viewport === null) return;
      drag = { kind: "thumb", grab: event.clientY - content.getBoundingClientRect().top - timelineToRow(boxes, viewport.scrollTop) * TIMELINE_PITCH };
    } else if (lens !== undefined) {
      const rect = target.getBoundingClientRect();
      drag = { kind: lens === "1" ? "lens1" : "lens2", grab: event.clientY - (rect.top + rect.height / 2) };
    } else return;
    event.preventDefault();
    box.setPointerCapture?.(event.pointerId);
    rail.setAttribute("data-dragging", "");
  };
  const move = (event: PointerEvent) => {
    if (drag === undefined || viewport === null) return;
    if (drag.kind === "thumb") {
      const content = inner(0);
      if (content === null || rowWindow === undefined) return;
      const y = event.clientY - content.getBoundingClientRect().top - drag.grab;
      const row = Math.max(rowWindow.start, Math.min(rowWindow.end, y / TIMELINE_PITCH));
      readRow(row, false);
      return;
    }
    const content = inner(drag.kind === "lens1" ? 1 : 2);
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
  box.addEventListener("pointerdown", down);
  box.addEventListener("pointermove", move);
  box.addEventListener("pointerup", up);
  box.addEventListener("pointercancel", up);

  return {
    sync: next => {
      const grew = next.levels !== model.levels;
      model = next;
      bind();
      remeasure();
      const rowsGone = rowWindow !== undefined && rowWindow.end > next.ids.length;
      if (rowsGone) rowWindow = undefined;
      if (blockWindow !== undefined && blockWindow.end > next.spans.length) blockWindow = undefined;
      // Rows may have changed under their indices: nothing stays marked from before.
      box.querySelectorAll(".sui-tl-row[data-in]").forEach(row => { row.removeAttribute("data-in"); row.removeAttribute("aria-current"); });
      inView.clear();
      update(grew || rowWindow === undefined);
      if (grew) follow(performance.now() + 760);
    },
    dispose: () => {
      observer?.disconnect();
      mounted.disconnect();
      pendingRead = undefined;
      if (frame !== 0) cancelAnimationFrame(frame);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", remeasure);
      box.removeEventListener("pointerdown", down);
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", up);
      box.removeEventListener("pointercancel", up);
    },
  };
};
