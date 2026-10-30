// The factory's view-models (plugins/factory/src/model.ts) over the status the collector pushes: a sample of the real
// status (status.sample.json, scrubbed of hosts' paths and accounts), one index document per top-level key, as the
// collector pushes it (decision 0126 §5). Each view's rows are checked against what the old factory showed.
import { describe, expect, test } from "vitest"
import {
  ageOf,
  commitDiffOf,
  decisionsOf,
  duration,
  failuresOf,
  gradeOf,
  gradesOf,
  gradeTone,
  implementationOf,
  lanesOf,
  mediaOf,
  nowOf,
  patchFiles,
  queueOf,
  reportName,
  reportOf,
  reviewsOf,
  scoreboardOf,
  specPhase,
  statusOf,
  toneOf,
  transcriptOf,
  VIEWS,
} from "./model"
import sample from "./status.sample.json" with { type: "json" }

/** The sample as the collector pushes it: one index document per top-level key. */
const documents = Object.entries(sample).map(([name, body]) => ({ name, body: body as unknown }))
const status = statusOf(documents)
const at = sample.at
const now = at + 60

describe("the status", () => {
  test("every index document is read by its name", () => {
    expect(status.at).toBe(at)
    expect(status.agents.map((agent) => agent.name)).toEqual([
      "ifix-data-r6", "spec-artifacts", "impl-hunt-svc", "diffcheck-r20", "smithers-factory", "bugs-impl-hunt-svc-45", "v18-opus",
    ])
    expect(status.agents[4]).toEqual({
      name: "smithers-factory", title: expect.any(String), phase: "ops", state: "failed", rc: "-15",
      started: 1793343490, ended: 1793343601, machine: "nyc-01", model: "Claude Opus", account: expect.any(String),
    })
    expect(status.commits[0]).toEqual({
      id: "e130b5d26d02", title: "fix(eslint): discover VIP-30 project configs for typed lint", author: "Smithers e2e lane",
      at: 1793335437, lane: "",
    })
    expect(status.vip.perVip.map((row) => row.vip).slice(0, 5)).toEqual(["VIP-1", "VIP-5", "VIP-6", "VIP-9", "VIP-10"])
    expect(status.migrations.map((row) => row.repo)).toEqual(["opencode", "t3code", "alchemy"])
    expect(status.hosts.map((host) => host.name)).toEqual(["nyc-01", "nyc-02"])
    expect(status.telegram).toHaveLength(2)
    expect(status.accounts).toEqual([{ pool: "codex-rr", lines: ["codex-1 ready", "codex-2 cooling 30m"] }])
    expect(status.daemons.every((daemon) => daemon.running)).toBe(true)
  })

  test("nothing pushed yet, or a field of the wrong shape, reads as empty, never a crash", () => {
    const empty = statusOf([])
    expect(empty).toMatchObject({ at: null, agents: [], commits: [], asks: [], telegram: null, accounts: null, streak: 0 })
    expect(empty.vip).toEqual({ pending: 0, total: 0, perVip: [] })
    const odd = statusOf([
      { name: "at", body: "soon" },
      { name: "agents", body: [null, { name: 7, rc: 2, started: "x" }] },
      { name: "for_will", body: [{ title: "no id" }, { id: "a", link: "https://example.com", links: [{ label: "L", url: "u" }] }] },
      { name: "answered", body: { a: { choice: "accept" } } },
      { name: "telegram", body: [{}] },
      { name: "accounts", body: { pool: "not a list" } },
      { name: "grades", body: { v1: null } },
      { name: "vip", body: { per_vip: { VIP: 2 } } },
    ])
    expect(odd.at).toBeNull()
    expect(odd.agents).toEqual([
      { name: "", title: "", phase: "", state: "", rc: null, started: null, ended: null, machine: "", model: "", account: "" },
      { name: "7", title: "", phase: "", state: "", rc: "2", started: null, ended: null, machine: "", model: "", account: "" },
    ])
    expect(odd.asks).toEqual([
      { id: "a", kind: "", title: "", due: "", body: "", decided: "", links: [{ label: "L", url: "u" }, { label: "Open", url: "https://example.com" }] },
    ])
    expect(odd.answered).toEqual({ a: { choice: "accept", text: "", at: 0 } })
    expect(odd.telegram).toEqual([{ at: null, bot: false, text: "" }])
    expect(odd.accounts).toEqual([{ pool: "pool", lines: [] }])
    expect(odd.grades).toEqual({ v1: {} })
    expect(odd.vip.perVip).toEqual([{ vip: "VIP", pending: 2 }])
  })
})

