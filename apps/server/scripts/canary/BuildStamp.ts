/*
 * CN-1: is the deployed bundle the git sha the deploy receipt claims?
 *
 * The live canary served a build 13 commits old and nothing detected it,
 * because the deployment could not state what it was. `apps/app/vite.config.ts`
 * now stamps the sha into the SPA bundle at build time, twice: a
 * `__build.json` asset and a `<meta name="smithers-build-sha">` tag on the
 * HTML. Both travel inside the artifact, so a stale bundle serves a stale
 * stamp. Nothing is computed at request time, so no deployment can report a
 * sha it is not serving.
 *
 * This module is the pure half of the probe: it turns a fetched status and
 * body into a verdict. `build-probe.ts` beside it does the fetching, the
 * printing, and the exit code. Everything here is a total function of its
 * arguments so the verdicts are tested without a deployment.
 */

/**
 * The asset `vite build` emits into the bundle. Served straight from the
 * Cloudflare assets layer: `wrangler.jsonc` runs the Worker first only for
 * `/api/*`, `/v1/*`, `/workflows/*` and `/smithersai/*`, so this path needs no Worker route and
 * no credential to read.
 */
export const BUILD_STAMP_PATH = "/__build.json"

/** The corroborating meta tag on the served HTML. */
export const BUILD_STAMP_META = "smithers-build-sha"

/** What a deployment says about itself. Mirrors the vite plugin's emit. */
export interface BuildStamp {
  readonly worker: string
  readonly gitSha: string
  readonly builtAt: string
}

/** A fetched response reduced to what the verdicts need. */
export interface FetchedStamp {
  readonly status: number
  readonly body: string
}

const SHA_PATTERN = /^(?:[0-9a-f]{7,40}|unknown)$/i

/**
 * The stamp, or a sentence naming why there is none. A missing stamp is never
 * silently tolerated: a deployment that cannot say what it is has failed CN-1
 * exactly as loudly as one that says the wrong thing.
 */
export const parseBuildStamp = (fetched: FetchedStamp): BuildStamp | string => {
  if (fetched.status === 404) {
    return `GET ${BUILD_STAMP_PATH} answered 404: this deployment's bundle carries no build stamp, so it predates the stamp and cannot state what it is`
  }
  if (fetched.status !== 200) {
    return `GET ${BUILD_STAMP_PATH} answered HTTP ${fetched.status}`
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fetched.body)
  } catch {
    /*
     * The SPA fallback answers HTML for an unknown path on some asset
     * configurations, so a 200 is not by itself evidence of a stamp.
     */
    return `GET ${BUILD_STAMP_PATH} answered 200 with a body that is not JSON: ${
      fetched.body.replace(/\s+/g, " ").trim().slice(0, 80)
    }`
  }
  /*
   * `JSON.parse` answers null, a number or an array for bodies that are valid
   * JSON without being a stamp, and reading a field off null throws. A total
   * function cannot throw where it promised a diagnostic, so the shape is
   * checked before any field is read.
   */
  if (typeof parsed !== "object" || parsed === null) {
    return `GET ${BUILD_STAMP_PATH} answered 200 with a body that is not a build stamp`
  }
  const stamp = parsed as { gitSha?: unknown; builtAt?: unknown; worker?: unknown }
  if (typeof stamp.gitSha !== "string" || typeof stamp.builtAt !== "string") {
    return `GET ${BUILD_STAMP_PATH} answered 200 with a body that is not a build stamp`
  }
  if (!SHA_PATTERN.test(stamp.gitSha)) {
    return `the deployment's build stamp names "${stamp.gitSha}", which is not a git sha`
  }
  if (stamp.gitSha.toLowerCase() === "unknown") {
    return "the deployment's build stamp says \"unknown\": it was built outside a git checkout, so nothing can be verified against it"
  }
  return {
    worker: typeof stamp.worker === "string" ? stamp.worker : "unknown",
    gitSha: stamp.gitSha,
    builtAt: stamp.builtAt
  }
}

/**
 * The sha the served HTML claims, or null when the HTML carries no stamp.
 * The tag is located by its name attribute and then read for its content, so
 * attribute order and quoting style do not change the answer.
 */
export const buildShaFromHtml = (html: string): string | null => {
  const tag = new RegExp(`<meta[^>]*name=["']${BUILD_STAMP_META}["'][^>]*>`, "i").exec(html)?.[0]
  if (tag === undefined) return null
  return /content=["']([^"']*)["']/i.exec(tag)?.[1] ?? null
}

