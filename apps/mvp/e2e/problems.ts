// What fails every e2e test unless the test declares it (docs/infrastructure.md#server-and-console-errors): a response
// of 500 or above from the app's origin, a failed `/api/` request, a console error and a page error, from every page of
// every browser context the test opened. On 2026-10-25 smithers.sh answered its shapes `500` 60 to 600 times an hour
// and no spec failed: the browser retried each shape and the specs checked only what rendered in the end.
//
// This module is the pure part: what each thing a browser reports counts as, how a test declares the errors it causes
// on purpose, and the list a failing test shows. e2e/watch.ts feeds it from Playwright's events.

/** The annotation a test that causes a server error on purpose sets: `<status> <path>`, e.g. `503 /api/auth/session`. */
export const EXPECTED_SERVER_ERROR = "expected server error"

/** The annotation a test that causes a console or page error on purpose sets: text the error contains. */
export const EXPECTED_CONSOLE_ERROR = "expected console error"

/** What a declaration names: a response status, or `failed` for a request that got no response. */
export type Status = number | "failed"

/** What a browser reported, as plain data. */
export type Observation =
  | { readonly kind: "response"; readonly method: string; readonly url: string; readonly status: number }
  | { readonly kind: "failed"; readonly method: string; readonly url: string; readonly error: string }
  | { readonly kind: "console"; readonly text: string; readonly url: string | undefined }
  | { readonly kind: "page"; readonly text: string; readonly name?: string }

/** A problem: its line in the list, and what a declaration matches it by. */
export type Problem =
  | { readonly kind: "server"; readonly status: Status; readonly path: string; readonly line: string }
  | { readonly kind: "console"; readonly line: string }

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/**
 * A URL's path for the list: its pathname with each id as `:id`, then its query's parameter names, sorted, without
 * their values (a value can be a person's or a repository's). `/api/shapes/items?offset=-1&handle=h` is
 * `/api/shapes/items?handle&offset`.
 */
export const pathOf = (url: string): string => {
  const parsed = new URL(url)
  const names = [...new Set(parsed.searchParams.keys())].sort()
  const path = parsed.pathname.replace(UUID, ":id")
  return names.length === 0 ? path : `${path}?${names.join("&")}`
}

const pathnameOf = (path: string) => path.split("?")[0]!

/** Where a console line points: the app's path, another origin's whole address (as `pathOf`), or `(unknown)`. */
const placeOf = (origin: string, url: string | undefined) => {
  if (url === undefined) return "(unknown)"
  try {
    const parsed = new URL(url)
    return parsed.origin === origin ? pathOf(url) : `${parsed.origin}${pathOf(url)}`
  } catch {
    return "(unknown)"
  }
}