describe("the Now view", () => {
  test("the scoreboard: spec, implementation, constructs, main and the example repositories", () => {
    expect(scoreboardOf(status, now)).toEqual([
      { area: "Spec", target: expect.any(String), now: "round 11: A- A- A A · streak 0/3", met: false },
      { area: "Implementation", target: expect.any(String), now: "r4: run F, func D, fail D, data F, svc D", met: false },
      { area: "VIP constructs", target: expect.any(String), now: "17 / 41", met: false },
      { area: "Main", target: expect.any(String), now: "GREEN", met: true },
      { area: "Example repos", target: expect.any(String), now: "opencode 21/25 · t3code 56/115 · alchemy 31/49", met: false },
    ])
    const met = statusOf([
      { name: "a_streak", body: 3 },
      { name: "impl_grades", body: { r1: { run: "A" } } },
      { name: "vip", body: { total: 2, pending: 0 } },
      { name: "migrations", body: Object.fromEntries(["a", "b", "c", "d"].map((repo) => [repo, { pass: 1, fail: 0 }])) },
    ])
    expect(scoreboardOf(met, now).map((score) => score.met)).toEqual([true, true, true, false, true])
    expect(scoreboardOf(met, now)[3]!.now).toBe("–")
    const empty = scoreboardOf(statusOf([]), now)
    expect(empty.map((score) => score.now)).toEqual(["– · streak 0/3", "–", "–", "–", "–"])
    const fuzz = statusOf([{ name: "postmerge", body: ["t abc RED graph failing: //:go-vibelangfuzz"] }])
    expect(scoreboardOf(fuzz, now)[3]!.now).toBe("RED (fuzz)")
    expect(scoreboardOf(statusOf([{ name: "postmerge", body: ["t abc RED graph failing: //:docs"] }]), now)[3]!.now).toBe("RED")
    // A round every reviewer reported on but without a letter grade shows `?`; a round named `v01` is no round `v1`.
    const all = (line: string) => Object.fromEntries(["fable", "opus", "sol", "astra"].map((who) => [who, { line }]))
    expect(scoreboardOf(statusOf([{ name: "grades", body: { v2: all("pending") } }]), now)[0]!.now).toBe("round 2: ? ? ? ? · streak 0/3")
    expect(specPhase(statusOf([{ name: "grades", body: { v01: all("A") } }]), now).latest).toBeNull()
  })

  test("constructs pending per VIP, by the VIP's number; one without a number first", () => {
    const vip = statusOf([{ name: "vip", body: { per_vip: { "VIP-3": 1, VIP: 2 } } }]).vip
    expect(vip.perVip).toEqual([{ vip: "VIP", pending: 2 }, { vip: "VIP-3", pending: 1 }])
  })

  test("the spec's phase follows the round's lanes: chapters, then the integrator, then the panel", () => {
    expect(specPhase(status, now)).toEqual({ what: "Round 18: panel reviewing (3/4 done)", latest: 11 })
    const lanes = (...names: Array<string>) =>
      statusOf([{ name: "agents", body: names.map((name) => ({ name, state: "running", started: now - 600 })) }])
    expect(specPhase(lanes("r3-001", "r3-002"), now).what).toBe("Round 3: 2 chapter lanes fixing findings")
    expect(specPhase(lanes("r3-integrate"), now).what).toBe("Round 3: integrator (10m)")
    expect(specPhase(statusOf([]), now)).toEqual({ what: "Waiting for the next step", latest: null })
  })

  test("Now: the round's grades with their reports, the lanes running, what waits, the latest events first", () => {
    const view = nowOf(status, now)
    expect(view.updated).toBe(at)
    expect(view.spec.grades.map((grade) => [grade.who, grade.grade, grade.tone, grade.report])).toEqual([
      ["fable", "A-", "ok", "report/spec/v11/fable"],
      ["opus", "A-", "ok", "report/spec/v11/opus"],
      ["sol", "A", "ok", "report/spec/v11/sol"],
      ["astra", "A", "ok", "report/spec/v11/astra"],
    ])
    expect(view.implementation).toEqual({ matched: 17, total: 41, running: ["impl-hunt-svc"] })
    expect(view.main.green).toBe(true)
    expect(view.main.running).toEqual(["diffcheck-r20"])
    expect(view.main.migrations[0]).toEqual({ repo: "opencode", pass: 21, total: 25, percent: 84 })
    expect(view.lanes.map((lane) => lane.name)).toEqual(["ifix-data-r6", "spec-artifacts", "impl-hunt-svc", "diffcheck-r20", "v18-opus"])
    expect(view.openFailures).toBe(2)
    expect(view.waiting.map((decision) => decision.id)).toEqual(["round3-page"])
    expect(view.events[0]).toMatch(/^resolver · 16:24:23/)
    expect(view.events.at(-1)).toBe("21:31 · Spec round 18 started 21:31 (round 17: B B B+ B+ ): 10 chapter lanes, then the integrator, then the panel.")
    expect(nowOf(statusOf([]), now).spec).toEqual({ what: "Waiting for the next step", round: null, grades: [] })
  })
})

