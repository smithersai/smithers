// The factory's view-models (decision 0128 §9): the repository's feed documents, as the collector pushes them, into
// the rows each view draws. Pure functions over plain data: no Effect, no React, no clock but the `now` they are given.
// A document the collector hasn't pushed yet, or a field it left out, reads as empty, never as a crash: the factory
// keeps drawing what it has.

/** Seconds since the epoch. */
type Seconds = number

/** One lane or agent the orchestrator runs. */
export interface Agent {
  readonly name: string
  readonly title: string
  readonly phase: string
  readonly state: string
  readonly rc: string | null
  readonly started: Seconds | null
  readonly ended: Seconds | null
  readonly machine: string
  readonly model: string
  readonly account: string
}

/** A decision or review that waits on a maintainer. */
export interface Ask {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly due: string
  readonly body: string
  readonly decided: string
  readonly links: ReadonlyArray<{ readonly label: string; readonly url: string }>
}

/** A maintainer's answer, as the collector read it back. */
export interface Answered {
  readonly choice: string
  readonly text: string
  /** Milliseconds since the epoch. */
  readonly at: number
}

/** The repository's status: every index document, by its name, with what each view reads typed. */
export interface Status {
  readonly at: Seconds | null
  readonly agents: ReadonlyArray<Agent>
  readonly commits: ReadonlyArray<{ readonly id: string; readonly title: string; readonly author: string; readonly at: Seconds | null; readonly lane: string }>
  readonly failures: ReadonlyArray<{ readonly at: string; readonly kind: string; readonly what: string; readonly why: string; readonly next: string; readonly resolved: boolean }>
  readonly grades: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly impl: Readonly<Record<string, string>>
  readonly implGrades: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly queue: ReadonlyArray<{ readonly at: string; readonly state: string; readonly lane: string; readonly rev: string; readonly reason: string; readonly landedAs: string }>
  readonly asks: ReadonlyArray<Ask>
  readonly answered: Readonly<Record<string, Answered>>
  readonly events: ReadonlyArray<string>
  readonly postmerge: ReadonlyArray<string>
  readonly resolver: ReadonlyArray<string>
  readonly migrations: ReadonlyArray<{ readonly repo: string; readonly pass: number; readonly fail: number; readonly updated: Seconds | null }>
  readonly hosts: ReadonlyArray<{ readonly name: string; readonly text: string }>
  readonly origins: Readonly<Record<string, ReadonlyArray<Finding>>>
  readonly media: ReadonlyArray<{ readonly file: string; readonly title: string; readonly kind: string; readonly description: string; readonly updated: string; readonly size: number }>
  readonly daemons: ReadonlyArray<{ readonly name: string; readonly running: boolean }>
  readonly vip: { readonly pending: number; readonly total: number; readonly perVip: ReadonlyArray<{ readonly vip: string; readonly pending: number }> }
  readonly streak: number
  readonly telegram: ReadonlyArray<{ readonly at: Seconds | null; readonly bot: boolean; readonly text: string }> | null
  readonly accounts: ReadonlyArray<{ readonly pool: string; readonly lines: ReadonlyArray<string> }> | null
}

/** A spec review finding, labeled by where it came from. */
export interface Finding {
  readonly title: string
  readonly severity: string
  readonly origin: string
  readonly evidence: string
  readonly reviewers: ReadonlyArray<string>
  readonly lego: boolean
  readonly circles: boolean
}

type Json = unknown
type Fields = Readonly<Record<string, Json>>

const isFields = (value: Json): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value)
const fields = (value: Json): Fields => (isFields(value) ? value : {})
const list = (value: Json): ReadonlyArray<Json> => (Array.isArray(value) ? value : [])
const text = (value: Json): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "")
const count = (value: Json): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)
const seconds = (value: Json): Seconds | null => (typeof value === "number" && Number.isFinite(value) ? value : null)
const entries = (value: Json) => Object.entries(fields(value))

