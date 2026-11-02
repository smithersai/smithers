// The fleet's view-models (decision 0143, docs/features/fleet.md#the-view): pure functions from a repository's synced
// agent runs and runner machines, and the time, to what the view draws. Nothing here keeps a clock or reads a row the
// host didn't serve; a value a run or machine didn't report reads as unknown, never zero.

/** A run's states, as `core/agent-runs` serves them. */
export type RunState = "queued" | "working" | "stalled" | "stopping" | "stopped" | "failed" | "done" | "retried"

/** One row of `core/agent-runs`. */
export interface AgentRun {
  readonly key: string
  readonly repoId: string
  readonly agent: string
  readonly generation: number
  readonly runId: string | null
  readonly number: number | null
  readonly title: string | null
  readonly runner: string | null
  readonly accountLabel?: string | null | undefined
  readonly state: RunState
  readonly reason: string | null
  readonly queuedAt: string
  readonly claimedAt: string | null
  readonly lastEventAt: string | null
  readonly activityAt: string | null
  readonly endedAt: string | null
  readonly contextTokens: number | null
  readonly costUsd: number | null
}

/** One row of `core/machines`. */
export interface Machine {
  readonly id: string
  readonly name: string
  readonly labels: ReadonlyArray<string>
  readonly capacity: number
  readonly seenAt: string | null
  readonly removedAt: string | null
  readonly version: string | null
  readonly load1: number | null
  readonly diskFreeGb: number | null
  /** Why the runner takes no job by its own admission rule (`load 31/24`); null or absent while it admits. */
  readonly held?: string | null | undefined
}

/** A state's tone, as `@smthrs/ui`'s badges tint it. */
export type Tone = "ok" | "warn" | "bad" | "run" | "muted"

/** A run's state in product words (FINAL.md §4.1), and its tone. */
export const WORDS: Readonly<Record<RunState, { readonly word: string; readonly tone: Tone }>> = {
  queued: { word: "Waiting", tone: "warn" },
  working: { word: "Working", tone: "run" },
  stalled: { word: "Stalled", tone: "bad" },
  stopping: { word: "Stopping", tone: "warn" },
  stopped: { word: "Stopped", tone: "muted" },
  failed: { word: "Failed", tone: "bad" },
  done: { word: "Done", tone: "ok" },
  retried: { word: "Retried", tone: "muted" },
}

/** How long after its last request a runner reads Offline (worker/runners/Fleet.ts `UNREACHABLE_SECONDS`). */
export const UNREACHABLE_MS = 45_000

/** Live runs first, the ones that need someone first among them; then ended runs, newest first. */
const ORDER: Readonly<Record<RunState, number>> = {
  stalled: 0,
  queued: 1,
  stopping: 2,
  working: 3,
  failed: 4,
  stopped: 4,
  done: 4,
  retried: 4,
}

const at = (iso: string | null): number | null => {
  if (iso === null) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** A duration as the fleet shows it: `0h03m`, `1h12m`; past a day, `2d04h`. */
export const durationOf = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
}

/** Tokens as the fleet shows them: `812k`, `1.2M`. */
export const tokensOf = (tokens: number): string =>
  tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)

/** One run as a row of the view. */
export interface RunRow {
  readonly key: string
  /** `T412 drive-foldkit-ui`, or the agent's name for a run that is no TODO's. */
  readonly label: string
  readonly number: number | null
  readonly agent: string
  readonly runner: string | null
  readonly account: string | null
  readonly state: RunState
  readonly word: string
  readonly tone: Tone
  readonly reason: string | null
  /** How long it has run, or ran: from its claim (its queueing while it waits) to its end or now. */
  readonly duration: string
  /** When the agent last said anything, in epoch ms; none before its first event. */
  readonly lastEventMs: number | null
  /** `812k tok`, `$1.20`, or `unreported`. */
  readonly usage: string
  readonly generation: number
}

