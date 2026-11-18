/**
 * What `github`, `runner` and the runner's own variables hold for a replay.
 *
 * A replay stands for one event: a pull request to the default branch whose
 * head is the commit and whose base is the commit's first parent, or, for a
 * workflow no pull request starts, a push of the commit to the default
 * branch. What that event fixes is known here. What only GitHub knows, such
 * as a pull request's number or title, is unknown, and an expression that
 * reads it leaves its job out.
 *
 * @since 0.1.0
 */

import type { Host } from "../contract/Inventory.ts"
import { type Context, fields, unknown, value, variable } from "./Expression.ts"
import { commitMark, parentMark } from "./Runner.ts"
import { asStrings, isRecord } from "./Values.ts"

/**
 * What the reader knows about the repository besides the workflow file.
 *
 * - `repository`: `owner/name`.
 * - `directory`: the name of the repository's directory, when no remote names the repository.
 * - `defaultBranch`: the branch a replayed commit is on.
 * - `read`: the text of a file in the repository, for a local action or a
 *   workflow another calls.
 *
 * @category models
 * @since 0.1.0
 */
export interface Facts {
  readonly repository?: string | undefined
  /** The directory's name, for a repository no remote names. */
  readonly directory?: string | undefined
  readonly defaultBranch?: string | undefined
  readonly read?: ((path: string) => string | undefined) | undefined
}

/**
 * The event a replay stands for.
 *
 * @category models
 * @since 0.1.0
 */
export type Event = "pull_request" | "push" | "merge_group"

/** The events a replay can stand for, the first that fits winning. */
const events = ["pull_request", "push", "merge_group"] as const

/** A branch filter as a pattern, or `undefined` for one written with `?`, `+` or `[`, which is not read here. */
const branchPattern = (pattern: string): RegExp | undefined =>
  /[?+[\]]/.test(pattern)
    ? undefined
    : new RegExp(
      `^${
        pattern.split("**").map((part) =>
          part.split("*").map((text) => text.replace(/[.^$(){}|\\]/g, "\\$&")).join("[^/]*")
        )
          .join(".*")
      }$`
    )

/**
 * Whether an event's `branches` and `branches-ignore` let it start a workflow
 * for a branch, as "Workflow syntax: on.<push|pull_request>.branches" reads
 * them: a later pattern wins, and one that starts with `!` takes a branch
 * out again. A filter this cannot read lets the branch through.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const admits = (config: unknown, branch: string): boolean => {
  const filters = isRecord(config) ? config : {}
  const texts = (raw: unknown): ReadonlyArray<string> | undefined => raw === undefined ? undefined : asStrings(raw)
  const matches = (pattern: string): boolean | undefined => branchPattern(pattern)?.test(branch)
  const ignored = texts(filters["branches-ignore"])
  if (ignored !== undefined) return !ignored.some((pattern) => matches(pattern) === true)
  const named = texts(filters["branches"])
  if (named === undefined) return true
  let admitted = false
  for (const pattern of named) {
    const found = matches(pattern.replace(/^!/, ""))
    if (found === undefined) return true
    if (found) admitted = !pattern.startsWith("!")
  }
  return admitted
}

/**
 * The event a workflow is replayed as: a pull request when one to the
 * default branch starts it, else a push of that branch, else a merge group.
 * `on` is the workflow's `on:` as a mapping of its events. When the filters
 * of every event keep the default branch out, the first event the workflow
 * names stands: its jobs then run more often than its CI runs them, never
 * less. `undefined` when no change starts the workflow.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const eventOf = (on: Readonly<Record<string, unknown>>, branch?: string): Event | undefined => {
  const named = events.filter((event) => Object.hasOwn(on, event))
  return named.find((event) => branch === undefined || admits(on[event], branch)) ?? named[0]
}

/**
 * How a sentence names the event.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const eventName = (event: Event | undefined, facts: Facts): string => {
  const branch = facts.defaultBranch === undefined ? "the default branch" : facts.defaultBranch
  if (event === "pull_request") return `a pull request to ${branch}`
  if (event === "merge_group") return `a merge group for ${branch}`
  return event === "push" ? `a push to ${branch}` : "a run no change starts"
}

/** The name stood in for whoever started the run. */
const actor = "smithers-ci"

/** What stands for a number only GitHub gives out: a pull request's, an account's, a repository's. */
const one = "1"

