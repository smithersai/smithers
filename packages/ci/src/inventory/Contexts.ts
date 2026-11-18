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
 * - `defaultBranch`: the branch a replayed commit is on.
 * - `read`: the text of a file in the repository, for a local action or a
 *   workflow another calls.
 *
 * @category models
 * @since 0.1.0
 */
export interface Facts {
  readonly repository?: string | undefined
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

/** The run's id, number and attempt: a replay is one run, started once. */
const run = "1"

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
 * Where an expression is read: the job's key, the workflow's name, and the
 * directory of the composite action it is in.
 *
 * @category models
 * @since 0.1.0
 */
export interface Place {
  readonly job: string
  readonly workflow: string
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
    ["run_id", () => value(run)],
    ["run_number", () => value(run)],
    ["run_attempt", () => value(run)],
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
 * The runner variables a step is given whose values are known when the
 * workflow is read. `CI` is `true` unless the workflow sets it, and
 * `GITHUB_JOB` is the job's key; the runner text sees to both. `GITHUB_SHA`, `GITHUB_WORKSPACE`, `RUNNER_ARCH`,
 * `RUNNER_TEMP`, `RUNNER_TOOL_CACHE`, `GITHUB_EVENT_PATH` and the files a
 * step writes for later steps are set when the step starts.
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
    GITHUB_RUN_ID: run,
    GITHUB_RUN_NUMBER: run,
    GITHUB_RUN_ATTEMPT: run,
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
 * The runner variables set when a step starts, whatever the workflow.
 *
 * @category constants
 * @since 0.1.0
 */
export const startedVariables: ReadonlyArray<string> = [
  "GITHUB_SHA",
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
