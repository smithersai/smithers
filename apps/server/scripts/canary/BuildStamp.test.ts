import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  BUILD_STAMP_META,
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
import { readFlag } from "./CanaryArgs.ts"
import { DEFAULT_APP_DOCUMENT_PATH } from "../../src/appDocument.ts"

/*
 * CN-1's whole value is that it fails when the deployment is stale, so these
 * tests spend most of their weight on the failure shapes. A probe that reports
 * "pass" for a bundle it could not read would be worse than no probe: it would
 * retire the checklist row that is currently the only thing telling the truth.
 *
 * The fetches live in build-probe.ts. Everything here is a fixture.
 */

const FRESH = "1dd856f1a2b3c4d5e6f708192a3b4c5d6e7f8091"
const STALE = "ceb784b6a2b3c4d5e6f708192a3b4c5d6e7f8091"

const stampOf = (gitSha: string): BuildStamp => ({
  worker: "smithers-mvp-web",
  gitSha,
  builtAt: "2026-08-18T00:00:00.000Z"
})

describe("parseBuildStamp", () => {
  test("reads the stamp the vite build emits", () => {
    const body = `${
      JSON.stringify({ worker: "smithers-mvp-web", gitSha: FRESH, builtAt: "2026-08-18T00:00:00.000Z" })
    }\n`
    expect(parseBuildStamp({ status: 200, body })).toEqual(stampOf(FRESH))
  })

  test("a 404 names the real cause: the bundle predates the stamp", () => {
    const verdict = parseBuildStamp({ status: 404, body: "Not found" })
    expect(typeof verdict).toBe("string")
    expect(verdict).toContain(BUILD_STAMP_PATH)
    expect(verdict).toContain("404")
    expect(verdict).toContain("predates the stamp")
  })

  test("any other HTTP status is reported, never treated as a stamp", () => {
    expect(parseBuildStamp({ status: 503, body: "" })).toBe(
      `GET ${BUILD_STAMP_PATH} answered HTTP 503`
    )
  })

  /*
   * The SPA fallback answers index.html for unknown paths on some asset
   * configurations, so HTTP 200 alone proves nothing.
   */
  test("a 200 that is HTML, not JSON, fails instead of passing on the status", () => {
    const verdict = parseBuildStamp({ status: 200, body: "<!DOCTYPE html><html><body>Smithers</body></html>" })
    expect(verdict).toContain("not JSON")
  })

  test("a 200 whose JSON is not a stamp fails", () => {
    expect(parseBuildStamp({ status: 200, body: "{\"nope\":1}" })).toBe(
      `GET ${BUILD_STAMP_PATH} answered 200 with a body that is not a build stamp`
    )
  })

  /*
   * `null`, a number and an array are all valid JSON. Reading gitSha off them
   * used to throw a TypeError out of a parser documented as total, so the
   * probe crashed instead of naming the unusable body.
   */
  test("a 200 whose JSON is not an object fails instead of throwing", () => {
    for (const body of ["null", "3", "[]", "\"abc1234\""]) {
      expect(parseBuildStamp({ status: 200, body })).toBe(
        `GET ${BUILD_STAMP_PATH} answered 200 with a body that is not a build stamp`
      )
    }
  })

  test("a stamp whose sha is not a sha fails", () => {
    const verdict = parseBuildStamp({
      status: 200,
      body: JSON.stringify({ gitSha: "HEAD~3", builtAt: "2026-08-18T00:00:00.000Z" })
    })
    expect(verdict).toContain("is not a git sha")
  })

  /*
   * A build outside a git checkout stamps "unknown". Accepting it would make
   * every later comparison vacuous, so it is a failure at the parse.
   */
  test("a stamp of \"unknown\" fails rather than verifying nothing", () => {
    const verdict = parseBuildStamp({
      status: 200,
      body: JSON.stringify({ gitSha: "unknown", builtAt: "2026-08-18T00:00:00.000Z" })
    })
    expect(verdict).toContain("built outside a git checkout")
  })

  test("a short sha is a sha", () => {
    expect(parseBuildStamp({ status: 200, body: JSON.stringify({ gitSha: "ceb784b", builtAt: "x" }) })).toEqual({
      worker: "unknown",
      gitSha: "ceb784b",
      builtAt: "x"
    })
  })
})

