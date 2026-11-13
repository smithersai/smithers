/** Offline, from the workspace root (no Chromium or judge process):
 * bun test --preload ./.specs/design/mock/evals/mock-fidelity/test-runtime.mjs ./.specs/design/mock/evals/mock-fidelity/mock-fidelity.test.ts
 * node --import ./.specs/design/mock/evals/mock-fidelity/test-runtime.mjs --test ./.specs/design/mock/evals/mock-fidelity/mock-fidelity.test.ts
 * test-runtime resolves three missing workspace links to their real source APIs.
 */
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import { auditPage, collectPage } from "./browser.ts"
import { registrationFor, defaultDists } from "./registration.ts"
import { test } from "node:test"
import { crawlClean as rawCrawlClean, hasSlashDoor, matchesPattern, requiredStatesFor, routeProblemsFor, screensFor, statesCovered as rawStatesCovered, statesFor, threeDoors as rawThreeDoors, appliesToSite, registrationProblemsFor, viewsForSite, type Assessment, type Score, type CaseOutput, type Observation, type SitePayload, type ViewSpec } from "./scoring.ts"

import { Cause, Effect, Exit, Result } from "effect"
import { makeExecutor, makeScorers, criteriaFor, retryableJudgeError, retryJudge, suite, makeSuite, selectedDist, rubricInstructions, contextWindowError } from "./mock-fidelity.eval.ts"

import { buildJudgeEvidence, judgeLimits, type EvidenceAudit } from "./evidence.ts"

const scored = (assessment: Assessment): Score => {
  assert.ok("score" in assessment, JSON.stringify(assessment))
  return assessment
}
const crawlClean = (value: CaseOutput) => scored(rawCrawlClean(value))
const statesCovered = (value: CaseOutput) => scored(rawStatesCovered(value))
const threeDoors = (value: CaseOutput) => scored(rawThreeDoors(value))
const views = JSON.parse(readFileSync(new URL("./views.json", import.meta.url), "utf8")) as ViewSpec[]
const issues = views.find(view => view.id === "issues")!
const route = (flags = "") => `smithers.sh/maya/tinyhttp/issues?as=in&role=member&net=ok&data=full&landing=open${flags ? `&${flags}` : ""}`
const fakeSite: SitePayload = {
  routes: ["smithers.sh/:owner/:repo/issues", "smithers.sh/:owner/:repo/issues/new", "smithers.sh/:owner/:repo/issues/:n"],
  screens: [
    { id: "issues-list-open", route: route() },
    { id: "issues-list-loading", route: route("net=slow").replace("net=ok&", "") },
    { id: "issues-list-error", route: route("net=error").replace("net=ok&", "") },
    { id: "issues-list-empty", route: route("data=empty").replace("data=full&", "") },
    { id: "issues-list-signed-out", route: route("as=out").replace("as=in&", "") },
    { id: "issues-detail-reader", route: route("role=reader").replace("role=member&", "") },
    { id: "issues-detail-held-implement", route: route("landing=install").replace("landing=open&", "") },
    { id: "pulls-list-error", route: "smithers.sh/maya/tinyhttp/pulls?net=error" }
  ]
}
const observation = (changes: Partial<Observation> = {}): Observation => ({
  id: "issues-list-open", route: route(), width: 1440, theme: "light", resolved: fakeSite.routes[0]!,
  text: "Issues\nOpen\nClosed\nNew issue", headings: ["Issues"], links: [],
  buttons: [
    { name: "New issue", title: "/issue.new", action: true, primary: true },
    { name: "Filter", title: "/issue.filter is:open", action: true, primary: false },
    { name: "Preview", title: "", action: false, primary: false }
  ],
  primary: { name: "New issue", title: "/issue.new", action: true, primary: true },
  primaries: [{ name: "New issue", title: "/issue.new", action: true, primary: true }],
  problems: [], ...changes
})
const output = (changes: Partial<CaseOutput> = {}): CaseOutput => ({
  view: "issues", dist: "/mock/dist-default-ui", states: statesFor(issues, fakeSite),
  requiredStates: requiredStatesFor(issues), routeProblems: [], ready: observation(), screens: [observation()], ...changes
})

