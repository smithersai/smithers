/** Require the durable command model to reject each broken inbox transition. */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const artifacts = resolve(process.env.SMITHERS_MUTATION_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "smithers-signal-mutations-")))
mkdirSync(artifacts, { recursive: true })
rmSync(join(artifacts, "summary.json"), { force: true })
const model = "matches the independent command model"
const pagination = "bounds pages and preserves pending fairness"
const mutations = [
  {
    name: "overwrite-admission",
    original: "VALUES (${commandId}, ${runId}, ${payloadJson}, ${principalJson}) ON CONFLICT(command_id) DO NOTHING",
    replacement: "VALUES (${commandId}, ${runId}, ${payloadJson}, ${principalJson}) ON CONFLICT(command_id) DO UPDATE SET payload_json = excluded.payload_json",
    test: model
  },
  {
    name: "rebind-command",
    original: "WHERE command_id = ${commandId} AND wait_token IS NULL AND state = 'pending' AND NOT EXISTS",
    replacement: "WHERE command_id = ${commandId} AND state = 'pending' AND NOT EXISTS",
    test: model
  },
  {
    name: "bind-terminal-command",
    original: "WHERE command_id = ${commandId} AND wait_token IS NULL AND state = 'pending' AND NOT EXISTS",
    replacement: "WHERE command_id = ${commandId} AND wait_token IS NULL AND NOT EXISTS",
    test: model
  },
  {
    name: "reuse-reserved-token",
    original: "AND NOT EXISTS (SELECT 1 FROM control_signal_commands WHERE wait_token = ${token})",
    replacement: "",
    test: model
  },
  {
    name: "resettle-terminal-command",
    original: "SET state = ${state}, rejection = ${\n            rejection ?? null\n          } WHERE command_id = ${commandId} AND state = 'pending'",
    replacement: "SET state = ${state}, rejection = ${\n            rejection ?? null\n          } WHERE command_id = ${commandId}",
    test: model
  },
  {
    name: "starve-later-pages",
    original: "pendingSignalCursor = rows.at(-1)?.seq ?? 0",
    replacement: "pendingSignalCursor = 0",
    test: pagination
  }
]

const execute = (name, config, pattern) => {
  const report = join(artifacts, `${name}.json`)
  rmSync(report, { force: true })
  rmSync(join(artifacts, name, "signal-inbox-20260904.json"), { force: true })
  const result = spawnSync("pnpm", [
    "exec", "vitest", "run", "test/SignalInboxModel.test.ts", "--config", config,
    "--testNamePattern", pattern, "--reporter=json", `--outputFile=${report}`
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 240_000,
    env: {
      ...process.env,
      SMITHERS_FUZZ_SEED: "20260904",
      SMITHERS_FUZZ_CASES: "1",
      SMITHERS_FUZZ_STEPS: "1",
      SMITHERS_FUZZ_ARTIFACT_DIR: join(artifacts, name)
    }
  })
  writeFileSync(join(artifacts, `${name}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`)
  if (result.error !== undefined) throw result.error
  const outcome = JSON.parse(readFileSync(report, "utf8"))
  return {
    status: result.status,
    outcome,
    tests: outcome.testResults.flatMap((file) => file.assertionResults)
  }
}

const configuration = (mutation) => {
  const config = join(artifacts, `${mutation?.name ?? "baseline"}.config.mjs`)
  writeFileSync(config, `import base from ${JSON.stringify(pathToFileURL(join(root, "vitest.config.ts")).href)};
export default {
  ...base,
  ${mutation === undefined ? "" : `plugins: [...base.plugins, { name: ${JSON.stringify(mutation.name)}, enforce: 'pre', transform(code, id) {
    if (!id.endsWith('/control/src/SqlControlRuntime.ts')) return null;
    const original = ${JSON.stringify(mutation.original)};
    if (code.split(original).length !== 2) throw new Error('Mutation site must occur exactly once');
    return code.replace(original, ${JSON.stringify(mutation.replacement)});
  }}],`}
  test: { ...base.test, coverage: { enabled: false } }
};
`)
  return config
}

// Reject stale or ambiguous sites before running a baseline or writing evidence.
const source = readFileSync(join(root, "src/SqlControlRuntime.ts"), "utf8")
for (const mutation of mutations) {
  const occurrences = source.split(mutation.original).length - 1
  if (occurrences !== 1) {
    throw new Error(`${mutation.name}: expected one SQL mutation site, found ${occurrences}`)
  }
}

// A broken environment cannot count as a killed mutant. Prove that both selected
// tests pass, then require each mutant to fail its selected behavioral assertion.
const baseline = execute("baseline", configuration(), `${model}|${pagination}`)
if (baseline.status !== 0 || baseline.outcome.numPassedTests !== 2 || !baseline.outcome.success) {
  throw new Error(`Baseline did not pass both model and pagination tests; see ${artifacts}`)
}
const results = []
for (const mutation of mutations) {
  const result = execute(mutation.name, configuration(mutation), mutation.test)
  const failures = result.tests.filter((test) => test.status === "failed")
  const modelFailure = mutation.test === model
    ? JSON.parse(readFileSync(join(artifacts, mutation.name, "signal-inbox-20260904.json"), "utf8"))
    : undefined
  const assertionFailed = modelFailure === undefined
    ? failures.some((test) => test.failureMessages.some((message) => message.includes("AssertionError")))
    : modelFailure.status === "failed" && modelFailure.cause.startsWith("AssertionError:")
  if (
    result.status !== 1 || failures.length !== 1 || !failures[0].title.includes(mutation.test) ||
    !assertionFailed
  ) {
    throw new Error(`${mutation.name} was not killed by its behavioral assertion; see ${artifacts}`)
  }
  results.push({ name: mutation.name, status: "killed", test: failures[0].fullName })
  console.log(`${mutation.name}: killed`)
}
writeFileSync(join(artifacts, "summary.json"), `${JSON.stringify({ baseline: "passed", results }, null, 2)}\n`)
console.log(`Mutation evidence: ${artifacts}`)