describe("buildShaFromHtml", () => {
  test("reads the meta tag vite injects", () => {
    const html = `<!DOCTYPE html><html><head><meta name="${BUILD_STAMP_META}" content="${FRESH}"></head></html>`
    expect(buildShaFromHtml(html)).toBe(FRESH)
  })

  test("reads it however it is quoted or self-closed", () => {
    expect(buildShaFromHtml(`<meta name='${BUILD_STAMP_META}' content='${FRESH}' />`)).toBe(FRESH)
  })

  test("HTML with no stamp answers null, not an empty sha", () => {
    expect(buildShaFromHtml("<!DOCTYPE html><html><head><title>Smithers</title></head></html>")).toBeNull()
  })

  test("a different meta tag is not mistaken for the stamp", () => {
    expect(buildShaFromHtml("<meta name=\"smithers-build-at\" content=\"2026-08-18T00:00:00.000Z\">")).toBeNull()
  })
})

describe("buildShaVerdict", () => {
  test("a matching sha passes and says what is deployed", () => {
    const verdict = buildShaVerdict(stampOf(FRESH), FRESH, FRESH, 0, 0)
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain(FRESH)
    expect(verdict.detail).toContain("2026-08-18T00:00:00.000Z")
  })

  /* 2026-09-13: a hand-typed short sha reported a green deploy as red. */
  test("an abbreviated expected sha matches as a prefix, a six-char one does not", () => {
    expect(buildShaVerdict(stampOf(FRESH), FRESH.slice(0, 12), null, undefined, 0).ok).toBe(true)
    expect(buildShaVerdict(stampOf(FRESH), FRESH.slice(0, 6), null, undefined, 0).ok).toBe(false)
    expect(buildShaVerdict(stampOf(STALE), FRESH.slice(0, 12), null, undefined, 0).ok).toBe(false)
  })

  /* The live defect this row exists to catch. */
  test("a stale deployment fails, naming both shas and the distance", () => {
    const verdict = buildShaVerdict(stampOf(STALE), FRESH, STALE, 13, 0)
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain(STALE)
    expect(verdict.detail).toContain(FRESH)
    expect(verdict.detail).toContain("13 commit(s) behind")
  })

  /*
   * A half-published deploy is checked first: when the HTML and the assets
   * disagree there is no single sha to compare with anything.
   */
  test("HTML and asset disagreeing is a partial deploy, reported before any other rule", () => {
    const verdict = buildShaVerdict(stampOf(STALE), STALE, FRESH, 0, 0)
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain("different builds")
  })

  test("no expected sha and no drift measurement still passes on a readable stamp", () => {
    const verdict = buildShaVerdict(stampOf(FRESH), undefined, null, undefined, 0)
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).not.toContain("behind origin/main")
  })

  test("drift alone fails once it exceeds the budget", () => {
    expect(buildShaVerdict(stampOf(STALE), undefined, null, 3, 2).ok).toBe(false)
    expect(buildShaVerdict(stampOf(STALE), undefined, null, 2, 2).ok).toBe(true)
  })
})

/*
 * The defect this suite now pins: a served index.html with no meta tag used to
 * grade "ok", so a deployment serving pre-stamp HTML beside a fresh
 * /__build.json — the old app, with fresh assets behind it — exited 0. The
 * asset stamp and the meta tag come out of one vite build, so once the stamp
 * parses, unstamped HTML is evidence, not an absent input.
 */