test("all sixteen spec rows have distinct cases, route patterns and ready screen contracts", () => {
  assert.equal(views.length, 23)
  assert.equal(new Set(views.map(view => view.id)).size, 23)
  assert.deepEqual(views.slice(0, 16).map(view => view.id), ["code-home", "tree-file", "blame", "commits", "commit", "branches", "issues", "pulls-stack", "runs", "flows", "wiki", "releases", "settings", "search", "ask", "terminal"])
  for (const view of views) {
    assert.ok(view.patterns.length && view.readyIds.length && view.anatomy && view.powers && view.primary)
    assert.equal(requiredStatesFor(view).length, view.held ? 7 : 6)
    assert.ok(requiredStatesFor(view).includes("reader-denied"))
  }
})
test("tiny fake __SITE__ payload covers every required issue state", () => {
  assert.equal(screensFor(issues, fakeSite).length, 7)
  assert.equal(statesCovered(output()).score, 1)
  assert.deepEqual(output().states["reader-denied"], ["issues-detail-reader"])
})
test("screen names alone cannot fake a network error or loading state", () => {
  const states = statesFor(issues, { ...fakeSite, screens: [
    { id: "issues-error", route: route() }, { id: "issues-loading", route: route() }
  ] })
  assert.deepEqual(states.error, [])
  assert.deepEqual(states.loading, [])
})
test("a plain reader listing is not evidence of permission denial", () => {
  const states = statesFor(issues, { ...fakeSite, screens: [{ id: "issues-list-reader", route: route("role=reader").replace("role=member&", "") }] })
  assert.deepEqual(states["reader-denied"], [])
})
test("loading and signed-out member-named screens do not count as ready", () => {
  const home = views[0]!
  const states = statesFor(home, { routes: home.patterns, screens: [{ id: "code-home-member-loading", route: "smithers.sh/maya/tinyhttp?as=out&net=slow" }] })
  assert.deepEqual(states.ready, [])
})
test("held requires an unavailable hosted act, not an own-install ready screen", () => {
  const states = statesFor(issues, { ...fakeSite, screens: [
    { id: "issues-held", route: route("host=install&landing=install").replace("landing=open&", "") }
  ] })
  assert.deepEqual(states.held, [])
})
test("terminal hosted-paused screen covers held availability", () => {
  const terminal = views.find(view => view.id === "terminal")!
  const states = statesFor(terminal, { routes: terminal.patterns, screens: [{ id: "history-terminal-hosted-paused", route: "smithers.sh/maya/tinyhttp/branches/main/terminal?as=in&role=member&net=ok&hosted=paused" }] })
  assert.equal(states.held?.length, 1)
})
test("Ask selects only its composer screens on the shared home route", () => {
  const ask = views.find(view => view.id === "ask")!
  assert.deepEqual(screensFor(ask, { routes: ask.patterns, screens: [
    { id: "code-home-member", route: "smithers.sh/maya/tinyhttp" },
    { id: "code-home-ask-sample", route: "smithers.sh/maya/tinyhttp?ask=sample" }
  ] }).map(screen => screen.id), ["code-home-ask-sample"])
})
test("required state fraction reports the missing names", () => {
  const result = statesCovered(output({ states: { ready: ["a"], error: ["b"] } }))
  assert.equal(result.score, 2 / 7)
  assert.match(result.reason, /loading/)
  assert.match(result.reason, /reader-denied/)
  assert.equal(statesCovered(output({ states: {} })).score, 0)
})
test("empty requirements never manufacture a passing score", () => {
  assert.equal(statesCovered(output({ requiredStates: [] })).score, 0)
})
for (const [problems, expected] of [[0, 1], [1, 0.95], [10, 0.5], [20, 0], [25, 0]]) {
  test(`crawl score for ${problems} distinct findings is ${expected}`, () => {
    assert.equal(crawlClean(output({ screens: [observation({ problems: Array.from({ length: problems! }, (_, i) => `problem ${i}`) })] })).score, expected)
  })
}
test("crawl de-duplicates a repeated finding per observation and retains viewport failures", () => {
  const result = crawlClean(output({ routeProblems: ["missing route"], screens: [
    observation({ problems: ["dead link", "dead link"] }),
    observation({ width: 390, problems: ["sideways scroll"] })
  ] }))
  assert.equal(result.score, 0.85)
})
test("missing case screens and missing declared routes cannot pass the crawl", () => {
  assert.ok(routeProblemsFor(issues, { screens: [], routes: [] }, []).includes("case has no screens to audit"))
  assert.equal(routeProblemsFor(issues, { screens: [], routes: [] }, []).length, 4)
  assert.ok("inconclusive" in rawCrawlClean(output({ screens: [], routeProblems: routeProblemsFor(issues, { screens: [], routes: [] }, []) })))
})
test("route coverage requires the actual resolved pattern", () => {
  const problems = routeProblemsFor(issues, fakeSite, [observation()])
  assert.equal(problems.length, 2)
  assert.ok(problems.some(problem => problem.includes("issues/new")))
})
test("parameter names do not change a declared route shape", () => {
  const terminal = views.find(view => view.id === "terminal")!
  const pattern = "smithers.sh/:owner/:repo/branches/:branch/terminal"
  assert.deepEqual(routeProblemsFor(terminal, { screens: [], routes: [pattern] }, [observation({ resolved: pattern })]), [])
})
test("wildcards, query flags, nested paths and trailing slashes match core router behavior", () => {
  assert.ok(matchesPattern("smithers.sh/:owner/:repo/tree/:ref/*", "smithers.sh/maya/tinyhttp/tree/main/src/middleware?net=ok"))
  assert.ok(matchesPattern("smithers.sh/:owner/:repo/tree/:ref/*", "smithers.sh/maya/tinyhttp/tree/main"))
  assert.ok(matchesPattern("smithers.sh/:owner/:repo", "smithers.sh/maya/tinyhttp/?as=out"))
  assert.ok(!matchesPattern("smithers.sh/:owner/:repo", "smithers.sh/maya/tinyhttp/issues"))
  assert.ok(!matchesPattern("smithers.sh/:owner/:repo/commit/:sha", "smithers.sh/maya/tinyhttp/commits/main"))
  assert.ok(!matchesPattern("smithers.sh/:owner/:repo", "smithers.sh/maya/"))
})
test("three doors excludes explicit inert controls and includes disabled action buttons", () => {
  assert.equal(threeDoors(output()).score, 1)
  const result = threeDoors(output({ screens: [observation({ buttons: [
    ...observation().buttons, { name: "Merge", title: "Merge on GitHub", disabled: true, action: true, primary: false }
  ] })] }))
  assert.equal(result.score, 2 / 3)
  assert.match(result.reason, /Merge/)
})
test("phone-only action buttons also need slash titles", () => {
  const result = threeDoors(output({ screens: [observation(), observation({ width: 390, buttons: [{ name: "Menu", title: "Menu", action: true, primary: false }] })] }))
  assert.equal(result.score, 2 / 3)
})
test("zero action buttons are unscorable unless the spec explicitly declares no actions", () => {
  const evidence = output({ screens: [observation({ buttons: [] })] })
  assert.ok("inconclusive" in rawThreeDoors(evidence))
  assert.equal(scored(rawThreeDoors(evidence, { ...issues, noActions: true })).score, 1)
  assert.ok("inconclusive" in rawThreeDoors(output({ screens: [] }), { ...issues, noActions: true }))
})
for (const [title, expected] of [
  ["/ask", true], ["/issue.implement 42", true], ["/ask.close · Escape", true],
  ["Copy /file.copy", true], ["https://smithers.sh", false], ["/", false], ["", false], ["/bad/command", false]
] as const) test(`slash title ${JSON.stringify(title)}`, () => assert.equal(hasSlashDoor(title), expected))


