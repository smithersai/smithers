/**
 * Bazel Skyframe parity review: five parallel fable agents, one per
 * evaluation-core package, each writes a findings section; the driver
 * concatenates them into one report.
 *
 * Launch: `bun factory/flows/bazel-review.ts`
 * Progress: tail factory/reports/bazel-review/<package>.log
 * Result:   factory/reports/BAZEL-PARITY-REVIEW.md
 */
import * as Schema from "effect/Schema"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { AgentTask, REPO_ROOT, REPORTS_DIR, runFlow, type TaskResult } from "./harness.ts"

const MODEL = "claude-fable-5"
const TIMEOUT_MS = 60 * 60_000
const PACKAGES = ["keys", "engine", "engine-store", "step-cache", "plan"]
const SKYFRAME = path.join(
  REPO_ROOT,
  "reference/bazel/src/main/java/com/google/devtools/build/skyframe"
)
const logDir = path.join(REPORTS_DIR, "bazel-review", randomUUID())
const reportPath = path.join(REPORTS_DIR, "BAZEL-PARITY-REVIEW.md")

const promptFor = (pkg: string): string =>
  [
    "You are a senior reviewer comparing our TypeScript incremental-evaluation engine to Bazel Skyframe.",
    `Read our package ${REPO_ROOT}/packages/${pkg} (src/ especially, tests where they document intent)`,
    `and the Skyframe sources in ${SKYFRAME} (read-only prior art; NEVER modify anything under reference/).`,
    "Hunt for real bugs and design gaps in our package relative to Skyframe's invariants:",
    "node dirtying and change pruning, version handling (graph/evaluation versions), error bubbling and transitive error propagation, cycle detection, dependency bookkeeping and invalidation, partial re-evaluation, interruption handling, memoization and reuse correctness.",
    "Report only findings that matter — bugs, missing invariants, unsound shortcuts — each with file:line evidence from our code and the Skyframe counterpart file that shows the invariant.",
    "Rank findings by severity. If an area is genuinely sound, say so in one line; do not pad.",
    `Write your findings as markdown to ${logDir}/${pkg}.md (create directories as needed). Do not modify any other file.`,
    "End by printing DONE."
  ].join(" ")

const Review = Flow.make("factory/BazelReview", {
  payload: { run: Schema.String },
  success: Schema.Record(Schema.String, Schema.Unknown),
  body: () =>
    Node.all(
      Object.fromEntries(
        PACKAGES.map((pkg) => [
          pkg,
          AgentTask.call({
            id: `review-${pkg}`,
            prompt: promptFor(pkg),
            cwd: REPO_ROOT,
            model: MODEL,
            timeoutMs: TIMEOUT_MS,
            logDir,
            completionMarker: "DONE",
            allowedPaths: [path.join(logDir, `${pkg}.md`)]
          })
        ])
      )
    )
})

const startedAt = new Date().toISOString()
console.log(`bazel-review: ${PACKAGES.length} reviewers, model ${MODEL}`)
const result = (await runFlow(
  Review,
  { run: startedAt },
  `bazel-review-${startedAt.slice(0, 10)}`
)) as Record<string, TaskResult>

const sections: Array<string> = [
  "# Bazel Skyframe parity review",
  "",
  `Generated ${new Date().toISOString()} by five parallel ${MODEL} agents`,
  `run through the Smithers library itself (factory/flows/bazel-review.ts).`,
  ""
]
for (const pkg of PACKAGES) {
  const r = result[pkg]!
  const sectionPath = path.join(logDir, `${pkg}.md`)
  sections.push(`## packages/${pkg}`, "")
  if (fs.existsSync(sectionPath)) {
    sections.push(fs.readFileSync(sectionPath, "utf8"), "")
  } else {
    sections.push(
      `Reviewer exited ${r.exitCode} without writing ${sectionPath}. Log: ${r.logPath}`,
      ""
    )
  }
  console.log(`  ${pkg}: exit ${r.exitCode}`)
}
const failed = PACKAGES.filter((pkg) => {
  const resultForPackage = result[pkg]!
  return resultForPackage.exitCode !== 0 || !fs.existsSync(path.join(logDir, `${pkg}.md`))
})
if (failed.length > 0) {
  process.exitCode = 1
  console.error(`bazel-review failed: incomplete seats: ${failed.join(", ")}`)
} else {
  fs.writeFileSync(reportPath, sections.join("\n"))
  console.log(`bazel-review done. Report: ${reportPath}`)
}