describe("htmlAgreementVerdict", () => {
  test("HTML and asset naming the same sha is the only pass", () => {
    const verdict = htmlAgreementVerdict(stampOf(FRESH), { status: 200, metaSha: FRESH }, false)
    expect(verdict.status).toBe("ok")
    expect(verdict.detail).toContain(FRESH)
  })

  /* CN-1's half-published deploy, in the direction the old code passed. */
  test("readable HTML with no stamp beside a parsed asset stamp FAILS", () => {
    const verdict = htmlAgreementVerdict(stampOf(FRESH), { status: 200, metaSha: null }, false)
    expect(verdict.status).toBe("FAIL")
    expect(verdict.detail).toContain(BUILD_STAMP_META)
    expect(verdict.detail).toContain("predates the stamp")
    expect(verdict.detail).toContain("half-published")
  })

  test("unstamped HTML is never graded ok, whatever the flag says", () => {
    for (const allow of [true, false]) {
      expect(htmlAgreementVerdict(stampOf(FRESH), { status: 200, metaSha: null }, allow).status).not.toBe("ok")
    }
  })

  /*
   * The one deploy that introduces the stamp is watched by a human, who can
   * park the row. Parking it is a skip, so the run still reports that the
   * comparison did not happen.
   */
  test("--allow-unstamped-html downgrades that failure to a skip, not to a pass", () => {
    const verdict = htmlAgreementVerdict(stampOf(FRESH), { status: 200, metaSha: null }, true)
    expect(verdict.status).toBe("skip")
    expect(verdict.detail).toContain("--allow-unstamped-html")
  })

  test("the other direction still fails: HTML and asset naming different shas", () => {
    const verdict = htmlAgreementVerdict(stampOf(FRESH), { status: 200, metaSha: STALE }, false)
    expect(verdict.status).toBe("FAIL")
    expect(verdict.detail).toContain("different builds")
  })

  /*
   * An unreadable root is a comparison that never ran. The uptime probe's spa
   * check is what grades GET / for a 200.
   */
  test("HTML that could not be read is a skip, not a pass and not a failure", () => {
    const verdict = htmlAgreementVerdict(stampOf(FRESH), { status: 503, metaSha: null }, false)
    expect(verdict.status).toBe("skip")
    expect(verdict.detail).toContain("503")
  })

  test("a 2xx that is not 200 is still read", () => {
    expect(htmlAgreementVerdict(stampOf(FRESH), { status: 203, metaSha: FRESH }, false).status).toBe("ok")
  })

  /*
   * The lane's original claim named one direction. The printed coverage note
   * must keep naming both, and must keep admitting what it does not fetch.
   */
  test("the coverage note states both directions, the no-stamp case, and the gap", () => {
    expect(HTML_AGREEMENT_COVERAGE).toContain("either direction")
    expect(HTML_AGREEMENT_COVERAGE).toContain("no stamp at all")
    expect(HTML_AGREEMENT_COVERAGE).toContain("does not fetch the hashed chunks")
  })
})

describe("expectedShaFromReceipt", () => {
  test("a real deploy receipt states its sha", () => {
    const claim = expectedShaFromReceipt(
      JSON.stringify({ worker: "smithers-mvp-web", dryRun: false, gitSha: FRESH, gitDirty: false })
    )
    expect(claim).toEqual({ kind: "sha", gitSha: FRESH, gitDirty: false })
  })

  test("a dirty-tree deploy is recorded, not hidden", () => {
    expect(expectedShaFromReceipt(JSON.stringify({ dryRun: false, gitSha: FRESH, gitDirty: true }))).toEqual({
      kind: "sha",
      gitSha: FRESH,
      gitDirty: true
    })
  })

  /*
   * Every receipt in deploy-receipts/dry-run/ has dryRun: true and a null
   * wranglerVersionId. Treating one as the expected sha would grade the
   * deployment against a build that was never published.
   */
  test("a dry-run receipt claims nothing about the deployment", () => {
    const claim = expectedShaFromReceipt(JSON.stringify({ dryRun: true, gitSha: FRESH }))
    expect(claim.kind).toBe("none")
    expect(claim.kind === "none" && claim.reason).toContain("dry run")
  })

  test("a receipt with no sha claims nothing", () => {
    expect(expectedShaFromReceipt(JSON.stringify({ dryRun: false })).kind).toBe("none")
  })

  test("a receipt that is not JSON claims nothing", () => {
    expect(expectedShaFromReceipt("<html>").kind).toBe("none")
  })

  /*
   * `null`, a number and an array are all valid JSON. Reading a field off them
   * used to throw a TypeError out of a parser documented as total, so the
   * probe crashed instead of reporting an unusable receipt.
   */
  test("JSON that is not an object claims nothing instead of throwing", () => {
    for (const body of ["null", "3", "\"abc1234\"", "[]"]) {
      const claim = expectedShaFromReceipt(body)
      expect(claim.kind).toBe("none")
      if (claim.kind === "none") expect(claim.reason).toContain("no usable gitSha")
    }
  })
})

