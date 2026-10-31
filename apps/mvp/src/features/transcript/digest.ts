import { digestSync } from "@smthrs/crypto"
import type { Row } from "./schema"

// The digest of a run's transcript (decision 0134): a SHA-256 chain over its events in order, so a tab that replayed
// the transcript can check it holds exactly what the run's `RunContent` holds, and a test can compare the two. The
// object keeps the chain as it stores each event; the tab computes it as each event arrives.

/** The chain after `row`, from the chain before it. */
export const chain = (previous: string, row: Pick<Row, "n" | "generation" | "seq" | "kind" | "update">): string =>
  digestSync(`${previous}\n${row.n} ${row.generation} ${row.seq} ${row.kind} ${JSON.stringify(row.update)}`)