export interface Verdict {
  readonly ok: boolean
  readonly detail: string
}

/**
 * What the HTML-vs-asset check does and does not cover, stated once and
 * printed by the probe so a green line cannot be read as a broader claim than
 * it is.
 *
 * It compares two artifacts of one build: the served app document (the
 * prerendered `/<owner>/<name>/` page) and the served `/__build.json`. It fails in both directions of disagreement: HTML
 * newer than the assets, and assets newer than the HTML, including the case
 * where the HTML carries no stamp at all. It does not fetch the hashed
 * chunks `index.html` names, so a deploy that published `index.html` and
 * `/__build.json` but not the chunks they reference is out of scope.
 */
export const HTML_AGREEMENT_COVERAGE =
  `compares the served app document with the served ${BUILD_STAMP_PATH} and fails either direction of disagreement, including HTML that carries no stamp at all; it does not fetch the hashed chunks the document names, so a deploy that published the document and ${BUILD_STAMP_PATH} but not the chunks they reference is out of scope`

/** A check that can also decline to grade, because its input was unreadable. */
export interface Graded {
  readonly status: "ok" | "FAIL" | "skip"
  readonly detail: string
}

/** The served HTML, reduced to what the agreement verdict needs. */
export interface FetchedHtml {
  readonly status: number
  readonly metaSha: string | null
}

/**
 * Are the served HTML and the served build stamp from the same build?
 *
 * One vite build emits both halves: `transformIndexHtml` injects the meta tag
 * and `generateBundle` emits the asset. So a parsed stamp proves the build
 * that produced it also stamped its own `index.html`. Served HTML with no meta
 * tag therefore came from a different, older, pre-stamp build. That is a
 * half-published deploy in the direction that matters most, because
 * `index.html` names the hashed chunks the browser actually runs, and it is
 * reported as a failure.
 *
 * The transition is not a hole. Before the first stamped deploy the HTML
 * legitimately has no meta tag, but that bundle also carries no
 * `/__build.json`: the stamp fetch answers 404 and the probe fails earlier,
 * naming the real cause. This verdict is only reached once a stamp parsed, and
 * no ordering of a single atomic deploy leaves a fresh stamp beside pre-stamp
 * HTML. `allowUnstampedHtml` exists for the one operator who is watching that
 * deploy land and wants the row parked rather than red; it downgrades the
 * failure to a skip and never to a pass.
 *
 * An unreadable root is a skip, not a pass and not a failure of this claim:
 * the comparison was never made. The uptime probe's `spa` check is what grades
 * `GET /` for a 200.
 */
export const htmlAgreementVerdict = (
  stamp: BuildStamp,
  html: FetchedHtml,
  allowUnstampedHtml: boolean
): Graded => {
  if (html.status < 200 || html.status > 299) {
    return {
      status: "skip",
      detail:
        `GET of the app document answered HTTP ${html.status}, so the served HTML could not be compared with ${BUILD_STAMP_PATH} (the uptime probe grades availability)`
    }
  }
  if (html.metaSha === null) {
    const cause =
      `the served HTML carries no <meta name="${BUILD_STAMP_META}"> tag, but ${BUILD_STAMP_PATH} names ${stamp.gitSha}: one build emits both, so the HTML predates the stamp while the assets do not`
    if (allowUnstampedHtml) {
      return { status: "skip", detail: `${cause}. Graded as unverified because --allow-unstamped-html was passed` }
    }
    return {
      status: "FAIL",
      detail:
        `${cause}. That is a half-published deploy, and index.html is the half that names the chunks the browser runs`
    }
  }
  if (html.metaSha !== stamp.gitSha) {
    return {
      status: "FAIL",
      detail:
        `the served HTML claims ${html.metaSha} but ${BUILD_STAMP_PATH} claims ${stamp.gitSha}: the HTML and the assets are from different builds`
    }
  }
  return {
    status: "ok",
    detail: `the HTML and ${BUILD_STAMP_PATH} both name ${stamp.gitSha}`
  }
}