describe("argument resolution", () => {
  test("the positional origin wins, then $CANARY_URL, then the canary", () => {
    expect(resolveOrigin(["https://staging.test"], { CANARY_URL: "https://env.test" })).toBe("https://staging.test")
    expect(resolveOrigin([], { CANARY_URL: "https://env.test" })).toBe("https://env.test")
    expect(resolveOrigin([], {})).toBe("https://canary.smithers.sh")
  })

  test("a leading flag is not mistaken for the origin", () => {
    expect(resolveOrigin(["--sha", "abc1234"], {})).toBe("https://canary.smithers.sh")
  })

  test("a trailing slash is dropped so paths concatenate cleanly", () => {
    expect(resolveOrigin(["https://canary.smithers.sh/"], {})).toBe("https://canary.smithers.sh")
  })

  test("a boolean flag is present only when it is passed", () => {
    expect(hasFlag(["--allow-unstamped-html"], "--allow-unstamped-html")).toBe(true)
    expect(hasFlag(["--sha", "abc1234"], "--allow-unstamped-html")).toBe(false)
  })

  /*
   * Reading `--name value` lives in CanaryArgs.ts now, shared by every canary
   * shell; CanaryArgs.test.ts holds the cases where --sha would otherwise
   * swallow the flag that follows it.
   */
  test("a value flag never hides the boolean flag that follows it", () => {
    expect(readFlag(["--sha", "--allow-unstamped-html"], "--sha").state).toBe("no-value")
    expect(hasFlag(["--sha", "--allow-unstamped-html"], "--allow-unstamped-html")).toBe(true)
  })
})

/*
 * The verdicts are pure and tested above, but the exit code is decided in
 * build-probe.ts. This holds the shell to the verdict: the old code inlined a
 * `metaSha === null || metaSha === stamp.gitSha` pass, and that is the exact
 * line that let a half-published deploy exit 0.
 */
describe("the probe grades through the verdict", () => {
  const probe = readFileSync(fileURLToPath(new URL("./build-probe.ts", import.meta.url)), "utf8")

  test("build-probe.ts calls htmlAgreementVerdict", () => {
    expect(probe).toContain("htmlAgreementVerdict(stamp, { status: htmlResponse.status, metaSha }, allowUnstampedHtml)")
  })

  test("build-probe.ts no longer passes a null metaSha as an agreement", () => {
    expect(probe).not.toContain("metaSha === null ||")
    expect(probe).not.toContain("stands alone")
  })

  test("build-probe.ts prints the coverage note", () => {
    expect(probe).toContain("HTML_AGREEMENT_COVERAGE")
  })
})

/*
 * The end-to-end pin. Source greps above can be satisfied by a probe that still
 * exits 0, and the exit code is the only thing the canary schedule reads. These
 * tests serve a bundle over real HTTP and run the real probe against it, so the
 * thing being asserted is the process exit code a half-published deploy earns.
 *
 * The stripped fixture is the auditor's reproduction in miniature: fresh
 * /__build.json, index.html with no meta tag. Against the pre-fix probe it
 * printed "the asset stamp stands alone" and exited 0.
 */
