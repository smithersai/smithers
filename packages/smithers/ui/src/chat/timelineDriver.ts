import {
  timelineBlockLayout, timelineBlockWindow, timelineEstimate, timelineLabels, timelineOffsets, timelineRowAt, timelineRowLayout, timelineRowWindow,
  timelineSearch, timelineToChat, timelineToRow, timelineTrack,
  type TimelineBlock, type TimelineBox, type TimelineSize, type TimelineWindow,
} from "./timelineZoom";

// What moves with the chat. Scrolling must not re-render a rail of hundreds of rows, so React draws the rows and blocks
// and this driver moves the windows, thumb, lens and funnel lines directly: the mock's `update`, as one function.

/** The rail as drawn: entries and the blocks of each outer level, in order. */
export interface TimelineModel {
  readonly ids: readonly string[];
  readonly asks: readonly boolean[];
  /** Each entry's length in characters: its size until it has been measured. */
  readonly lengths?: readonly number[];
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
const MOVE = "260ms";
/** Inter's mean advance at the rail's sizes: how many lines a label wants, before anything is drawn. */
const LABEL_CHAR = 5.6;
const TITLE_LINE = 12;

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

export const timelineDriver = (rail: HTMLElement, box: HTMLElement, scrollByReader?: (delta: number) => void): TimelineDriver => {
  let model: TimelineModel = { ids: [], asks: [], levels: 0, spans: [], arcs: [] };
  let boxes: readonly TimelineBox[] = [];
  let tops: readonly number[] = [];
  /** Every entry measured so far, kept after it unmounts so the rail never falls back to its estimate. */
  const known = new Map<string, TimelineSize>();
  let sizes: readonly TimelineSize[] = [];
  let offsets: readonly number[] = [0];
  /** The position scale has changed since the columns were laid out. */
  let stale = true;
  let rows: ReturnType<typeof timelineRowLayout> | undefined;
  let rowWindow: TimelineWindow | undefined;
  let blockWindows: (TimelineWindow | undefined)[] = [];
  const blockLayouts: (ReadonlyArray<{ readonly top: number; readonly height: number }> | undefined)[] = [];
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

  /** Rebuilds the position scale. Held during a drag: the thumb must not move under the pointer. */
  const scaleUp = () => {
    if (drag !== undefined) return;
    const next = model.ids.map((id, row) => known.get(id) ?? timelineEstimate(model.lengths?.[row] ?? 0));
    if (next.length === sizes.length && next.every((size, row) => Math.abs(size.height - sizes[row]!.height) < .5 && Math.abs(size.advance - sizes[row]!.advance) < .5)) return;
    sizes = next; offsets = timelineOffsets(next); stale = true;
  };

  /** Each entry mounted in the transcript, as content coordinates; the host's window may hold fewer than the rail. */
  const measure = () => {
    if (viewport === null) { boxes = []; tops = []; scaleUp(); return; }
    const origin = viewport.getBoundingClientRect().top - viewport.scrollTop;
    boxes = model.ids.flatMap((id, row) => {
      const element = document.getElementById(id);
      if (element === null) return [];
      const rect = element.getBoundingClientRect();
      return [{ row, top: rect.top - origin, bottom: rect.bottom - origin }];
    });
    tops = boxes.map(item => item.top);
    boxes.forEach((item, index) => {
      const next = boxes[index + 1], height = item.bottom - item.top, id = model.ids[item.row]!;
      const gap = known.get(id) ?? timelineEstimate(0);
      const advance = next?.row === item.row + 1 ? next.top - item.top : item.row === model.ids.length - 1 ? height : height + gap.advance - gap.height;
      known.set(id, { height, advance });
    });
    scaleUp();
  };

  /** Lays level 0 out on the position scale. A row outside the window stays on it too, so paging slides, clipped. */
  const layRows = (window: TimelineWindow, animate: boolean) => {
    const content = inner(0), frameEl = clip(0);
    if (content === null || frameEl === null) return;
    const height = box.clientHeight, layout = timelineRowLayout(sizes, offsets, window, height);
    rows = layout;
    content.style.setProperty("--sui-tl-move", animate ? MOVE : "0ms");
    frameEl.style.transition = animate ? "" : "none";
    const elements = [...box.querySelectorAll<HTMLElement>(".sui-tl-row")];
    const text = Math.max(1, content.clientWidth - 24);
    const inWindow = elements.filter(element => { const row = Number(element.dataset.row); return row >= window.start && row < window.end; });
    const labels = timelineLabels(inWindow.map(element => {
      const mark = layout.marks[Number(element.dataset.row)]!;
      return { y: mark.y, height: mark.height, urgent: !["done", "queued"].includes(element.dataset.state ?? "done"),
        lines: Math.min(2, Math.ceil((element.querySelector(".sui-tl-tx")?.textContent?.length ?? 0) * LABEL_CHAR / text)) || 1 };
    }), height);
    let bottom = layout.height;
    for (const element of elements) {
      const row = Number(element.dataset.row), mark = layout.marks[row]!;
      element.style.top = px(mark.y); element.style.height = px(mark.height); element.style.zIndex = String(sizes.length - row);
      element.tabIndex = row === window.start ? 0 : -1;
      const label = labels[inWindow.indexOf(element)];
      const tx = element.querySelector<HTMLElement>(".sui-tl-tx"), lead = element.querySelector<HTMLElement>(".sui-tl-lead");
      if (label?.visible !== true) { element.dataset.label = "hidden"; lead?.removeAttribute("data-on"); continue; }
      delete element.dataset.label;
      const shift = label.y - mark.y;
      bottom = Math.max(bottom, label.y + label.lines * 14);
      if (tx !== null) { tx.style.top = px(shift); tx.style.setProperty("--sui-tl-lines", String(label.lines)); }
      if (lead !== null) {
        if (Math.abs(shift) > 2) { lead.dataset.on = ""; lead.style.height = px(Math.max(0, shift) + 7); } else lead.removeAttribute("data-on");
      }
    }
    frameEl.style.height = px(height > 0 ? Math.min(height, bottom) : bottom);
    frameEl.dataset.windowStart = String(window.start); frameEl.dataset.windowEnd = String(window.end);
  };

  /** Lays one outer column out for its window: blocks, the strip marks inside them, and how much of a title fits. */
  const layBlocks = (lvl: number, blocks: readonly TimelineBlock[], window: TimelineWindow, animate: boolean): boolean => {
    const content = inner(lvl), frameEl = clip(lvl);
    if (content === null || frameEl === null) return false;
    const items = [...content.querySelectorAll<HTMLElement>("[data-block]")];
    if (items.length === 0) return false;
    const layout = timelineBlockLayout(blocks.map(block => offsets[block.end]! - offsets[block.start]!), window, box.clientHeight);
    blockLayouts[lvl - 1] = layout;
    content.style.setProperty("--sui-tl-move", animate ? MOVE : "0ms");
    frameEl.style.transition = animate ? "" : "none";
    items.forEach(item => {
      const index = Number(item.dataset.block), block = blocks[index], place = layout[index];
      if (block === undefined || place === undefined) return;
      item.style.top = px(place.top); item.style.height = px(place.height);
      item.querySelector<HTMLElement>(".sui-tl-tx")?.style.setProperty("--sui-tl-lines", String(Math.max(1, Math.floor(place.height / TITLE_LINE))));
      const span = Math.max(1, offsets[block.end]! - offsets[block.start]!);
      item.querySelectorAll<HTMLElement>(".sui-tl-sm").forEach(mark => {
        const start = Number(mark.dataset.start), end = Number(mark.dataset.end);
        mark.style.top = px((offsets[start]! - offsets[block.start]!) / span * place.height);
        mark.style.height = px(Math.max(1.5, (offsets[end]! - offsets[start]!) / span * place.height - 1));
      });
    });
    const last = layout[window.end - 1];
    frameEl.style.height = px(last === undefined ? 0 : last.top + last.height);
    frameEl.dataset.windowStart = String(window.start); frameEl.dataset.windowEnd = String(window.end);
    return true;
  };

  const blockOf = (blocks: readonly TimelineBlock[], row: number) => {
    const found = timelineSearch(blocks.map(block => block.start), row);
    return Math.max(0, found);
  };

  /** Where a fractional spot in `row` falls on outer level `lvl`: the same scale, inside the block that covers it. */
  const blockY = (lvl: number, blocks: readonly TimelineBlock[], row: number, fraction: number) => {
    const index = blockOf(blocks, row), block = blocks[index]!, place = blockLayouts[lvl - 1]?.[index];
    if (place === undefined) return 0;
    const at = offsets[row]! + fraction * (offsets[row + 1]! - offsets[row]!) - offsets[block.start]!;
    return place.top + at / Math.max(1, offsets[block.end]! - offsets[block.start]!) * place.height;
  };

  const markStrips = (content: HTMLElement, first: number, last: number) => {
    content.querySelectorAll<HTMLElement>(".sui-tl-sm").forEach(mark => {
      const hit = Number(mark.dataset.end) > first && Number(mark.dataset.start) <= last;
      if (hit) mark.setAttribute("data-in", ""); else mark.removeAttribute("data-in");
    });
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
      // Level 0's track ends with its window; a last label may hang below that, inside the clip.
      const framed = rect(frame), bounds = lvl === 0 && rows !== undefined ? { ...framed, bottom: framed.top + rows.height } : framed, x = rect(column).left + 3.5;
      const corner = lvl < model.levels - 1 ? CORNER : 0;
      track(lvl, `M${x} ${bounds.top + corner} L${x} ${Math.max(bounds.top + corner, bounds.bottom - corner)}`);
      if (lvl > 0) {
        const lower = level(lvl - 1), lowerClip = clip(lvl - 1);
        if (lower !== null && lowerClip !== null) {
          const bounds = rect(lowerClip), bottom = lvl === 1 && rows !== undefined ? bounds.top + rows.height : bounds.bottom;
          funnel(lvl, q(`[data-lens='${lvl}']`), rect(lower).left + 3.5, bounds.top, bottom);
        }
      }
    }
    box.querySelectorAll<SVGPathElement>(".sui-tl-trk").forEach(path => {
      if (Number(path.dataset.t) >= model.levels) path.setAttribute("d", "");
    });
  };