describe("the Agents view", () => {
  test("a lane's machine, model, state and how long it ran; a failed one carries its exit code", () => {
    const lanes = lanesOf(status.agents, now)
    expect(lanes[0]).toEqual({
      name: "ifix-data-r6", title: expect.any(String), phase: "ops", machine: "nyc-02", model: "Codex", account: "every",
      state: "running", tone: "run", label: "running", duration: "1m",
    })
    expect(lanes[4]).toMatchObject({ name: "smithers-factory", tone: "bad", label: "failed rc -15", duration: "2m" })
    expect(lanes[5]).toMatchObject({ name: "bugs-impl-hunt-svc-45", tone: "ok", label: "done", duration: "4m" })
  })

  test("durations, ages and tones", () => {
    expect(duration(null, null, now)).toBe("")
    expect(duration(now - 3_900, null, now)).toBe("1h05")
    expect(duration(now + 60, null, now)).toBe("0m")
    expect(ageOf(null, now)).toBe("")
    expect(ageOf(now - 12, now)).toBe("12s")
    expect(ageOf(now - 240, now)).toBe("4m")
    expect(ageOf(now - 7_200, now)).toBe("2h")
    expect(["landed", "queued", "rejected", "superseded", "mystery"].map(toneOf)).toEqual(["ok", "run", "bad", "muted", "muted"])
    expect(["A", "B+", "C", ""].map(gradeTone)).toEqual(["ok", "warn", "bad", "muted"])
    expect(gradeOf("**Grade: C+.** The chapter skeleton")).toBe("C+")
    expect(gradeOf("A — The specification")).toBe("A")
    expect(gradeOf("Grade: B")).toBe("B")
    expect(gradeOf("All good")).toBe("")
  })
})

describe("the For you view", () => {
  test("what waits apart from what was decided or answered", () => {
    const { waiting, past } = decisionsOf(status)
    expect(waiting.map((decision) => [decision.id, decision.kind, decision.links.length])).toEqual([["round3-page", "review", 1]])
    expect(past.map((decision) => decision.id)).toEqual(["revisit-r8", "catch-always-function", "live-spec"])
    expect(past[2]!.answer).toEqual({ choice: "accept", text: "ship it", at: 1793343000000 })
    expect(past[0]!.decided).not.toBe("")
  })
})