/** `{ who: { line } }` as `{ who: line }`. */
const lines = (value: Json): Readonly<Record<string, string>> =>
  Object.fromEntries(entries(value).map(([who, report]) => [who, text(fields(report).line)]))

const agentOf = (value: Json): Agent => {
  const row = fields(value)
  return {
    name: text(row.name),
    title: text(row.title),
    phase: text(row.phase),
    state: text(row.state),
    rc: row.rc === null || row.rc === undefined ? null : text(row.rc),
    started: seconds(row.started),
    ended: seconds(row.ended),
    machine: text(row.machine),
    model: text(row.model),
    account: text(row.account),
  }
}

const askOf = (value: Json): Ask => {
  const row = fields(value)
  const links = list(row.links).map((link) => ({ label: text(fields(link).label), url: text(fields(link).url) }))
  return {
    id: text(row.id),
    kind: text(row.kind),
    title: text(row.title),
    due: text(row.due),
    body: text(row.body),
    decided: text(row.decided),
    links: typeof row.link === "string" ? [...links, { label: "Open", url: row.link }] : links,
  }
}

const findingOf = (value: Json): Finding => {
  const row = fields(value)
  return {
    title: text(row.title),
    severity: text(row.severity),
    origin: text(row.origin),
    evidence: text(row.origin_evidence),
    reviewers: list(row.reviewers).map(text),
    lego: row.lego === true,
    circles: row.circles === true,
  }
}

/** The repository's status from its index documents, `{ name, body }`, each read as the collector writes it. */
export const statusOf = (documents: ReadonlyArray<{ readonly name: string; readonly body: Json }>): Status => {
  const doc = new Map(documents.map((document) => [document.name, document.body]))
  const vip = fields(doc.get("vip"))
  return {
    at: seconds(doc.get("at")),
    agents: list(doc.get("agents")).map(agentOf),
    commits: list(doc.get("commits")).map((value) => {
      const row = fields(value)
      return { id: text(row.id), title: text(row.title), author: text(row.author), at: seconds(row.at), lane: text(row.lane) }
    }),
    failures: list(doc.get("failures")).map((value) => {
      const row = fields(value)
      return { at: text(row.at), kind: text(row.kind), what: text(row.what), why: text(row.why), next: text(row.next), resolved: row.resolved === true }
    }),
    grades: Object.fromEntries(entries(doc.get("grades")).map(([round, reports]) => [round, lines(reports)])),
    impl: lines(doc.get("impl")),
    implGrades: Object.fromEntries(entries(doc.get("impl_grades")).map(([round, areas]) => [round, Object.fromEntries(entries(areas).map(([area, grade]) => [area, text(grade)]))])),
    queue: list(doc.get("queue")).map((value) => {
      const row = fields(value)
      return { at: text(row.at), state: text(row.state), lane: text(row.lane), rev: text(row.rev), reason: text(row.reason), landedAs: text(row.landed_as) }
    }),
    asks: list(doc.get("for_will")).map(askOf).filter((ask) => ask.id !== ""),
    answered: Object.fromEntries(entries(doc.get("answered")).map(([id, value]) => {
      const row = fields(value)
      return [id, { choice: text(row.choice), text: text(row.text), at: count(row.at) }]
    })),
    events: list(doc.get("events")).map(text),
    postmerge: list(doc.get("postmerge")).map(text),
    resolver: list(doc.get("resolver")).map(text),
    migrations: entries(doc.get("migrations")).map(([repo, value]) => {
      const row = fields(value)
      return { repo, pass: count(row.pass), fail: count(row.fail), updated: seconds(row.updated) }
    }),
    hosts: entries(doc.get("hosts")).map(([name, value]) => ({ name, text: text(value) })),
    origins: Object.fromEntries(entries(doc.get("origins")).map(([round, findings]) => [round, list(findings).map(findingOf)])),
    media: list(doc.get("media")).map((value) => {
      const row = fields(value)
      return { file: text(row.file), title: text(row.title), kind: text(row.kind), description: text(row.description), updated: text(row.updated), size: count(row.size) }
    }),
    daemons: list(doc.get("daemons")).map((value) => ({ name: text(fields(value).name), running: fields(value).running === true })),
    vip: {
      pending: count(vip.pending),
      total: count(vip.total),
      perVip: entries(vip.per_vip).map(([name, pending]) => ({ vip: name, pending: count(pending) }))
        .sort((left, right) => numberIn(left.vip) - numberIn(right.vip)),
    },
    streak: count(doc.get("a_streak")),
    telegram: doc.has("telegram")
      ? list(doc.get("telegram")).map((value) => ({ at: seconds(fields(value).date), bot: fields(value).bot === true, text: text(fields(value).text) }))
      : null,
    accounts: doc.has("accounts") ? entries(doc.get("accounts")).map(([pool, value]) => ({ pool, lines: list(value).map(text) })) : null,
  }
}