const reply = (view = issues) => JSON.stringify({ scores: Object.fromEntries(criteriaFor(view).map(item => [item.id, 5])), reason: "Mock defects: none. Unobservable: none." })
/** Exercise the real executor and scorer boundary with fake inspection and judge. */
const evaluate = async (inspect: Parameters<typeof makeExecutor>[0], judge: (request: { system: string; prompt: string }) => Effect.Effect<string, unknown> = () => Effect.succeed(reply()), viewId = "issues", sleeps: number[] = []) => {
  const view = views.find(view => view.id === viewId)!
  const ownPatterns = view.declaration?.patterns ?? view.patterns
  const site: SitePayload = { ...fakeSite, routes: [...new Set([...fakeSite.routes, ...ownPatterns])], screens: [
    ...fakeSite.screens, ...ownPatterns.map((pattern, i) => ({ id: `fake-ready-${i}`, route: pattern.replace(":owner/:repo", view.declaration?.repo ?? "maya/tinyhttp").replace(/:[^/]+/g, "example").replace("*", "file.ts") + "?as=in&role=member" }))
  ] }
  const declared = await Effect.runPromise(makeSuite(site))
  const entry = declared.cases.find(entry => entry.name === viewId)!
  assert.ok(entry, `fake suite includes ${viewId}`)
  const execution = await Effect.runPromise(makeExecutor(inspect).run(entry))
  const results = await Promise.all(makeScorers(judge, { sleep: ms => Effect.sync(() => { sleeps.push(ms) }), log: () => {} }).map(async scorer => ({
    name: scorer.name,
    result: await Effect.runPromise(Effect.result(scorer.score({ input: entry.input, output: execution.output })))
  })))
  return results
}
const assertInconclusive = (results: Awaited<ReturnType<typeof evaluate>>, names = ["crawl-clean", "states-covered", "three-doors", "spec-fidelity"]) => {
  for (const item of results.filter(item => names.includes(item.name))) {
    assert.ok(Result.isFailure(item.result), `${item.name} must have no numeric score`)
    const error = item.result.failure as { code: string; message: string }
    assert.equal(error.code, "inconclusive")
    assert.ok(error.message.length > 0)
  }
}
for (const problem of ["screen inspection failed: ReferenceError: __name is not defined", "navigation failed: timeout", "browser launch failed: closed"]) {
  test(`fake executor: ${problem} never produces a quality score or calls the judge`, async () => {
    let calls = 0
    const results = await evaluate(async () => output({ screens: [observation(), observation({ id: "failed", width: 390, problems: [problem] })] }), () => { calls++; return Effect.succeed(reply()) })
    assertInconclusive(results)
    assert.equal(calls, 0)
  })
}
for (const error of [new Error("chromium.launch: permission denied"), new Error("page.goto: Navigation timeout")]) {
  test(`fake executor: rejected inspection (${error.message}) stays inconclusive`, async () => {
    let calls = 0
    const results = await evaluate(async () => { throw error }, () => { calls++; return Effect.succeed(reply()) })
    assertInconclusive(results)
    assert.equal(calls, 0)
  })
}
test("fake executor: zero buttons never passes three doors, even with successful rubric evidence", async () => {
  const results = await evaluate(async () => output({ screens: [observation({ buttons: [] })] }))
  assertInconclusive(results, ["three-doors"])
  assert.ok(Result.isSuccess(results.find(item => item.name === "crawl-clean")!.result))
})
test("fake executor: judge retries transport/5xx/timeout only, with 2s and 8s backoff", async () => {
  const sleeps: number[] = []
  let calls = 0
  const results = await evaluate(async () => output(), () => {
    calls++
    return calls === 1 ? Effect.fail({ status: 503, message: "Unavailable" }) : calls === 2 ? Effect.fail({ _tag: "TimeoutError" }) : Effect.succeed(reply())
  }, "issues", sleeps)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [2000, 8000])
  const judged = results.find(item => item.name === "spec-fidelity")!.result
  assert.ok(Result.isSuccess(judged))
  assert.equal(judged.success.score, 1)
})
test("fake executor: exhausted judge transport errors are unscorable with original reason", async () => {
  const sleeps: number[] = []
  let calls = 0
  const results = await evaluate(async () => output(), () => { calls++; return Effect.fail(new Error("fetch failed")) }, "issues", sleeps)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [2000, 8000])
  assertInconclusive(results, ["spec-fidelity"])
  const result = results.find(item => item.name === "spec-fidelity")!.result
  assert.ok(Result.isFailure(result))
  assert.match((result.failure as Error).message, /3 attempt.*fetch failed/)
})
for (const error of [{ status: 401, message: "Unauthorized" }, { status: 429, message: "Request timeout quota" }, new Error("Invalid judge configuration")]) {
  test(`fake executor: permanent judge failure does not retry (${JSON.stringify(error)})`, async () => {
    const sleeps: number[] = []
    let calls = 0
    const results = await evaluate(async () => output(), () => { calls++; return Effect.fail(error) }, "issues", sleeps)
    assert.equal(calls, 1)
    assert.deepEqual(sleeps, [])
    assertInconclusive(results, ["spec-fidelity"])
  })
}
test("fake executor: malformed judge verdict is an invalid score, never retried", async () => {
  let calls = 0
  const results = await evaluate(async () => output(), () => { calls++; return Effect.succeed("not a verdict") })
  assert.equal(calls, 1)
  const result = results.find(item => item.name === "spec-fidelity")!.result
  assert.ok(Result.isFailure(result))
  assert.equal((result.failure as { code: string }).code, "invalid_score")
})
for (const [error, expected] of [
  [{ cause: { code: "ECONNRESET" } }, true], [{ response: { status: 502 } }, true],
  [new Error("HTTP 504"), true], [new Error("HTTP 403 timeout quota"), false],
  [new Error("invalid rubric JSON"), false], [{ _tag: "TimeoutException" }, true], [{ _tag: "TransportError" }, true]
] as const) test(`judge retry classification ${JSON.stringify(error)}`, () => assert.equal(retryableJudgeError(error), expected))

for (const [site, prefix] of [["default", "history"], ["smithers-site", "smithers-site"], ["effeck-site", "effeck-site"], ["effect", "effect-repo"]]) {
  test(`fake executor: ${site} selects commit by route, then ready by flags despite prefix`, async () => {
    const view = views.find(view => view.id === "commit")!
    const payload: SitePayload = { site, routes: view.patterns, screens: [
      { id: `${prefix}-commit`, route: "smithers.sh/owner/repo/commit/abc?as=in&role=member&net=ok&landing=install" },
      { id: `${prefix}-commit-error`, route: "smithers.sh/owner/repo/commit/abc?as=in&net=error" },
      { id: `${prefix}-commits`, route: "smithers.sh/owner/repo/commits/main?as=in" }
    ] }
    assert.deepEqual(screensFor(view, payload).map(item => item.id), [`${prefix}-commit`, `${prefix}-commit-error`])
    const states = statesFor(view, payload)
    assert.deepEqual(states.ready, [`${prefix}-commit`])
    assert.deepEqual(states.error, [`${prefix}-commit-error`])
    const results = await evaluate(async () => output({ view: view.id, states, requiredStates: requiredStatesFor(view) }), () => Effect.succeed(reply(view)), view.id)
    assert.ok(results.every(item => Result.isSuccess(item.result)))
  })
}
test("product states use query flags before unfamiliar IDs; public readers do not fake denial", () => {
  const home = views[0]!
  const flags = ["as=in", "as=in&net=slow", "as=in&net=error", "as=in&data=empty", "as=out", "as=in&role=reader"]
  const payload: SitePayload = { site: "effeck-site", routes: home.patterns, screens: flags.map((flag, i) => ({ id: `unfamiliar-${i}`, route: `smithers.sh/effeck/effeck?${flag}` })) }
  const states = statesFor(home, payload)
  for (const [i, state] of ["ready", "loading", "error", "empty", "signed-out"].entries()) assert.deepEqual(states[state], [`unfamiliar-${i}`])
  assert.deepEqual(states["reader-denied"], [])
})
test("Ask uses product query stories and falls back to docked home when none are registered", () => {
  const ask = views.find(view => view.id === "ask")!
  const home = { id: "effect-repo-home", route: "smithers.sh/Effect-TS/effect?as=in" }
  const explicit = { id: "effect-composer", route: `${home.route}&ask=sample` }
  assert.deepEqual(screensFor(ask, { routes: ask.patterns, screens: [home, explicit] }), [explicit])
  assert.deepEqual(screensFor(ask, { routes: ask.patterns, screens: [home] }), [home])
})
for (const id of ["smithers-evals", "effeck-golden-set", "effect-packages-scope", "effect-ci-matrix", "effect-version-packages"]) {
  test(`fake executor: ${id} applies only to matching declared routes and repo screens`, async () => {
    const view = views.find(view => view.id === id)!
    const pattern = view.declaration!.patterns[0]!
    const concrete = pattern.replace(":owner/:repo", view.declaration!.repo!).replace(":id", "run-1")
    const own = { id: "custom-prefix-ready", route: `${concrete}?as=in&role=member` }
    const payload = { routes: view.declaration!.patterns, screens: [own] }
    assert.ok(appliesToSite(view, payload))
    assert.deepEqual(screensFor(view, payload), [own])
    for (const missing of [{ routes: [], screens: [own] }, { routes: payload.routes, screens: [{ id: own.id, route: own.route.replace(view.declaration!.repo!, "someone/else") }] }]) {
      assert.equal(appliesToSite(view, missing), false)
      assert.deepEqual(screensFor(view, missing), [])
      let calls = 0
      const results = await evaluate(async () => output({ view: id, notApplicable: "not declared by this dist", screens: [], ready: null }), () => { calls++; return Effect.succeed(reply(view)) }, id)
      assertInconclusive(results)
      assert.equal(calls, 0)
    }
  })
}
test("v2.1 rubric covers frame, home order and the CEO claim rule", () => {
  const questions = criteriaFor(views[0]!).map(item => item.question).join("\n")
  for (const text of ["declared tabs", "At most three", "1440", "1280", "bottom sheet", "Waiting on you", "Run on a sandbox", "Ready to merge", "no agent or Smithers approves", "ABOVE the file table"]) assert.ok(questions.includes(text), text)
})

