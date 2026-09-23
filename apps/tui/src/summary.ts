/** Evidence-first summary, projected onto exactly the same panel contract agents publish. */
import type * as Panels from "./panels.ts"
import * as Transcript from "./transcript.ts"

export const sentence = (value: string): string => {
  const line =
    value.replace(/```[\s\S]*?```/g, "").replace(/[*#`]/g, "").trim().split(/\n/).find((line) => line.trim() !== "")
      ?.trim() ?? ""
  const first = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line
  return first.length > 220 ? `${first.slice(0, 217).trimEnd()}…` : first
}
const verbs: Record<string, string> = {
  read: "Read",
  ls: "Listed",
  glob: "Found files matching",
  grep: "Searched for",
  edit: "Updated",
  write: "Wrote",
  apply_patch: "Patched files",
  "ui.publish": "Updated a view",
  "agent.delegate": "Requested background work",
  "tab.read": "Checked background work"
}
const callLabel = (call: Transcript.Call): string => {
  if (call.status === "failed") return `Failed to ${call.verb?.pending ?? call.flow}: ${sentence(call.subject)}`
  if (call.status === "running") return `${call.verb?.pending ?? `Running ${call.flow}`}: ${sentence(call.subject)}`
  if (call.flow === "bash") {
    return `Ran ${sentence(call.subject)}${call.exit === undefined ? "" : ` (exit ${call.exit})`}`
  }
  return `${verbs[call.flow] ?? call.verb?.success ?? `Called ${call.flow}`} ${sentence(call.subject)}`.trim()
}
const cellLabel = (cell: Extract<Transcript.Item, { kind: "cell" }>): string => {
  if (cell.status === "failed" || cell.status === "rejected") return sentence(cell.error ?? "The cell failed.")
  if (cell.calls.length > 0) {
    const changed = cell.calls.filter((call) =>
      (call.patches?.length ?? 0) > 0 || (call.status === "ok" && call.change !== undefined)
    )
    const failed = cell.calls.filter((call) => call.status === "failed" || call.exit !== undefined)
    const important = [...new Set([...changed, ...failed])]
    const chosen = important.length > 0 ? important : cell.calls
    if (chosen.every((call) => call.flow === "read" && call.status === "ok") && chosen.length > 2) {
      return `Read ${chosen.length} files`
    }
    return chosen.slice(0, 2).map(callLabel).join("; ").slice(0, 220)
  }
  if (cell.prose.trim() !== "") return sentence(cell.prose)
  if (cell.status === "writing") return "Preparing the next step"
  if (cell.status === "running") return "Running the next step"
  if (/ctx\.(done|resolve)\(/.test(cell.source)) return "Returned the answer"
  return cell.printed.trim() === "" ? "Finished the calculation" : "Collected the results"
}
export const panel = (transcript: Transcript.Transcript, id = "summary", title = "Summary"): Panels.Panel => {
  const rows: Panels.Row[] = []
  for (const item of transcript.items) {
    if (item.kind === "cell") {
      const diffs = item.calls.flatMap((call): Panels.Block[] =>
        call.patches !== undefined
          ? call.patches.map((patch) => ({ kind: "diff", ...patch }))
          : call.status !== "ok" || call.change === undefined
          ? []
          : [{ kind: "diff", path: call.change.path, patch: Transcript.unified(call.change) }]
      )
      rows.push({
        id: item.id,
        label: cellLabel(item),
        status: item.status === "rejected" ? "failed" : item.status === "writing" ? "running" : item.status,
        details: [
          ...(item.source === "" ? [] : [{ kind: "code" as const, code: item.source, language: "javascript" }]),
          ...item.calls.map((call): Panels.Block => ({
            kind: "text",
            text: `${callLabel(call)}${call.message === undefined ? "" : `\n${call.message}`}`
          })),
          ...(item.printed === "" ? [] : [{ kind: "text" as const, text: item.printed }]),
          ...(item.error === undefined ? [] : [{ kind: "text" as const, text: item.error }]),
          ...diffs
        ]
      })
    } else if (item.kind === "user") {
      rows.push({ id: item.id, label: `Asked: ${sentence(item.text)}`, details: [{ kind: "text", text: item.text }] })
    } else if (item.kind === "answer") {
      rows.push({
        id: item.id,
        label: sentence(item.text) || "Returned the answer",
        status: "done",
        details: [{ kind: "text", text: item.text }]
      })
    } else if (item.kind === "error") {
      rows.push({
        id: item.id,
        label: sentence(item.text),
        status: "failed",
        details: [{ kind: "text", text: item.text }]
      })
    } else if (item.kind === "shell") {
      rows.push({
        id: item.id,
        label: `Ran ${sentence(item.command)}${item.result?.exitCode ? ` (exit ${item.result.exitCode})` : ""}`,
        status: item.result === undefined
          ? "running"
          : item.result.cancelled
          ? "cancelled"
          : item.result.exitCode === 0
          ? "done"
          : "failed",
        details: [{ kind: "code", code: item.command, language: "bash" }, { kind: "text", text: item.output }]
      })
    }
  }
  const last = rows.at(-1)
  const answer = transcript.items.findLast((item) => item.kind === "answer")
  const summary = transcript.items.at(-1)?.kind === "user"
    ? `Requested: ${sentence((transcript.items.at(-1) as Extract<Transcript.Item, { kind: "user" }>).text)}`
    : last?.status === "failed"
    ? `Stopped: ${last.label}`
    : last?.status === "running"
    ? last.label
    : answer?.kind === "answer"
    ? sentence(answer.text)
    : last?.label ?? "No turns yet."
  return { id, title, summary, rows }
}
