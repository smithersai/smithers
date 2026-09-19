/**
 * The demo is a fold. Every frame is a complete, immutable snapshot, so
 * scrubbing is free and playback is just an index moving on a timer.
 */
import {
  CACHED,
  EDGES,
  FIRST_RUN_MS,
  formatDuration,
  NODE_BY_ID,
  NODES,
  PLAN_NODE_COUNT,
  REKEY_RUN_MS,
  REKEYED,
  type NodeState
} from "./flow.ts"

export type Act = 1 | 2 | 3

export interface JevAnswer {
  readonly question: string
  readonly answer: string
  readonly confidence: number
}

export type ChatItem =
  | { readonly id: string; readonly kind: "user"; readonly text: string }
  | { readonly id: string; readonly kind: "agent"; readonly text: string; readonly typing?: boolean }
  | { readonly id: string; readonly kind: "act"; readonly text: string }
  | {
      readonly id: string
      readonly kind: "plan"
      readonly nodes: number
      readonly irreversible: number
      readonly gates: number
      readonly digest: string
    }
  | {
      readonly id: string
      readonly kind: "run"
      readonly phase: "running" | "waiting-approval" | "completed"
      readonly built: number
      readonly clean: number
      readonly skipped: number
      readonly elapsedMs: number
      readonly total: number
      readonly title: string
    }
  | {
      readonly id: string
      readonly kind: "approval"
      readonly prompt: string
      readonly attempt: number
      readonly maxAttempts: number
      readonly decided: "pending" | "approved"
      readonly detail: readonly string[]
    }
  | {
      readonly id: string
      readonly kind: "rekey"
      readonly rerun: number
      readonly cached: number
      readonly newMs: number
      readonly oldMs: number
      readonly voids: number
      readonly decided: "pending" | "approved"
    }
  | { readonly id: string; readonly kind: "jev"; readonly title: string; readonly answers: readonly JevAnswer[] }

export interface Hud {
  readonly tone: "brand" | "warning" | "success"
  readonly title: string
  readonly detail: string
  readonly stats: readonly { readonly label: string; readonly value: string; readonly tone?: string }[]
}

export interface Frame {
  readonly act: Act
  readonly ms: number
  readonly label: string
  readonly mode: "draft" | "run" | "rekey"
  readonly nodes: Readonly<Record<string, NodeState>>
  readonly captions: Readonly<Record<string, string>>
  readonly attempts: Readonly<Record<string, number>>
  readonly settled: Readonly<Record<string, number>>
  readonly activeEdges: readonly string[]
  readonly doneEdges: readonly string[]
  readonly chat: readonly ChatItem[]
  readonly selected: string | null
  readonly cursor: string | null
  readonly hud: Hud | null
  /** Where the camera should sit. `null` fits the whole graph. */
  readonly focus: string | null
  readonly zoom: number
}

interface Draft {
  act: Act
  mode: "draft" | "run" | "rekey"
  nodes: Record<string, NodeState>
  captions: Record<string, string>
  attempts: Record<string, number>
  settled: Record<string, number>
  activeEdges: string[]
  doneEdges: string[]
  chat: ChatItem[]
  selected: string | null
  cursor: string | null
  hud: Hud | null
  focus: string | null
  zoom: number
}

const edgesInto = (id: string) => EDGES.filter((edge) => edge.to === id).map((edge) => edge.id)