test("fake executor: subscription adapter transport defects retry like typed failures", async () => {
  const sleeps: number[] = []
  let calls = 0
  const results = await evaluate(async () => output(), () => ++calls < 3 ? Effect.die(new Error("HTTP 502")) : Effect.succeed(reply()), "issues", sleeps)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [2000, 8000])
  assert.ok(Result.isSuccess(results.find(item => item.name === "spec-fidelity")!.result))
})
test("fake executor: exhausted subscription adapter defects stay inconclusive", async () => {
  const results = await evaluate(async () => output(), () => Effect.die(new Error("fetch failed")))
  assertInconclusive(results, ["spec-fidelity"])
})

test("judge cancellation remains interrupted with no retries", async () => {
  let sleeps = 0
  const exit = await Effect.runPromiseExit(retryJudge(() => Effect.interrupt, { sleep: () => Effect.sync(() => { sleeps++ }) })({ system: "", prompt: "" }))
  assert.ok(Exit.isFailure(exit))
  assert.ok(Cause.hasInterrupts(exit.cause))
  assert.equal(sleeps, 0)
})
test("a product ready screen's install flag alone cannot manufacture a held action state", () => {
  const payload: SitePayload = { routes: issues.patterns, screens: [{ id: "effeck-site-issues", route: "smithers.sh/effeck/effeck/issues?as=in&role=member&landing=install" }] }
  assert.deepEqual(statesFor(issues, payload).held, [])
})

test("suite load selects the live MOCK_DIST declarations, not stale N/A cases", async () => {
  const declared = await Effect.runPromise(suite)
  const site = registrationFor(selectedDist)
  assert.deepEqual(declared.cases.map(entry => entry.name), viewsForSite(views, site).map(view => view.id))
  assert.ok(declared.cases.every(entry => (entry.input as { site: string }).site === site.site))
})

for (const dist of defaultDists) test(`fake executor: ${dist} scores only applicable cases`, async () => {
  const site = registrationFor(dist)
  const declared = await Effect.runPromise(makeSuite(site))
  const expected = viewsForSite(views, site).map(view => view.id)
  assert.deepEqual(declared.cases.map(entry => entry.name), expected)
  if (dist === "dist-default-ui") assert.ok(!expected.includes("effeck-golden-set"))
  if (dist === "dist-effeck-site") assert.ok(!expected.includes("smithers-evals"))
  const inspected: string[] = []
  const executor = makeExecutor(async view => {
    inspected.push(view.id)
    assert.ok(appliesToSite(view, site))
    return output({ view: view.id })
  })
  for (const entry of declared.cases) {
    const execution = await Effect.runPromise(executor.run(entry))
    const scorers = makeScorers(() => Effect.succeed(reply(views.find(view => view.id === entry.name)!)))
    for (const scorer of scorers) {
      const result = await Effect.runPromise(Effect.result(scorer.score({ input: entry.input, output: execution.output })))
      assert.ok(Result.isSuccess(result), `${entry.name}/${scorer.name}: ${JSON.stringify(result)}`)
    }
  }
  assert.deepEqual(inspected, expected)
})

test("missing core routes stay cases; undeclared optional Docs is excluded", async () => {
  const declared = await Effect.runPromise(makeSuite(fakeSite))
  assert.ok(declared.cases.some(entry => entry.name === "blame"))
  assert.ok(!declared.cases.some(entry => entry.name === "docs"))
  assert.ok(!declared.cases.some(entry => entry.name === "effeck-golden-set"))
})

const transientMessages = [
  "ERR_HTTP2_INVALID_SESSION", "ERR_HTTP2_STREAM_ERROR", "ECONNRESET", "ETIMEDOUT", "EPIPE", "socket hang up", "other side closed",
  "HTTP transport failed: TransportError: [ERR_HTTP2_INVALID_SESSION] The session has been destroyed (POST https://example.test/responses)"
]
for (const message of transientMessages) {
  test(`fake executor: wrapped ${message} retries three times and recovers`, async () => {
    let calls = 0
    const sleeps: number[] = []
    const results = await evaluate(async () => output(), () => ++calls < 3 ? Effect.die(new Error(message)) : Effect.succeed(reply()), "issues", sleeps)
    assert.equal(calls, 3)
    assert.deepEqual(sleeps, [2000, 8000])
    assert.ok(results.every(item => Result.isSuccess(item.result)))
  })
  test(`fake executor: exhausted ${message} remains inconclusive after three attempts`, async () => {
    let calls = 0
    const results = await evaluate(async () => output(), () => { calls++; return Effect.fail({ cause: { code: message }, message }) })
    assert.equal(calls, 3)
    assertInconclusive(results, ["spec-fidelity"])
    const result = results.find(item => item.name === "spec-fidelity")!.result
    assert.ok(Result.isFailure(result))
    assert.match((result.failure as Error).message, /after 3 attempt/)
  })
}
for (const code of transientMessages.slice(0, 5)) test(`permanent HTTP response wins over ${code}`, () => {
  assert.equal(retryableJudgeError({ status: 403, code, message: code }), false)
  assert.equal(retryableJudgeError({ cause: { code } }), true)
})