  /** A position on the scale to a y in level 0's column. */
  const railY = (position: number) => rows === undefined ? 0 : (position - rows.base) * rows.scale;

  const update = (force = false) => {
    const count = model.ids.length;
    if (count === 0) return;
    const height = box.clientHeight;
    if (height !== layoutHeight || box.clientWidth !== layoutWidth) {
      layoutHeight = height; layoutWidth = box.clientWidth;
      rail.dataset.layoutHeight = String(layoutHeight); rail.dataset.layoutWidth = String(layoutWidth);
      rowWindow = undefined; blockWindows = [];
      force = true;
    }
    const top = viewport?.scrollTop ?? 0, bottom = top + (viewport?.clientHeight ?? 0);
    const reading = timelineToRow(boxes, (top + bottom) / 2);
    const firstIndex = boxes.length === 0 ? -1 : timelineSearch(tops, top);
    const lastIndex = boxes.length === 0 ? -1 : timelineSearch(tops, bottom);
    const visible = boxes.length === 0 ? [] : boxes.slice(boxes[firstIndex]!.bottom < top && firstIndex < boxes.length - 1 ? firstIndex + 1 : firstIndex, lastIndex + 1).map(item => item.row);
    const vf = visible[0] ?? 0, vl = visible.at(-1) ?? vf;
    const nextRows = drag?.level === 0 && rowWindow !== undefined ? rowWindow : timelineRowWindow({
      count, levels: model.levels, height, first: vf, last: vl, reading, force: force || (drag !== undefined), ask: row => model.asks[row] === true,
      blockStart: row => model.spans[blockOf(model.spans, row)]?.start ?? row,
      ...(rowWindow === undefined ? {} : { current: rowWindow }),
    });
    const animate = rowWindow !== undefined && !force, paged = force || nextRows.start !== rowWindow?.start || nextRows.end !== rowWindow?.end;
    const lay = paged || stale;
    rowWindow = nextRows;
    if (lay) layRows(nextRows, animate && drag === undefined);
    stale = false;
    if (paged && animate) follow(performance.now() + 280);
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
      if (lay || next.start !== current?.start || next.end !== current?.end) {
        if (layBlocks(lvl, blocks, next, current !== undefined && !force && drag === undefined)) blockWindows[lvl - 1] = next;
      }
      const content = inner(lvl), lens = q<HTMLElement>(`[data-lens='${lvl}']`);
      markBlocks(lvl, blocks, firstEntry, lastEntry);
      if (content !== null) markStrips(content, firstEntry, lastEntry);
      if (lens !== null) {
        const low = blockY(lvl, blocks, firstEntry, 0), high = blockY(lvl, blocks, lastEntry, 1);
        lens.style.top = px(low); lens.style.height = px(Math.max(4, high - low));
      }
      firstEntry = blocks[next.start]?.start ?? firstEntry;
      lastEntry = (blocks[next.end - 1]?.end ?? lastEntry + 1) - 1;
    }
    const thumb = q<HTMLElement>(".sui-tl-thumb"), dot = q<HTMLElement>(".sui-tl-dot"), cursor = q<HTMLElement>(".sui-tl-cur");
    if (thumb !== null && dot !== null && cursor !== null) {
      const rail = (y: number) => railY(timelineTrack(boxes, offsets, y));
      thumb.style.top = px(rail(top));
      thumb.style.height = px(Math.max(6, rail(bottom) - rail(top)));
      dot.style.top = cursor.style.top = px(rail((top + bottom) / 2));
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
      drag = { level: 0, grab: event.clientY - content.getBoundingClientRect().top - railY(timelineTrack(boxes, offsets, viewport.scrollTop)) };
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
      if (content === null || rowWindow === undefined || rows === undefined) return;
      const y = event.clientY - content.getBoundingClientRect().top - drag.grab;
      const row = timelineRowAt(sizes, offsets, rows.base + y / rows.scale);
      readRow(Math.max(rowWindow.start, Math.min(rowWindow.end, row)), false);
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
    scaleUp();
    update();
  };
  const wheel = (event: WheelEvent) => {
    if (viewport === null || event.ctrlKey || event.deltaY === 0) return;
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? parseFloat(getComputedStyle(viewport).lineHeight) || 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1;
    event.preventDefault();
    releaseRead();
    const delta = event.deltaY * unit;
    if (scrollByReader) scrollByReader(delta);
    else viewport.scrollTop += delta;
  };
  rail.addEventListener("wheel", wheel, { passive: false });
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
      stale = true;
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
      rail.removeEventListener("wheel", wheel);
      box.removeEventListener("keydown", releaseRead, { capture: true });
      box.removeEventListener("pointerdown", down);
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", up);
      box.removeEventListener("pointercancel", up);
    },
  };
};
