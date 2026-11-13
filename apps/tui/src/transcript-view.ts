/**
 * The chat transcript as it shows: its rows with the workers it delegated as
 * host-owned cards between them, its scroll, the card `tab` focuses, and the
 * activity scrubber's selection. Moving the selection aims the scroll at the
 * step it lands on, in the chat or in the worker's own tab.
 */
import type { CliRenderer, MouseEvent, ScrollBoxRenderable } from "@opentui/core"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"
import type * as Activity from "./activity.ts"
import * as DragScroll from "./drag-scroll.ts"
import type { Run } from "./flows.ts"
import type * as Panels from "./panels.ts"
import * as RunCard from "./run-card.ts"
import * as Scrubber from "./scrubber.ts"
import * as Subagents from "./subagents.ts"
import { tabTitle } from "./surfaces.ts"
import { lane as laneColor } from "./theme.ts"
import * as Timeline from "./timeline.ts"
import * as Timer from "./timer.ts"
import * as Transcript from "./transcript.ts"
import type { Tab } from "./workspace.ts"

interface Source {
  readonly id: string
  readonly title: string
  readonly activity: Activity.Activity
}

/** The chat's own activity source; a worker's is its tab id. */
const chat = "chat"

/** A transcript row's identity and where it sat relative to the viewport top. */
interface Anchor {
  readonly key: string
  readonly offset: number
  readonly height: number
}
/**
 * Rows as seen from the scroll offset `top`, whether that was the live bottom,
 * and the box's own largest offset then, which shrinking content lowers.
 */
interface Position {
  readonly bottom: boolean
  readonly top: number
  readonly max: number
  readonly anchors: ReadonlyArray<Anchor>
}
/** Distance from the viewport's top edge; zero for the row covering it. */
const edge = (anchor: Anchor): number =>
  anchor.offset <= 0 && anchor.offset + anchor.height > 0 ? 0 : Math.abs(anchor.offset)
/** The box's largest scroll offset: hiding programs lowers it. */
const furthest = (box: ScrollBoxRenderable): number => Math.max(0, box.scrollHeight - box.viewport.height)
/**
 * The same rows from a newer scroll offset: a reader's scroll moves every row
 * alike. Shorter content pulling the offset down to the box's new end is the
 * box clamping itself, which asks for nothing and leaves the rows alone.
 */
const rebase = (position: Position, top: number, max: number): Position =>
  top === position.top || (top >= max && max < position.max) ? { ...position, top, max } : {
    // Scrolling up leaves the live bottom; the anchors then place the view.
    bottom: position.bottom && top >= position.top,
    top,
    max,
    anchors: position.anchors.map((anchor) => ({ ...anchor, offset: anchor.offset - (top - position.top) }))
  }