test("fake executor: crawl reasons group duplicate findings, show locations and the first ten problems", async () => {
  const problems = Array.from({ length: 12 }, (_, index) => `dead link ${index}`)
  const evidence = output({ routeProblems: ["missing route /example"], screens: [
    observation({ problems: [problems[0]!, ...problems] }),
    observation({ width: 390, theme: "dark", problems: [problems[0]!] })
  ] })
  const results = await evaluate(async () => evidence)
  const result = results.find(item => item.name === "crawl-clean")!.result
  assert.ok(Result.isSuccess(result))
  assert.equal(result.success.score, Math.max(0, 1 - 14 / 20))
  const reason = result.success.reason!
  assert.match(reason, /missing route \/example/)
  assert.match(reason, /1440\/light/)
  assert.match(reason, /390\/dark/)
  assert.equal(reason.split("dead link 0").length - 1, 1)
  assert.match(reason, /dead link 8/)
  assert.ok(!reason.includes("dead link 9"))
  assert.match(reason, /\+3 more distinct problems/)
})

test("fake executor: Effect scope does not require shared-route coverage within its subset", async () => {
  const view = views.find(view => view.id === "effect-packages-scope")!
  const site: SitePayload = {
    routes: [...view.patterns],
    screens: [{ id: "packages-ready", route: "smithers.sh/Effect-TS/effect/packages?as=in&role=member" }]
  }
  const observations = view.declaration!.patterns.map(pattern => observation({ resolved: pattern }))
  const routeProblems = routeProblemsFor(view, site, observations)
  assert.deepEqual(routeProblems, [])
  const results = await evaluate(async () => output({ view: view.id, routeProblems, screens: observations }), () => Effect.succeed(reply(view)), view.id)
  const result = results.find(item => item.name === "crawl-clean")!.result
  assert.ok(Result.isSuccess(result))
  assert.equal(result.success.score, 1)
  assert.ok(routeProblemsFor(view, { ...site, routes: [] }, observations).some(problem => problem.startsWith("missing route")))
  assert.ok(routeProblemsFor(view, site, []).some(problem => problem.includes("no resolving screen")))
})

test("DOM audit uses the same rules as crawl.mjs without launching a browser", () => {
  const element = (text: string, attributes: Record<string, string> = {}, extra = {}) => ({
    textContent: text, getAttribute: (key: string) => attributes[key] ?? null,
    hasAttribute: (key: string) => key in attributes, closest: () => null, querySelector: () => null, ...extra
  })
  const anchors = [element("Dead", { href: "#" }), element("Unknown", { href: "#/missing" }), element("External", { href: "https://example.test" }), element("Valid", { href: "#/valid" }), element("Mail", { href: "mailto:a@example.test" }), element("Unsupported", { href: "/relative" }), element("", { href: "https://example.test", target: "_blank" }), element("Harness", {}, { closest: () => ({}) })]
  const buttons = [element(""), element("Inert", { "data-inert": "preview" }), element("Working", {}, { __reactPropsTest: { onClick() {} } }), element("Submit", {}, { type: "submit", form: {}, __reactPropsTest: {} }), element("Disabled", {}, { disabled: true, __reactPropsTest: {} })]
  const inputs = [element("", {}, { name: "email" }), element("", { "aria-label": "Search" }), element("", {}, { labels: [{}] })]
  const environment = () => ({
    window: { __SITE__: { resolve: (path: string) => path === "valid" }, innerWidth: 390 },
    document: { documentElement: { scrollWidth: 450 }, querySelector: () => ({}), querySelectorAll: (selector: string) => selector === "a" ? anchors : selector === "button" ? buttons : inputs },
    __name: (target: unknown) => target
  })
  const source = readFileSync(new URL("../../crawl.mjs", import.meta.url), "utf8")
  const audit = source.slice(source.indexOf("const audit = () => {"), source.indexOf("const browser ="))
  const expected = Array.from(runInNewContext(`${audit}; audit()`, environment()))
  const actual = Array.from(runInNewContext(`(${auditPage.toString()})()`, environment()))
  assert.deepEqual(actual, expected)
  assert.ok(actual.includes("renders the not-found page"))
  assert.ok(actual.some(problem => String(problem).includes("page scrolls sideways")))
})

test("remaining cut Effect screens fail registration audit without becoming required states", () => {
  const site: SitePayload = { routes: [], screens: [
    { id: "effect-ownership-ready", route: "smithers.sh/Effect-TS/effect/settings/ownership?as=in" },
    { id: "effect-run-affected", route: "smithers.sh/Effect-TS/effect/runs?as=in" },
    { id: "effect-check-package", route: "smithers.sh/Effect-TS/effect/packages/core?check=running" },
    { id: "effect-generate-docs", route: "smithers.sh/Effect-TS/effect/docs?as=in" },
    { id: "ownership-ready", route: "smithers.sh/other/repo/settings/ownership" },
    { id: "version-pr-checks", route: "smithers.sh/Effect-TS/effect/pull/111/checks" }
  ] }
  assert.equal(registrationProblemsFor(site).length, 4)
  assert.deepEqual(screensFor(views.find(view => view.id === "settings")!, site).map(screen => screen.id), ["ownership-ready"])
  const problems = routeProblemsFor(views[0]!, site, [observation()])
  assert.equal(problems.filter(problem => problem.startsWith("removed Effect feature screen")).length, 4)
  assert.ok(crawlClean(output({ routeProblems: problems })).score < 1)
  assert.equal(views.find(view => view.id === "effect-packages-scope")!.held, false)
})

test("v2.1 primaries retain the authoritative sixteen-row spec table", () => {
  assert.deepEqual(views.slice(0, 16).map(view => view.primary), [
    "Ask about this repo", "Copy permalink", "Open the commit", "Open a commit", "Browse files at this commit", "Open a branch", "New issue", "Open the next one to review", "Open the run that needs you", "Run a flow", "Edit or ask", "Open notes", "Save", "Open a result", "Send", "Type"
  ])
  assert.equal(views.find(view => view.id === "effect-version-packages")!.primary, "Preview release")
  // Spec principle 3 (PM d-iez026): list-primary views have no solid button.
  assert.deepEqual(views.filter(view => view.solid === false).map(view => view.id), ["blame", "commits", "branches", "releases", "search"])
  const questions = views.flatMap(view => criteriaFor(view).map(criterion => criterion.question)).join("\n")
  for (const text of ["reviews requested", "header count equals", "no counts", "not-found", "golden-set suite", "write controls must be hidden", "one Sign in", "Releases ONLY (PM d-59r9fj)", "never a bare green Synced", "member-only S.Home.App", "512 KiB", "16 KiB", "/actions", "/labels", "/milestones", "/releases/latest", "Generate docs", "Check this package", "Run affected", "Ownership"]) assert.ok(questions.includes(text), text)
})

