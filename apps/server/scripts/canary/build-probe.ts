/*
 * CN-1: the deployed bundle is the git sha the deploy receipt claims.
 *
 *   bun scripts/canary/build-probe.ts [origin] [--sha <sha>] [--receipt <path>]
 *                                     [--max-drift <n>] [--json <path>]
 *                                     [--allow-unstamped-html]
 *
 * Reads the build stamp the deployment carries (the site build writes it,
 * apps/site/scripts/build-stamp-integration.ts over apps/app/scripts/build-stamp.ts)
 * and compares it with the sha the caller expects. No credential is needed:
 * the stamp is a static asset on a public deployment.
 *
 * Expected sha resolution, first hit wins: --sha, $CANARY_EXPECTED_SHA,
 * --receipt <path>, then ../../deploy-receipts/latest.json when it exists.
 * Receipts are gitignored, so a scheduled run usually resolves none; that
 * check then prints as skipped, never as a pass.
 *
 * The HTML-vs-asset row compares the served app document (the prerendered
 * /<owner>/<name>/ page, the one HTML in the build that carries the stamp) with
 * the served /__build.json and fails either direction of disagreement,
 * including HTML that carries no stamp at all. It does not fetch the hashed
 * chunks the document names. Pass --allow-unstamped-html only while the deploy that introduces the
 * stamp is landing; it downgrades that row to a skip and never to a pass.
 *
 * This file is the process shell only. Every verdict lives in BuildStamp.ts,
 * which is unit-tested; the fetches below are the untested lines.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  BUILD_STAMP_PATH,
  buildShaFromHtml,
  buildShaVerdict,
  expectedShaFromReceipt,
  hasFlag,
  HTML_AGREEMENT_COVERAGE,
  htmlAgreementVerdict,
  parseBuildStamp,
  resolveOrigin
} from "./BuildStamp.ts"
import type { BuildStamp } from "./BuildStamp.ts"
import { argReader } from "./CanaryArgs.ts"
import { DEFAULT_APP_DOCUMENT_PATH } from "../../src/appDocument.ts"

const argv = process.argv.slice(2)
/*
 * Exit 2, not 1: a flag the operator left empty is a mistake in this
 * invocation, and it must never be read as a verdict about the deployment.
 */
const flag = argReader(argv, (detail) => {
  console.error(`FAIL: ${detail}`)
  process.exit(2)
})
/*
 * The escape hatch for the single deploy that introduces the stamp, and for
 * nothing else. It downgrades unstamped HTML from a failure to a skip; it
 * cannot turn any comparison into a pass.
 */
const allowUnstampedHtml = hasFlag(argv, "--allow-unstamped-html")
const origin = resolveOrigin(argv, { CANARY_URL: process.env.CANARY_URL })
const maxDriftArg = flag("--max-drift")
if (maxDriftArg !== undefined && !/^\d+$/.test(maxDriftArg)) {
  console.error(`--max-drift takes a commit count, not "${maxDriftArg}".`)
  process.exit(2)
}
const maxDrift = maxDriftArg === undefined ? undefined : Number.parseInt(maxDriftArg, 10)
const jsonPath = flag("--json")
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url))

let failures = 0
const checks: Array<{ label: string; status: "ok" | "FAIL" | "skip"; detail: string }> = []
const record = (label: string, status: "ok" | "FAIL" | "skip", detail: string): void => {
  if (status === "FAIL") failures += 1
  console.log(`${status}: ${label} — ${detail}`)
  checks.push({ label, status, detail })
}
const check = (label: string, ok: boolean, detail: string): void => record(label, ok ? "ok" : "FAIL", detail)
const skip = (label: string, detail: string): void => record(label, "skip", detail)

/*
 * A cache-buster and no-store together: the stamp is an unhashed asset, so
 * Cloudflare's asset layer and any intermediary are both entitled to hold a
 * copy, and a probe that reads a cache is measuring nothing.
 */
const noCache = { cache: "no-store" as const, headers: { "cache-control": "no-cache" } }
const bust = `?t=${Date.now()}`

// 1. The deployment states what it is.
const stampResponse = await fetch(`${origin}${BUILD_STAMP_PATH}${bust}`, noCache)
const parsed = parseBuildStamp({ status: stampResponse.status, body: await stampResponse.text() })
check(
  "the deployment carries a build stamp",
  typeof parsed !== "string",
  typeof parsed === "string" ? parsed : `${BUILD_STAMP_PATH} names ${parsed.gitSha}`
)

if (typeof parsed === "string") {
  console.log(`\nCN-1 FAILED: ${failures} check(s). The deployment cannot state which commit it is.`)
  if (jsonPath !== undefined) {
    writeFileSync(jsonPath, `${JSON.stringify({ origin, stamp: null, checks }, null, "\t")}\n`)
  }
  process.exit(1)
}
const stamp: BuildStamp = parsed

