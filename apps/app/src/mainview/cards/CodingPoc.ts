import { Option, Schema } from "effect"
import * as Digest from "@smthrs/core/Digest"
import { PocInput, PocResult } from "../../../../../flows/coding/poc-schema.ts"
import type { Card } from "../state/AppState"
import { engineRunEvidence } from "./EngineTrace"

const decodeInput = Schema.decodeUnknownOption(PocInput)
const decodeResult = Schema.decodeUnknownOption(PocResult)

/** A retained child result, selected through the existing native trace cursor. */
export const codingPocOf = (card: Extract<Card, { kind: "run-trace" }>) => {
  const { completed } = engineRunEvidence(card.payload.events ?? [], card.payload.runId, card.payload.cursorSeq)
  const candidates = completed.flatMap(execution => {
    if (execution.flowName !== "coding/Poc") return []
    const input = decodeInput(execution.input)
    const result = decodeResult(execution.result!.value)
    if (Option.isNone(input) || Option.isNone(result) || result.value.changes.files.length === 0 ||
      Digest.canonical(input.value.source) !== Digest.canonical(result.value.source)) return []
    if (new Set(result.value.changes.files.map(file => file.path)).size !== result.value.changes.files.length) return []
    return [{ executionId: execution.executionId, spanId: execution.spanId, result: result.value,
      sequence: execution.result!.sequence }]
  }).sort((a, b) => b.sequence - a.sequence)
  const selected = candidates.filter(row => row.spanId === card.payload.selection)
  if (selected.length === 1) return selected[0]
  return candidates[0] === undefined || candidates[1]?.sequence === candidates[0].sequence ? undefined : candidates[0]
}