/** The branch a pull request comes from, which only GitHub knows. */
const headBranch = "smithers-ci"

const servers = {
  server_url: "https://github.com",
  api_url: "https://api.github.com",
  graphql_url: "https://api.github.com/graphql"
}

/**
 * Top-level names of event payloads that the payload of each event does not have. An expression that reads one
 * gets `null`, as on GitHub. Any other name may be in the payload, and only GitHub knows what it holds.
 */
const absent: Readonly<Record<Event, ReadonlySet<string>>> = (() => {
  const never = ["inputs", "release", "issue", "comment", "schedule", "workflow_run", "client_payload", "deployment"]
  const pushed = ["ref", "head_commit", "commits", "created", "deleted", "forced", "pusher", "compare"]
  return {
    pull_request: new Set([...never, ...pushed, "merge_group"]),
    push: new Set([...never, "pull_request", "merge_group", "number", "action", "label"]),
    merge_group: new Set([...never, ...pushed, "pull_request", "before", "after", "number", "label"])
  }
})()

const optional = (held: string | undefined, what: string): Context =>
  held === undefined ? unknown(`${what} is not known here`) : value(held)

const eventContext = (event: Event | undefined, facts: Facts): Context => {
  const ofRepository = (name: string): Context =>
    name === "full_name"
      ? optional(facts.repository, "the repository's name")
      : name === "default_branch"
      ? optional(facts.defaultBranch, "the default branch")
      : unknown(`github.event.repository.${name} is known only on GitHub`)
  const repository = fields(ofRepository)
  // The pull request's branch is in the repository itself: a replay has no fork to read.
  const side = (commit: Context, branch: Context | undefined, what: string): Context =>
    fields((name) => {
      if (name === "sha") return commit
      if (name === "ref" && branch !== undefined) return branch
      if (name === "repo") return fields((field) => field === "fork" ? value(false) : ofRepository(field))
      return unknown(`github.event.pull_request.${what}.${name} is known only on GitHub`)
    })
  const own: ReadonlyMap<string, Context> = new Map<string, Context>(
    event === "pull_request"
      ? [[
        "pull_request",
        fields((name) => {
          if (name === "head") return side(variable("sha", "github.event.pull_request.head.sha"), undefined, "head")
          if (name === "base") {
            return side(
              variable("base:the pull request", "github.event.pull_request.base.sha"),
              optional(facts.defaultBranch, "the default branch"),
              "base"
            )
          }
          if (name === "labels") return value([])
          if (name === "draft") return value(false)
          return unknown(`github.event.pull_request.${name} is known only on GitHub`)
        })
      ]]
      : event === "push"
      ? [
        ["before", variable("before", "github.event.before")],
        ["after", variable("sha", "github.event.after")],
        [
          "ref",
          facts.defaultBranch === undefined
            ? unknown("the default branch is not known here")
            : value(`refs/heads/${facts.defaultBranch}`)
        ],
        ["created", value(false)],
        ["deleted", value(false)],
        ["forced", value(false)]
      ]
      : event === "merge_group"
      ? [[
        "merge_group",
        fields((name) => {
          if (name === "head_sha") return variable("sha", "github.event.merge_group.head_sha")
          if (name === "base_sha") return variable("base:the merge group", "github.event.merge_group.base_sha")
          if (name === "base_ref") {
            return facts.defaultBranch === undefined
              ? unknown("the default branch is not known here")
              : value(`refs/heads/${facts.defaultBranch}`)
          }
          return unknown(`github.event.merge_group.${name} is known only on GitHub`)
        })
      ]]
      : []
  )
  return fields((name) => {
    if (event === undefined) return unknown("no change starts this workflow, so it has no event to read")
    if (name === "repository") return repository
    return own.get(name) ??
      (absent[event].has(name) ? undefined : unknown(`github.event.${name} is known only on GitHub`))
  })
}

/**
 * Where an expression is read: the job's key, the workflow's name and file,
 * and the directory of the composite action it is in.
 *
 * @category models
 * @since 0.1.0
 */
export interface Place {
  readonly job: string
  readonly workflow: string
  /** The workflow's file, from the repository root. */
  readonly file?: string | undefined
  readonly actionPath?: string | undefined
}

/**
 * The `github` context of a replay.
 *
 * @category contexts
 * @since 0.1.0
 * @throws {never}
 */