// 2. The HTML and the assets are the same build. The app document is the
// HTML that carries the stamp; the site's landing page at / does not.
const htmlResponse = await fetch(`${origin}${DEFAULT_APP_DOCUMENT_PATH}${bust}`, noCache)
const metaSha = htmlResponse.ok ? buildShaFromHtml(await htmlResponse.text()) : null
if (!htmlResponse.ok) {
  await htmlResponse.body?.cancel()
}

// 3. The expected sha, if anything states one.
const receiptPath = flag("--receipt") ??
  fileURLToPath(new URL("../../deploy-receipts/latest.json", import.meta.url))
let expectedSha = flag("--sha") ?? process.env.CANARY_EXPECTED_SHA
let receiptNote = expectedSha === undefined ? "" : "from --sha/$CANARY_EXPECTED_SHA"
if (expectedSha === undefined) {
  if (existsSync(receiptPath)) {
    const claim = expectedShaFromReceipt(readFileSync(receiptPath, "utf8"))
    if (claim.kind === "sha") {
      expectedSha = claim.gitSha
      receiptNote = `from ${receiptPath}${claim.gitDirty ? " (built from a dirty tree)" : ""}`
    } else {
      receiptNote = claim.reason
    }
  } else {
    receiptNote = `no deploy receipt at ${receiptPath}`
  }
}

/*
 * 4. Drift. `git rev-list --count <sha>..origin/main` is the only honest
 * measure of how far behind a deployment is, and it needs a checkout that has
 * both commits. A shallow clone or an unfetched origin cannot answer, and that
 * is reported rather than guessed.
 */
let commitsBehind: number | undefined
let driftNote = "not requested (--max-drift)"
if (maxDrift !== undefined) {
  const proc = Bun.spawn(["git", "rev-list", "--count", `${stamp.gitSha}..origin/main`], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe"
  })
  const out = (await new Response(proc.stdout).text()).trim()
  const exitCode = await proc.exited
  if (exitCode === 0 && /^\d+$/.test(out)) {
    commitsBehind = Number.parseInt(out, 10)
  } else {
    driftNote = `git could not measure drift from ${stamp.gitSha} to origin/main in ${repoRoot} (exit ${exitCode})`
  }
}

/*
 * The stamp parsed, so the build that emitted it also stamped its own app
 * document. Unstamped HTML from here on is evidence of a half-published
 * deploy, not of an unverifiable input, and it is graded as one.
 */
const agreement = htmlAgreementVerdict(stamp, { status: htmlResponse.status, metaSha }, allowUnstampedHtml)
record("the served HTML and the build stamp are from the same build", agreement.status, agreement.detail)
console.log(`note: that check ${HTML_AGREEMENT_COVERAGE}.`)

/*
 * Each of the last two checks makes exactly one claim, so a failing line names
 * the thing that is wrong. Both are skipped rather than passed when the input
 * they need is absent: a probe that reports "ok" for a comparison it never made
 * is the failure mode CN-1 exists to end.
 */
if (expectedSha === undefined) {
  skip("the deployed sha matches the expected sha", receiptNote)
} else {
  /*
   * metaSha is not passed: the HTML/asset comparison has its own row above, and
   * this line claims only that the served sha is the expected one. Reporting a
   * disagreement twice under two labels hides which one is broken.
   */
  const verdict = buildShaVerdict(stamp, expectedSha, null, undefined, 0)
  check("the deployed sha matches the expected sha", verdict.ok, `${verdict.detail} (${receiptNote})`)
}

if (maxDrift === undefined || commitsBehind === undefined) {
  skip("the deployment is within the drift budget of origin/main", driftNote)
} else {
  const verdict = buildShaVerdict(stamp, undefined, null, commitsBehind, maxDrift)
  check("the deployment is within the drift budget of origin/main", verdict.ok, verdict.detail)
}

if (jsonPath !== undefined) {
  writeFileSync(
    jsonPath,
    `${
      JSON.stringify(
        {
          origin,
          stamp,
          expectedSha: expectedSha ?? null,
          metaSha,
          htmlAgreementCoverage: HTML_AGREEMENT_COVERAGE,
          commitsBehind: commitsBehind ?? null,
          checks
        },
        null,
        "\t"
      )
    }\n`
  )
}

if (failures > 0) {
  console.log(`\nCN-1 FAILED: ${failures} check(s). ${origin} is not serving the commit it is supposed to.`)
  process.exit(1)
}
/*
 * A pass line names the rows that were never graded. A skipped row is not a
 * verified one, and CN-1 exists because a green summary that hides an ungraded
 * comparison is how a stale deployment stayed invisible for thirteen commits.
 */
const skipped = checks.filter((entry) => entry.status === "skip")
console.log(
  `\nCN-1 PASS: ${origin} serves ${stamp.gitSha}, built ${stamp.builtAt}${
    skipped.length === 0
      ? ""
      : ` (${skipped.length} check(s) not graded: ${skipped.map((entry) => entry.label).join("; ")})`
  }.`
)