export const useTranscriptView = (options: {
  readonly renderer: CliRenderer
  /** Disclosure chrome belongs to this conversation. */
  readonly conversation: string
  /** The chat's own transcript. */
  readonly transcript: Transcript.Transcript
  readonly tabs: ReadonlyArray<Tab>
  readonly runs?: ReadonlyArray<Run>
  /** A worker's transcript. */
  readonly worker: (id: string) => Transcript.Transcript
  readonly filter: Timeline.Filter
  /** Ctrl+O: every cell draws its program. */
  readonly expanded: boolean
  readonly surface: string
  /** The shown surface's panel; the chat shows none. */
  readonly panel: Panels.Panel | undefined
  readonly setPanelFocus: (focus: boolean) => void
  readonly panelFocus: boolean
  /** The width available to the host cards. */
  readonly width: number
}) => {
  const { renderer, transcript, tabs, worker, filter, surface, panel, setPanelFocus, panelFocus } = options
  /** The chat card `tab` focused, by its key; `enter` opens it. */
  const [cardFocus, setCardFocus] = useState<string | undefined>()
  const [earlierOpened, setEarlierOpened] = useState<ReadonlySet<string>>(() => new Set())
  const earlierContext = (parent?: string) => JSON.stringify([options.conversation, parent ?? null])
  const earlierOpen = (parent?: string) => earlierOpened.has(earlierContext(parent))
  const showEarlier = (parent?: string) => {
    setCardFocus(undefined)
    setEarlierOpened((before) => new Set([...before, earlierContext(parent)]))
  }
  const [inspection, setInspection] = useState<
    { source: string; seq: number; first: Activity.Activity["records"][number] } | undefined
  >()
  const [inspectionInterrupted, setInspectionInterrupted] = useState(false)
  /** The surface inspection owns, including its own jumps between views. */
  const inspectionSurface = useRef<string | undefined>(undefined)
  const previousSurface = useRef(surface)
  const scroll = useRef<ScrollBoxRenderable>(null)
  const workerScroll = useRef<ScrollBoxRenderable | null>(null)
  // Keep a message at the viewport edge when its programs change height.
  // Native row positions settle on renderer frames, after React's commit.
  const viewportPosition = useRef<Position | undefined>(undefined)
  const pendingPosition = useRef<Position | undefined>(undefined)
  const cancelPosition = useCallback(() => {
    pendingPosition.current = undefined
  }, [])
  const program = options.expanded || Timeline.program(filter)
  useLayoutEffect(() => {
    const saved = viewportPosition.current
    if (surface !== "chat" || saved === undefined) return
    // Keys and the wheel reach the box before this commit's frame, so restore
    // the position the reader scrolled to, not the one last drawn.
    const box = scroll.current
    pendingPosition.current = box === null ? saved : rebase(saved, box.scrollTop, furthest(box))
  }, [program, options.width])
  useLayoutEffect(() => {
    viewportPosition.current = undefined
    pendingPosition.current = undefined
    if (surface !== "chat" || panel !== undefined) return
    const frame = () => {
      const box = scroll.current
      if (box === null) return
      const pending = pendingPosition.current
      if (pending !== undefined) {
        // Scrolling away from the aimed position is the reader's newer intent:
        // carry it, so the correction lands where they scrolled to.
        const aimed = rebase(pending, box.scrollTop, furthest(box))
        const anchor = [...aimed.anchors].sort((a, b) => edge(a) - edge(b) || b.offset - a.offset).find(
          ({ key, offset }) => {
            const child = box.content.findDescendantById(key)
            return child !== undefined && child.height > 0 && offset > -child.height
          }
        )
        const child = anchor === undefined ? undefined : box.content.findDescendantById(anchor.key)
        const bottom = furthest(box)
        const target = aimed.bottom ?
          bottom
          : anchor === undefined || child === undefined ?
          box.scrollTop
          : Math.min(bottom, Math.max(0, box.scrollTop + child.y - box.viewport.y - anchor.offset))
        if (box.scrollTop !== target) {
          box.scrollTop = target
          // Read the box back: native clamping is not the reader scrolling.
          pendingPosition.current = { ...aimed, top: box.scrollTop, max: furthest(box) }
        } else pendingPosition.current = undefined
      }
      // Save row identities and their offset from the viewport edge for the
      // next toggle. A hidden program falls back to the nearest surviving row.
      const anchors = box.getChildren().filter((child) => child.height > 0).map((child) => ({
        key: child.id,
        offset: child.y - box.viewport.y,
        height: child.height
      }))
      viewportPosition.current = {
        bottom: box.scrollTop >= furthest(box),
        top: box.scrollTop,
        max: furthest(box),
        anchors
      }
    }
    renderer.on("frame", frame)
    return () => {
      renderer.off("frame", frame)
    }
  }, [renderer, options.conversation, surface, panel])
  /** Inspection borrows navigation; closing gives back the exact view it borrowed. */
  const origin = useRef<{ surface: string; panelFocus: boolean; scrollTop: number } | undefined>(undefined)
  const restore = useRef<{ surface: string; scrollTop: number } | undefined>(undefined)
  const viewport = () => surface.startsWith("tab:") ? workerScroll.current : scroll.current
  const [liveEdge, setLiveEdge] = useState(0)
  useLayoutEffect(() => {
    const position = restore.current
    if (position === undefined || position.surface !== surface) return
    const box = viewport()
    if (box === null) return
    box.scrollTop = position.scrollTop
    // Native layout settles after React has mounted a returned tab.
    return Timer.after(60, () => {
      if (restore.current !== position) return
      restore.current = undefined
      const returned = viewport()
      if (returned !== null) returned.scrollTop = position.scrollTop
    })
  }, [surface, inspection])
  useLayoutEffect(() => {
    if (liveEdge === 0) return
    const follow = () => {
      const box = viewport()
      if (box === null) return
      box.scrollTop = box.scrollHeight
      // Short panes can fit only the steering label and trailing padding at
      // the bottom. Keep the submitted text itself in the viewport.
      const shown = surface.startsWith("tab:") ? worker(surface.slice(4)) : transcript
      const message = shown.items.findLast((item) => item.kind === "user")
      if (message !== undefined) box.scrollChildIntoView(`${message.id}:text`)
    }
    follow()
    // The aim lands on the next native frame. Layout that settles later moves
    // nothing or keeps the bottom (sticky scroll), and then the edge is aimed
    // again. A reader who scrolled up in between has newer intent: keep it.
    let landed: number | undefined
    const land = () => {
      renderer.off("frame", land)
      landed = viewport()?.scrollTop
    }
    renderer.on("frame", land)
    const cancel = Timer.after(60, () => {
      renderer.off("frame", land)
      const box = viewport()
      if (box === null || landed === undefined || box.scrollTop === landed || box.scrollTop >= furthest(box)) follow()
      setLiveEdge(0)
    })
    return () => {
      renderer.off("frame", land)
      cancel()
    }
  }, [liveEdge, surface])
  const pendingReveal = useRef<
    {
      inspection: NonNullable<typeof inspection>
      timer: Timer.Cancel
    } | undefined
  >(undefined)
  const cancelReveal = useCallback(() => {
    if (pendingReveal.current === undefined) return
    pendingReveal.current.timer()
    pendingReveal.current = undefined
  }, [])
  useLayoutEffect(() => cancelReveal, [cancelReveal])
  useLayoutEffect(() => {
    if (previousSurface.current === surface) return
    previousSurface.current = surface
    if (restore.current?.surface !== surface) restore.current = undefined
    if (origin.current !== undefined && inspectionSurface.current !== surface) {
      cancelReveal()
      origin.current = undefined
      inspectionSurface.current = undefined
      setInspection(undefined)
      // The first dismissal closes the interrupted inspection in this view.
      setInspectionInterrupted(true)
    } else if (inspectionSurface.current === undefined) {
      setInspectionInterrupted(false)
    }
  }, [surface, cancelReveal])

  /** A worker's lane color: its card rail, its crumb and its steering accent. */
  const lane = (id: string): string => laneColor(Math.max(0, tabs.findIndex((tab) => tab.id === id)))
  const chatRows = useMemo(() => Timeline.cached(), [])
  const drawsProgram = options.expanded || Timeline.program(filter)
  // A fresh projection on every render would miss the row cache, which keys on identity.
  const liveProjectedChat = useMemo(() => RunCard.chat(transcript, drawsProgram), [transcript, drawsProgram])

  const activitySources = [
    { id: chat, title: "Chat", activity: transcript.activity },
    ...tabs.map((tab) => ({ id: tab.id, title: tabTitle(tab), activity: worker(tab.id).activity }))
  ].filter((source): source is Source => source.activity !== undefined && source.activity.records.length > 0)
  // A new turn or restored session cannot inherit a cursor from an old turn.
  const pinnedActivity = activitySources.find((source) =>
    source.id === inspection?.source &&
    source.activity.records[0] === inspection.first
  )
  const monitored = surface === "chat" ?
    liveProjectedChat.activity === undefined ? undefined : activitySources.find((source) => source.id === chat)
    : surface.startsWith("tab:") ?
    activitySources.find((source) => source.id === surface.slice(4))
    : undefined
  const showActivity = monitored !== undefined && (panel === undefined || surface.startsWith("tab:"))
  const activeInspection = showActivity && pinnedActivity === monitored ? inspection : undefined
  const inspectedAt = activeInspection === undefined ?
    undefined :
    monitored?.activity.records.findLast((record) => record.sequence! <= activeInspection.seq)?.occurredAt
  const shownTranscript = Transcript.inspect(
    transcript,
    activeInspection?.source === chat ? activeInspection.seq : undefined
  )
  const inspected = activeInspection === undefined ?
    undefined :
    Transcript.inspect(
      activeInspection.source === chat ? transcript : worker(activeInspection.source),
      activeInspection.seq
    )
  // Other runs have independent clocks and sequence spaces. A recorded request
  // proves their presence; their live results do not prove a historical outcome.
  const requested = (flow: string) =>
    new Map(
      (inspected?.activity?.records ?? []).flatMap((record) => {
        const payload = record.payload as { flowName?: string; input?: Record<string, unknown> } | undefined
        return record.kind === "control.agent.cell-call-started" && payload?.flowName === flow &&
            typeof payload.input?.id === "string"
          ? [[payload.input.id, { input: payload.input, at: record.occurredAt ?? 0 }] as const] :
          []
      })
    )
  const requestedTabs = requested("agent.delegate")
  const requestedRuns = requested("smithers.run")
  const shownWorker = (id: string) =>
    activeInspection === undefined ?
      worker(id) :
      activeInspection.source === id
      ? inspected!
      : Transcript.empty
  const shownTabs: ReadonlyArray<Tab> = activeInspection === undefined ?
    tabs :
    tabs.filter((tab) => tab.id === activeInspection.source || requestedTabs.has(tab.id)).map((tab): Tab => {
      const shown = shownWorker(tab.id)
      const own = tab.id === activeInspection.source
      const request = requestedTabs.get(tab.id)
      const user = shown.items.findLast((item) => item.kind === "user" && item.queued !== true)
      const prompt = own ?
        user?.kind === "user" ? user.text : "" :
        typeof request?.input.prompt === "string"
        ? request.input.prompt
        : ""
      const title = own ?
        prompt.split("\n")[0]!.slice(0, 80) :
        typeof request?.input.title === "string"
        ? request.input.title
        : prompt.slice(0, 80)
      const seat = own ?
        (shown.activity?.records.findLast((record) =>
          ["control.agent.turn-opened", "control.agent.model-requested", "control.agent.model-selected"].includes(
            record.kind ?? ""
          )
        )?.payload as { seat?: unknown } | undefined)?.seat :
        request?.input.model
      const status = own ? shown.activity?.status ?? "running" : "requested"
      const answer = shown.items.findLast((item) => item.kind === "answer")
      return {
        id: tab.id,
        file: tab.file,
        parent: own ? undefined : activeInspection.source === chat ? undefined : activeInspection.source,
        depth: own ? 0 : 1,
        title,
        prompt,
        seat: typeof seat === "string" ? seat : "auto",
        status: status === "completed" ? "done" : status,
        startedAt: own ? shown.activity?.records[0]?.occurredAt ?? 0 : request?.at ?? 0,
        answer: answer?.kind === "answer" ? answer.text : undefined,
        endedAt: status === "running" || status === "requested" ? undefined : shown.activity?.records.at(-1)?.occurredAt
      }
    })
  const shownRuns: ReadonlyArray<Run> | undefined = activeInspection === undefined ?
    options.runs :
    [...requestedRuns].map(([id, request]): Run => ({
      id,
      flow: typeof request.input.flow === "string" ?
        request.input.flow :
        typeof request.input.name === "string"
        ? request.input.name
        : "Run",
      by: "agent",
      input:
        typeof request.input.input === "object" && request.input.input !== null && !Array.isArray(request.input.input)
          ? request.input.input as Record<string, unknown> :
          {},
      requested: JSON.stringify(request.input),
      status: "requested",
      startedAt: request.at
    }))
  const projectedChat = useMemo(() => RunCard.chat(shownTranscript, drawsProgram), [shownTranscript, drawsProgram])
  const transcriptOf = (source: string) => source === chat ? transcript : worker(source)
  /** The transcript item a scrubber position lands on, in the chat or a worker's tab. */
  const jump = activeInspection === undefined ? undefined : (() => {
    const id = Scrubber.target(transcriptOf(activeInspection.source), activeInspection.seq)
    return id === undefined ? undefined : { source: activeInspection.source, id }
  })()
  const rows = chatRows(projectedChat, filter, {
    expanded: options.expanded,
    chat: true,
    source: shownTranscript,
    selected: jump?.source === chat ? jump.id : undefined
  })
  const lines = Subagents.lines(
    rows,
    Subagents.batches(shownTranscript, shownTabs, undefined, shownRuns),
    earlierOpen()
  )
  const workerTab = surface.startsWith("tab:") ? tabs.find((tab) => `tab:${tab.id}` === surface) : undefined
  const workerEarlier = workerTab === undefined ? undefined : Subagents.lines(
    Timeline.rows(shownWorker(workerTab.id)),
    Subagents.batches(shownWorker(workerTab.id), shownTabs, workerTab.id),
    earlierOpen(workerTab.id),
    workerTab.id
  ).find((line) => line.kind === "earlier")
  /** Cards in the chat, top to bottom; `tab` on an empty composer walks them. */
  const cardKeys = surface === "chat" && panel === undefined
    ? lines.flatMap((line) =>
      line.kind === "row"
        ? line.row.item.kind === "card" || line.row.item.kind === "run" ? [line.key] : []
        : line.kind === "grid"
        ? [
          ...line.batch.tabs.map((tab) => Subagents.cardKey(tab.id)),
          ...line.batch.runs?.map((run) => `flow:${run.id}`) ?? []
        ]
        : line.kind === "earlier"
        ? [line.key]
        : []
    )
    : panel?.placement !== "main" && workerEarlier !== undefined
    ? [workerEarlier.key]
    : []
  const focusedCard = cardFocus !== undefined && cardKeys.includes(cardFocus) ? cardFocus : undefined
  useLayoutEffect(() => {
    // A borrowed card focus cannot survive leaving its lane or removing its row.
    if (cardFocus !== undefined && !cardKeys.includes(cardFocus)) setCardFocus(undefined)
  }, [cardFocus, cardKeys])
  /** The worker whose card has focus. */
  const focusedWorker = focusedCard === undefined
    ? undefined
    : tabs.find((tab) => Subagents.cardKey(tab.id) === focusedCard)

  useLayoutEffect(() => {
    if (pendingReveal.current?.inspection !== activeInspection) cancelReveal()
  }, [activeInspection, cancelReveal])
  const reveal = (key: string) => {
    pendingPosition.current = undefined
    const box = scroll.current
    const child = box?.content.findDescendantById(key)
    if (box === null || box === undefined || child === undefined) return
    box.scrollTop = Math.max(0, box.scrollTop + child.y - box.viewport.y - 1)
  }
  const inspectActivity = (seq: number, jumping = true) => {
    cancelReveal()
    setInspectionInterrupted(false)
    if (monitored === undefined) return
    if (activeInspection === undefined || origin.current === undefined) {
      origin.current = { surface, panelFocus, scrollTop: viewport()?.scrollTop ?? 0 }
    }
    inspectionSurface.current = surface
    setPanelFocus(false)
    const nextInspection = { source: monitored.id, seq, first: monitored.activity.records[0]! }
    setInspection(nextInspection)
    const id = Scrubber.target(transcriptOf(monitored.id), seq)
    if (id === undefined || !jumping) return
    // The current run's transcript handles its own selection; inspection never changes views.
    if (monitored.id !== chat) return
    const key = Timeline.key(id)
    reveal(key)
    // Layout may settle after the inspected row changes; aim again then.
    const timer = Timer.after(60, () => {
      if (pendingReveal.current?.timer !== timer) return
      pendingReveal.current = undefined
      reveal(key)
    })
    pendingReveal.current = { inspection: nextInspection, timer }
  }
  const followLive = () => {
    cancelReveal()
    setInspection(undefined)
    setInspectionInterrupted(false)
    inspectionSurface.current = undefined
    const prior = origin.current
    origin.current = undefined
    if (prior === undefined) return
    restore.current = prior
    setPanelFocus(prior.panelFocus)
  }
  const snapToLive = () => {
    pendingPosition.current = undefined
    cancelReveal()
    setInspectionInterrupted(false)
    inspectionSurface.current = undefined
    origin.current = undefined
    restore.current = undefined
    setInspection(undefined)
    setLiveEdge((current) => current + 1)
    const box = viewport()
    if (box !== null) box.scrollTop = box.scrollHeight
  }
  const dragScroll = useMemo(() => ({
    ...DragScroll.make(() => renderer.getSelection()?.isDragging === true),
    // A selection drag owns the viewport: correcting it would move the text
    // under the pointer. Wheel and scrollbar scrolls are carried instead.
    onMouse: (event: MouseEvent) => {
      if (event.type === "drag" && renderer.getSelection()?.isDragging === true) cancelPosition()
    }
  }), [renderer, cancelPosition])
  return {
    transcript: shownTranscript,
    worker: shownWorker,
    tabs: shownTabs,
    inspectedAt,
    scroll,
    workerScroll,
    dragScroll,
    lane,
    rows,
    lines,
    cardKeys,
    focusedCard,
    focusedWorker,
    setCardFocus,
    earlierOpen,
    showEarlier,
    /** Expand the focused earlier row in its own parent transcript. */
    openEarlier: () => showEarlier(workerTab?.id),
    /** Moves the focused card and scrolls it into view. */
    moveCard: (direction: Subagents.Direction) => {
      if (focusedCard === undefined) return
      const next = Subagents.move(cardKeys, focusedCard, direction)
      setCardFocus(next)
      reveal(next)
    },
    reveal,
    monitored,
    showActivity,
    activeInspection,
    inspectionInterrupted,
    /** The chat row the scrubber's playhead is on. */
    jumpTarget: jump?.source === chat ? Timeline.key(jump.id) : undefined,
    /** A worker's transcript item the scrubber's playhead is on. */
    workerJump: (id: string) => jump?.source === id ? jump.id : undefined,
    inspectActivity,
    followLive,
    snapToLive,
    /** A new session starts at the live edge. */
    clearInspection: () => {
      cancelReveal()
      setInspection(undefined)
      setInspectionInterrupted(false)
      inspectionSurface.current = undefined
      origin.current = undefined
      restore.current = undefined
      setLiveEdge(0)
    }
  }
}