describe("the other views", () => {
  test("Failures: open and resolved, by kind", () => {
    const failures = failuresOf(status)
    expect(failures).toMatchObject({ open: 2, resolved: 1, kinds: [{ kind: "agent", count: 3 }] })
    expect(failures.rows.map((row) => row.tone)).toEqual(["bad", "bad", "ok"])
  })

  test("Spec reviews: graded rounds, a reviewer at work, and findings by origin", () => {
    const reviews = reviewsOf(status, now)
    expect(reviews.rounds.map((row) => row.round)).toEqual([1, 10, 11, 18])
    expect(reviews.rounds[0]!.cells[0]).toMatchObject({ _tag: "Graded", grade: { who: "fable", grade: "C+", tone: "bad" } })
    expect(reviews.rounds[3]!.cells).toEqual([
      { _tag: "None" },
      { _tag: "Working", lane: "v18-opus", state: "running", duration: "12m" },
      { _tag: "None" },
      { _tag: "None" },
    ])
    expect(reviews.origins.map((row) => row.round)).toEqual([2, 9, 18])
    expect(reviews.origins[0]).toMatchObject({ total: 3, byOrigin: expect.any(Array) })
    expect(reviews.findings.map((round) => round.round)).toEqual([18, 9, 2])
    expect(reviews.findings[2]!.findings[0]).toMatchObject({ title: expect.any(String), reviewers: ["opus"] })
    expect(reviews.events[0]).toMatch(/^21:56 · /)
    const flagged = reviewsOf(statusOf([
      { name: "origins", body: { v1: [{ origin: "regression", lego: true, circles: true }] } },
      { name: "agents", body: [{ name: "v2-sol", state: "running" }, { name: "v2-sol", state: "done" }] },
    ]), now)
    expect(flagged.origins).toEqual([{ round: 1, total: 1, byOrigin: [1, 0, 0], lego: 1, circles: 1 }])
    expect(flagged.rounds[0]!.cells[2]).toEqual({ _tag: "Working", lane: "v2-sol", state: "running", duration: "" })
  })

  test("Implementation: constructs pending, verdicts with their reports, lanes and what landed", () => {
    const implementation = implementationOf(status, now)
    expect(implementation.perVip[0]).toEqual({ vip: "VIP-1", pending: 1 })
    expect(implementation.reviews.map((review) => [review.who, review.grade, review.report])).toEqual([
      ["fable", "C", "report/impl/fable"],
      ["opus", "D", "report/impl/opus"],
      ["sol", "D", "report/impl/sol"],
    ])
    expect(implementation.lanes.map((lane) => lane.name)).toEqual(["impl-hunt-svc"])
    expect(implementation.landed).toEqual([{ at: "2026-10-30T05:40:00Z", lane: "vip-types", commit: "909dbaadafe0" }])
  })

  test("Queue: entries newest first, main after merges, hosts' load and disk", () => {
    const queue = queueOf(status)
    expect(queue.entries[0]).toEqual({
      at: "2026-10-30T05:40:00Z", state: "landed", tone: "ok", lane: "vip-types", rev: "aa11bb22", detail: "landed as 909dbaadafe0",
    })
    expect(queue.entries[1]).toMatchObject({ state: "superseded", tone: "muted", detail: expect.stringContaining("") })
    expect(queue.main[0]).toEqual({ at: "2026-10-30T03:00:00Z", commit: "9a1b2c3d4e", green: true, why: "" })
    expect(queue.main[1]).toMatchObject({ green: false, why: expect.stringMatching(/^graph 1 failed/) })
    expect(queue.hosts).toEqual([
      { name: "nyc-01", load: "96.03", disk: 99, free: "25G", tone: "bad" },
      { name: "nyc-02", load: "135.26", disk: 98, free: "44G", tone: "bad" },
    ])
    expect(queue.telegram!.map((message) => message.bot)).toEqual([false, true])
    expect(queue.resolver[0]).toMatch(/^16:24:23/)
    const hosts = queueOf(statusOf([{ name: "hosts", body: { a: "x 92% /\n", b: "x 10% /\n", c: "down", d: 5 } }])).hosts
    expect(hosts.map((host) => [host.tone, host.disk, host.load])).toEqual([["warn", 92, "?"], ["ok", 10, "?"], ["muted", null, "?"], ["muted", null, "?"]])
    expect(queueOf(statusOf([])).telegram).toBeNull()
    expect(queueOf(statusOf([{ name: "postmerge", body: ["only"] }])).main).toEqual([{ at: "only", commit: "", green: false, why: "" }])
  })

  test("Media: newest first; a file too large to host says so", () => {
    const media = mediaOf(status)
    expect(media.map((item) => [item.updated, item.hosted])).toEqual([
      ["2026-10-30 00:09", false],
      ["2026-10-30 00:07", true],
      ["2026-10-29 23:07", true],
    ])
    expect(mediaOf(statusOf([{ name: "media", body: [{ file: "a.png" }] }]))[0]!.title).toBe("a.png")
  })
})

describe("on-demand documents", () => {
  test("a transcript's entries, live or not, with their times", () => {
    expect(transcriptOf({
      source: "lane.jsonl",
      live: true,
      events: [
        { kind: "text", text: "**hi**", ts: 1793343600000 },
        { kind: "tool", text: "ls", ts: "2026-10-30T07:00:00Z" },
        { kind: "weird", text: 5 },
        { kind: "result", text: "x", ts: "not a time" },
      ],
    })).toEqual({
      live: true,
      found: true,
      entries: [
        { kind: "text", text: "**hi**", at: 1793343600000 },
        { kind: "tool", text: "ls", at: Date.parse("2026-10-30T07:00:00Z") },
        { kind: "log", text: "5", at: null },
        { kind: "result", text: "x", at: null },
      ],
    })
    expect(transcriptOf(null)).toEqual({ live: false, found: false, entries: [] })
  })

  test("a commit's diff, one patch per file; a report's Markdown; report names", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b",
      "diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts", "@@ -1 +1,2 @@", " b", "+c",
    ].join("\n")
    const diff = commitDiffOf({ message: "fix: things", patch, truncated: true })
    expect(diff.message).toBe("fix: things")
    expect(diff.truncated).toBe(true)
    expect(diff.files).toHaveLength(2)
    expect(diff.files[1]).toMatch(/^diff --git a\/b.ts/)
    expect(commitDiffOf({})).toEqual({ message: "", truncated: false, files: [] })
    expect(patchFiles("no header")).toEqual([])
    expect(reportOf({ text: "# Grade: A" })).toBe("# Grade: A")
    expect(reportOf(undefined)).toBe("")
    expect(reportName("spec", "v3", "sol")).toBe("report/spec/v3/sol")
    expect(reportName("impl", "", "sol")).toBe("report/impl/sol")
    expect(gradesOf(statusOf([]), 1).map((grade) => grade.grade)).toEqual(["", "", "", ""])
  })

  test("the views and their paths: Now is the factory's index", () => {
    expect(VIEWS.map((view) => view.path)).toEqual(["", "for-you", "failures", "reviews", "implementation", "commits", "agents", "media", "docs", "queue"])
  })
})