const at = (origin: string, url: string | undefined): url is string => {
  if (url === undefined) return false
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

const api = (url: string) => new URL(url).pathname.startsWith("/api/")

/**
 * A server on this machine that isn't the app: a fixture an earlier test served and stopped (e2e/web-page.spec.ts),
 * whose page stays in the home conversation every local test shares. Nothing in a deployment points at one.
 */
const fixture = (origin: string, url: string | undefined) => {
  if (url === undefined) return false
  try {
    const parsed = new URL(url)
    return parsed.origin !== origin && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * A request the page cancelled itself, in Chromium, Firefox and WebKit: a navigation, a closed page, an interrupted
 * fiber's fetch, or the telemetry exporter giving up after 10 s or dropping a body it already has the status of. The
 * server failing shows as a 5xx or as another network error (a reset or empty response, an HTTP/2 error).
 */
const cancelled = (error: string) => error === "net::ERR_ABORTED" || error === "NS_BINDING_ABORTED" || error === "cancelled"

/** A request the test's own offline device couldn't send (`context.setOffline(true)`): not the server's failure. */
const offline = (error: string) => error === "net::ERR_INTERNET_DISCONNECTED" || error === "NS_ERROR_OFFLINE"

const RESOURCE_STATUS = /^Failed to load resource: the server responded with a status of (\d{3})/
const RESOURCE_FAILURE = /^Failed to load resource: (net::\S+)/

/** A console line without what differs between two of the same: an Effect logger's time and fiber id. */
const steady = (text: string) => text.replace(/^\[\d{2}:\d{2}:\d{2}\.\d+\] /, "").replace(/ \(#\d+\)/, "").slice(0, 300)

/** The problem `observation` is for the app at `origin`, or undefined when it isn't one. */
export const problemOf = (origin: string, observation: Observation): Problem | undefined => {
  switch (observation.kind) {
    case "response": {
      if (observation.status < 500 || !at(origin, observation.url)) return undefined
      const path = pathOf(observation.url)
      return { kind: "server", status: observation.status, path, line: `${observation.status} ${observation.method} ${path}` }
    }
    case "failed": {
      const { error } = observation
      if (!at(origin, observation.url) || !api(observation.url) || cancelled(error) || offline(error)) return undefined
      const path = pathOf(observation.url)
      return { kind: "server", status: "failed", path, line: `failed ${observation.method} ${path} ${error}` }
    }
    case "console": {
      const status = RESOURCE_STATUS.exec(observation.text)
      if (status !== null) {
        const code = Number(status[1])
        // Chrome logs every refused response. A 5xx from the app is already on the list as its response, and a 409 on a
        // shape is Electric's "must refetch", which its client answers by starting the shape again.
        if (code >= 500 && at(origin, observation.url)) return undefined
        if (code === 409 && at(origin, observation.url) && new URL(observation.url).pathname.startsWith("/api/shapes/")) return undefined
        const path = placeOf(origin, observation.url)
        return { kind: "server", status: code, path, line: `console ${code} ${path}: Failed to load resource` }
      }
      const failure = RESOURCE_FAILURE.exec(observation.text)
      // A request that failed is the request check's: offline, cancelled, or on the list as failed.
      if (failure !== null && (offline(failure[1]!) || (at(origin, observation.url) && api(observation.url)))) return undefined
      if (failure !== null && fixture(origin, observation.url)) return undefined
      if (failure !== null) return { kind: "console", line: `console failed ${placeOf(origin, observation.url)} ${failure[1]}` }
      return { kind: "console", line: `console error: ${steady(observation.text)}` }
    }
    case "page":
      return { kind: "console", line: `page error: ${steady(observation.text)}` }
  }
}

/** The annotation that declares a server error: `status` on `path`, where `*` in `path` stands for any characters. */
export const serverErrorAnnotation = (status: Status, path: string) => {
  if (!(status === "failed" || (Number.isInteger(status) && status >= 400 && status <= 599))) {
    throw new Error(`expectServerError: ${status} is not a 4xx or 5xx status or "failed"`)
  }
  if (!path.startsWith("/") || /[\s?]/.test(path)) throw new Error(`expectServerError: "${path}" is not a pathname such as /api/auth/session`)
  return { type: EXPECTED_SERVER_ERROR, description: `${status} ${path}` }
}

/** The services a run's target runs without, for `environmentAnnotations`. */
export type Lacks = { readonly codeStorage: boolean; readonly model: boolean; readonly github: boolean }

/**
 * The server errors a local dev server answers in place of a service it runs without, which no test causes: without
 * Code Storage its clones and repository reads answer `503 not_configured` (worker/RepoApi.ts), without a model key its
 * model endpoint answers `502`, and without the GitHub App, GitHub's anonymous allowance runs out in a suite and its
 * About reads answer `503 rate_limited`. A deployment has all three, so it declares none.
 */
export const environmentAnnotations = (lacks: Lacks) => [
  ...(lacks.codeStorage
    ? ["/api/repos", "/api/repos/launch", "/api/repos/*/refs", "/api/repos/*/tree/*", "/api/repos/*/blob/*", "/api/repos/*/raw/*"]
      .map((path) => serverErrorAnnotation(503, path))
    : []),
  ...(lacks.model ? [serverErrorAnnotation(502, "/api/model/*")] : []),
  ...(lacks.github ? [serverErrorAnnotation(503, "/api/repos/*/about")] : []),
]

/** The annotation that declares a console or page error: one whose line contains `text`. */
export const consoleErrorAnnotation = (text: string) => {
  if (text.trim() === "") throw new Error("expectConsoleError: name some text the error contains")
  return { type: EXPECTED_CONSOLE_ERROR, description: text }
}

type Annotation = { readonly type: string; readonly description?: string | undefined }

type Declaration =
  | { readonly kind: "server"; readonly status: Status; readonly path: RegExp }
  | { readonly kind: "console"; readonly text: string }

const patternOf = (path: string) => new RegExp(`^${path.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)

/** The declarations among a test's annotations. */
export const declarationsOf = (annotations: ReadonlyArray<Annotation>): Array<Declaration> =>
  annotations.flatMap((annotation): Array<Declaration> => {
    if (annotation.type === EXPECTED_CONSOLE_ERROR) return [{ kind: "console", text: annotation.description ?? "" }]
    if (annotation.type !== EXPECTED_SERVER_ERROR) return []
    const match = /^(\d{3}|failed) (\/\S*)$/.exec(annotation.description ?? "")
    if (match === null) throw new Error(`An "${EXPECTED_SERVER_ERROR}" annotation reads "${annotation.description}": use expectServerError (e2e/watch.ts)`)
    return [{ kind: "server", status: match[1] === "failed" ? "failed" : Number(match[1]), path: patternOf(match[2]!) }]
  })

/** Whether `declaration` names `problem`. */
export const declares = (declaration: Declaration, problem: Problem): boolean =>
  declaration.kind === "server"
    ? problem.kind === "server" && problem.status === declaration.status && declaration.path.test(pathnameOf(problem.path))
    : problem.kind === "console" && declaration.text !== "" && problem.line.includes(declaration.text)

/** One line of the list: the problem, how many times it happened, and whether the test declared it. */
export type Counted = { readonly line: string; readonly count: number; readonly declared: boolean }

/** Every problem a test's browsers reported, counted by its line, in the order each first happened. */
export class Problems {
  private readonly counts = new Map<string, { problem: Problem; count: number }>()

  constructor(readonly origin: string) {}

  /** Counts `observation` if it is a problem. */
  note(observation: Observation): void {
    const problem = problemOf(this.origin, observation)
    if (problem === undefined) return
    const counted = this.counts.get(problem.line)
    if (counted === undefined) this.counts.set(problem.line, { problem, count: 1 })
    else counted.count++
  }

  /** Each problem, counted, and whether one of the test's annotations declares it. */
  list(annotations: ReadonlyArray<Annotation>): Array<Counted> {
    const declarations = declarationsOf(annotations)
    return [...this.counts.values()].map(({ problem, count }) => ({
      line: problem.line,
      count,
      declared: declarations.some((declaration) => declares(declaration, problem)),
    }))
  }

  /** The problems the test didn't declare, as `<line> ×<count>`: a passing test has none. */
  undeclared(annotations: ReadonlyArray<Annotation>): Array<string> {
    return this.list(annotations).filter((each) => !each.declared).map((each) => `${each.line} ×${each.count}`)
  }

  /** The list for a failing test's browser.log: every problem, declared or not. */
  report(annotations: ReadonlyArray<Annotation>): Array<string> {
    const list = this.list(annotations)
    if (list.length === 0) return ["problems: none"]
    return ["problems (e2e/problems.ts):", ...list.map((each) => `  ${each.declared ? "declared" : "UNDECLARED"} ${each.line} ×${each.count}`)]
  }
}

/** The failure message of the check: what the test didn't declare and how to declare what it causes on purpose. */
export const UNDECLARED =
  "Server errors (5xx), failed /api/ requests, console errors and page errors this test didn't declare. Fix the cause; " +
  "a test that causes one on purpose declares it with expectServerError(status, path) or expectConsoleError(text) " +
  "(e2e/watch.ts)"
