/*
 * CN-1's propagation window: how long a deployment is allowed to still be
 * serving the previous build before the probe calls it wrong.
 *
 * A new Worker version reaches every edge location seconds after
 * `wrangler deploy` returns, not at once, and the two hostnames that reach
 * smithers-mvp-web get there by different mechanisms — canary.smithers.sh is a
 * custom domain, smithers.sh is a zone route — so they flip at different
 * moments. On 2026-09-14 the autodeploy runner probed canary.smithers.sh four
 * seconds after the deploy of 83a400d9, read the previous stamp
 * (22316c30), and rolled a good deploy back; smithers.sh, probed seconds
 * later, already served the new one. The deployment was never wrong. The
 * probe was early.
 *
 * So the probe reads until the deployment agrees with the claim or a deadline
 * passes, instead of judging on a single read. Waiting is not weakening: a
 * disagreement that outlives the window still fails, with the same verdicts
 * from BuildStamp.ts and the same exit code. The only thing that changed is
 * that a read taken before propagation finished is no longer a verdict.
 *
 * This module owns the loop and nothing else. Every judgement it makes comes
 * from BuildStamp.ts, and `fetch`, the clock and the sleep are injected, so
 * build-probe.test.ts holds the window to a stopwatch without a deployment
 * and without a network.
 */
import {
  BUILD_STAMP_PATH,
  buildShaFromHtml,
  htmlAgreementVerdict,
  parseBuildStamp,
  shaMatches
} from "./BuildStamp.ts"
import type { BuildStamp, FetchedHtml } from "./BuildStamp.ts"

/**
 * How long the deployment may take to propagate. Cloudflare's own guidance is
 * "a few seconds" for a global version rollout; the observed miss was four
 * seconds and the observed settle two seconds after that. 90 s is an order of
 * magnitude over both, which is the point: the deadline exists to bound a
 * stuck deploy, not to time a healthy one, and a healthy one returns on the
 * first read anyway.
 */
export const SETTLE_MS = 90_000

/**
 * The gap between reads. Short enough that a deploy that settles in four
 * seconds costs the runner about four seconds, long enough that a full window
 * is thirty reads of two small static assets rather than thousands.
 */
export const SETTLE_INTERVAL_MS = 3_000

/** One reading of the deployment: what it says it is, and what its HTML says. */
export interface DeploymentRead {
  /** The parsed stamp, or the sentence naming why there is none (`parseBuildStamp`'s contract). */
  readonly stamp: BuildStamp | string
  readonly html: FetchedHtml
}

/**
 * Everything the loop touches that is not a pure function. The shell supplies
 * the real three; a test supplies three fakes and the window runs in no time
 * at all.
 */
export interface SettleDeps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

export interface SettleOptions {
  readonly origin: string
  /** The one HTML document in the build that carries the stamp. */
  readonly documentPath: string
  /** The sha the caller expects, when anything states one. Absent: nothing is waited for on that row. */
  readonly expectedSha: string | undefined
  readonly allowUnstampedHtml: boolean
  /** The deadline in milliseconds. 0 means one read, which is the pre-2026-09-14 behaviour. */
  readonly settleMs: number
  readonly intervalMs: number
}

export interface SettleResult {
  /** The last read taken. Settled or not, this is the one the probe grades and reports. */
  readonly read: DeploymentRead
  readonly reads: number
  readonly waitedMs: number
  /** Did the deployment agree before the deadline? False means the last read is graded as the verdict. */
  readonly settled: boolean
}

/*
 * A cache-buster and no-store together: the stamp is an unhashed asset, so
 * Cloudflare's asset layer and any intermediary are both entitled to hold a
 * copy, and a probe that reads a cache is measuring nothing. Every read in the
 * loop gets its own buster — a window that re-read one cached URL thirty times
 * would be a slow way to learn nothing.
 */
const NO_CACHE = { cache: "no-store" as const, headers: { "cache-control": "no-cache" } }

/** A fetch that answered, or the reason it never did. */
type Fetched = { readonly status: number; readonly body: string } | { readonly error: string }

