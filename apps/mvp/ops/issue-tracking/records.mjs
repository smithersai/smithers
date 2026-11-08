// Pure parts of the issue-tracking import (collect.mjs): scrubbing, one issue record per tracked thing, and the order
// issues are created in. Tested by records.test.ts with synthetic input only.

/** The longest title and body the writes route takes (src/features/issues/contract.ts), kept well under. */
const MAX_TITLE = 200
const MAX_BODY = 8000

export const CREDENTIAL_SHAPES = [
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:xox[abpr]-|glpat-)[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(authorization|bearer|token|secret|password|api[_-]?key)(\s*[:=]\s*|\s+)["']?[A-Za-z0-9_./+=-]{12,}/gi,
  // Long opaque strings that aren't hex (hex is commit ids and hashes we want to keep).
  // From where a run starts only, so a long run is read once, not from each boundary inside it.
  /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*[g-zG-Z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}/g,
]

/** `text` with anything credential-shaped replaced and home directories shortened to `~`. */
export const scrub = (text) => {
  let out = String(text ?? "")
  for (const shape of CREDENTIAL_SHAPES) {
    out = out.replace(shape, (match, name) =>
      typeof name === "string" && /^(authorization|bearer|token|secret|password|api)/i.test(name) ? `${name}: [redacted]` : "[redacted]")
  }
  return out.replace(/\/(?:Users|home)\/[A-Za-z0-9._-]+/g, "~")
}

const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`)
const title = (text) => clip(scrub(text).replace(/\s+/g, " ").trim(), MAX_TITLE) || "(untitled)"
const body = (lines) => clip(scrub(lines.filter((line) => line !== undefined).join("\n")), MAX_BODY)
const iso = (seconds) => (typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : undefined)

/** Inbox entries: a line opening with `[lane]`, `- <time>` or `## [lane]` starts one; the lines after it continue it. */
export const inboxEntries = (inbox) => {
  const entries = []
  for (const line of inbox.split("\n")) {
    if (/^(\[[^\]]+\]|- 20\d\d-|## \[)/.test(line)) entries.push([line])
    else if (entries.length > 0 && line.trim() !== "") entries.at(-1).push(line)
  }
  return entries.map((lines) => lines.join("\n"))
}

/** The lane a text names first as `[lane]`, if any. */
const authorOf = (text) => /\[([a-z0-9][a-z0-9-]{1,40})\]/i.exec(text)?.[1]

/** The work a queue entry's state means for its issue's links. */
const queueState = (state) =>
  state === "landed" ? "passed" : state === "rejected" ? "failed" : state === "queued" || state === "held" ? "queued" : "closed"

/** One issue record per inbox entry, lane, review and queue entry, with the links each implies. */
export const recordsOf = ({ inbox, remote }) => {
  const records = []
  inboxEntries(inbox).forEach((entry, index) => {
    const author = authorOf(entry)
    records.push({
      key: `inbox:${index + 1}`,
      kind: "inbox",
      title: title(entry.replace(/^(- |## )/, "").split("\n")[0]),
      body: body([entry, "", "Imported from the proxy inbox."]),
      links: author === undefined ? [] : [{ kind: "assignee", ref: author, label: author }],
    })
  })
  const entries = remote.filter((row) => row.kind === "queue").map((row) => row.entry)
  const byLane = new Map()
  for (const entry of entries) {
    if (typeof entry.lane !== "string") continue
    byLane.set(entry.lane, [...(byLane.get(entry.lane) ?? []), entry])
  }
  const queueLink = (entry) => ({ kind: "queue", ref: entry.id, label: `${entry.id} (${entry.state})`, state: queueState(entry.state) })
  const mergeLink = (entry) =>
    entry.state === "landed" && typeof entry.rev === "string" ? [{ kind: "merge", ref: entry.rev, label: `landed ${entry.rev}`, state: "merged" }] : []
  for (const row of remote) {
    if (row.kind === "lane") {
      const heading = (row.prompt ?? "").split("\n").find((line) => line.trim() !== "") ?? row.name
      const queued = byLane.get(row.name) ?? []
      records.push({
        key: `lane:${row.name}`,
        kind: "lane",
        title: title(heading.replace(/^#+\s*/, "")),
        body: body([row.prompt ?? "", "", `Lane \`${row.name}\`, started ${iso(row.started) ?? "unknown"}.`]),
        links: [
          { kind: "assignee", ref: row.name, label: row.name },
          {
            kind: "session",
            ref: `lane:${row.name}`,
            label: `lane ${row.name}`,
            state: row.exited === undefined || row.exited === null ? "working" : row.exit === null || row.exit === "0" ? "done" : "failed",
          },
          ...queued.map(queueLink),
          ...queued.flatMap(mergeLink),
        ],
      })
    } else if (row.kind === "review") {
      const heading = (row.report ?? "").split("\n").find((line) => line.trim() !== "") ?? row.lane
      records.push({
        key: `review:${row.lane}`,
        kind: "review",
        title: title(`Review: ${heading.replace(/^#+\s*/, "")}`),
        body: body([row.report ?? "", "", `Review findings of lane \`${row.lane}\`, ${iso(row.at) ?? ""}.`]),
        links: [{ kind: "review", ref: `review:${row.lane}`, label: `review of ${row.lane}` }, { kind: "session", ref: `lane:${row.lane}`, label: `lane ${row.lane}` }],
      })
    }
  }
  for (const entry of entries) {
    records.push({
      key: `queue:${entry.id}`,
      kind: "queue",
      title: title(`Queue entry ${entry.id}: ${entry.lane ?? "?"} ${entry.state ?? ""}`),
      body: body([
        `Merge-queue entry \`${entry.id}\``,
        `- lane: ${entry.lane ?? "?"}`,
        `- revision: ${entry.rev ?? "?"} (${entry.commits ?? "?"} commits)`,
        `- queued: ${entry.at ?? "?"}`,
        `- state: ${entry.state ?? "?"}`,
        entry.reason ? `- reason: ${entry.reason}` : undefined,
      ]),
      links: [
        queueLink(entry),
        ...(typeof entry.lane === "string" ? [{ kind: "session", ref: `lane:${entry.lane}`, label: `lane ${entry.lane}` }] : []),
        ...mergeLink(entry),
      ],
    })
  }
  return records
}

/**
 * Up to `total` records, taking from each kind in turn so any prefix has every kind, then synthetic records, which
 * say they are synthetic, to fill `total`.
 */
export const interleave = (records, total) => {
  const kinds = new Map()
  for (const record of records) kinds.set(record.kind, [...(kinds.get(record.kind) ?? []), record])
  const queues = [...kinds.values()]
  const out = []
  while (out.length < total && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) if (queue.length > 0 && out.length < total) out.push(queue.shift())
  }
  for (let index = 1; out.length < total; index++) {
    out.push({
      key: `synthetic:${index}`,
      kind: "synthetic",
      title: `Synthetic volume issue ${index}`,
      body: "Synthetic: made to bring the proof repository to its volume. No work stands behind it.",
      links: [],
    })
  }
  return out
}