export const github = (event: Event | undefined, facts: Facts, place: Place): Context => {
  const payload = eventContext(event, facts)
  const branch = facts.defaultBranch
  const onPush = (held: (branch: string) => string, name: string): Context => {
    if (event !== "push") return unknown(`github.${name} of ${eventName(event, facts)} is known only on GitHub`)
    return branch === undefined ? unknown("the default branch is not known here") : value(held(branch))
  }
  const static_: ReadonlyMap<string, () => Context> = new Map<string, () => Context>([
    ["event_name", () => event === undefined ? unknown("no change starts this workflow") : value(event)],
    ["event", () => payload],
    ["sha", () => variable("sha", "github.sha")],
    ["workspace", () => variable("workspace", "github.workspace")],
    ["ref", () => onPush((name) => `refs/heads/${name}`, "ref")],
    ["ref_name", () => onPush((name) => name, "ref_name")],
    ["ref_type", () => value("branch")],
    ["base_ref", () => event === "pull_request" ? optional(branch, "the default branch") : value("")],
    ["head_ref", () =>
      event === "pull_request"
        ? unknown("github.head_ref, the pull request's branch, is known only on GitHub")
        : value("")],
    ["repository", () => optional(facts.repository, "the repository's name")],
    ["repository_owner", () => optional(facts.repository?.split("/")[0], "the repository's owner")],
    ["actor", () => value(actor)],
    ["triggering_actor", () => value(actor)],
    // The run's own: a runner gives them, and another commit is another run.
    ["run_id", () => variable("runid", "github.run_id")],
    ["run_number", () => variable("runnumber", "github.run_number")],
    ["run_attempt", () => variable("runattempt", "github.run_attempt")],
    ["job", () => value(place.job)],
    ["workflow", () => value(place.workflow)],
    ["action_path", () =>
      place.actionPath === undefined
        ? unknown("github.action_path has a value only inside an action")
        : variable(`path:${place.actionPath}`, "github.action_path")],
    ["token", () => ({ kind: "secret", name: "GITHUB_TOKEN" })],
    ...Object.entries(servers).map(([name, held]) => [name, () => value(held)] as const)
  ])
  return fields((name) => (static_.get(name) ?? (() => unknown(`github.${name} is known only on GitHub`)))())
}

const systems: Readonly<Record<Host, string>> = { linux: "Linux", darwin: "macOS", win32: "Windows" }

/**
 * The `runner` context. The machine is not GitHub's, so its environment is
 * `self-hosted`, as GitHub reports for any runner that is not its own: a step
 * a workflow keeps for GitHub's own machines, such as one that deletes
 * system directories to free space, is left out.
 *
 * @category contexts
 * @since 0.1.0
 * @throws {never}
 */
export const runner = (host: Host | undefined): Context =>
  fields((name) => {
    // A runner whose name says nothing of its system, or names a different one in each variant, runs here as this
    // machine: the step reads the system when it starts.
    if (name === "os") return host === undefined ? variable("os", "runner.os") : value(systems[host])
    if (name === "arch") return variable("arch", "runner.arch")
    if (name === "temp") return variable("temp", "runner.temp")
    if (name === "tool_cache") return variable("toolcache", "runner.tool_cache")
    if (name === "name") return value(actor)
    if (name === "environment") return value("self-hosted")
    return name === "debug" ? undefined : unknown(`runner.${name} is known only on GitHub`)
  })