for (const dist of defaultDists) test(`${dist}: shared versus site-owned state contracts`, async () => {
  const site = registrationFor(dist)
  const declared = await Effect.runPromise(makeSuite(site))
  const selected = viewsForSite(views, site)
  assert.equal(declared.cases.length, ({ "dist-default-ui": 21, "dist-smithers-site": 19, "dist-effeck-site": 19, "dist-effect-monorepo": 20 })[dist])
  for (const view of selected) {
    const required = requiredStatesFor(view, site)
    const entry = declared.cases.find(entry => entry.name === view.id)!
    assert.deepEqual((entry.input as { requiredStates: string[] }).requiredStates, required)
    if (dist === "dist-default-ui" || view.declaration) assert.deepEqual(required, requiredStatesFor(view))
    else {
      const signedOut = screensFor(view, site).some(screen => new URLSearchParams(screen.route.split("?")[1]).get("as") === "out")
      assert.deepEqual(required, signedOut ? ["ready", "signed-out"] : ["ready"])
      assert.equal(statesCovered(output({ view: view.id, states: statesFor(view, site), requiredStates: required })).score, 1)
    }
  }
})

test("shared-site signed-out is required only when registered, and ready never disappears", () => {
  const site = { ...fakeSite, site: "smithers-site", screens: [fakeSite.screens[0]!] }
  assert.deepEqual(requiredStatesFor(issues, site), ["ready"])
  assert.deepEqual(requiredStatesFor(issues, { ...site, screens: [...site.screens, fakeSite.screens[4]!] }), ["ready", "signed-out"])
  assert.deepEqual(requiredStatesFor(issues, { ...site, screens: [] }), ["ready"])
  assert.equal(statesCovered(output({ states: {}, requiredStates: requiredStatesFor(issues, site) })).score, 0)
  assert.deepEqual(requiredStatesFor(issues, { ...site, site: "default" }), requiredStatesFor(issues))
})

test("Fixed by agents owns its state coverage, not ordinary Issues stories", () => {
  const view = views.find(view => view.id === "fixed-by-agents")!
  for (const dist of ["dist-smithers-site", "dist-effeck-site"]) {
    const site = registrationFor(dist)
    // qa-eval2 registered the five missing states on both site catalogs.
    assert.equal(screensFor(view, site).length, 6)
    assert.deepEqual(requiredStatesFor(view, site), ["ready", "loading", "error", "empty", "signed-out", "reader-denied"])
    const result = statesCovered(output({ states: statesFor(view, site), requiredStates: requiredStatesFor(view, site) }))
    assert.equal(result.score, 1)
    assert.match(result.reason, /All 6 required states have screens/)
    assert.ok(screensFor(view, site).every(screen => screen.id.includes("fixed-by-agents")))
  }
  assert.equal(appliesToSite(view, registrationFor("dist-default-ui")), false)
  assert.equal(appliesToSite(view, registrationFor("dist-effect-monorepo")), false)
})

test("rubric pins every v2.1 allowance and the observable-evidence boundary", () => {
  const questions = views.flatMap(view => criteriaFor(view).map(item => item.question)).join("\n")
  for (const text of [
    "Issues, Pull requests and Runs keep their counts", "only declared tabs carry no count",
    "Stack is the canonical TODO list", "Add TODO is correct", "A repo may rename it", "only Smithers calls its Stack Landing queue",
    "SMITHERS wordmark", "Design lead's brand and out of scope", "guest-off outline prompt Sign in to ask about <repo>",
    "view's one Sign in", "Design lead D1", "closed menu makes the entry unobservable, not missing", "do not deduct for unobservable"
  ]) assert.ok(questions.includes(text), text)
  assert.match(rubricInstructions, /Mock defects:.*Unobservable:/)
  assert.match(rubricInstructions, /Unobservable items receive no deduction/)
})

/** Capture the real scorer's judge request: these pin rubric contracts, not a
 * live model's compliance with them. No browser or subscription is invoked. */
const primaryJudgeRequest = async (viewId: string): Promise<string> => {
  const view = views.find(view => view.id === viewId)!
  const requests: string[] = []
  const scorer = makeScorers(request => {
    requests.push(`${request.system}\n${request.prompt}`)
    return Effect.succeed(reply(view))
  }, { log: () => {} }).find(scorer => scorer.name === "spec-fidelity")!
  await Effect.runPromise(scorer.score({ input: {}, output: output({ view: viewId }) }))
  assert.equal(requests.length, 1)
  return requests[0]!
}

test("e5 Docs declares Ask about this page as its solid ready primary (PM d-iez026)", async () => {
  const docs = views.find(view => view.id === "docs")!
  assert.equal(docs.primary, "Ask about this page")
  assert.notEqual(docs.solid, false)
  const request = await primaryJudgeRequest("docs")
  assert.ok(request.includes("Ready-state primary: Ask about this page"))
  assert.ok(request.includes("'Ask about this page' is the ready subject's one solid button"))
  assert.ok(!request.includes("Open a page"))
})

for (const [view, example] of [["code-home", "sandbox dialog"], ["effect-packages-scope", "package confirmation"]]) {
  test(`e5 ${example} excludes background controls but retains the foreground primary limit`, async () => {
    const request = await primaryJudgeRequest(view!)
    for (const text of ["modal or dialog is open", "confirmation is the focused view", "controls behind it do not count against one-solid-per-view", "Multiple competing foreground solid actions remain defects"])
      assert.ok(request.includes(text), text)
  })
}

for (const [view, recovery] of [["settings", "Open install instructions on a held Settings section"], ["effeck-golden-set", "Open golden cases on an empty suite"]]) {
  test(`e5 ${view} uses recovery rather than the ready-state primary`, async () => {
    const request = await primaryJudgeRequest(view!)
    for (const text of ["Judge the Views-table primary in the ready state", "held, denied, error, empty and setup states", recovery!, "Retry on an error", "Do not require Save or Run eval in those recovery states", "missing or inert recovery actions remain defects"])
      assert.ok(request.includes(text), text)
  })
}

test("e5 docked Ask satisfies Code home without demanding an enabled empty Send", async () => {
  const request = await primaryJudgeRequest("code-home")
  assert.ok(request.includes("primary is met by the home prompt or the open Ask panel"))
  assert.ok(request.includes("Send disabled until text is typed do not make the home primary absent or disabled"))
  assert.ok(!request.includes("Ask about this repo (the view's one solid button"))
})

test("e5 Ask judges its panel and composer separately from home prompts and content primaries", async () => {
  const request = await primaryJudgeRequest("ask")
  for (const text of ["Judge the Ask case on the Ask panel and composer only", "Send disabled until text is typed is correct chat behavior, not a disabled primary", "Judge home-content prompts under their own view", "Send does not compete with the content view's primary, even when enabled", "an unopened panel is unobservable, not missing"])
    assert.ok(request.includes(text), text)
})

test("e5 Terminal Type is usable command input, with no invented solid button", async () => {
  const request = await primaryJudgeRequest("terminal")
  for (const text of ["Type means the terminal command input itself, not a solid Type button", "Run command may remain disabled until a command is typed", "Require usable terminal input"])
    assert.ok(request.includes(text), text)
  assert.ok(!request.includes("Type (the view's one solid button"))
  assert.ok(!criteriaFor(views.find(view => view.id === "terminal")!).find(item => item.id === "primary-action")!.question.includes("only solid primary action"))
})