export const buildFrames = (): Frame[] => {
  const frames: Frame[] = []
  let seq = 0
  const nextId = () => `c${++seq}`

  const draft: Draft = {
    act: 1,
    mode: "draft",
    nodes: Object.fromEntries(NODES.map((node) => [node.id, "hidden" as NodeState])),
    captions: {},
    attempts: {},
    settled: {},
    activeEdges: [],
    doneEdges: [],
    chat: [],
    selected: null,
    cursor: null,
    hud: null,
    focus: null,
    zoom: 0.94
  }

  const push = (label: string, ms: number) => {
    frames.push({
      act: draft.act,
      ms,
      label,
      mode: draft.mode,
      nodes: { ...draft.nodes },
      captions: { ...draft.captions },
      attempts: { ...draft.attempts },
      settled: { ...draft.settled },
      activeEdges: [...draft.activeEdges],
      doneEdges: [...draft.doneEdges],
      chat: [...draft.chat],
      selected: draft.selected,
      cursor: draft.cursor,
      hud: draft.hud,
      focus: draft.focus,
      zoom: draft.zoom
    })
  }

  const say = (text: string) => draft.chat.push({ id: nextId(), kind: "agent", text })
  const you = (text: string) => draft.chat.push({ id: nextId(), kind: "user", text })
  const act = (text: string) => draft.chat.push({ id: nextId(), kind: "act", text })
  const replaceLast = (item: ChatItem) => {
    draft.chat = [...draft.chat.slice(0, -1), item]
  }

  /* ── Act 1 · the agent drafts the flow ─────────────────────────────── */

  push("Empty canvas", 700)

  you("every weekday morning, triage new issues on tevm-monorepo, reproduce the top bug, write a failing test, and open a PR for me to review")
  push("The ask", 1_500)

  act("Smithers ran /flow.create")
  draft.chat.push({ id: nextId(), kind: "agent", text: "Reading the repo's flows and conventions", typing: true })
  push("Front door", 900)

  replaceLast({
    id: nextId(),
    kind: "agent",
    text: "Drafting **morning-triage**. Nine of these steps already exist in your repo, so I'm calling them rather than writing them again."
  })
  push("Drafting", 1_000)

  const revealPlan: { id: string; ms: number; say?: string }[] = [
    { id: "trigger", ms: 420 },
    { id: "issues", ms: 420 },
    {
      id: "triage",
      ms: 520,
      say: "Two decisions here belong to **Jev**, not to a chat model: which issues are relevant, and how risky each edit is. Typed questions, typed answers, 1.5 second deadline."
    },
    { id: "branch", ms: 420 },
    {
      id: "defer",
      ms: 560,
      say: "Both arms of the branch go into the plan. The one you don't take settles **skipped** — it is never simply missing."
    },
    { id: "repro", ms: 480 },
    { id: "test", ms: 420 },
    {
      id: "bundle",
      ms: 560,
      say: "`bun test` can fail, so it gets a catch handler on a failure edge."
    },
    {
      id: "approve",
      ms: 560,
      say: "`jj/create-change`, `github/open-pr` and `slack/post` are **irreversible**, so your approval goes in front of all three."
    },
    { id: "change", ms: 380 },
    { id: "writetest", ms: 420 },
    { id: "checks", ms: 420 },
    { id: "pr", ms: 380 },
    { id: "notify", ms: 380 }
  ]

  for (const step of revealPlan) {
    draft.nodes[step.id] = step.id === "trigger" ? "armed" : "idle"
    draft.cursor = step.id
    draft.doneEdges = [...new Set([...draft.doneEdges, ...edgesInto(step.id)])]
    if (step.say) say(step.say)
    push(`Drafts ${NODE_BY_ID[step.id].tag}`, step.ms)
  }

  draft.cursor = null
  draft.chat.push({
    id: nextId(),
    kind: "plan",
    nodes: PLAN_NODE_COUNT,
    irreversible: NODES.filter((node) => node.tier === "irreversible").length,
    gates: NODES.filter((node) => node.kind === "human").length,
    digest: "key1_9f3c2ab7e015"
  })
  push("Plan compiled", 1_400)

  say("It's typed TypeScript in `flows/morning-triage/flow.ts`, so it diffs and reviews like the rest of the repo. Run it, or open any node and change it first.")
  push("Ready", 1_600)

  /* ── Act 2 · the run ───────────────────────────────────────────────── */

  draft.act = 2
  draft.mode = "run"
  you("run it")
  act("Will ran /flow.run morning-triage")
  draft.chat.push({
    id: nextId(),
    kind: "run",
    phase: "running",
    built: 0,
    clean: 0,
    skipped: 0,
    elapsedMs: 0,
    total: 11,
    title: "morning-triage"
  })
  push("Run accepted", 900)

  const runCardIndex = draft.chat.length - 1
  let built = 0
  let elapsed = 0

  const updateRunCard = (
    phase: "running" | "waiting-approval" | "completed",
    extra?: { skipped?: number }
  ) => {
    const current = draft.chat[runCardIndex]
    if (current.kind !== "run") return
    draft.chat = draft.chat.map((item, index) =>
      index === runCardIndex
        ? { ...current, phase, built, elapsedMs: elapsed, skipped: extra?.skipped ?? current.skipped }
        : item
    )
  }

  const settle = (id: string, state: NodeState = "built") => {
    draft.nodes[id] = state
    delete draft.captions[id]
    draft.settled[id] = NODE_BY_ID[id].ms
    draft.activeEdges = draft.activeEdges.filter((edge) => !edgesInto(id).includes(edge))
    if (state === "built") {
      built += 1
      elapsed += NODE_BY_ID[id].ms
    }
  }

  const start = (id: string, caption?: string) => {
    draft.nodes[id] = "running"
    draft.activeEdges = [...new Set([...draft.activeEdges, ...edgesInto(id)])]
    if (caption) draft.captions[id] = caption
  }

  draft.nodes.trigger = "fired"
  draft.activeEdges = ["e1"]
  push("Trigger fires", 500)
  start("issues", "GET /repos/tevm/tevm-monorepo/issues")
  updateRunCard("running")
  push("Listing issues", 900)

  settle("issues")
  start("triage", "9 issues × 3 questions")
  updateRunCard("running")
  push("Jev is deciding", 1_000)

  settle("triage")
  draft.chat.push({
    id: nextId(),
    kind: "jev",
    title: "triage/relevance · #4412 “State clone drops storage overrides”",
    answers: [
      { question: "Does this need a code change?", answer: "yes", confidence: 0.94 },
      { question: "What kind of file?", answer: "implementation", confidence: 0.89 },
      { question: "Edit risk", answer: "medium", confidence: 0.71 }
    ]
  })
  start("branch")
  updateRunCard("running")
  push("Jev answers", 1_400)

  settle("branch")
  draft.nodes.defer = "skipped"
  draft.doneEdges = [...draft.doneEdges]
  start("repro", "reading packages/state/src/StateManager.ts")
  updateRunCard("running", { skipped: 1 })
  push("Branch taken · else arm skipped", 1_200)

  draft.captions.repro = "writing a minimal reproduction"
  push("Agent working", 1_000)
  draft.captions.repro = "confirmed: storage overrides dropped on clone()"
  push("Agent working", 1_000)

  settle("repro")
  start("test", "bun test --filter @tevm/state")
  updateRunCard("running")
  push("Running the suite", 1_000)

  draft.nodes.test = "failed"
  draft.attempts.test = 1
  draft.captions.test = "exit 1 · cold Bun cache"
  updateRunCard("running")
  push("Attempt 1 fails", 900)

  draft.nodes.test = "retrying"
  draft.captions.test = "attempt 2 in 200ms"
  push("Retry", 800)

  draft.attempts.test = 2
  start("test", "bun test --filter @tevm/state")
  push("Attempt 2", 800)

  settle("test")
  draft.nodes.bundle = "skipped"
  draft.nodes.approve = "waiting"
  draft.activeEdges = [...new Set([...draft.activeEdges, ...edgesInto("approve")])]
  draft.chat.push({
    id: nextId(),
    kind: "approval",
    prompt: "Land a failing test on a new change?",
    attempt: 1,
    maxAttempts: 10,
    decided: "pending",
    detail: [
      "jj/create-change · irreversible",
      "github/open-pr · irreversible",
      "slack/post · irreversible"
    ]
  })
  updateRunCard("waiting-approval")
  push("Parked on you", 1_800)

  const approvalIndex = draft.chat.length - 1
  draft.chat = draft.chat.map((item, index) =>
    index === approvalIndex && item.kind === "approval" ? { ...item, decided: "approved" } : item
  )
  settle("approve")
  start("change")
  updateRunCard("running")
  push("Approved", 900)

  settle("change")
  start("writetest", "editing packages/state/src/StateManager.spec.ts")
  updateRunCard("running")
  push("Writing the test", 1_000)

  draft.captions.writetest = "41 minutes · 612k tokens"
  push("The expensive step", 1_100)

  settle("writetest")
  start("checks", "6 maintainer rules × 4 hunks")
  updateRunCard("running")
  push("AI checks", 900)

  settle("checks")
  start("pr")
  updateRunCard("running")
  push("Opening the PR", 800)

  settle("pr")
  start("notify")
  updateRunCard("running")
  push("Posting", 600)

  settle("notify")
  updateRunCard("completed", { skipped: 2 })
  draft.focus = "checks"
  draft.zoom = 0.62
  draft.hud = {
    tone: "success",
    title: "Run completed",
    detail: "11 built · 2 skipped · 1 retry · 1 approval",
    stats: [
      { label: "Wall clock", value: formatDuration(FIRST_RUN_MS) },
      { label: "Tokens", value: "796k" },
      { label: "Cost", value: "$10.47" }
    ]
  }
  push("Completed", 2_200)

  /* ── Act 3 · one edit, three steps ─────────────────────────────────── */

  draft.act = 3
  draft.mode = "rekey"
  draft.hud = null
  you("the reviewer says we don't enforce the error-handling rule anywhere. add it to the AI checks and ship it again.")
  push("The change request", 1_800)

  say("That's one node. Here's what it costs before you commit to it.")
  draft.selected = "checks"
  draft.cursor = "checks"
  draft.focus = "checks"
  draft.zoom = 0.82
  push("Selects the node", 1_200)

  for (const id of REKEYED) {
    draft.nodes[id] = "dirty"
  }
  for (const id of CACHED) {
    draft.nodes[id] = "clean"
  }
  draft.nodes.trigger = "armed"
  draft.cursor = null
  draft.focus = "writetest"
  draft.zoom = 0.6
  draft.hud = {
    tone: "warning",
    title: "Editing repository/jev-semantic-check re-keys 3 nodes",
    detail: "A node's key is a function of what it consumes, so this node and everything downstream of it re-run. Nothing else does.",
    stats: [
      { label: "Re-runs", value: "3 of 11", tone: "warning" },
      { label: "Cache hits", value: "8", tone: "success" },
      { label: "Estimate", value: `${formatDuration(REKEY_RUN_MS)} (was ${formatDuration(FIRST_RUN_MS)})`, tone: "success" }
    ]
  }
  draft.chat.push({
    id: nextId(),
    kind: "rekey",
    rerun: 3,
    cached: 8,
    newMs: REKEY_RUN_MS,
    oldMs: FIRST_RUN_MS,
    voids: 1,
    decided: "pending"
  })
  push("Re-key preview", 2_600)

  const rekeyIndex = draft.chat.length - 1
  draft.chat = draft.chat.map((item, index) =>
    index === rekeyIndex && item.kind === "rekey" ? { ...item, decided: "approved" } : item
  )
  act("Will ran /flow.run morning-triage --from checks")
  push("Approved", 900)

  built = 0
  elapsed = 0
  draft.selected = null
  draft.focus = null
  draft.zoom = 0.6

  const cacheOrder = [
    "issues",
    "triage",
    "branch",
    "repro",
    "test",
    "approve",
    "change",
    "writetest"
  ]
  let cleanCount = 0
  for (const id of cacheOrder) {
    draft.nodes[id] = "clean"
    draft.settled[id] = 0
    cleanCount += 1
    push(`Cache hit ${NODE_BY_ID[id].tag}`, id === "writetest" ? 700 : 190)
  }

  draft.chat.push({
    id: nextId(),
    kind: "run",
    phase: "running",
    built: 0,
    clean: cleanCount,
    skipped: 2,
    elapsedMs: 0,
    total: 3,
    title: "morning-triage · from checks"
  })
  const rerunIndex = draft.chat.length - 1
  const updateRerun = (phase: "running" | "completed") => {
    const current = draft.chat[rerunIndex]
    if (current.kind !== "run") return
    draft.chat = draft.chat.map((item, index) =>
      index === rerunIndex ? { ...current, phase, built, elapsedMs: elapsed } : item
    )
  }
  draft.focus = "writetest"
  draft.zoom = 0.66
  push("8 cache hits", 1_100)

  for (const id of REKEYED) {
    draft.nodes[id] = "running"
    draft.activeEdges = [...new Set([...draft.activeEdges, ...edgesInto(id)])]
    if (id === "checks") draft.captions[id] = "7 maintainer rules × 4 hunks"
    push(`Re-runs ${NODE_BY_ID[id].tag}`, 700)

    draft.nodes[id] = "built"
    delete draft.captions[id]
    draft.settled[id] = NODE_BY_ID[id].rekeyMs ?? NODE_BY_ID[id].ms
    draft.activeEdges = draft.activeEdges.filter((edge) => !edgesInto(id).includes(edge))
    built += 1
    elapsed += NODE_BY_ID[id].rekeyMs ?? NODE_BY_ID[id].ms
    updateRerun("running")
    push(`Built ${NODE_BY_ID[id].tag}`, 450)
  }

  updateRerun("completed")
  draft.focus = "checks"
  draft.zoom = 0.64
  draft.hud = {
    tone: "success",
    title: "Completed in 4.9 seconds",
    detail: "3 built · 8 clean · the 41-minute agent step never re-ran, because nothing it consumes changed.",
    stats: [
      { label: "Wall clock", value: formatDuration(REKEY_RUN_MS) },
      { label: "Saved", value: formatDuration(FIRST_RUN_MS - REKEY_RUN_MS), tone: "success" },
      { label: "Cost", value: "$0.02", tone: "success" }
    ]
  }
  push("Done", 2_000)

  say("Shipped. The expensive step was a cache hit: its inputs didn't change, so its key didn't. That's the whole invalidation rule — re-keying, nothing else.")
  push("Closing", 3_000)

  return frames
}

export const FRAMES = buildFrames()

export const ACT_STARTS: Readonly<Record<Act, number>> = {
  1: 0,
  2: FRAMES.findIndex((frame) => frame.act === 2),
  3: FRAMES.findIndex((frame) => frame.act === 3)
}

export const ACT_META: readonly { readonly act: Act; readonly title: string; readonly blurb: string }[] = [
  { act: 1, title: "Draft", blurb: "The agent writes the flow while you watch" },
  { act: 2, title: "Run", blurb: "The plan executes on the same canvas" },
  { act: 3, title: "Re-key", blurb: "One edit, three steps, eight cache hits" }
]