/**
 * Does the deployment serve the sha it is supposed to?
 *
 * The checks run in this order because an earlier failure makes the later
 * comparisons meaningless:
 *
 *   1. HTML and asset disagreeing means a half-published deploy. There is no
 *      single sha for the later checks to compare. `htmlAgreementVerdict`
 *      above grades that comparison on its own row, including the case this
 *      rule cannot see, where the HTML carries no stamp at all.
 *   2. The receipt is the claim CN-1 exists to test.
 *   3. Drift from origin/main catches the deploy nobody ran, which no receipt
 *      records because no receipt was written.
 *
 * `expectedSha` and `commitsBehind` are optional because a scheduled probe
 * often has neither a receipt nor a git checkout. An absent input is reported
 * as a skipped check by the caller, never as a pass.
 */
export const shaMatches = (served: string, expected: string): boolean =>
  expected.length >= 7 && served.startsWith(expected)

export const buildShaVerdict = (
  stamp: BuildStamp,
  expectedSha: string | undefined,
  metaSha: string | null,
  commitsBehind: number | undefined,
  maxDrift: number
): Verdict => {
  if (metaSha !== null && metaSha !== stamp.gitSha) {
    return {
      ok: false,
      detail:
        `the served HTML claims ${metaSha} but ${BUILD_STAMP_PATH} claims ${stamp.gitSha}: the HTML and the assets are from different builds`
    }
  }
  // `--sha` is typed by hand, so an abbreviated sha (7+ hex) matches as a prefix.
  if (expectedSha !== undefined && !shaMatches(stamp.gitSha, expectedSha)) {
    return {
      ok: false,
      detail: `the deployment serves ${stamp.gitSha}, the receipt claims ${expectedSha}${
        commitsBehind === undefined ? "" : ` (${commitsBehind} commit(s) behind origin/main)`
      }`
    }
  }
  if (commitsBehind !== undefined && commitsBehind > maxDrift) {
    return {
      ok: false,
      detail:
        `the deployment serves ${stamp.gitSha}, which is ${commitsBehind} commit(s) behind origin/main (drift budget ${maxDrift})`
    }
  }
  return {
    ok: true,
    detail: `the deployment serves ${stamp.gitSha}, built ${stamp.builtAt}${
      commitsBehind === undefined ? "" : ` (${commitsBehind} commit(s) behind origin/main)`
    }`
  }
}

/**
 * What a deploy receipt claims about the live deployment. A dry-run receipt is
 * refused: it published nothing, so its sha is not a claim about anything that
 * is serving traffic.
 */
export type ReceiptClaim =
  | { readonly kind: "sha"; readonly gitSha: string; readonly gitDirty: boolean }
  | { readonly kind: "none"; readonly reason: string }

export const expectedShaFromReceipt = (receiptJson: string): ReceiptClaim => {
  let parsed: unknown
  try {
    parsed = JSON.parse(receiptJson)
  } catch {
    return { kind: "none", reason: "the deploy receipt is not JSON" }
  }
  /* Same as above: a receipt of `null` is JSON, and reading dryRun off it throws. */
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "none", reason: "the deploy receipt records no usable gitSha" }
  }
  const receipt = parsed as { gitSha?: unknown; dryRun?: unknown; gitDirty?: unknown }
  if (receipt.dryRun === true) {
    return {
      kind: "none",
      reason: "the latest deploy receipt is a dry run: it published nothing, so it makes no claim about the deployment"
    }
  }
  if (typeof receipt.gitSha !== "string" || !SHA_PATTERN.test(receipt.gitSha)) {
    return { kind: "none", reason: "the deploy receipt records no usable gitSha" }
  }
  return { kind: "sha", gitSha: receipt.gitSha, gitDirty: receipt.gitDirty === true }
}

/*
 * Reading `--name value` is not a build-stamp concern: it lives in
 * CanaryArgs.ts, where every canary shell shares one parser.
 */

/** Is the boolean flag `--name` present? */
export const hasFlag = (argv: ReadonlyArray<string>, name: string): boolean => argv.includes(name)

/**
 * The origin to probe: the first positional argument, then $CANARY_URL, then
 * the canary itself. A trailing slash is dropped so paths concatenate cleanly.
 */
export const resolveOrigin = (
  argv: ReadonlyArray<string>,
  env: { readonly CANARY_URL?: string | undefined }
): string => {
  const positional = argv[0] !== undefined && !argv[0].startsWith("--") ? argv[0] : undefined
  const origin = positional ?? env.CANARY_URL ?? "https://canary.smithers.sh"
  return origin.endsWith("/") ? origin.slice(0, -1) : origin
}
