import type { ChainEventRecord } from "../state/AppState"

/*
 * Debug mode's read side (DESIGN.md §14): pure folds over the chainEvents
 * collection — the same journal the chain runs on, rendered at full
 * fidelity. Forensics discipline: these functions read recorded evidence and
 * report what is absent as absent; they never replay, never mutate, and a
 * seq cap (`upToSeq`) makes the fold a scrubber — the view at any journal
 * offset, honest by construction because replay is deterministic.
 */

interface RawEvent {
  readonly _tag: string
  readonly chain?: string
  readonly link?: number
  readonly name?: string
  readonly payload?: unknown
  readonly result?: unknown
  readonly key?: { readonly ordinal?: number }
  readonly ordinal?: number
  readonly script?: { readonly text?: string; readonly digest?: string }
  readonly observation?: { readonly kind?: string; readonly message?: string }
  readonly outcome?: { readonly _tag?: string; readonly reason?: { readonly code?: string } }
  readonly messages?: ReadonlyArray<string>
  readonly goal?: string
}

export interface DebugCall {
  readonly seq: number
  readonly ordinal: number
  readonly name: string
  readonly payload: unknown
  readonly result: unknown
}

export interface DebugRejection {
  readonly seq: number
  readonly kind: string
  readonly message: string
}

export interface DebugLink {
  readonly link: number
  readonly script?: string
  readonly scriptDigest?: string
  readonly calls: ReadonlyArray<DebugCall>
  readonly rejections: ReadonlyArray<DebugRejection>
  readonly steering: ReadonlyArray<string>
  readonly outcome?: string
  /** What each author call in this link was handed — the two-histories view. */
  readonly authorContexts: ReadonlyArray<ReadonlyArray<string>>
}

export interface DebugLineage {
  readonly lineageId: string
  readonly goal?: string
  readonly seqCount: number
  readonly links: ReadonlyArray<DebugLink>
  /** Child-scoped event counts by derived chain id (sub-agents). */
  readonly children: Readonly<Record<string, number>>
}

const contextOf = (payload: unknown): ReadonlyArray<string> | undefined => {
  if (typeof payload === "object" && payload !== null && "context" in payload) {
    const context = (payload as { readonly context?: unknown }).context
    if (Array.isArray(context)) return context.map((line) => String(line))
  }
  return undefined
}

export const foldLineages = (
  records: ReadonlyArray<ChainEventRecord>,
  upToSeq?: number
): ReadonlyArray<DebugLineage> => {
  const byLineage = new Map<string, Array<ChainEventRecord>>()
  for (const record of records) {
    if (upToSeq !== undefined && record.seq > upToSeq) continue
    const rows = byLineage.get(record.lineageId) ?? []
    rows.push(record)
    byLineage.set(record.lineageId, rows)
  }
  return [...byLineage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([lineageId, rows]) => {
      rows.sort((left, right) => left.seq - right.seq)
      const links = new Map<
        number,
        {
          script?: string
          scriptDigest?: string
          calls: Array<DebugCall>
          rejections: Array<DebugRejection>
          steering: Array<string>
          outcome?: string
          authorContexts: Array<ReadonlyArray<string>>
        }
      >()
      const children: Record<string, number> = {}
      let goal: string | undefined
      const linkOf = (index: number) => {
        const existing = links.get(index)
        if (existing !== undefined) return existing
        const fresh = { calls: [], rejections: [], steering: [], authorContexts: [] } as NonNullable<
          ReturnType<typeof links.get>
        >
        links.set(index, fresh)
        return fresh
      }
      for (const record of rows) {
        const event = record.event as RawEvent
        if (event.chain !== undefined) {
          children[event.chain] = (children[event.chain] ?? 0) + 1
          continue
        }
        switch (event._tag) {
          case "ChainStarted":
            goal = event.goal
            break
          case "LinkAuthored": {
            const target = linkOf(event.link ?? 0)
            target.script = event.script?.text
            target.scriptDigest = event.script?.digest
            break
          }
          case "CallSettled": {
            const target = linkOf(event.link ?? 0)
            target.calls.push({
              seq: record.seq,
              ordinal: event.key?.ordinal ?? 0,
              name: event.name ?? "",
              payload: event.payload,
              result: event.result
            })
            if (event.name === "author") {
              const context = contextOf(event.payload)
              if (context !== undefined) target.authorContexts.push(context)
            }
            break
          }
          case "GateRejected": {
            const target = linkOf(event.link ?? 0)
            target.rejections.push({
              seq: record.seq,
              kind: event.observation?.kind ?? "",
              message: event.observation?.message ?? ""
            })
            break
          }
          case "SteeringDrained": {
            const target = linkOf(event.link ?? 0)
            target.steering.push(...(event.messages ?? []))
            break
          }
          case "LinkEnded": {
            const target = linkOf(event.link ?? 0)
            const tag = event.outcome?._tag ?? ""
            target.outcome = tag === "Park" ? `Park(${event.outcome?.reason?.code ?? ""})` : tag
            break
          }
        }
      }
      return {
        lineageId,
        goal,
        seqCount: rows.length,
        links: [...links.entries()]
          .sort(([left], [right]) => left - right)
          .map(([link, value]) => ({ link, ...value })),
        children
      }
    })
}