/**
 * Every default variable of a GitHub runner, and who gives it to a step.
 *
 * The names are GitHub's own list: "Variables reference", "Default
 * environment variables",
 * https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables
 * (`content/actions/reference/workflows-and-actions/variables.md` of
 * github/docs at commit a9386877b03a, 2026-08-27). The test keeps a copy of
 * that table and fails when a name is missing here.
 *
 * - `job`: the same for every step of a job at every commit. Known when the
 *   workflow is read: {@link variables} and {@link standIns}.
 * - `step`: set when the step starts: the machine, the job's directories, the
 *   files a step writes for later steps. The runner text sees to them.
 * - `run`: another at every run. A runner gives them; a step no runner
 *   started is given the commit it stands on and numbers made from it.
 * - `action`: set only inside an action, as on GitHub.
 * - `unset`: a runner leaves it unset where a replay stands: for a script
 *   step, with debug logging off.
 *
 * `GITHUB_TOKEN` and the `ACTIONS_` credentials are not default variables and
 * are never given: a step gets no token, as for a pull request from a fork.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultVariables: Readonly<Record<string, "job" | "step" | "run" | "action" | "unset">> = {
  CI: "step",
  GITHUB_ACTION: "step",
  GITHUB_ACTION_PATH: "action",
  GITHUB_ACTION_REPOSITORY: "unset",
  GITHUB_ACTIONS: "job",
  GITHUB_ACTOR: "job",
  GITHUB_ACTOR_ID: "job",
  GITHUB_API_URL: "job",
  GITHUB_ARTIFACTS: "step",
  GITHUB_ARTIFACTS_LIST: "step",
  GITHUB_BASE_REF: "job",
  GITHUB_ENV: "step",
  GITHUB_EVENT_NAME: "job",
  GITHUB_EVENT_PATH: "run",
  GITHUB_GRAPHQL_URL: "job",
  GITHUB_HEAD_REF: "job",
  GITHUB_JOB: "step",
  GITHUB_OUTPUT: "step",
  GITHUB_PATH: "step",
  GITHUB_REF: "job",
  GITHUB_REF_NAME: "job",
  GITHUB_REF_PROTECTED: "job",
  GITHUB_REF_TYPE: "job",
  GITHUB_REPOSITORY: "job",
  GITHUB_REPOSITORY_ID: "job",
  GITHUB_REPOSITORY_OWNER: "job",
  GITHUB_REPOSITORY_OWNER_ID: "job",
  GITHUB_RETENTION_DAYS: "job",
  GITHUB_RUN_ATTEMPT: "run",
  GITHUB_RUN_ID: "run",
  GITHUB_RUN_NUMBER: "run",
  GITHUB_SERVER_URL: "job",
  GITHUB_SHA: "run",
  GITHUB_STEP_SUMMARY: "step",
  GITHUB_TRIGGERING_ACTOR: "job",
  GITHUB_WORKFLOW: "job",
  GITHUB_WORKFLOW_REF: "job",
  GITHUB_WORKFLOW_SHA: "run",
  GITHUB_WORKSPACE: "step",
  RUNNER_ARCH: "step",
  RUNNER_DEBUG: "unset",
  RUNNER_ENVIRONMENT: "job",
  RUNNER_NAME: "job",
  RUNNER_OS: "step",
  RUNNER_TEMP: "step",
  RUNNER_TOOL_CACHE: "step"
}

/**
 * The runner variables a step is given whose values are known when the
 * workflow is read. `CI` is `true` unless the workflow sets it, and
 * `GITHUB_JOB` is the job's key; the runner text sees to both, and to every
 * variable set when a step starts ({@link startedVariables}).
 *
 * @category contexts
 * @since 0.1.0
 * @throws {never}
 */
export const variables = (
  event: Event | undefined,
  facts: Facts,
  place: Place
): Readonly<Record<string, string>> => {
  const branch = facts.defaultBranch
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_ACTOR: actor,
    GITHUB_TRIGGERING_ACTOR: actor,
    GITHUB_API_URL: servers.api_url,
    GITHUB_GRAPHQL_URL: servers.graphql_url,
    GITHUB_SERVER_URL: servers.server_url,
    ...(event === undefined ? {} : { GITHUB_EVENT_NAME: event }),
    GITHUB_WORKFLOW: place.workflow,
    GITHUB_REF_TYPE: "branch",
    RUNNER_NAME: actor,
    RUNNER_ENVIRONMENT: "self-hosted",
    ...(facts.repository === undefined
      ? {}
      : { GITHUB_REPOSITORY: facts.repository, GITHUB_REPOSITORY_OWNER: facts.repository.split("/")[0] as string }),
    ...(event === "pull_request" ? {} : { GITHUB_BASE_REF: "", GITHUB_HEAD_REF: "" }),
    ...(branch === undefined
      ? {}
      : event === "push"
      ? { GITHUB_REF: `refs/heads/${branch}`, GITHUB_REF_NAME: branch }
      : event === "pull_request"
      ? { GITHUB_BASE_REF: branch }
      : {})
  }
}