test("e5 global Sign in is navigation; only duplicate view-owned Sign in controls are defects", async () => {
  const request = await primaryJudgeRequest("branches")
  for (const text of ["global header's Sign in is navigation, not a view control", "One Sign in per view counts only the view's own controls", "duplicate Sign in controls within that view remain defects", "Signed-out write controls must be hidden", "no agent or Smithers approves", "Merge and land verbs take a person as subject"])
    assert.ok(request.includes(text), text)
})

const oversizedOutput = () => {
  const ready = observation({ id: "ready", text: "source ".repeat(20_000), links: Array.from({ length: 1000 }, (_, i) => ({ name: `link ${i}`, href: `#/file/${i}`, title: "title ".repeat(100) })) })
  const phone = observation({ id: "ready", width: 390, text: "phone ".repeat(2000) })
  return output({ ready, states: { ready: ["ready"] }, screens: [
    ...Array.from({ length: 100 }, (_, i) => observation({ id: `rest-${i}`, text: `screen ${i} `.repeat(3000) })),
    phone, { ...phone, theme: "dark" }, ready, { ...ready, theme: "dark" },
    observation({ id: "different-dark", theme: "dark", text: "unique dark content" })
  ] })
}

test("oversized fake evidence is bounded, ordered, deduped and auditable", () => {
  const original = oversizedOutput()
  const before = JSON.stringify(original)
  const { evidence, audit } = buildJudgeEvidence(original)
  assert.ok(JSON.stringify(evidence).length <= judgeLimits.totalChars)
  assert.equal(audit.serializedChars, JSON.stringify(evidence).length)
  assert.equal(evidence.screens[0]!.id, "ready")
  assert.equal(evidence.screens[0]!.width, 1440)
  assert.equal(evidence.screens[1]!.width, 390)
  assert.ok(evidence.screens.every(screen => String(screen.text).length <= judgeLimits.textChars && JSON.stringify(screen).length <= judgeLimits.observationChars))
  assert.equal(evidence.screens[0]!.textTruncated, true)
  assert.equal(evidence.screens[0]!.evidenceTruncated, true)
  assert.equal(audit.dropped.filter(drop => drop.reason === "duplicate").length, 2)
  assert.ok(audit.dropped.some(drop => drop.reason === "budget"))
  assert.ok(audit.dropped.some(drop => drop.reason === "truncated" && drop.chars > 0 && drop.fields?.includes("text")))
  assert.ok(!audit.dropped.some(drop => drop.id === "different-dark" && drop.reason === "duplicate"))
  assert.equal(JSON.stringify(original), before)
  assert.ok(JSON.stringify(buildJudgeEvidence(original, judgeLimits.totalChars / 2).evidence).length <= judgeLimits.totalChars / 2)
})

test("dark-only differences survive deduplication, including controls beyond the text cap", () => {
  const light = observation({ text: "x".repeat(5000) })
  const dark = { ...light, theme: "dark" as const, buttons: [{ name: "Dark action", title: "/dark", action: true, primary: true }] }
  const { evidence, audit } = buildJudgeEvidence(output({ ready: light, screens: [light, { ...light, theme: "dark" }, dark] }))
  assert.equal(evidence.screens.length, 2)
  assert.equal(audit.dropped.filter(drop => drop.reason === "duplicate").length, 1)
  assert.ok(evidence.screens.some(screen => screen.theme === "dark"))
})

const judgedEvidence = (prompt: string) => JSON.parse(/Output under judgment:\n`+text\n([\s\S]*)\n`+$/.exec(prompt)![1]!)
const partitionedObservation = async (width = 1440) => {
  // DOM membership regression without Chromium; layout is supplied explicitly.
  const requireApp = createRequire(new URL("../../../../../apps/app/package.json", import.meta.url))
  const { Window } = await import(requireApp.resolve("happy-dom"))
  const window = new Window()
  window.innerWidth = width
  const document = window.document
  document.body.innerHTML = `<header class="repo-frame-global"><a href="#/">SMITHERS</a><button>Sign in</button></header>
    <header class="repo-frame-repo-header"><h1>Effect / effect</h1><nav class="repo-ui-tabs" aria-label="Repository"><a href="#/code" aria-current="page">Code</a><a href="#/issues">Issues 17</a></nav></header>
    <main><h2>Branches</h2><p>${"branch-row ".repeat(600)}VIEW END</p><button data-primary="true" title="/branch.new">New branch</button><a href="#/view">Shared label</a></main>
    <aside id="repo-ask-panel"><header><h2>Ask</h2></header><p>${"ASK ONLY ".repeat(12_000)}</p>
      <button class="repo-frame-suggestion">Question one</button><button class="repo-frame-suggestion">Question two</button>
      <section><button data-primary="true">Send</button><a href="#/ask">Shared label</a></section></aside>`
  window.HTMLElement.prototype.getClientRects = () => [{ x: 0, y: 0, width: 200, height: 30 }]
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: Math.min(width, 1000), height: 30 })
  const page = runInNewContext(`(${collectPage.toString()})()`, {
    window, document, HTMLElement: window.HTMLElement,
    getComputedStyle: window.getComputedStyle.bind(window), __name: (value: unknown) => value
  })
  // Remove cross-realm prototypes so strict assertions compare evidence values.
  const screen = observation({ ...JSON.parse(JSON.stringify(page)), width })
  await window.happyDOM.close()
  return screen
}

test("large docked Ask is excluded before clipping while 1440 view content and controls survive", async () => {
  const screen = await partitionedObservation()
  const before = JSON.stringify(screen)
  const { evidence, audit } = buildJudgeEvidence(output({ ready: screen, screens: [screen] }), 12_000)
  const included = evidence.screens[0]!
  assert.ok(included, "large Ask must not crowd out the view")
  assert.ok(String(included.text).includes("VIEW END"))
  assert.ok(!JSON.stringify(evidence).includes("ASK ONLY"))
  assert.equal(included.ask, "Ask docked; 2 suggestions.")
  assert.deepEqual((included.buttons as Array<{ name: string }>).map(item => item.name), ["New branch"])
  assert.deepEqual((included.links as Array<{ href: string }>).map(item => item.href), ["#/view"])
  assert.equal((included.primary as { name: string }).name, "New branch")
  assert.equal(included.textTruncated, false)
  assert.equal(audit.dropped.length, 0)
  assert.ok(audit.serializedChars <= 12_000)
  assert.ok(screen.text.includes("ASK ONLY"))
  assert.ok(screen.buttons.some(item => item.name === "Send"))
  assert.equal(JSON.stringify(screen), before)
  const ask = buildJudgeEvidence(output({ view: "ask", ready: screen, screens: [screen] })).evidence.screens[0]!
  assert.ok(String(ask.text).includes("ASK ONLY"))
  assert.ok(!String(ask.text).includes("VIEW END"))
  assert.ok((ask.buttons as Array<{ name: string }>).some(item => item.name === "Send"))
})

