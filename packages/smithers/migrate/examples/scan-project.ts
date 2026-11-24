/**
 * Plans a migration without writing a byte: `Scan.scan` reads a 0.x project,
 * `Scan.toReport` renders the plan-mode report, and `Report.toMarkdown`
 * produces the text `smithers-migrate` writes to
 * `.smithers-migrate/report.md`. This is the library form of
 * `smithers-migrate --scan`; `test/examples.test.ts` runs it.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Report from "@smthrs/migrate/Report"
import * as Scan from "@smthrs/migrate/Scan"
import * as SqliteStoreNode from "@smthrs/migrate/SqliteStoreNode"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

/** Scans `root` and returns the run-state verdict, the planned units, each construct's mapping class, and the report. */
export const scanProject = (root: string, generatedAt = new Date().toISOString()) =>
  Effect.gen(function*() {
    const result = yield* Scan.scan(root)
    const report = Scan.toReport(result, "plan", generatedAt)
    return {
      exitCode: report.exitCode,
      runState: report.runState.verdict,
      units: report.units.map((unit) => `${unit.id}:${unit.status}`),
      mapping: report.mapping.map((decision) => `${decision.construct}:${decision.class}`),
      markdown: Report.toMarkdown(report)
    }
  }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, SqliteStoreNode.layer)))