/** The first number in `name` (`VIP-12` is 12, `v3` is 3), 0 without one. */
const numberIn = (name: string): number => Number(/\d+/.exec(name)?.[0] ?? 0)

/** How long from `start` to `end` (or `now`), as `42m` or `3h05`. */
export const duration = (start: Seconds | null, end: Seconds | null, now: Seconds): string => {
  if (start === null) return ""
  const minutes = Math.max(0, Math.round(((end ?? now) - start) / 60))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`
}

/** A tone the theme colors: good, waiting, bad, running, or nothing to say. */
export type Tone = "ok" | "warn" | "bad" | "run" | "muted"

const STATE_TONE: Readonly<Record<string, Tone>> = {
  landed: "ok", done: "ok", queued: "run", split: "run", running: "run", rejected: "bad", failed: "bad",
  withdrawn: "muted", superseded: "muted", stopped: "muted",
}

/** The tone of a lane's or a queue entry's state. */
export const toneOf = (state: string): Tone => STATE_TONE[state] ?? "muted"

/** The letter grade a reviewer's verdict line leads with (`**Grade: C+.**` is `C+`), "" without one. */
export const gradeOf = (line: string): string => /\b([A-F][+-]?)(?=[\s.—*:,]|$)/.exec(line)?.[1] ?? ""

/** A grade's tone: A good, B waiting, below bad. */
export const gradeTone = (grade: string): Tone =>
  grade === "" ? "muted" : grade.startsWith("A") ? "ok" : grade.startsWith("B") ? "warn" : "bad"

/** The spec's four reviewers, in the order every table shows them. */
export const REVIEWERS = ["fable", "opus", "sol", "astra"] as const

/** One lane as the lane list draws it. */
export interface Lane {
  readonly name: string
  readonly title: string
  readonly phase: string
  readonly machine: string
  readonly model: string
  readonly account: string
  readonly state: string
  readonly tone: Tone
  /** `failed rc 2` for a failed lane with its exit code. */
  readonly label: string
  readonly duration: string
}

/** Lanes as the list draws them, in the collector's order (newest first). */
export const lanesOf = (agents: ReadonlyArray<Agent>, now: Seconds): ReadonlyArray<Lane> =>
  agents.map((agent) => ({
    name: agent.name,
    title: agent.title,
    phase: agent.phase,
    machine: agent.machine,
    model: agent.model,
    account: agent.account,
    state: agent.state,
    tone: toneOf(agent.state),
    label: agent.rc !== null && agent.rc !== "0" && agent.state !== "running" ? `${agent.state} rc ${agent.rc}` : agent.state,
    duration: duration(agent.started, agent.ended, now),
  }))

const roundsOf = (status: Status): ReadonlyArray<number> =>
  Object.keys(status.grades).filter((round) => /^v\d+$/.test(round)).map(numberIn).sort((left, right) => left - right)

/** What the spec rounds are doing now, and the latest round every reviewer graded. */
export const specPhase = (status: Status, now: Seconds): { readonly what: string; readonly latest: number | null } => {
  const running = (pattern: RegExp) => status.agents.filter((agent) => pattern.test(agent.name) && agent.state === "running")
  const named = (pattern: RegExp) => status.agents.flatMap((agent) => (pattern.test(agent.name) ? [numberIn(agent.name)] : []))
  const round = Math.max(0, ...roundsOf(status), ...named(/^v\d+-/), ...named(/^r\d+-/))
  const chapters = running(new RegExp(`^r${round}-\\d{3}$`))
  const integrator = running(new RegExp(`^r${round}-integrate$`))
  const panel = running(new RegExp(`^v${round}-`))
  const what = chapters.length > 0
    ? `Round ${round}: ${chapters.length} chapter lanes fixing findings`
    : integrator.length > 0
    ? `Round ${round}: integrator (${duration(integrator[0]!.started, null, now)})`
    : panel.length > 0
    ? `Round ${round}: panel reviewing (${REVIEWERS.length - panel.length}/${REVIEWERS.length} done)`
    : "Waiting for the next step"
  const graded = roundsOf(status).filter((done) => REVIEWERS.every((who) => (status.grades[`v${done}`]?.[who] ?? "") !== ""))
  return { what, latest: graded.at(-1) ?? null }
}

/** One reviewer's grade in a round: its letter and tone, and the report document that holds the full review. */
export interface Grade {
  readonly who: string
  readonly grade: string
  readonly tone: Tone
  readonly line: string
  readonly report: string
}

/** The four reviewers' grades for spec round `round`. */
export const gradesOf = (status: Status, round: number): ReadonlyArray<Grade> =>
  REVIEWERS.map((who) => {
    const line = status.grades[`v${round}`]?.[who] ?? ""
    const grade = gradeOf(line)
    return { who, grade, tone: gradeTone(grade), line, report: reportName("spec", `v${round}`, who) }
  })

/** The on-demand document that holds a review: `report/spec/<round>/<who>` or `report/impl/<who>`. */
export const reportName = (kind: "spec" | "impl", round: string, who: string): string =>
  kind === "spec" ? `report/spec/${round}/${who}` : `report/impl/${who}`

/** One row of the success scoreboard: an area, its target, where it is now, and whether it's met. */
export interface Score {
  readonly area: string
  readonly target: string
  readonly now: string
  readonly met: boolean
}

/** Whether main is green after the last merge. */
const mainGreen = (status: Status): boolean => / GREEN/.test(status.postmerge.at(-1) ?? "")

/** The scoreboard: the factory's finish line, area by area. */
export const scoreboardOf = (status: Status, now: Seconds): ReadonlyArray<Score> => {
  const { latest } = specPhase(status, now)
  const implRound = Object.keys(status.implGrades).sort((left, right) => numberIn(left) - numberIn(right)).at(-1)
  const implGrades = implRound === undefined ? [] : Object.entries(status.implGrades[implRound]!)
  const green = mainGreen(status)
  const last = status.postmerge.at(-1) ?? ""
  return [
    {
      area: "Spec",
      target: "3 straight rounds, all four reviewers A",
      now: `${latest === null ? "–" : `round ${latest}: ${gradesOf(status, latest).map((grade) => grade.grade || "?").join(" ")}`} · streak ${status.streak}/3`,
      met: status.streak >= 3,
    },
    {
      area: "Implementation",
      target: "every area graded A",
      now: implRound === undefined ? "–" : `${implRound}: ${implGrades.map(([area, grade]) => `${area} ${grade}`).join(", ")}`,
      met: implGrades.length > 0 && implGrades.every(([, grade]) => grade.startsWith("A")),
    },
    {
      area: "VIP constructs",
      target: "every construct matches its Effect TS",
      now: status.vip.total > 0 ? `${status.vip.total - status.vip.pending} / ${status.vip.total}` : "–",
      met: status.vip.total > 0 && status.vip.pending === 0,
    },
    {
      area: "Main",
      target: "green after merge, fuzz included",
      now: green ? "GREEN" : / RED /.test(last) && /fuzz/.test(last) ? "RED (fuzz)" : status.postmerge.length === 0 ? "–" : "RED",
      met: green,
    },
    {
      area: "Example repos",
      target: "every tool passes in all 4 repos",
      now: status.migrations.map((migration) => `${migration.repo} ${migration.pass}/${migration.pass + migration.fail}`).join(" · ") || "–",
      met: status.migrations.length === 4 && status.migrations.every((migration) => migration.fail === 0),
    },
  ]
}

/** An ask, with whether it's answered and how. */
export interface Decision extends Ask {
  readonly answer: Answered | null
}

/** The asks that wait on a maintainer, and the past ones, decided or answered. */
export const decisionsOf = (status: Status): { readonly waiting: ReadonlyArray<Decision>; readonly past: ReadonlyArray<Decision> } => {
  const all = status.asks.map((ask) => ({ ...ask, answer: status.answered[ask.id] ?? null }))
  const done = (decision: Decision) => decision.answer !== null || decision.decided !== ""
  return { waiting: all.filter((decision) => !done(decision)), past: all.filter(done) }
}

/** The Now view: the scoreboard, the spec, the implementation, main and migrations, running lanes, asks and events. */
export interface Now {
  readonly updated: Seconds | null
  readonly scoreboard: ReadonlyArray<Score>
  readonly spec: { readonly what: string; readonly round: number | null; readonly grades: ReadonlyArray<Grade> }
  readonly implementation: { readonly matched: number; readonly total: number; readonly running: ReadonlyArray<string> }
  readonly main: { readonly green: boolean; readonly migrations: ReadonlyArray<Migration>; readonly running: ReadonlyArray<string> }
  readonly lanes: ReadonlyArray<Lane>
  readonly openFailures: number
  readonly waiting: ReadonlyArray<Decision>
  readonly events: ReadonlyArray<string>
}

/** A migration's progress: tools passing of all, and the share passing as a percentage. */
export interface Migration {
  readonly repo: string
  readonly pass: number
  readonly total: number
  readonly percent: number
}

const migrationsOf = (status: Status): ReadonlyArray<Migration> =>
  status.migrations.map(({ repo, pass, fail }) => ({
    repo,
    pass,
    total: pass + fail,
    percent: Math.round((100 * pass) / Math.max(1, pass + fail)),
  }))

/** The orchestrator's events and the resolver's, newest first, at most `limit`. */
const latestEvents = (status: Status, limit: number): ReadonlyArray<string> =>
  [...status.events.map((event) => event.replace(" tg: ", " · ")), ...status.resolver.map((line) => `resolver · ${line}`)]
    .slice(-limit)
    .reverse()

/** The Now view's model. */
export const nowOf = (status: Status, now: Seconds): Now => {
  const running = status.agents.filter((agent) => agent.state === "running")
  const phase = specPhase(status, now)
  return {
    updated: status.at,
    scoreboard: scoreboardOf(status, now),
    spec: { what: phase.what, round: phase.latest, grades: phase.latest === null ? [] : gradesOf(status, phase.latest) },
    implementation: {
      matched: status.vip.total - status.vip.pending,
      total: status.vip.total,
      running: running.filter((agent) => agent.phase.startsWith("implementation")).map((agent) => agent.name),
    },
    main: {
      green: mainGreen(status),
      migrations: migrationsOf(status),
      running: running.filter((agent) => agent.phase === "migrations").map((agent) => agent.name),
    },
    lanes: lanesOf(running, now),
    openFailures: status.failures.filter((failure) => !failure.resolved).length,
    waiting: decisionsOf(status).waiting,
    events: latestEvents(status, 30),
  }
}

/** The Failures view: open and resolved counts, by kind, and every failure newest first. */
export const failuresOf = (status: Status) => {
  const open = status.failures.filter((failure) => !failure.resolved).length
  const kinds = new Map<string, number>()
  for (const failure of status.failures) kinds.set(failure.kind, (kinds.get(failure.kind) ?? 0) + 1)
  return {
    open,
    resolved: status.failures.length - open,
    kinds: [...kinds].map(([kind, n]) => ({ kind, count: n })),
    rows: status.failures.map((failure) => ({ ...failure, tone: (failure.resolved ? "ok" : "bad") as Tone })),
  }
}

/** Where a finding came from, as the origins table labels it. */
export const ORIGINS: ReadonlyArray<{ readonly origin: string; readonly label: string; readonly tone: Tone }> = [
  { origin: "regression", label: "caused by last round", tone: "bad" },
  { origin: "late-found", label: "existed before", tone: "warn" },
  { origin: "new-material", label: "new text", tone: "run" },
]

/** One cell of the spec rounds table: a grade with its report, a reviewer still at work, or nothing yet. */
export type ReviewCell =
  | { readonly _tag: "Graded"; readonly grade: Grade }
  | { readonly _tag: "Working"; readonly lane: string; readonly state: string; readonly duration: string }
  | { readonly _tag: "None" }

/** The Spec reviews view: every round's four cells, and the findings by origin, newest round first. */
export const reviewsOf = (status: Status, now: Seconds) => {
  const live = new Map<string, Agent>()
  for (const agent of status.agents) {
    const match = /^v(\d+)-(\w+)/.exec(agent.name)
    if (match !== null && !live.has(`${match[1]}-${match[2]}`)) live.set(`${match[1]}-${match[2]}`, agent)
  }
  const rounds = [...new Set([...roundsOf(status), ...[...live.keys()].map(numberIn)])].sort((left, right) => left - right)
  const cell = (round: number, grade: Grade): ReviewCell => {
    if (grade.grade !== "") return { _tag: "Graded", grade }
    const lane = live.get(`${round}-${grade.who}`)
    return lane === undefined
      ? { _tag: "None" }
      : { _tag: "Working", lane: lane.name, state: lane.state, duration: duration(lane.started, lane.ended, now) }
  }
  const origins = Object.keys(status.origins).sort((left, right) => numberIn(left) - numberIn(right))
  return {
    rounds: rounds.map((round) => ({ round, cells: gradesOf(status, round).map((grade) => cell(round, grade)) })),
    origins: origins.map((round) => {
      const findings = status.origins[round]!
      const n = (keep: (finding: Finding) => boolean) => findings.filter(keep).length
      return {
        round: numberIn(round),
        total: findings.length,
        byOrigin: ORIGINS.map(({ origin }) => n((finding) => finding.origin === origin)),
        lego: n((finding) => finding.lego),
        circles: n((finding) => finding.circles),
      }
    }),
    findings: origins.slice().reverse().map((round) => ({ round: numberIn(round), findings: status.origins[round]! })),
    events: status.events.map((event) => event.replace(" tg: ", " · ")).reverse(),
  }
}

/** The Implementation view: VIP constructs still pending, the reviewers' verdicts, the lanes and what landed. */
export const implementationOf = (status: Status, now: Seconds) => ({
  perVip: status.vip.perVip,
  reviews: Object.entries(status.impl).map(([who, line]) => {
    const grade = gradeOf(line)
    return { who, grade, tone: gradeTone(grade), line, report: reportName("impl", "", who) }
  }),
  lanes: lanesOf(status.agents.filter((agent) => agent.phase.startsWith("implementation")).slice(0, 40), now),
  landed: status.queue.filter((entry) => entry.state === "landed").slice(-20).reverse()
    .map((entry) => ({ at: entry.at, lane: entry.lane, commit: entry.landedAs.slice(0, 12) })),
})

/** The Queue view: the merge queue newest first, main after each merge, the resolver, migrations and hosts. */
export const queueOf = (status: Status) => ({
  entries: status.queue.slice(-30).reverse().map((entry) => ({
    at: entry.at,
    state: entry.state,
    tone: toneOf(entry.state),
    lane: entry.lane,
    rev: entry.rev.slice(0, 8),
    detail: entry.landedAs === "" ? entry.reason : `landed as ${entry.landedAs.slice(0, 12)}`,
  })),
  main: status.postmerge.slice().reverse().map((line) => {
    const [at = "", commit = ""] = line.split(" ")
    const green = / GREEN/.test(line)
    return { at, commit: commit.slice(0, 10), green, why: green ? "" : (line.split(" RED ")[1] ?? "").slice(0, 200) }
  }),
  resolver: status.resolver.slice().reverse(),
  migrations: migrationsOf(status),
  hosts: status.hosts.map(({ name, text: report }) => {
    const disk = /(\d+)%\s+\/\s*$/m.exec(report)?.[1]
    return {
      name,
      load: /load average: ([\d.]+)/.exec(report)?.[1] ?? "?",
      disk: disk === undefined ? null : Number(disk),
      free: /\s(\d+[GT])\s+\d+%\s+\/\s*$/m.exec(report)?.[1] ?? "",
      tone: (disk === undefined ? "muted" : Number(disk) >= 95 ? "bad" : Number(disk) >= 90 ? "warn" : "ok") as Tone,
    }
  }),
  telegram: status.telegram === null ? null : status.telegram.slice().reverse(),
})

/** The Media view: newest first; a file over 95 MB isn't hosted. */
export const mediaOf = (status: Status) =>
  status.media.slice().sort((left, right) => right.updated.localeCompare(left.updated)).map((item) => ({
    ...item,
    title: item.title || item.file,
    hosted: item.size <= 95_000_000,
    updated: item.updated.slice(0, 16).replace("T", " "),
  }))

/** One entry of a lane's transcript. */
export interface Entry {
  readonly kind: "text" | "tool" | "result" | "user" | "log"
  readonly text: string
  /** Milliseconds since the epoch, when the transcript has it. */
  readonly at: number | null
}

/** A lane's transcript document (`transcript/<lane>`): its entries, and whether it's live. */
export const transcriptOf = (body: Json): { readonly live: boolean; readonly found: boolean; readonly entries: ReadonlyArray<Entry> } => {
  const row = fields(body)
  const kinds = new Set(["text", "tool", "result", "user", "log"])
  return {
    live: row.live === true,
    found: typeof row.source === "string" && row.source !== "",
    entries: list(row.events).map((value) => {
      const entry = fields(value)
      const at = typeof entry.ts === "number" ? entry.ts : typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN
      return {
        kind: (kinds.has(text(entry.kind)) ? text(entry.kind) : "log") as Entry["kind"],
        text: text(entry.text),
        at: Number.isNaN(at) ? null : at,
      }
    }),
  }
}

/** A commit's diff document (`diff/<id>`): its message, each file's own patch, and whether it was cut short. */
export const commitDiffOf = (body: Json): { readonly message: string; readonly truncated: boolean; readonly files: ReadonlyArray<string> } => {
  const row = fields(body)
  return { message: text(row.message), truncated: row.truncated === true, files: patchFiles(text(row.patch)) }
}

/** A multi-file patch split into each file's own patch, at its `diff --git` line. */
export const patchFiles = (patch: string): ReadonlyArray<string> =>
  patch === "" ? [] : patch.split(/^(?=diff --git )/m).filter((file) => file.startsWith("diff --git "))

/** A report document's Markdown (`report/...`, `needs`). */
export const reportOf = (body: Json): string => text(fields(body).text)

/** The factory's views, in the order the tabs show them: each view's id, the path it shows at, and its tab's name. */
export const VIEWS = [
  { id: "factory/now", path: "", title: "Now" },
  { id: "factory/for-you", path: "for-you", title: "For you" },
  { id: "factory/failures", path: "failures", title: "Failures" },
  { id: "factory/reviews", path: "reviews", title: "Spec reviews" },
  { id: "factory/implementation", path: "implementation", title: "Implementation" },
  { id: "factory/commits", path: "commits", title: "Commits" },
  { id: "factory/agents", path: "agents", title: "Agents" },
  { id: "factory/media", path: "media", title: "Media" },
  { id: "factory/docs", path: "docs", title: "Docs" },
  { id: "factory/queue", path: "queue", title: "Queue" },
] as const

/** A view of the factory, by id. */
export type ViewId = (typeof VIEWS)[number]["id"]