/**
 * What a step finds in the default variables that only GitHub can fill: a
 * pull request's number and branch, the numbers GitHub gives an account and a
 * repository, the name of a repository no remote names. A runner always sets
 * them, and a program that only looks for one must find it, so each has a
 * value of the right shape. None is the value GitHub would give, so a script
 * that names one still leaves its job out: only {@link variables} and
 * {@link startedVariables} are a script's to read.
 *
 * A replayed commit stands for pull request `1` from the branch
 * `smithers-ci`. The default branch reads `main` where the repository names
 * none.
 *
 * @category contexts
 * @since 0.1.0
 * @throws {never}
 */
export const standIns = (
  event: Event | undefined,
  facts: Facts,
  place: Place
): Readonly<Record<string, string>> => {
  const branch = facts.defaultBranch ?? "main"
  const repository = facts.repository ?? `local/${facts.directory ?? "repository"}`
  const ref = event === "pull_request"
    ? `refs/pull/${one}/merge`
    : event === "merge_group"
    ? `refs/heads/gh-readonly-queue/${branch}/pr-${one}`
    : `refs/heads/${branch}`
  const all: Readonly<Record<string, string>> = {
    GITHUB_ACTOR_ID: one,
    GITHUB_EVENT_NAME: "push",
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_OWNER: repository.split("/")[0] as string,
    GITHUB_REPOSITORY_ID: one,
    GITHUB_REPOSITORY_OWNER_ID: one,
    GITHUB_RETENTION_DAYS: "90",
    GITHUB_REF: ref,
    GITHUB_REF_NAME: ref.replace(/^refs\/(?:heads|pull)\//, ""),
    GITHUB_REF_PROTECTED: "false",
    GITHUB_BASE_REF: branch,
    GITHUB_HEAD_REF: headBranch,
    GITHUB_WORKFLOW_REF: `${repository}/${place.file ?? ".github/workflows/ci.yml"}@${ref}`
  }
  const known = variables(event, facts, place)
  return Object.fromEntries(Object.entries(all).filter(([name]) => !Object.hasOwn(known, name)))
}

/**
 * The runner variables set when a step starts, whatever the workflow, that a
 * script may read: each holds what a runner would put there.
 *
 * @category constants
 * @since 0.1.0
 */
export const startedVariables: ReadonlyArray<string> = [
  "GITHUB_SHA",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_WORKSPACE",
  "GITHUB_EVENT_PATH",
  "GITHUB_ENV",
  "GITHUB_PATH",
  "GITHUB_OUTPUT",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_STATE",
  "GITHUB_JOB",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE"
]

/**
 * The event file of each event a replay can stand for, by the event's name:
 * what `Inventory.events` holds.
 *
 * @category contexts
 * @since 0.1.0
 * @throws {never}
 */
export const eventFilesOf = (facts: Facts): Readonly<Record<Event, string>> => ({
  pull_request: eventFile("pull_request", facts),
  push: eventFile("push", facts),
  merge_group: eventFile("merge_group", facts)
})

/**
 * The event file a step finds at `GITHUB_EVENT_PATH`: what the `github.event`
 * context holds, as JSON. The runner text puts the commit and its first
 * parent where `commitMark` and `parentMark` stand.
 *
 * @category contexts
 * @since 0.1.0
 * @throws {never}
 */
export const eventFile = (event: Event | undefined, facts: Facts): string => {
  const repository = {
    ...(facts.repository === undefined ? {} : { full_name: facts.repository }),
    ...(facts.defaultBranch === undefined ? {} : { default_branch: facts.defaultBranch })
  }
  const ref = facts.defaultBranch === undefined ? {} : { ref: `refs/heads/${facts.defaultBranch}` }
  const repo = { ...repository, fork: false }
  const payload = event === "pull_request"
    ? {
      pull_request: {
        head: { sha: commitMark, repo },
        base: { sha: parentMark, ...(facts.defaultBranch === undefined ? {} : { ref: facts.defaultBranch }), repo },
        labels: [],
        draft: false
      }
    }
    : event === "push"
    ? { before: parentMark, after: commitMark, ...ref, created: false, deleted: false, forced: false }
    : event === "merge_group"
    ? {
      merge_group: {
        head_sha: commitMark,
        base_sha: parentMark,
        ...(ref.ref === undefined ? {} : { base_ref: ref.ref })
      }
    }
    : {}
  return JSON.stringify({ ...payload, repository })
}
