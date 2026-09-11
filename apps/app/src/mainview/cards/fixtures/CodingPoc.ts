import { readFileSync } from "node:fs"
import type { PocResult } from "../../../../../../flows/coding/poc-schema.ts"
import { CODING_PLAN } from "./CodingPlan"
import { codingDecision } from "./CodingJournal"

/** Actual standalone Node/JJ/SQLite prototype output (2026-09-09), including create/edit/delete and a UTF-8 BOM. */
export const CODING_POC_RESULT: PocResult = JSON.parse(readFileSync(new URL("./CodingPocResult.json", import.meta.url), "utf8"))
/** Unmodified configured-host decisions through the real POC child's completion; its parent is still running. */
export const CODING_POC_HOST_EVENTS: Array<Record<string, unknown>> = readFileSync(new URL("./CodingPocHostDecisions.ndjson", import.meta.url), "utf8")
  .trim().split("\n").map(line => JSON.parse(line))
/** Synthetic production-writer envelopes around the actual result for adverse projection cases. */
export const codingPocJournal = (result = CODING_POC_RESULT) => [
  codingDecision(1, "run-1", "agent/run"),
  codingDecision(2, "request", "coding/Request", { parent: "run-1", status: "running" }),
  codingDecision(3, "poc", "coding/Poc", { parent: "request", status: "running", input: { plan: CODING_PLAN, source: result.source } }),
  codingDecision(4, "poc", "coding/Poc", { parent: "request", status: "completed", input: { plan: CODING_PLAN, source: result.source }, value: result })
]