/** The runs as the view lists them, at `nowMs`. */
export const runsOf = (runs: ReadonlyArray<AgentRun>, nowMs: number): ReadonlyArray<RunRow> =>
  [...runs]
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (at(b.queuedAt) ?? 0) - (at(a.queuedAt) ?? 0) || a.key.localeCompare(b.key))
    .map((run) => {
      const start = run.state === "queued" ? at(run.queuedAt) : at(run.claimedAt) ?? at(run.queuedAt)
      const end = at(run.endedAt) ?? nowMs
      const usage = [
        run.contextTokens === null ? null : `${tokensOf(run.contextTokens)} tok`,
        run.costUsd === null ? null : `$${run.costUsd.toFixed(2)}`,
      ].filter((part) => part !== null).join(" · ")
      return {
        key: run.key,
        label: run.number === null ? run.agent : `T${run.number} ${run.title ?? ""}`.trim(),
        number: run.number,
        agent: run.agent,
        runner: run.runner,
        account: run.accountLabel ?? null,
        state: run.state,
        word: WORDS[run.state].word,
        tone: WORDS[run.state].tone,
        reason: run.reason,
        duration: durationOf(start === null ? 0 : end - start),
        lastEventMs: at(run.lastEventAt),
        usage: usage === "" ? "unreported" : usage,
        generation: run.generation,
      }
    })

/**
 * A machine's state: Online, Held (online, but its runner takes no job by its own admission rule, decision 0144),
 * Offline (unseen 45 s), Never seen, or Removed.
 */
export type MachineState = "online" | "held" | "offline" | "unseen" | "removed"

/** One machine as a row of the view. */
export interface MachineRow {
  readonly id: string
  readonly name: string
  readonly state: MachineState
  readonly word: string
  readonly tone: Tone
  /** Why a Held machine holds back, as its runner said (`load 31/24`, `disk 31G/40G`); null in any other state. */
  readonly held: string | null
  /** Jobs it holds now, of its capacity. */
  readonly running: number
  readonly capacity: number
  readonly load: string | null
  readonly disk: string | null
  readonly version: string | null
  readonly seenMs: number | null
  readonly labels: ReadonlyArray<string>
}

const MACHINE_WORDS: Readonly<Record<MachineState, { readonly word: string; readonly tone: Tone }>> = {
  online: { word: "Online", tone: "ok" },
  held: { word: "Held", tone: "warn" },
  offline: { word: "Offline", tone: "bad" },
  unseen: { word: "Never seen", tone: "muted" },
  removed: { word: "Removed", tone: "muted" },
}

/** The machines as the view lists them, with each one's live jobs from `runs`, at `nowMs`: removed ones last. */
export const machinesOf = (
  machines: ReadonlyArray<Machine>,
  runs: ReadonlyArray<AgentRun>,
  nowMs: number,
): ReadonlyArray<MachineRow> =>
  machines.map((machine) => {
    const seenMs = at(machine.seenAt)
    const state: MachineState = machine.removedAt !== null
      ? "removed"
      : seenMs === null
      ? "unseen"
      : nowMs - seenMs >= UNREACHABLE_MS
      ? "offline"
      : machine.held
      ? "held"
      : "online"
    return {
      id: machine.id,
      name: machine.name,
      state,
      ...MACHINE_WORDS[state],
      held: state === "held" ? machine.held! : null,
      running: runs.filter((run) =>
        run.runner === machine.name && (run.state === "working" || run.state === "stalled" || run.state === "stopping")
      ).length,
      capacity: machine.capacity,
      load: machine.load1 === null ? null : machine.load1.toFixed(1),
      disk: machine.diskFreeGb === null ? null : `${Math.round(machine.diskFreeGb)}G`,
      version: machine.version,
      seenMs,
      labels: machine.labels,
    }
  }).sort((a, b) => Number(a.state === "removed") - Number(b.state === "removed") || a.name.localeCompare(b.name))

/** The header's counts. */
export interface Summary {
  readonly working: number
  readonly waiting: number
  readonly stalled: number
  /** Runs that failed since the start of `nowMs`'s day, in UTC. */
  readonly failedToday: number
  /** Machines that answer, Held ones included. */
  readonly online: number
  /** Machines that answer but take no job by their own admission rule. */
  readonly held: number
  /** Machines not removed. */
  readonly machines: number
}

/** The counts the header shows, at `nowMs`. */
export const summaryOf = (runs: ReadonlyArray<AgentRun>, machines: ReadonlyArray<MachineRow>, nowMs: number): Summary => {
  const day = Math.floor(nowMs / 86_400_000) * 86_400_000
  return {
    working: runs.filter((run) => run.state === "working" || run.state === "stopping").length,
    waiting: runs.filter((run) => run.state === "queued").length,
    stalled: runs.filter((run) => run.state === "stalled").length,
    failedToday: runs.filter((run) => run.state === "failed" && (at(run.endedAt) ?? 0) >= day).length,
    online: machines.filter((machine) => machine.state === "online" || machine.state === "held").length,
    held: machines.filter((machine) => machine.state === "held").length,
    machines: machines.filter((machine) => machine.state !== "removed").length,
  }
}