describe("the probe's exit code moves with the deployment", () => {
  const SERVED_SHA = "a6cab0684a3f5d873dc23cc5b63784e93ffcdb50"
  const stampBody = `${
    JSON.stringify({ worker: "smithers-mvp-web", gitSha: SERVED_SHA, builtAt: "2026-08-19T03:16:28.120Z" })
  }\n`
  const probePath = fileURLToPath(new URL("./build-probe.ts", import.meta.url))

  /** Serves one app document and one /__build.json on an ephemeral port; the root is the site's unstamped landing page. */
  const serve = (html: string) =>
    Bun.serve({
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        if (path === BUILD_STAMP_PATH) {
          return new Response(stampBody, { headers: { "content-type": "application/json" } })
        }
        if (path === DEFAULT_APP_DOCUMENT_PATH) return new Response(html, { headers: { "content-type": "text/html" } })
        if (path === "/") return new Response("<html><body>landing</body></html>", { headers: { "content-type": "text/html" } })
        return new Response("Not found", { status: 404 })
      }
    })

  const runProbe = async (html: string, extraArgs: ReadonlyArray<string> = []) => {
    const server = serve(html)
    try {
      const proc = Bun.spawn(["bun", probePath, server.url.origin, "--sha", SERVED_SHA, ...extraArgs], {
        stdout: "pipe",
        stderr: "pipe"
      })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text()
      ])
      return { exitCode: await proc.exited, stdout, stderr }
    } finally {
      server.stop(true)
    }
  }

  const STAMPED_HTML =
    `<!DOCTYPE html><html><head><meta name="${BUILD_STAMP_META}" content="${SERVED_SHA}"><title>Smithers</title></head><body><div id="root"></div></body></html>`
  const UNSTAMPED_HTML =
    `<!DOCTYPE html><html><head><title>Smithers</title></head><body><div id="root"></div></body></html>`

  /*
   * Exit 2, never 1: an empty flag is a mistake in the invocation, and a 1
   * would read as a verdict about the deployment.
   */
  test("a flag with no value exits 2 without grading the deployment", async () => {
    const result = await runProbe(STAMPED_HTML, ["--max-drift"])
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("--max-drift needs a value")
    expect(result.stdout).not.toContain("CN-1 PASS")
  })

  test("a correctly stamped bundle exits 0", async () => {
    const result = await runProbe(STAMPED_HTML)
    expect(result.stdout).toContain("CN-1 PASS")
    expect(result.exitCode).toBe(0)
  })

  /* The defect: this exited 0 and printed "stands alone" before the fix. */
  test("pre-stamp HTML beside a fresh build stamp exits 1", async () => {
    const result = await runProbe(UNSTAMPED_HTML)
    expect(result.stdout).toContain("FAIL: the served HTML and the build stamp are from the same build")
    expect(result.stdout).toContain("CN-1 FAILED")
    expect(result.stdout).not.toContain("stands alone")
    expect(result.exitCode).toBe(1)
  })

  test("HTML naming a different sha exits 1", async () => {
    const stale = `<!DOCTYPE html><html><head><meta name="${BUILD_STAMP_META}" content="${STALE}"></head></html>`
    const result = await runProbe(stale)
    expect(result.stdout).toContain("different builds")
    expect(result.exitCode).toBe(1)
  })

  /*
   * The escape hatch is for the operator watching the stamp's first deploy
   * land. It parks the row; the pass line must then say the row was not
   * graded, or the run reads as a verification that never happened.
   */
  test("--allow-unstamped-html parks the row and the pass line says so", async () => {
    const result = await runProbe(UNSTAMPED_HTML, ["--allow-unstamped-html"])
    expect(result.stdout).toContain("skip: the served HTML and the build stamp are from the same build")
    expect(result.stdout).toContain("CN-1 PASS")
    expect(result.stdout).toContain("check(s) not graded: the served HTML and the build stamp are from the same build")
    expect(result.exitCode).toBe(0)
  })

  test("the probe prints what the HTML-vs-asset row does not cover", async () => {
    const result = await runProbe(STAMPED_HTML)
    expect(result.stdout).toContain("does not fetch the hashed chunks")
  })
})

/*
 * The producer of the stamp is apps/app/scripts/build-stamp.ts (wired into
 * apps/app/vite.config.ts) and the reader is this directory; apps/app does not
 * depend on apps/server, so the two constants are spelled twice. This holds
 * them equal: renaming the meta tag or the asset in the plugin reds here
 * instead of silently retiring the probe.
 */
describe("the probe reads what the build writes", () => {
  const stampSource = readFileSync(
    fileURLToPath(new URL("../../../app/scripts/build-stamp.ts", import.meta.url)),
    "utf8"
  )
  const viteConfig = readFileSync(
    fileURLToPath(new URL("../../../app/vite.config.ts", import.meta.url)),
    "utf8"
  )

  test("the plugin emits the asset this probe fetches", () => {
    expect(stampSource).toContain(`const BUILD_STAMP_ASSET = "${BUILD_STAMP_PATH.slice(1)}"`)
  })

  test("the plugin injects the meta tag this probe reads", () => {
    expect(stampSource).toContain(`const BUILD_STAMP_META = "${BUILD_STAMP_META}"`)
    expect(stampSource).toContain("apply: \"build\"")
  })

  test("the plugin is wired into the build", () => {
    expect(viteConfig).toContain("from \"./scripts/build-stamp\"")
    expect(viteConfig).toContain("buildStamp()")
  })
})