test("shared frame is sent once with viewports; phone layout and control differences survive", async () => {
  const desktop = await partitionedObservation(1440)
  const laptop = await partitionedObservation(1280)
  const phone = await partitionedObservation(390)
  phone.judgeParts!.frame[0]!.buttons[0]!.name = "Phone account"
  const source = output({ ready: desktop, screens: [desktop, laptop, phone] })
  const { evidence } = buildJudgeEvidence(source)
  const globals = evidence.frames.filter(item => item.content.selector === ".repo-frame-global")
  assert.equal(globals.length, 2)
  assert.deepEqual(globals[0]!.viewports, [{ width: 1440, theme: "light" }, { width: 1280, theme: "light" }])
  assert.deepEqual(globals[1]!.viewports, [{ width: 390, theme: "light" }])
  assert.ok(JSON.stringify(globals[1]).includes("Phone account"))
  assert.equal((globals[1]!.content.bounds as { width: number }).width, 390)
  assert.equal(evidence.frames.filter(item => item.content.selector === ".repo-frame-repo-header").length, 2)
  assert.equal(evidence.frames.filter(item => item.content.selector === ".repo-ui-tabs").length, 2)
  assert.ok(!JSON.stringify(evidence.screens).includes("SMITHERS"))
  assert.ok(evidence.screens.every(screen => !(screen.layout as { tabs?: string[] })?.tabs))
  const tabs = evidence.frames.find(item => item.content.selector === ".repo-ui-tabs")!
  assert.equal((tabs.content.links as Array<{ current?: string }>)[0]!.current, "page")
  for (const screen of evidence.screens) for (const id of screen.frame as string[]) assert.ok(evidence.frames.some(frame => frame.id === id))
  const dark = structuredClone(desktop)
  dark.theme = "dark"
  dark.judgeParts!.frame[0]!.text = "Dark-only header"
  const variants = buildJudgeEvidence(output({ ready: desktop, screens: [desktop, dark] })).evidence
  assert.equal(variants.screens.length, 2)
  assert.ok(variants.frames.some(frame => frame.content.text === "Dark-only header"))
})

test("evidence size is logged even for a case without omissions", async () => {
  const logs: EvidenceAudit[] = []
  const scorer = makeScorers(() => Effect.succeed(reply()), { log: entry => logs.push(entry) }).find(item => item.name === "spec-fidelity")!
  await Effect.runPromise(scorer.score({ input: {}, output: output() }))
  assert.equal(logs.length, 1)
  assert.equal(logs[0]!.case, "issues")
  assert.ok(logs[0]!.originalChars > 0)
  assert.ok(logs[0]!.serializedChars > 0)
  assert.deepEqual(logs[0]!.dropped, [])
})

test("expanded case budget retains eighteen large views with one shared desktop frame", async () => {
  const source = await partitionedObservation()
  const screens = Array.from({ length: 18 }, (_, i) => ({ ...source, id: `branch-state-${i}`, route: `${source.route}&sample=${i}` }))
  const { evidence, audit } = buildJudgeEvidence(output({ ready: screens[0], screens }))
  assert.equal(evidence.screens.length, 18)
  assert.equal(evidence.frames.length, 3)
  assert.ok(audit.serializedChars > 48_000)
  assert.ok(audit.serializedChars < judgeLimits.totalChars)
  assert.deepEqual(audit.dropped, [])
  assert.ok(evidence.screens.every(screen => String(screen.text).includes("VIEW END")))
})

for (const defect of [false, true]) test(`context-window ${defect ? "defect" : "typed error"} retries oversized case once with half budget`, async () => {
  const requests: Array<{ system: string; prompt: string }> = []
  const audits: EvidenceAudit[] = []
  const scorer = makeScorers(request => {
    requests.push(request)
    return requests.length === 1 ? (defect ? Effect.die(new Error("Your input exceeds the context window of this model")) : Effect.fail({ status: 400, message: "context_length_exceeded" })) : Effect.succeed(reply())
  }, { log: audit => audits.push(audit), sleep: () => Effect.die("context errors must not sleep") }).find(scorer => scorer.name === "spec-fidelity")!
  const result = await Effect.runPromise(scorer.score({ input: {}, output: oversizedOutput() }))
  assert.equal(requests.length, 2)
  assert.deepEqual(audits.map(audit => audit.budget), [judgeLimits.totalChars, judgeLimits.totalChars / 2])
  assert.ok(JSON.stringify(judgedEvidence(requests[0]!.prompt)).length <= judgeLimits.totalChars)
  assert.ok(JSON.stringify(judgedEvidence(requests[1]!.prompt)).length <= judgeLimits.totalChars / 2)
  assert.ok(requests[1]!.prompt.length < requests[0]!.prompt.length)
  const meta = result.meta as { evidenceAudits: EvidenceAudit[]; mockDefects: string; unobservable: string }
  assert.equal(meta.evidenceAudits.length, 2)
  assert.match(meta.mockDefects, /none/)
  assert.match(meta.unobservable, /none/)
})

test("repeated context-window failure is inconclusive after exactly one reduced retry", async () => {
  let calls = 0
  const results = await evaluate(async () => oversizedOutput(), () => { calls++; return Effect.die(new Error("Your input exceeds the context window of this model")) })
  assert.equal(calls, 2)
  assertInconclusive(results, ["spec-fidelity"])
  const failure = results.find(item => item.name === "spec-fidelity")!.result
  assert.ok(Result.isFailure(failure))
  assert.match((failure.failure as Error).message, /after one half-budget retry/)
  assert.ok(contextWindowError({ cause: { code: "context_length_exceeded" } }))
  assert.equal(contextWindowError(new Error("HTTP 403 unauthorized")), false)
})

test("spec-fidelity exposes defects separately and refuses unstructured reasons", async () => {
  for (const reason of ["Mock defects: issues-list-open has two primaries. Unobservable: closed Code menu; no deduction.", "Mixed defects and missing observations"]) {
    const results = await evaluate(async () => output(), () => Effect.succeed(JSON.stringify({ ...JSON.parse(reply()), reason })))
    const result = results.find(item => item.name === "spec-fidelity")!.result
    if (reason.startsWith("Mock defects:")) {
      assert.ok(Result.isSuccess(result))
      const meta = result.success.meta as { mockDefects: string; unobservable: string }
      assert.equal(meta.mockDefects, "issues-list-open has two primaries.")
      assert.equal(meta.unobservable, "closed Code menu; no deduction.")
      assert.equal(result.success.reason, reason)
    } else {
      assert.ok(Result.isFailure(result))
      assert.equal((result.failure as { code: string }).code, "invalid_score")
    }
  }
})