const fetchText = async (deps: SettleDeps, url: string): Promise<Fetched> => {
  try {
    const response = await deps.fetch(url, NO_CACHE)
    return { status: response.status, body: await response.text() }
  } catch (error) {
    /*
     * DNS that has not caught up with a freshly attached custom domain, a TLS
     * handshake against a colo mid-rollout, a connection reset: the same
     * window that covers a stale read covers these, because they are the same
     * event seen one layer down. It is retried, never swallowed — a window
     * that expires with nothing but transport errors fails with the last one
     * named, exactly as a window that expires on a stale sha fails with the
     * stale sha named.
     */
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Read the deployment once: the stamp asset, then the app document. */
export const readDeployment = async (deps: SettleDeps, options: SettleOptions): Promise<DeploymentRead> => {
  const bust = `?t=${deps.now()}`
  const stampFetch = await fetchText(deps, `${options.origin}${BUILD_STAMP_PATH}${bust}`)
  const stamp = "error" in stampFetch
    ? `GET ${BUILD_STAMP_PATH} never answered: ${stampFetch.error}`
    : parseBuildStamp(stampFetch)
  const htmlFetch = await fetchText(deps, `${options.origin}${options.documentPath}${bust}`)
  if ("error" in htmlFetch) {
    return { stamp, html: { status: 0, metaSha: null, transportError: htmlFetch.error } }
  }
  const ok = htmlFetch.status >= 200 && htmlFetch.status <= 299
  return { stamp, html: { status: htmlFetch.status, metaSha: ok ? buildShaFromHtml(htmlFetch.body) : null } }
}

/**
 * Has the deployment stopped changing under the probe?
 *
 * Settled means every row that propagation can move is satisfied: the stamp
 * reads, the document and the stamp are from one build, and the served sha is
 * the expected one. Those are exactly the rows that are transiently wrong
 * during a rollout, and each of them is a real failure once the window closes.
 *
 * A row the deployment cannot fix by finishing — an app document that answers
 * 404, which `htmlAgreementVerdict` declines to grade — counts as settled.
 * That row is a skip today and stays a skip; burning ninety seconds waiting
 * for a skip to become a pass would slow every deploy to buy nothing.
 *
 * Drift from origin/main is deliberately not here. It measures whether anyone
 * ran the deploy, not whether this one has landed, and no amount of waiting
 * moves it.
 */
export const readIsSettled = (
  read: DeploymentRead,
  expectedSha: string | undefined,
  allowUnstampedHtml: boolean
): boolean => {
  if (typeof read.stamp === "string") return false
  if (htmlAgreementVerdict(read.stamp, read.html, allowUnstampedHtml).status === "FAIL") return false
  return expectedSha === undefined || shaMatches(read.stamp.gitSha, expectedSha)
}

/**
 * Read until the deployment agrees or the deadline passes, and hand back the
 * last read either way.
 *
 * The first read short-circuits on success, so a deployment that is already
 * serving the right commit costs one round trip and no sleep — the common
 * case, and the one the autodeploy runner pays on every green deploy.
 */
export const awaitDeployment = async (deps: SettleDeps, options: SettleOptions): Promise<SettleResult> => {
  const startedAt = deps.now()
  let reads = 0
  for (;;) {
    const read = await readDeployment(deps, options)
    reads += 1
    const waitedMs = deps.now() - startedAt
    if (readIsSettled(read, options.expectedSha, options.allowUnstampedHtml)) {
      return { read, reads, waitedMs, settled: true }
    }
    const remaining = options.settleMs - waitedMs
    if (remaining <= 0) return { read, reads, waitedMs, settled: false }
    /* The last sleep is trimmed to the deadline, so the window is a ceiling on the wait and not a floor. */
    await deps.sleep(Math.min(options.intervalMs, remaining))
  }
}

/**
 * How the wait is reported. Every line the probe prints about the window says
 * both numbers — how long it waited and how many times it looked — because a
 * timeout that names neither is indistinguishable from a probe that never
 * waited at all, which is the failure this window was added to end.
 */
export const describeWait = (result: SettleResult): string =>
  result.reads === 1
    ? "on the first read"
    : `after ${(result.waitedMs / 1000).toFixed(1)} s and ${result.reads} reads`

/** What the last read saw, for the failure summary: the served sha, or why there was none. */
export const describeRead = (read: DeploymentRead): string =>
  typeof read.stamp === "string"
    ? read.stamp
    : `${BUILD_STAMP_PATH} names ${read.stamp.gitSha}, the served document names ${read.html.metaSha ?? "no sha"}`
